use crate::chat_window_records::{Action, Phase, Profile};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const PROFILE_METADATA_BYTES: usize = b"\"inlineCompletionVersion\":1,".len();
const INITIAL_EPOCH_BYTES: usize = b"\"intentEpoch\":1,".len();
const DEFAULT_CARRY_BYTES: usize = b"\"carry\":false,".len();
const INLINE_PHASE_GROWTH: usize = b"inline-ready".len() - b"assigned".len();

pub fn random_id() -> Result<String, &'static str> {
    let mut bytes = [0; 16];
    security_framework::random::SecRandom::default()
        .copy_bytes(&mut bytes)
        .map_err(|_| "native-random-unavailable")?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Records {
    schema_version: u8,
    profiles: BTreeMap<String, Profile>,
}
impl Records {
    fn encode(&self) -> Result<Vec<u8>, &'static str> {
        let bytes = serde_json::to_vec(self).map_err(|_| "native-records-unavailable")?;
        // Charge the compact legacy representation, excluding defaulted schema metadata
        // and the maximum phase growth introduced by inline-completion reconciliation.
        let overhead: usize = self
            .profiles
            .values()
            .map(|profile| {
                PROFILE_METADATA_BYTES
                    + if profile.intent_epoch == 1 {
                        INITIAL_EPOCH_BYTES
                    } else {
                        0
                    }
                    + profile
                        .windows
                        .values()
                        .filter(|entry| entry.phase == Phase::InlineReady)
                        .count()
                        * INLINE_PHASE_GROWTH
                    + profile
                        .intents
                        .values()
                        .map(|intent| {
                            let carry = match &intent.action {
                                Action::Open { carry, .. } | Action::Create { carry, .. } => *carry,
                            };
                            (if carry { 0 } else { DEFAULT_CARRY_BYTES })
                                + if intent
                                    .target
                                    .as_ref()
                                    .is_some_and(|target| target.phase == Phase::InlineReady)
                                {
                                    INLINE_PHASE_GROWTH
                                } else {
                                    0
                                }
                        })
                        .sum::<usize>()
            })
            .sum();
        let payload = bytes.len().saturating_sub(overhead);
        if payload as u64 > MAX_BYTES {
            return Err("native-record-capacity");
        }
        Ok(bytes)
    }
    fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != 1 {
            return Err("unsupported-native-records");
        }
        for (key, value) in &self.profiles {
            if key != &value.origin {
                return Err("native-profile-mismatch");
            }
            value.validate()?;
        }
        Ok(())
    }
}
fn private_metadata(
    path: &Path,
    directory: &std::fs::Metadata,
) -> Result<std::fs::Metadata, &'static str> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "native-records-unavailable")?;
    if !metadata.is_file() || metadata.uid() != directory.uid() || metadata.mode() & 0o077 != 0 {
        return Err("unsafe-native-records");
    }
    Ok(metadata)
}
fn same_file(file: &File, expected: &std::fs::Metadata) -> Result<(), &'static str> {
    let actual = file.metadata().map_err(|_| "native-records-unavailable")?;
    if actual.dev() != expected.dev() || actual.ino() != expected.ino() {
        return Err("native-records-changed");
    }
    Ok(())
}
pub struct Storage {
    directory: PathBuf,
    records: Records,
    _lock: File,
    fault: Option<&'static str>,
}
impl Storage {
    pub fn open(directory: &Path) -> Result<Self, &'static str> {
        std::fs::create_dir_all(directory).map_err(|_| "native-records-unavailable")?;
        let dir = std::fs::symlink_metadata(directory).map_err(|_| "native-records-unavailable")?;
        if !dir.is_dir() {
            return Err("unsafe-native-directory");
        }
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "native-records-unavailable")?;
        let lock_path = directory.join("chat-windows-v1.lock");
        match std::fs::symlink_metadata(&lock_path) {
            Ok(_) => {
                private_metadata(&lock_path, &dir)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("native-records-unavailable"),
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .open(&lock_path)
            .map_err(|_| "native-records-unavailable")?;
        same_file(&lock, &private_metadata(&lock_path, &dir)?)?;
        lock.try_lock().map_err(|_| "native-profile-in-use")?;
        let path = directory.join("chat-windows-v1.json");
        let records = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Records {
                schema_version: 1,
                profiles: BTreeMap::new(),
            },
            Err(_) => return Err("native-records-unavailable"),
            Ok(_) => {
                let expected = private_metadata(&path, &dir)?;
                let file = File::open(&path).map_err(|_| "native-records-unavailable")?;
                same_file(&file, &expected)?;
                let mut bytes = Vec::new();
                file.take(MAX_BYTES * 2 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "native-records-unavailable")?;
                if bytes.len() as u64 > MAX_BYTES * 2 {
                    return Err("native-record-capacity");
                }
                serde_json::from_slice(&bytes).map_err(|_| "corrupt-native-records")?
            }
        };
        records.validate()?;
        records.encode()?;
        Ok(Self {
            directory: directory.into(),
            records,
            _lock: lock,
            fault: None,
        })
    }
    pub fn profile(&self, origin: &str) -> Result<&Profile, &'static str> {
        if let Some(fault) = self.fault {
            return Err(fault);
        }
        self.records
            .profiles
            .get(origin)
            .ok_or("unknown-native-profile")
    }
    pub fn ensure_profile(&mut self, origin: &str) -> Result<(), &'static str> {
        if let Some(fault) = self.fault {
            return Err(fault);
        }
        if self.records.profiles.contains_key(origin) {
            let mut next = self.records.clone();
            if next
                .profiles
                .get_mut(origin)
                .ok_or("unknown-native-profile")?
                .reconcile_inline_completions()?
            {
                self.commit(next)?;
            }
            return Ok(());
        }
        let catalog_view_id = random_id()?;
        let mut next = self.records.clone();
        next.profiles.insert(
            origin.into(),
            Profile {
                origin: origin.into(),
                inline_completion_version: 1,
                intent_epoch: 1,
                catalog_view_id,
                windows: BTreeMap::new(),
                intents: BTreeMap::new(),
            },
        );
        self.commit(next)
    }
    pub fn mutate<T>(
        &mut self,
        origin: &str,
        operation: impl FnOnce(&mut Profile) -> Result<T, &'static str>,
    ) -> Result<T, &'static str> {
        if let Some(fault) = self.fault {
            return Err(fault);
        }
        let mut next = self.records.clone();
        let result = operation(
            next.profiles
                .get_mut(origin)
                .ok_or("unknown-native-profile")?,
        )?;
        self.commit(next)?;
        Ok(result)
    }
    fn commit(&mut self, next: Records) -> Result<(), &'static str> {
        self.commit_with_sync(next, |directory| File::open(directory)?.sync_all())
    }
    fn commit_with_sync(
        &mut self,
        next: Records,
        sync: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), &'static str> {
        next.validate()?;
        let bytes = next.encode()?;
        let temporary = self
            .directory
            .join(format!(".chat-windows-{}.tmp", random_id()?));
        let mut replaced = false;
        let write = || -> Result<(), &'static str> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|_| "native-records-unavailable")?;
            file.write_all(&bytes)
                .map_err(|_| "native-records-unavailable")?;
            file.sync_all().map_err(|_| "native-records-unavailable")?;
            std::fs::rename(&temporary, self.directory.join("chat-windows-v1.json"))
                .map_err(|_| "native-records-unavailable")?;
            replaced = true;
            sync(&self.directory).map_err(|_| "native-records-commit-uncertain")?;
            Ok(())
        };
        let result = write();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        if let Err(error) = result {
            if replaced {
                self.records = next;
                self.fault = Some(error);
            }
            return Err(error);
        }
        self.records = next;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("openpane-chat-windows-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn legacy_profiles_at_capacity_upgrade_and_reopen_without_losing_catalog_ids() {
        let dir = temp();
        let profile = |origin: String, catalog_view_id: String| Profile {
            origin,
            catalog_view_id,
            inline_completion_version: 0,
            intent_epoch: 1,
            windows: BTreeMap::new(),
            intents: BTreeMap::new(),
        };
        let mut legacy = profile(String::new(), "c".into());
        use crate::chat_window_records::{Action, CompletedPlacement, Phase, Reservation, Scope};
        let source = Scope {
            host_id: "host".into(),
            conversation_id: "source".into(),
        };
        let target_scope = Scope {
            host_id: "host".into(),
            conversation_id: "target".into(),
        };
        legacy
            .intent(
                source.clone(),
                "1:legacy".into(),
                Action::Open {
                    scope: target_scope.clone(),
                    carry: false,
                    passive: false,
                },
            )
            .unwrap();
        legacy
            .assign_intent(
                &source,
                "1:legacy",
                Reservation {
                    scope: target_scope.clone(),
                    view_id: "view".into(),
                    label: "chat".into(),
                    transition_id: "attempt".into(),
                    creation_agent_id: None,
                    phase: Phase::Assigned,
                    binding_revision: None,
                    writer_generation: None,
                },
                false,
                None,
            )
            .unwrap();
        legacy
            .intents
            .get_mut(&Profile::intent_key(&source, "1:legacy"))
            .unwrap()
            .result = Some(CompletedPlacement::Inline {
            scope: target_scope.clone(),
        });
        let mut value = serde_json::to_value(legacy).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("inlineCompletionVersion");
        value.as_object_mut().unwrap().remove("intentEpoch");
        value["intents"][Profile::intent_key(&source, "1:legacy")]["action"]
            .as_object_mut()
            .unwrap()
            .remove("carry");
        let overhead = serde_json::to_vec(&value).unwrap().len() + 4;
        let empty = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"profiles":{}}))
            .unwrap()
            .len();
        let target = MAX_BYTES as usize - 1;
        let count = (target - empty) / (4096 + overhead) - 1;
        let mut profiles = serde_json::Map::new();
        for index in 0..count {
            let origin = format!("{index:08}{}", "x".repeat(2040));
            let mut entry = value.clone();
            entry["origin"] = serde_json::json!(origin);
            profiles.insert(origin, entry);
        }
        let current =
            serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"profiles":profiles}))
                .unwrap()
                .len();
        let remaining = target - current - 2 * overhead;
        let first_len = remaining / 4;
        let first_origin = "y".repeat(first_len);
        let mut first = value.clone();
        first["origin"] = serde_json::json!(first_origin);
        profiles.insert(first_origin, first);
        let origin = "z".repeat(remaining / 2 - first_len);
        let mut entry = value;
        entry["origin"] = serde_json::json!(origin);
        if remaining % 2 == 1 {
            entry["catalogViewId"] = serde_json::json!("cc");
        }
        profiles.insert(origin.clone(), entry);
        let bytes = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"profiles":profiles}))
            .unwrap();
        assert_eq!(bytes.len(), target);
        let path = dir.join("chat-windows-v1.json");
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut store = Storage::open(&dir).unwrap();
        let catalog = store.profile(&origin).unwrap().catalog_view_id.clone();
        store.ensure_profile(&origin).unwrap();
        assert_eq!(store.profile(&origin).unwrap().inline_completion_version, 1);
        assert_eq!(
            store.profile(&origin).unwrap().windows[&target_scope.key()].phase,
            Phase::InlineReady
        );
        drop(store);
        let reopened = Storage::open(&dir).unwrap();
        assert_eq!(reopened.profile(&origin).unwrap().catalog_view_id, catalog);
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn state_survives_restart_with_private_modes_and_one_writer() {
        let dir = temp();
        let mut store = Storage::open(&dir).unwrap();
        store.ensure_profile("origin").unwrap();
        let assigned = store.profile("origin").unwrap().catalog_view_id.clone();
        assert!(matches!(Storage::open(&dir), Err("native-profile-in-use")));
        assert_eq!(
            std::fs::metadata(dir.join("chat-windows-v1.json"))
                .unwrap()
                .mode()
                & 0o777,
            0o600
        );
        drop(store);
        let reopened = Storage::open(&dir).unwrap();
        assert_eq!(
            reopened.profile("origin").unwrap().catalog_view_id,
            assigned
        );
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn corrupt_or_symlinked_records_cannot_silently_allocate_new_ids() {
        let dir = temp();
        std::fs::write(dir.join("chat-windows-v1.json"), b"corrupt").unwrap();
        std::fs::set_permissions(
            dir.join("chat-windows-v1.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(matches!(Storage::open(&dir), Err("corrupt-native-records")));
        std::fs::remove_file(dir.join("chat-windows-v1.json")).unwrap();
        std::os::unix::fs::symlink("absent", dir.join("chat-windows-v1.json")).unwrap();
        assert!(matches!(Storage::open(&dir), Err("unsafe-native-records")));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn a_dangling_lock_link_is_rejected_without_creating_its_target() {
        let dir = temp();
        let target = dir.join("not-a-lock");
        std::os::unix::fs::symlink(&target, dir.join("chat-windows-v1.lock")).unwrap();
        assert!(matches!(Storage::open(&dir), Err("unsafe-native-records")));
        assert!(!target.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejected_mutation_does_not_change_memory_or_disk() {
        let dir = temp();
        let mut store = Storage::open(&dir).unwrap();
        store.ensure_profile("origin").unwrap();
        let before = std::fs::read(dir.join("chat-windows-v1.json")).unwrap();
        let result = store.mutate("origin", |profile| {
            profile.catalog_view_id.clear();
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "invalid-identifier");
        assert!(!store.profile("origin").unwrap().catalog_view_id.is_empty());
        assert_eq!(
            before,
            std::fs::read(dir.join("chat-windows-v1.json")).unwrap()
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_rename_can_retry_and_uncertain_directory_sync_never_serves_stale_memory() {
        let dir = temp();
        let mut store = Storage::open(&dir).unwrap();
        store.ensure_profile("origin").unwrap();
        let canonical = dir.join("chat-windows-v1.json");
        let backup = dir.join("backup.json");
        std::fs::rename(&canonical, &backup).unwrap();
        std::fs::create_dir(&canonical).unwrap();
        assert!(store
            .mutate("origin", |profile| {
                profile.catalog_view_id = "retry".into();
                Ok(())
            })
            .is_err());
        std::fs::remove_dir(&canonical).unwrap();
        std::fs::rename(&backup, &canonical).unwrap();
        store
            .mutate("origin", |profile| {
                profile.catalog_view_id = "retry".into();
                Ok(())
            })
            .unwrap();
        assert_eq!(store.profile("origin").unwrap().catalog_view_id, "retry");
        let mut next = store.records.clone();
        next.profiles.get_mut("origin").unwrap().catalog_view_id = "renamed".into();
        assert_eq!(
            store.commit_with_sync(next, |_| Err(std::io::Error::other("sync failed"))),
            Err("native-records-commit-uncertain")
        );
        let disk: Records = serde_json::from_slice(&std::fs::read(&canonical).unwrap()).unwrap();
        assert_eq!(
            store.records.profiles["origin"].catalog_view_id,
            disk.profiles["origin"].catalog_view_id
        );
        assert!(matches!(
            store.profile("origin"),
            Err("native-records-commit-uncertain")
        ));
        drop(store);
        assert_eq!(
            Storage::open(&dir)
                .unwrap()
                .profile("origin")
                .unwrap()
                .catalog_view_id,
            "renamed"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn additional_origins_use_the_file_byte_budget_and_preserve_catalog_identity() {
        let dir = temp();
        let mut store = Storage::open(&dir).unwrap();
        let mut ids = Vec::new();
        for n in 0..20 {
            let origin = format!("http://127.0.0.1:{}", 17000 + n);
            store.ensure_profile(&origin).unwrap();
            ids.push((
                origin.clone(),
                store.profile(&origin).unwrap().catalog_view_id.clone(),
            ));
        }
        drop(store);
        let reopened = Storage::open(&dir).unwrap();
        for (origin, id) in ids {
            assert_eq!(reopened.profile(&origin).unwrap().catalog_view_id, id);
        }
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn reopening_reconciles_legacy_inline_completion_without_rewinding_a_newer_transition() {
        use crate::chat_window_records::{Action, Phase, Reservation, Scope};
        let dir = temp();
        let mut store = Storage::open(&dir).unwrap();
        store.ensure_profile("origin").unwrap();
        let scope = Scope {
            host_id: "host".into(),
            conversation_id: "target".into(),
        };
        let source = Scope {
            host_id: "host".into(),
            conversation_id: "source".into(),
        };
        store
            .mutate("origin", |profile| {
                profile.intent(
                    source.clone(),
                    "1:old".into(),
                    Action::Open {
                        scope: scope.clone(),
                        passive: false,
                        carry: false,
                    },
                )?;
                profile.assign_intent(
                    &source,
                    "1:old",
                    Reservation {
                        scope: scope.clone(),
                        view_id: "view".into(),
                        label: "chat".into(),
                        transition_id: "original".into(),
                        creation_agent_id: None,
                        phase: Phase::Requested,
                        binding_revision: None,
                        writer_generation: None,
                    },
                    false,
                    None,
                )?;
                profile
                    .intents
                    .get_mut(&Profile::intent_key(&source, "1:old"))
                    .unwrap()
                    .result = Some(crate::chat_window_records::CompletedPlacement::Inline {
                    scope: scope.clone(),
                });
                Ok(())
            })
            .unwrap();
        drop(store);
        let path = dir.join("chat-windows-v1.json");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        for profile in legacy["profiles"].as_object_mut().unwrap().values_mut() {
            assert_eq!(
                profile
                    .as_object_mut()
                    .unwrap()
                    .remove("inlineCompletionVersion"),
                Some(serde_json::json!(1))
            );
        }
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let mut reopened = Storage::open(&dir).unwrap();
        reopened.ensure_profile("origin").unwrap();
        assert_eq!(
            reopened.profile("origin").unwrap().windows[&scope.key()].phase,
            Phase::InlineReady
        );
        reopened
            .mutate("origin", |profile| {
                let entry = profile.windows.get_mut(&scope.key()).unwrap();
                entry.phase = Phase::Requested;
                entry.transition_id = "newer".into();
                Ok(())
            })
            .unwrap();
        drop(reopened);
        let mut later = Storage::open(&dir).unwrap();
        later.ensure_profile("origin").unwrap();
        assert_eq!(
            later.profile("origin").unwrap().windows[&scope.key()].phase,
            Phase::Requested
        );
        drop(later);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

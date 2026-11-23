use crate::chat_window_records::Profile;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 8 * 1024 * 1024;

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
    fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != 1 || self.profiles.len() > 16 {
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
        if lock_path
            .try_exists()
            .map_err(|_| "native-records-unavailable")?
        {
            private_metadata(&lock_path, &dir)?;
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
                file.take(MAX_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "native-records-unavailable")?;
                if bytes.len() as u64 > MAX_BYTES {
                    return Err("native-record-capacity");
                }
                serde_json::from_slice(&bytes).map_err(|_| "corrupt-native-records")?
            }
        };
        records.validate()?;
        Ok(Self {
            directory: directory.into(),
            records,
            _lock: lock,
            fault: None,
        })
    }
    pub fn profile(&self, origin: &str) -> Result<&Profile, &'static str> {
        self.records
            .profiles
            .get(origin)
            .ok_or("unknown-native-profile")
    }
    pub fn ensure_profile(&mut self, origin: &str) -> Result<(), &'static str> {
        if self.records.profiles.contains_key(origin) {
            return Ok(());
        }
        let catalog_view_id = random_id()?;
        if let Some(fault) = self.fault {
            return Err(fault);
        }
        let mut next = self.records.clone();
        next.profiles.insert(
            origin.into(),
            Profile {
                origin: origin.into(),
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
        next.validate()?;
        let bytes = serde_json::to_vec(&next).map_err(|_| "native-records-unavailable")?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("native-record-capacity");
        }
        let temporary = self
            .directory
            .join(format!(".chat-windows-{}.tmp", random_id()?));
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
            File::open(&self.directory)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "native-records-unavailable")?;
            Ok(())
        };
        let result = write();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        if let Err(error) = result {
            self.fault = Some(error);
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
}

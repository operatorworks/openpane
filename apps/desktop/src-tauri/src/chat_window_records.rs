use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_WINDOWS: usize = 512;
pub const MAX_INTENTS: usize = 1024;
pub const MAX_PENDING_INTENTS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub host_id: String,
    pub conversation_id: String,
}
impl Scope {
    pub fn validate(&self) -> Result<(), &'static str> {
        identifier(&self.host_id, 1024)?;
        identifier(&self.conversation_id, 1024)
    }
    pub fn key(&self) -> String {
        serde_json::to_string(self).expect("scope serialization")
    }
}
pub fn identifier(value: &str, max: usize) -> Result<(), &'static str> {
    if value.is_empty() || value.encode_utf16().count() > max {
        Err("invalid-identifier")
    } else {
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Open {
        scope: Scope,
        #[serde(default)]
        carry: bool,
    },
    Create {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(default)]
        carry: bool,
    },
}
impl Action {
    pub fn validate(&self, host_id: &str) -> Result<(), &'static str> {
        match self {
            Self::Open { scope, .. } => {
                scope.validate()?;
                if scope.host_id != host_id {
                    return Err("foreign-host");
                }
            }
            Self::Create { agent_id, .. } => identifier(agent_id, 1024)?,
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Requested,
    SourceSaved,
    TransferCommitted,
    SourceReleased,
    TargetReady,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reservation {
    pub scope: Scope,
    pub view_id: String,
    pub label: String,
    pub transition_id: String,
    pub creation_agent_id: Option<String>,
    pub phase: Phase,
    pub binding_revision: Option<u64>,
    pub writer_generation: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub source_scope: Scope,
    pub request_id: String,
    pub action: Action,
    pub target: Option<Reservation>,
    pub result: Option<serde_json::Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub origin: String,
    pub catalog_view_id: String,
    pub windows: BTreeMap<String, Reservation>,
    pub intents: BTreeMap<String, Intent>,
}
impl Profile {
    pub fn validate(&self) -> Result<(), &'static str> {
        identifier(&self.origin, 2048)?;
        identifier(&self.catalog_view_id, 200)?;
        if self.windows.len() > MAX_WINDOWS || self.intents.len() > MAX_INTENTS {
            return Err("native-record-capacity");
        }
        for (key, value) in &self.windows {
            value.scope.validate()?;
            if key != &value.scope.key() {
                return Err("native-binding-key-mismatch");
            }
            identifier(&value.view_id, 200)?;
            identifier(&value.label, 200)?;
            identifier(&value.transition_id, 200)?;
            if let Some(agent) = &value.creation_agent_id {
                identifier(agent, 1024)?;
            }
            for count in [value.binding_revision, value.writer_generation]
                .into_iter()
                .flatten()
            {
                if count == 0 || count > 9_007_199_254_740_991 {
                    return Err("invalid-binding-generation");
                }
            }
        }
        for (key, intent) in &self.intents {
            intent.source_scope.validate()?;
            identifier(&intent.request_id, 200)?;
            intent.action.validate(&intent.source_scope.host_id)?;
            if key != &Self::intent_key(&intent.source_scope, &intent.request_id) {
                return Err("native-intent-key-mismatch");
            }
            if let Some(target) = &intent.target {
                let reserved = self
                    .windows
                    .get(&target.scope.key())
                    .ok_or("missing-intent-reservation")?;
                if target.view_id != reserved.view_id
                    || target.label != reserved.label
                    || target.scope.host_id != intent.source_scope.host_id
                {
                    return Err("native-intent-target-mismatch");
                }
                match &intent.action {
                    Action::Open { scope, .. } if scope != &target.scope => {
                        return Err("native-intent-action-mismatch")
                    }
                    Action::Create { agent_id, .. }
                        if target.creation_agent_id.as_ref() != Some(agent_id) =>
                    {
                        return Err("native-intent-agent-mismatch")
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
    pub fn intent_key(scope: &Scope, request_id: &str) -> String {
        serde_json::to_string(&(scope, request_id)).expect("intent key serialization")
    }
    pub fn intent(
        &mut self,
        source_scope: Scope,
        request_id: String,
        action: Action,
    ) -> Result<Intent, &'static str> {
        source_scope.validate()?;
        identifier(&request_id, 200)?;
        action.validate(&source_scope.host_id)?;
        let key = Self::intent_key(&source_scope, &request_id);
        if let Some(previous) = self.intents.get(&key) {
            return if previous.action == action {
                Ok(previous.clone())
            } else {
                Err("intent-input-conflict")
            };
        }
        if self.intents.len() == MAX_INTENTS
            || self
                .intents
                .values()
                .filter(|intent| intent.result.is_none())
                .count()
                >= MAX_PENDING_INTENTS
        {
            return Err("native-intent-capacity");
        }
        let intent = Intent {
            source_scope,
            request_id,
            action,
            target: None,
            result: None,
        };
        self.intents.insert(key, intent.clone());
        Ok(intent)
    }
    pub fn reserve(&mut self, reservation: Reservation) -> Result<Reservation, &'static str> {
        reservation.scope.validate()?;
        identifier(&reservation.view_id, 200)?;
        identifier(&reservation.label, 200)?;
        identifier(&reservation.transition_id, 200)?;
        let key = reservation.scope.key();
        if let Some(previous) = self.windows.get(&key) {
            if previous.view_id != reservation.view_id {
                return Err("native-binding-mismatch");
            }
            if reservation.creation_agent_id.is_some()
                && previous.creation_agent_id != reservation.creation_agent_id
            {
                return Err("native-creation-agent-mismatch");
            }
            return Ok(previous.clone());
        }
        if self.windows.len() == MAX_WINDOWS {
            return Err("native-window-capacity");
        }
        if self
            .windows
            .values()
            .any(|entry| entry.label == reservation.label || entry.view_id == reservation.view_id)
        {
            return Err("native-reservation-collision");
        }
        self.windows.insert(key, reservation.clone());
        Ok(reservation)
    }
    pub fn assign_intent(
        &mut self,
        source: &Scope,
        request_id: &str,
        reservation: Reservation,
    ) -> Result<Intent, &'static str> {
        let key = Self::intent_key(source, request_id);
        let previous = self.intents.get(&key).ok_or("unknown-intent")?;
        if let Some(target) = &previous.target {
            return if target.scope == reservation.scope && target.view_id == reservation.view_id {
                Ok(previous.clone())
            } else {
                Err("intent-target-conflict")
            };
        }
        match &previous.action {
            Action::Open { scope, .. } if scope != &reservation.scope => {
                return Err("intent-target-conflict")
            }
            Action::Create { agent_id, .. }
                if reservation.creation_agent_id.as_ref() != Some(agent_id) =>
            {
                return Err("intent-agent-conflict")
            }
            _ => {}
        }
        if reservation.scope.host_id != source.host_id {
            return Err("foreign-host");
        }
        let target = self.reserve(reservation)?;
        let intent = self.intents.get_mut(&key).ok_or("unknown-intent")?;
        intent.target = Some(target);
        Ok(intent.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(id: &str) -> Scope {
        Scope {
            host_id: "host".into(),
            conversation_id: id.into(),
        }
    }
    fn profile() -> Profile {
        Profile {
            origin: "http://127.0.0.1:7140".into(),
            catalog_view_id: "catalog".into(),
            windows: BTreeMap::new(),
            intents: BTreeMap::new(),
        }
    }
    fn reservation() -> Reservation {
        Reservation {
            scope: scope("target"),
            view_id: "view".into(),
            label: "chat-label".into(),
            transition_id: "transition".into(),
            creation_agent_id: Some("agent".into()),
            phase: Phase::Requested,
            binding_revision: None,
            writer_generation: None,
        }
    }
    #[test]
    fn reservation_replay_reuses_exact_view_and_refuses_scope_label_collisions() {
        let mut p = profile();
        let first = p.reserve(reservation()).unwrap();
        assert_eq!(
            p.reserve(reservation()).unwrap().transition_id,
            first.transition_id
        );
        let mut conflict = reservation();
        conflict.view_id = "replacement".into();
        assert_eq!(p.reserve(conflict).unwrap_err(), "native-binding-mismatch");
        let mut collision = reservation();
        collision.scope = scope("another");
        assert_eq!(
            p.reserve(collision).unwrap_err(),
            "native-reservation-collision"
        );
    }
    #[test]
    fn durable_intent_never_reallocates_after_lost_reply_or_source_reload() {
        let mut p = profile();
        let source = scope("source");
        let action = Action::Create {
            agent_id: "agent".into(),
            carry: false,
        };
        p.intent(source.clone(), "request".into(), action.clone())
            .unwrap();
        p.assign_intent(&source, "request", reservation()).unwrap();
        let data = serde_json::to_vec(&p).unwrap();
        let mut restored: Profile = serde_json::from_slice(&data).unwrap();
        restored.validate().unwrap();
        let replay = restored
            .intent(source.clone(), "request".into(), action)
            .unwrap();
        assert_eq!(replay.target.unwrap().scope, scope("target"));
        assert_eq!(
            restored
                .intent(
                    source,
                    "request".into(),
                    Action::Create {
                        agent_id: "different".into(),
                        carry: false
                    }
                )
                .unwrap_err(),
            "intent-input-conflict"
        );
    }
    #[test]
    fn intent_queue_is_bounded_and_unresolved_records_are_retained() {
        let mut p = profile();
        for index in 0..MAX_PENDING_INTENTS {
            p.intent(
                scope("source"),
                index.to_string(),
                Action::Open {
                    scope: scope("target"),
                    carry: false,
                },
            )
            .unwrap();
        }
        assert_eq!(
            p.intent(
                scope("source"),
                "extra".into(),
                Action::Open {
                    scope: scope("target"),
                    carry: false
                }
            )
            .unwrap_err(),
            "native-intent-capacity"
        );
        assert_eq!(p.intents.len(), MAX_PENDING_INTENTS);
    }
    #[test]
    fn corrupt_or_foreign_target_is_refused_instead_of_reset() {
        let mut p = profile();
        let source = scope("source");
        p.intent(
            source.clone(),
            "request".into(),
            Action::Create {
                agent_id: "agent".into(),
                carry: false,
            },
        )
        .unwrap();
        let mut target = reservation();
        target.scope.host_id = "foreign".into();
        assert_eq!(
            p.assign_intent(&source, "request", target).unwrap_err(),
            "foreign-host"
        );
        p.assign_intent(&source, "request", reservation()).unwrap();
        p.windows.clear();
        assert_eq!(p.validate().unwrap_err(), "missing-intent-reservation");
    }
}

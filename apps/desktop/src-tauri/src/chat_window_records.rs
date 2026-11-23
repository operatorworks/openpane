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
    Assigned,
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
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum CompletedPlacement {
    Inline { scope: Scope },
    Detached { scope: Scope, label: String },
    Refused { reason: String },
}
fn completed_placement(value: &serde_json::Value) -> Result<CompletedPlacement, &'static str> {
    let result = serde_json::from_value::<CompletedPlacement>(value.clone())
        .map_err(|_| "invalid-intent-result")?;
    match &result {
        CompletedPlacement::Inline { scope } => scope.validate()?,
        CompletedPlacement::Detached { scope, label } => {
            scope.validate()?;
            identifier(label, 200)?;
        }
        CompletedPlacement::Refused { reason } => identifier(reason, 1000)?,
    }
    Ok(result)
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
impl Intent {
    fn completion_is_inline(&self, value: &serde_json::Value) -> Result<bool, &'static str> {
        match completed_placement(value)? {
            CompletedPlacement::Refused { .. } => Ok(false),
            CompletedPlacement::Inline { scope } => {
                if self
                    .target
                    .as_ref()
                    .is_none_or(|target| target.scope != scope)
                {
                    return Err("intent-result-target-mismatch");
                }
                Ok(true)
            }
            CompletedPlacement::Detached { scope, label } => {
                if self
                    .target
                    .as_ref()
                    .is_none_or(|target| target.scope != scope || target.label != label)
                {
                    return Err("intent-result-target-mismatch");
                }
                Ok(false)
            }
        }
    }
}
pub struct InlineRecovery {
    pub from_transition_id: String,
    pub transition_id: String,
}
impl Reservation {
    pub fn inline_recovery(&self, expected: &str) -> Result<InlineRecovery, &'static str> {
        let original = self
            .transition_id
            .strip_prefix("inline:")
            .unwrap_or(&self.transition_id);
        let transition_id = format!("inline:{original}");
        if expected != original && expected != transition_id {
            return Err("stale-recovery-reservation");
        }
        identifier(&transition_id, 200)?;
        Ok(InlineRecovery {
            from_transition_id: original.into(),
            transition_id,
        })
    }
    fn validate(&self) -> Result<(), &'static str> {
        self.scope.validate()?;
        identifier(&self.view_id, 200)?;
        identifier(&self.label, 200)?;
        identifier(&self.transition_id, 200)?;
        if let Some(agent) = &self.creation_agent_id {
            identifier(agent, 1024)?;
        }
        for count in [self.binding_revision, self.writer_generation]
            .into_iter()
            .flatten()
        {
            if count == 0 || count > 9_007_199_254_740_991 {
                return Err("invalid-binding-generation");
            }
        }
        Ok(())
    }
}
fn initial_intent_epoch() -> u64 {
    1
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub origin: String,
    #[serde(default = "initial_intent_epoch")]
    pub intent_epoch: u64,
    pub catalog_view_id: String,
    pub windows: BTreeMap<String, Reservation>,
    pub intents: BTreeMap<String, Intent>,
}
impl Profile {
    pub fn validate_carry_notification(
        &self,
        source: &Scope,
        request_id: &str,
        caller: Option<&Scope>,
    ) -> Result<(), &'static str> {
        source.validate()?;
        identifier(request_id, 200)?;
        if caller.is_some_and(|target| target.host_id != source.host_id || target == source) {
            return Err("foreign-carry-intent");
        }
        if let Some(intent) = self.intents.get(&Self::intent_key(source, request_id)) {
            let target = intent.target.as_ref().ok_or("unassigned-intent")?;
            let carries = match &intent.action {
                Action::Open { carry, .. } | Action::Create { carry, .. } => *carry,
            };
            if !carries || caller.is_some_and(|scope| scope != &target.scope) {
                return Err("foreign-carry-intent");
            }
            return Ok(());
        }
        // Main carries live in IndexedDB; this notification only wakes its fenced writer.
        if request_id
            .split_once(":main-")
            .is_some_and(|(epoch, transition)| {
                !transition.is_empty()
                    && epoch
                        .parse::<u64>()
                        .is_ok_and(|epoch| epoch > 0 && epoch <= 9_007_199_254_740_991)
            })
        {
            return Ok(());
        }
        Err("unknown-carry-request")
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        identifier(&self.origin, 2048)?;
        if self.intent_epoch == 0 || self.intent_epoch > 9_007_199_254_740_991 {
            return Err("invalid-intent-epoch");
        }
        identifier(&self.catalog_view_id, 200)?;
        if self.windows.len() > MAX_WINDOWS || self.intents.len() > MAX_INTENTS {
            return Err("native-record-capacity");
        }
        for (key, value) in &self.windows {
            value.validate()?;
            if key != &value.scope.key() {
                return Err("native-binding-key-mismatch");
            }
        }
        for (key, intent) in &self.intents {
            intent.source_scope.validate()?;
            identifier(&intent.request_id, 200)?;
            intent.action.validate(&intent.source_scope.host_id)?;
            if key != &Self::intent_key(&intent.source_scope, &intent.request_id) {
                return Err("native-intent-key-mismatch");
            }
            if let Some(result) = &intent.result {
                intent.completion_is_inline(result)?;
            }
            if let Some(target) = &intent.target {
                target.validate()?;
                if target.scope.host_id != intent.source_scope.host_id {
                    return Err("native-intent-target-mismatch");
                }
                if intent.result.is_none() {
                    let reserved = self
                        .windows
                        .get(&target.scope.key())
                        .ok_or("missing-intent-reservation")?;
                    if target.view_id != reserved.view_id || target.label != reserved.label {
                        return Err("native-intent-target-mismatch");
                    }
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
    pub fn complete_intent(
        &mut self,
        source: &Scope,
        request_id: &str,
        result: serde_json::Value,
    ) -> Result<(), &'static str> {
        let key = Self::intent_key(source, request_id);
        let intent = self.intents.get(&key).ok_or("unknown-intent")?;
        if let Some(previous) = &intent.result {
            return if previous == &result {
                Ok(())
            } else {
                Err("intent-result-conflict")
            };
        }
        if intent.completion_is_inline(&result)? {
            let target = intent.target.as_ref().ok_or("unassigned-intent")?;
            let entry = self
                .windows
                .get_mut(&target.scope.key())
                .ok_or("missing-intent-reservation")?;
            if entry.view_id != target.view_id || entry.label != target.label {
                return Err("native-intent-target-mismatch");
            }
            if matches!(entry.phase, Phase::Assigned | Phase::Requested)
                && entry.transition_id == target.transition_id
            {
                entry.phase = Phase::TargetReady;
            }
        }
        self.intents.get_mut(&key).ok_or("unknown-intent")?.result = Some(result);
        Ok(())
    }
    pub fn reconcile_inline_completions(&mut self) -> Result<bool, &'static str> {
        let mut completed = Vec::new();
        for intent in self.intents.values() {
            if let Some(result) = &intent.result {
                if intent.completion_is_inline(result)? {
                    completed.push(intent.target.as_ref().ok_or("unassigned-intent")?.clone());
                }
            }
        }
        let mut changed = false;
        for target in completed {
            if let Some(entry) = self.windows.get_mut(&target.scope.key()) {
                if matches!(entry.phase, Phase::Assigned | Phase::Requested)
                    && entry.transition_id == target.transition_id
                    && entry.view_id == target.view_id
                    && entry.label == target.label
                {
                    entry.phase = Phase::TargetReady;
                    changed = true;
                }
            }
        }
        Ok(changed)
    }
    pub fn retire_closed_windows(
        &mut self,
        live: &std::collections::BTreeSet<String>,
    ) -> Result<(), &'static str> {
        if self.windows.len() < MAX_WINDOWS {
            return Ok(());
        }
        if self.intents.values().any(|intent| intent.result.is_some()) {
            self.compact_terminal_intents(Some(self.intent_epoch))?;
        }
        let pending: std::collections::BTreeSet<_> = self
            .intents
            .values()
            .filter(|intent| intent.result.is_none())
            .filter_map(|intent| intent.target.as_ref().map(|target| target.scope.key()))
            .collect();
        self.windows.retain(|key, entry| {
            entry.phase != Phase::TargetReady
                || live.contains(&entry.label)
                || pending.contains(key)
        });
        Ok(())
    }
    pub fn compact_terminal_intents(
        &mut self,
        retire_after: Option<u64>,
    ) -> Result<(), &'static str> {
        if self.intents.len() < MAX_INTENTS && retire_after != Some(self.intent_epoch) {
            return Ok(());
        }
        if self.intent_epoch >= 9_007_199_254_740_991 {
            return Err("native-intent-epoch-exhausted");
        }
        self.intents.retain(|_, intent| intent.result.is_none());
        self.intent_epoch += 1;
        Ok(())
    }
    pub fn pending_intents<'a>(
        &'a self,
        host_id: &'a str,
    ) -> impl Iterator<Item = &'a Intent> + 'a {
        self.intents
            .values()
            .filter(move |intent| intent.result.is_none() && intent.source_scope.host_id == host_id)
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
        if !request_id.starts_with(&format!("{}:", self.intent_epoch)) {
            return Err("native-intent-expired");
        }
        if self.intents.len() == MAX_INTENTS
            || self.pending_intents(&source_scope.host_id).count() >= MAX_PENDING_INTENTS
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
        if let Some(previous) = self.windows.get_mut(&key) {
            if previous.view_id != reservation.view_id {
                return Err("native-binding-mismatch");
            }
            if reservation.creation_agent_id.is_some()
                && previous.creation_agent_id != reservation.creation_agent_id
            {
                return Err("native-creation-agent-mismatch");
            }
            if previous.phase == Phase::Assigned && reservation.phase == Phase::Requested {
                previous.phase = Phase::Requested;
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
        mut reservation: Reservation,
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
        reservation.phase = Phase::Assigned;
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
            intent_epoch: 1,
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
    fn main_carry_notifications_do_not_require_a_child_intent_and_do_not_allocate_one() {
        let p = profile();
        let source = scope("source");
        let target = scope("target");
        assert!(p
            .validate_carry_notification(&source, "1:main-transition", Some(&target))
            .is_ok());
        assert!(p
            .validate_carry_notification(&source, "1:main-transition", None)
            .is_ok());
        assert!(p.intents.is_empty());
        assert!(p.windows.is_empty());
        assert!(p
            .validate_carry_notification(&source, "1:main-transition", Some(&source))
            .is_err());
        assert!(p
            .validate_carry_notification(&source, "1:unknown", Some(&target))
            .is_err());
        assert!(p
            .validate_carry_notification(&source, "0:main-transition", Some(&target))
            .is_err());
        assert!(p
            .validate_carry_notification(&source, "1:main-", Some(&target))
            .is_err());
        let foreign = Scope {
            host_id: "other".into(),
            conversation_id: "target".into(),
        };
        assert!(p
            .validate_carry_notification(&source, "1:main-transition", Some(&foreign))
            .is_err());
    }
    #[test]
    fn interrupted_inline_recovery_replays_its_original_binding_transition() {
        let original = reservation();
        let first = original.inline_recovery("transition").unwrap();
        let mut interrupted = original.clone();
        interrupted.transition_id = first.transition_id.clone();
        interrupted.phase = Phase::Failed;
        let restored: Reservation =
            serde_json::from_slice(&serde_json::to_vec(&interrupted).unwrap()).unwrap();
        for expected in ["transition", restored.transition_id.as_str()] {
            let replay = restored.inline_recovery(expected).unwrap();
            assert_eq!(replay.from_transition_id, "transition");
            assert_eq!(replay.transition_id, first.transition_id);
        }
        assert!(restored.inline_recovery("another-transition").is_err());
    }
    #[test]
    fn assigning_an_intent_does_not_admit_a_native_window_and_reserving_promotes_it() {
        let mut p = profile();
        let source = scope("source");
        p.intent(
            source.clone(),
            "1:allocation".into(),
            Action::Create {
                agent_id: "agent".into(),
                carry: false,
            },
        )
        .unwrap();
        let assigned = p
            .assign_intent(&source, "1:allocation", reservation())
            .unwrap()
            .target
            .unwrap();
        assert_eq!(assigned.phase, Phase::Assigned);
        assert_eq!(p.reserve(reservation()).unwrap().phase, Phase::Requested);
        assert_eq!(p.windows[&scope("target").key()].label, assigned.label);
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
        p.intent(source.clone(), "1:request".into(), action.clone())
            .unwrap();
        p.assign_intent(&source, "1:request", reservation())
            .unwrap();
        let data = serde_json::to_vec(&p).unwrap();
        let mut restored: Profile = serde_json::from_slice(&data).unwrap();
        restored.validate().unwrap();
        let replay = restored
            .intent(source.clone(), "1:request".into(), action)
            .unwrap();
        assert_eq!(replay.target.unwrap().scope, scope("target"));
        assert_eq!(
            restored
                .intent(
                    source,
                    "1:request".into(),
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
                format!("1:{index}"),
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
                "1:extra".into(),
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
            "1:request".into(),
            Action::Create {
                agent_id: "agent".into(),
                carry: false,
            },
        )
        .unwrap();
        let mut target = reservation();
        target.scope.host_id = "foreign".into();
        assert_eq!(
            p.assign_intent(&source, "1:request", target).unwrap_err(),
            "foreign-host"
        );
        p.assign_intent(&source, "1:request", reservation())
            .unwrap();
        p.windows.clear();
        assert_eq!(p.validate().unwrap_err(), "missing-intent-reservation");
    }
    #[test]
    fn full_terminal_history_rotates_its_epoch_without_reallocating_old_or_pending_ids() {
        let mut p = profile();
        let source = scope("source");
        let action = Action::Open {
            scope: scope("target"),
            carry: false,
        };
        p.intent(source.clone(), "1:pending".into(), action.clone())
            .unwrap();
        for n in 0..MAX_INTENTS - 1 {
            let id = format!("1:done-{n}");
            p.intent(source.clone(), id.clone(), action.clone())
                .unwrap();
            p.intents
                .get_mut(&Profile::intent_key(&source, &id))
                .unwrap()
                .result = Some(serde_json::json!({"kind":"refused","reason":"done"}));
        }
        p.compact_terminal_intents(None).unwrap();
        assert_eq!(p.intents.len(), 1);
        assert_eq!(p.intent_epoch, 2);
        assert!(p
            .intent(source.clone(), "1:pending".into(), action.clone())
            .is_ok());
        assert_eq!(
            p.intent(source.clone(), "1:done-0".into(), action.clone())
                .unwrap_err(),
            "native-intent-expired"
        );
        assert!(p.intent(source, "2:fresh".into(), action).is_ok());
        let restored: Profile = serde_json::from_slice(&serde_json::to_vec(&p).unwrap()).unwrap();
        restored.validate().unwrap();
        assert_eq!(restored.intent_epoch, 2);
        p.compact_terminal_intents(Some(2)).unwrap();
        assert_eq!(p.intent_epoch, 3);
        p.compact_terminal_intents(Some(2)).unwrap();
        assert_eq!(p.intent_epoch, 3);
        assert_eq!(p.intents.len(), 2);
    }
    #[test]
    fn closed_ready_window_history_retires_without_removing_live_windows_or_unresolved_targets() {
        let mut p = profile();
        for n in 0..MAX_WINDOWS {
            let mut entry = reservation();
            entry.scope = scope(&format!("window-{n}"));
            entry.view_id = format!("view-{n}");
            entry.label = format!("label-{n}");
            entry.phase = Phase::TargetReady;
            p.reserve(entry).unwrap();
        }
        p.intent(
            scope("source"),
            "1:pending".into(),
            Action::Open {
                scope: scope("window-1"),
                carry: false,
            },
        )
        .unwrap();
        let target = p.windows[&scope("window-1").key()].clone();
        p.assign_intent(&scope("source"), "1:pending", target)
            .unwrap();
        let completed_source = scope("completed-source");
        p.intent(
            completed_source.clone(),
            "1:done".into(),
            Action::Open {
                scope: scope("window-2"),
                carry: false,
            },
        )
        .unwrap();
        let completed_target = p.windows[&scope("window-2").key()].clone();
        p.assign_intent(&completed_source, "1:done", completed_target)
            .unwrap();
        p.intents
            .get_mut(&Profile::intent_key(&completed_source, "1:done"))
            .unwrap()
            .result = Some(
            serde_json::json!({"kind":"detached","scope":scope("window-2"),"label":"label-2"}),
        );
        p.retire_closed_windows(&std::collections::BTreeSet::from(["label-0".into()]))
            .unwrap();
        assert_eq!(p.intent_epoch, 2);
        assert_eq!(
            p.intent(
                completed_source,
                "1:done".into(),
                Action::Open {
                    scope: scope("window-2"),
                    carry: false
                }
            )
            .unwrap_err(),
            "native-intent-expired"
        );
        assert_eq!(p.windows.len(), 2);
        p.validate().unwrap();
        assert!(p.reserve(reservation()).is_ok());
    }
    #[test]
    fn inline_completion_finishes_its_reservation_and_replay_cannot_rewind_a_later_handoff() {
        let mut p = profile();
        let source = scope("source");
        p.intent(
            source.clone(),
            "1:inline".into(),
            Action::Create {
                agent_id: "agent".into(),
                carry: false,
            },
        )
        .unwrap();
        p.assign_intent(&source, "1:inline", reservation()).unwrap();
        let wrong = serde_json::json!({"kind":"inline","scope":scope("wrong")});
        assert_eq!(
            p.complete_intent(&source, "1:inline", wrong).unwrap_err(),
            "intent-result-target-mismatch"
        );
        let result = serde_json::json!({"kind":"inline","scope":scope("target")});
        p.complete_intent(&source, "1:inline", result.clone())
            .unwrap();
        assert_eq!(p.windows[&scope("target").key()].phase, Phase::TargetReady);
        let entry = p.windows.get_mut(&scope("target").key()).unwrap();
        entry.phase = Phase::SourceSaved;
        entry.transition_id = "later-transition".into();
        p.complete_intent(&source, "1:inline", result).unwrap();
        assert_eq!(p.windows[&scope("target").key()].phase, Phase::SourceSaved);
        p.validate().unwrap();
    }
    #[test]
    fn archived_host_intents_do_not_consume_the_current_hosts_pending_budget() {
        let mut p = profile();
        for n in 0..MAX_PENDING_INTENTS {
            p.intent(
                scope("old-source"),
                format!("1:old-{n}"),
                Action::Open {
                    scope: scope("old-target"),
                    carry: false,
                },
            )
            .unwrap();
        }
        let source = Scope {
            host_id: "current-host".into(),
            conversation_id: "source".into(),
        };
        let target = Scope {
            host_id: "current-host".into(),
            conversation_id: "target".into(),
        };
        p.intent(
            source,
            "1:current".into(),
            Action::Open {
                scope: target,
                carry: false,
            },
        )
        .unwrap();
        assert_eq!(p.pending_intents("current-host").count(), 1);
        assert_eq!(p.pending_intents("host").count(), MAX_PENDING_INTENTS);
        p.validate().unwrap();
    }
}

#[cfg(test)]
mod completed_placement_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn completion_is_a_terminal_typed_result_and_survives_optional_roundtrip() {
        for invalid in [
            json!(null),
            json!({"kind":"pending","scope":null,"reason":"waiting"}),
            json!({"kind":"refused","reason":""}),
            json!({"kind":"refused","reason":"no","extra":true}),
        ] {
            assert!(completed_placement(&invalid).is_err());
        }
        let result = json!({"kind":"refused","reason":"Explicit refusal"});
        assert!(completed_placement(&result).is_ok());
        let saved = serde_json::to_string(&Some(result.clone())).unwrap();
        assert_eq!(
            serde_json::from_str::<Option<serde_json::Value>>(&saved).unwrap(),
            Some(result)
        );
    }
}

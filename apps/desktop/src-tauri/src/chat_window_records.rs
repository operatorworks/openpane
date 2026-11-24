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
fn is_false(value: &bool) -> bool {
    !*value
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Open {
        scope: Scope,
        #[serde(default)]
        carry: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        passive: bool,
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
    InlineReady,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentRef {
    pub source_scope: Scope,
    pub request_id: String,
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
    pub fn recover_inline(&mut self, expected: &str) -> Result<InlineRecovery, &'static str> {
        let recovery = self.inline_recovery(expected)?;
        if self.transition_id != recovery.transition_id {
            self.transition_id = recovery.transition_id.clone();
            self.phase = Phase::Failed;
        }
        Ok(recovery)
    }
    pub fn confirm_binding(&mut self, revision: u64, writer: u64) -> Result<(), &'static str> {
        if revision == 0
            || writer == 0
            || revision > 9_007_199_254_740_991
            || writer > 9_007_199_254_740_991
            || self
                .binding_revision
                .is_some_and(|current| revision < current)
            || self
                .writer_generation
                .is_some_and(|current| writer < current)
        {
            return Err("stale-binding-generation");
        }
        self.binding_revision = Some(revision);
        self.writer_generation = Some(writer);
        self.phase = Phase::TargetReady;
        Ok(())
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
        if request_id.split_once(':').is_some_and(|(epoch, request)| {
            !request.is_empty()
                && epoch
                    .parse::<u64>()
                    .is_ok_and(|epoch| epoch > 0 && epoch < self.intent_epoch)
        }) {
            return Ok(());
        }
        // Carries live in IndexedDB; this notification only wakes their fenced writer.
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
        let mut labels = std::collections::BTreeSet::new();
        let mut views = std::collections::BTreeSet::new();
        for (key, value) in &self.windows {
            value.validate()?;
            if !labels.insert(&value.label) || !views.insert(&value.view_id) {
                return Err("native-reservation-collision");
            }
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
        if intent
            .target
            .as_ref()
            .is_some_and(|target| target.phase == Phase::TargetReady)
            && matches!(
                completed_placement(&result)?,
                CompletedPlacement::Refused { .. }
            )
        {
            return Err("confirmed-opening-cannot-be-refused");
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
                entry.phase = Phase::InlineReady;
            }
        }
        self.intents.get_mut(&key).ok_or("unknown-intent")?.result = Some(result);
        Ok(())
    }
    pub fn reconcile_inline_completions(&mut self) -> Result<bool, &'static str> {
        let mut changed = false;
        for entry in self.windows.values_mut() {
            if entry.phase == Phase::TargetReady && entry.transition_id.starts_with("inline:") {
                entry.phase = Phase::InlineReady;
                changed = true;
            }
        }
        for intent in self.intents.values_mut() {
            if let Some(target) = &mut intent.target {
                if target.phase == Phase::TargetReady && target.transition_id.starts_with("inline:")
                {
                    target.phase = Phase::InlineReady;
                    changed = true;
                }
            }
        }
        let mut completed = Vec::new();
        for intent in self.intents.values() {
            if let Some(result) = &intent.result {
                if intent.completion_is_inline(result)? {
                    let target = intent.target.as_ref().ok_or("unassigned-intent")?;
                    if matches!(target.phase, Phase::Assigned | Phase::Requested) {
                        completed.push(target.clone());
                    }
                }
            }
        }
        for target in completed {
            if let Some(entry) = self.windows.get_mut(&target.scope.key()) {
                if matches!(
                    entry.phase,
                    Phase::Assigned | Phase::Requested | Phase::TargetReady
                ) && entry.transition_id == target.transition_id
                    && entry.view_id == target.view_id
                    && entry.label == target.label
                {
                    entry.phase = Phase::InlineReady;
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
            !matches!(
                entry.phase,
                Phase::TargetReady | Phase::InlineReady | Phase::Assigned
            ) || live.contains(&entry.label)
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
    pub fn retry_intent(
        &mut self,
        source: &Scope,
        request_id: &str,
    ) -> Result<Intent, &'static str> {
        let key = Self::intent_key(source, request_id);
        let current = self.intents.get(&key).ok_or("unknown-intent")?;
        if current
            .result
            .as_ref()
            .and_then(|result| result.get("kind"))
            .and_then(serde_json::Value::as_str)
            != Some("refused")
        {
            return Ok(current.clone());
        }
        if self.pending_intents(&source.host_id).count() >= MAX_PENDING_INTENTS {
            return Err("native-intent-capacity");
        }
        let intent = self.intents.get_mut(&key).ok_or("unknown-intent")?;
        intent.result = None;
        Ok(intent.clone())
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
    pub fn guard_intent_placement(
        &self,
        reference: &IntentRef,
        scope: &Scope,
    ) -> Result<(), &'static str> {
        reference.source_scope.validate()?;
        identifier(&reference.request_id, 200)?;
        if reference.source_scope.host_id != scope.host_id {
            return Err("foreign-intent-source");
        }
        let intent = self
            .intents
            .get(&Self::intent_key(
                &reference.source_scope,
                &reference.request_id,
            ))
            .ok_or("unknown-intent")?;
        let target = intent.target.as_ref().ok_or("unassigned-intent")?;
        if target.scope != *scope {
            return Err("intent-target-conflict");
        }
        if target.phase == Phase::TargetReady {
            return Err("intent-already-ready");
        }
        if intent.result.is_some() {
            return Err("intent-already-completed");
        }
        Ok(())
    }
    pub fn preserve_child_ready(&mut self, ready: &Reservation) {
        if ready.phase != Phase::TargetReady {
            return;
        }
        for intent in self
            .intents
            .values_mut()
            .filter(|intent| intent.result.is_none())
        {
            if intent.target.as_ref().is_some_and(|target| {
                target.scope == ready.scope
                    && target.view_id == ready.view_id
                    && target.label == ready.label
                    && target.transition_id == ready.transition_id
            }) {
                intent.target = Some(ready.clone());
            }
        }
    }
    pub fn attach_launched_intents(&mut self, reservation: &Reservation) {
        for intent in self
            .intents
            .values_mut()
            .filter(|intent| intent.result.is_none())
        {
            if intent.target.as_ref().is_some_and(|target| {
                target.phase != Phase::TargetReady
                    && target.scope == reservation.scope
                    && target.view_id == reservation.view_id
                    && target.label == reservation.label
            }) {
                intent.target = Some(reservation.clone());
            }
        }
    }
    pub fn assign_intent(
        &mut self,
        source: &Scope,
        request_id: &str,
        mut reservation: Reservation,
        target_closed: bool,
        current_binding: Option<(&Scope, &str, u64, u64)>,
    ) -> Result<Intent, &'static str> {
        let key = Self::intent_key(source, request_id);
        let previous = self.intents.get(&key).ok_or("unknown-intent")?;
        let passive = matches!(&previous.action, Action::Open { passive: true, .. });
        if let Some(target) = &previous.target {
            return if target.scope == reservation.scope && target.view_id == reservation.view_id {
                Ok(previous.clone())
            } else {
                Err("intent-target-conflict")
            };
        }
        if previous.result.is_some() {
            return Err("intent-already-completed");
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
        let fresh_transition = reservation.transition_id.clone();
        reservation.phase = Phase::Assigned;
        let mut target = self.reserve(reservation)?;
        let reclaimed = current_binding.is_some_and(|(scope, view_id, revision, writer)| {
            scope == &target.scope
                && view_id == target.view_id
                && target
                    .binding_revision
                    .zip(target.writer_generation)
                    .is_some_and(|(saved_revision, saved_writer)| {
                        revision >= saved_revision
                            && writer >= saved_writer
                            && (revision > saved_revision || writer > saved_writer)
                    })
        });
        if target_closed
            && matches!(target.phase, Phase::TargetReady | Phase::InlineReady)
            && !(passive && target.phase == Phase::TargetReady && !reclaimed)
        {
            target.transition_id = fresh_transition;
            target.phase = Phase::Assigned;
        }
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
    fn completed_inline_recovery_replays_without_reopening_its_reservation() {
        let mut entry = reservation();
        let first = entry.recover_inline("transition").unwrap();
        entry.confirm_binding(8, 8).unwrap();
        let replay = entry.recover_inline("transition").unwrap();
        assert_eq!(replay.transition_id, first.transition_id);
        assert_eq!(entry.phase, Phase::TargetReady);
        assert_eq!(entry.binding_revision, Some(8));
    }
    #[test]
    fn child_binding_confirmation_never_regresses() {
        let mut entry = reservation();
        entry.confirm_binding(8, 8).unwrap();
        entry.confirm_binding(8, 8).unwrap();
        assert!(entry.confirm_binding(7, 8).is_err());
        assert!(entry.confirm_binding(8, 7).is_err());
        assert_eq!(entry.binding_revision, Some(8));
        assert_eq!(entry.writer_generation, Some(8));
    }
    #[test]
    fn lost_retry_reply_cannot_reopen_a_completed_success() {
        let mut p = profile();
        let source = scope("source");
        p.intent(
            source.clone(),
            "1:retry".into(),
            Action::Create {
                agent_id: "agent".into(),
                carry: false,
            },
        )
        .unwrap();
        p.complete_intent(
            &source,
            "1:retry",
            serde_json::json!({"kind":"refused","reason":"Try explicitly"}),
        )
        .unwrap();
        assert!(p.retry_intent(&source, "1:retry").unwrap().result.is_none());
        let target = p
            .assign_intent(&source, "1:retry", reservation(), false, None)
            .unwrap()
            .target
            .unwrap();
        let success =
            serde_json::json!({"kind":"detached","scope":target.scope,"label":target.label});
        p.complete_intent(&source, "1:retry", success.clone())
            .unwrap();
        assert_eq!(
            p.retry_intent(&source, "1:retry").unwrap().result,
            Some(success)
        );
        assert_eq!(p.pending_intents("host").count(), 0);
    }
    #[test]
    fn terminal_unassigned_intent_refuses_late_assignment_without_allocating() {
        let mut p = profile();
        let source = scope("source");
        let target = reservation();
        p.intent(
            source.clone(),
            "1:terminal".into(),
            Action::Create {
                agent_id: "agent".into(),
                carry: false,
            },
        )
        .unwrap();
        p.complete_intent(
            &source,
            "1:terminal",
            serde_json::json!({"kind":"refused","reason":"Cancelled before allocation"}),
        )
        .unwrap();
        let before = serde_json::to_value(&p).unwrap();
        assert!(p
            .assign_intent(&source, "1:terminal", target, false, None)
            .is_err());
        assert_eq!(serde_json::to_value(&p).unwrap(), before);
    }
    #[test]
    fn loaded_profile_rejects_duplicate_window_labels_and_view_ids() {
        for duplicate_label in [true, false] {
            let mut p = profile();
            let first = reservation();
            let mut second = first.clone();
            second.scope = scope("second");
            if duplicate_label {
                second.view_id = "other-view".into();
            } else {
                second.label = "other-label".into();
            }
            p.windows.insert(first.scope.key(), first);
            p.windows.insert(second.scope.key(), second);
            assert!(p.validate().is_err(), "duplicate label={duplicate_label}");
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
            .assign_intent(&source, "1:allocation", reservation(), false, None)
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
        p.assign_intent(&source, "1:request", reservation(), false, None)
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
                    passive: false,
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
                    passive: false,
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
            p.assign_intent(&source, "1:request", target, false, None)
                .unwrap_err(),
            "foreign-host"
        );
        p.assign_intent(&source, "1:request", reservation(), false, None)
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
            passive: false,
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
    fn closed_unpromoted_assignments_retire_without_consuming_history_forever() {
        let mut p = profile();
        for n in 0..MAX_WINDOWS {
            let mut entry = reservation();
            entry.scope = scope(&format!("assigned-{n}"));
            entry.view_id = format!("view-{n}");
            entry.label = format!("label-{n}");
            entry.phase = Phase::Assigned;
            p.reserve(entry).unwrap();
        }
        p.retire_closed_windows(&std::collections::BTreeSet::from(["label-0".into()]))
            .unwrap();
        assert_eq!(p.windows.len(), 1);
        assert!(p.windows.values().any(|entry| entry.label == "label-0"));
        let mut next = reservation();
        next.scope = scope("fresh-target");
        p.reserve(next).unwrap();
        assert_eq!(p.windows.len(), 2);
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
                passive: false,
                carry: false,
            },
        )
        .unwrap();
        let target = p.windows[&scope("window-1").key()].clone();
        p.assign_intent(&scope("source"), "1:pending", target, false, None)
            .unwrap();
        let completed_source = scope("completed-source");
        p.intent(
            completed_source.clone(),
            "1:done".into(),
            Action::Open {
                scope: scope("window-2"),
                passive: false,
                carry: false,
            },
        )
        .unwrap();
        let completed_target = p.windows[&scope("window-2").key()].clone();
        p.assign_intent(&completed_source, "1:done", completed_target, false, None)
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
                    passive: false,
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
        p.assign_intent(&source, "1:inline", reservation(), false, None)
            .unwrap();
        let wrong = serde_json::json!({"kind":"inline","scope":scope("wrong")});
        assert_eq!(
            p.complete_intent(&source, "1:inline", wrong).unwrap_err(),
            "intent-result-target-mismatch"
        );
        let result = serde_json::json!({"kind":"inline","scope":scope("target")});
        p.complete_intent(&source, "1:inline", result.clone())
            .unwrap();
        assert_eq!(p.windows[&scope("target").key()].phase, Phase::InlineReady);
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
                    passive: false,
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
                passive: false,
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

#[cfg(test)]
mod readiness_regressions {
    use super::*;
    fn scope(name: &str) -> Scope {
        Scope {
            host_id: "host".into(),
            conversation_id: name.into(),
        }
    }
    fn profile() -> Profile {
        Profile {
            origin: "http://localhost".into(),
            intent_epoch: 1,
            catalog_view_id: "catalog".into(),
            windows: BTreeMap::new(),
            intents: BTreeMap::new(),
        }
    }
    fn ready() -> Reservation {
        Reservation {
            scope: scope("target"),
            view_id: "target-view".into(),
            label: "target-child".into(),
            transition_id: "old-transition".into(),
            creation_agent_id: None,
            phase: Phase::TargetReady,
            binding_revision: Some(2),
            writer_generation: Some(3),
        }
    }
    fn request(p: &mut Profile, id: &str) {
        p.intent(
            scope("source"),
            id.into(),
            Action::Open {
                scope: scope("target"),
                passive: false,
                carry: true,
            },
        )
        .unwrap();
    }
    #[test]
    fn assignment_retains_live_ready_attempt_after_normal_close_and_lost_reply() {
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        request(&mut p, "1:observed");
        let mut proposed = old.clone();
        proposed.transition_id = "unused-transition".into();
        let first = p
            .assign_intent(
                &scope("source"),
                "1:observed",
                proposed.clone(),
                false,
                None,
            )
            .unwrap();
        let replay = p
            .assign_intent(&scope("source"), "1:observed", proposed, true, None)
            .unwrap();
        for intent in [first, replay] {
            let target = intent.target.unwrap();
            assert_eq!(target.transition_id, old.transition_id);
            assert_eq!(target.phase, Phase::TargetReady);
        }
        p.validate().unwrap();
    }
    #[test]
    fn new_explicit_open_after_prior_close_gets_fresh_attempt_and_preserves_old_success() {
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        request(&mut p, "1:prior");
        p.assign_intent(&scope("source"), "1:prior", old.clone(), true, None)
            .unwrap();
        request(&mut p, "1:new-open");
        let mut next = old.clone();
        next.transition_id = "new-transition".into();
        let target = p
            .assign_intent(&scope("source"), "1:new-open", next, true, None)
            .unwrap()
            .target
            .unwrap();
        assert_eq!(target.phase, Phase::Assigned);
        assert_eq!(target.transition_id, "new-transition");
        assert_eq!(target.view_id, old.view_id);
        assert_eq!(target.label, old.label);
        assert!(p.intents[&Profile::intent_key(&scope("source"), "1:prior")]
            .result
            .is_none());
        assert_eq!(p.windows[&old.scope.key()].transition_id, old.transition_id);
        assert_eq!(p.windows[&old.scope.key()].phase, Phase::TargetReady);
        p.validate().unwrap();
    }
    #[test]
    fn passive_closed_assignment_preserves_historical_ready_and_explicit_wire_shape() {
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        let source = scope("passive-source");
        let action: Action = serde_json::from_value(
            serde_json::json!({"kind":"open","scope":old.scope,"carry":false,"passive":true}),
        )
        .unwrap();
        p.intent(source.clone(), "1:passive".into(), action)
            .unwrap();
        let mut proposed = old.clone();
        proposed.transition_id = "unused-fresh-attempt".into();
        let target = p
            .assign_intent(&source, "1:passive", proposed, true, None)
            .unwrap()
            .target
            .unwrap();
        assert_eq!(target.phase, Phase::TargetReady);
        assert_eq!(target.transition_id, old.transition_id);
        assert_eq!(p.windows[&old.scope.key()].transition_id, old.transition_id);
        let serialized = serde_json::to_value(&p).unwrap();
        let key = Profile::intent_key(&source, "1:passive");
        assert_eq!(
            serialized["intents"].get(key.as_str()).unwrap()["action"]["passive"],
            true
        );
        let restored: Profile = serde_json::from_value(serialized).unwrap();
        restored.validate().unwrap();
        let explicit: Action = serde_json::from_value(
            serde_json::json!({"kind":"open","scope":old.scope,"carry":false}),
        )
        .unwrap();
        assert!(serde_json::to_value(explicit)
            .unwrap()
            .get("passive")
            .is_none());
        assert!(serde_json::from_value::<Action>(
            serde_json::json!({"kind":"create","agentId":"agent","carry":false,"passive":true})
        )
        .is_err());
    }
    #[test]
    fn new_closed_assignment_never_inherits_historical_ready() {
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        request(&mut p, "1:new-closed");
        let mut proposed = old.clone();
        proposed.transition_id = "new-closed-transition".into();
        let target = p
            .assign_intent(&scope("source"), "1:new-closed", proposed, true, None)
            .unwrap()
            .target
            .unwrap();
        assert_eq!(target.phase, Phase::Assigned);
        assert_eq!(target.transition_id, "new-closed-transition");
        p.validate().unwrap();
    }
    #[test]
    fn expired_child_carry_wake_preserves_host_and_source_fences_without_allocating() {
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        request(&mut p, "1:child-carry");
        p.assign_intent(&scope("source"), "1:child-carry", old.clone(), true, None)
            .unwrap();
        p.complete_intent(
            &scope("source"),
            "1:child-carry",
            serde_json::json!({"kind":"detached","scope":old.scope,"label":old.label}),
        )
        .unwrap();
        p.compact_terminal_intents(Some(1)).unwrap();
        assert_eq!(p.intent_epoch, 2);
        assert!(p.intents.is_empty());
        let before = serde_json::to_value(&p).unwrap();
        assert!(p
            .validate_carry_notification(&scope("source"), "1:child-carry", Some(&scope("target")))
            .is_ok());
        assert!(p
            .validate_carry_notification(&scope("source"), "1:child-carry", None)
            .is_ok());
        assert!(p
            .validate_carry_notification(&scope("source"), "1:child-carry", Some(&scope("source")))
            .is_err());
        assert!(p
            .validate_carry_notification(
                &scope("source"),
                "1:child-carry",
                Some(&Scope {
                    host_id: "foreign".into(),
                    conversation_id: "target".into()
                })
            )
            .is_err());
        for id in ["2:missing", "3:future", "0:invalid", "1:", "bad:request"] {
            assert!(
                p.validate_carry_notification(&scope("source"), id, Some(&scope("target")))
                    .is_err(),
                "{id}"
            );
        }
        assert_eq!(serde_json::to_value(&p).unwrap(), before);
    }
    #[test]
    fn a_closed_failed_handoff_keeps_its_original_recovery_transition() {
        let mut p = profile();
        let mut prior = ready();
        prior.phase = Phase::Failed;
        p.windows.insert(prior.scope.key(), prior.clone());
        request(&mut p, "1:retry-failed");
        let mut proposed = prior.clone();
        proposed.transition_id = "unused-new-transition".into();
        let target = p
            .assign_intent(&scope("source"), "1:retry-failed", proposed, true, None)
            .unwrap()
            .target
            .unwrap();
        assert_eq!(target.transition_id, prior.transition_id);
        assert_eq!(target.phase, Phase::Failed);
        p.validate().unwrap();
    }
    #[test]
    fn rollover_preserves_unbound_carry_as_pending_ready_evidence_until_main_binds() {
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        request(&mut p, "1:carry");
        let mut allocated = old.clone();
        allocated.phase = Phase::Assigned;
        p.intents
            .get_mut(&Profile::intent_key(&scope("source"), "1:carry"))
            .unwrap()
            .target = Some(allocated);
        p.preserve_child_ready(&old);
        let mut rolled = old.clone();
        rolled.transition_id = "later".into();
        rolled.phase = Phase::Requested;
        p.windows.insert(rolled.scope.key(), rolled.clone());
        let saved = &p.intents[&Profile::intent_key(&scope("source"), "1:carry")];
        assert!(saved.result.is_none());
        assert_eq!(saved.target.as_ref().unwrap().phase, Phase::TargetReady);
        assert_eq!(
            saved.target.as_ref().unwrap().transition_id,
            old.transition_id
        );
        p.validate().unwrap();
        // The next committed launch must not overwrite the old successful attempt.
        p.attach_launched_intents(&rolled);
        assert_eq!(
            p.intents[&Profile::intent_key(&scope("source"), "1:carry")]
                .target
                .as_ref()
                .unwrap()
                .transition_id,
            old.transition_id
        );
    }
    #[test]
    fn inline_completion_with_inherited_counters_never_confirms_another_child_opening() {
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        request(&mut p, "1:first");
        request(&mut p, "1:second");
        let mut proposal = old.clone();
        proposal.transition_id = "placeholder".into();
        p.assign_intent(&scope("source"), "1:first", proposal.clone(), true, None)
            .unwrap();
        p.assign_intent(&scope("source"), "1:second", proposal, true, None)
            .unwrap();
        let mut launched = old.clone();
        launched.transition_id = "actual-new-attempt".into();
        launched.phase = Phase::Requested;
        p.windows.insert(launched.scope.key(), launched.clone());
        p.attach_launched_intents(&launched);
        p.complete_intent(
            &scope("source"),
            "1:first",
            serde_json::json!({"kind":"inline","scope":old.scope}),
        )
        .unwrap();
        let inline = p.windows[&old.scope.key()].clone();
        assert_eq!(inline.phase, Phase::InlineReady);
        assert_eq!(inline.binding_revision, old.binding_revision);
        assert_eq!(inline.writer_generation, old.writer_generation);
        p.preserve_child_ready(&inline);
        let second = &p.intents[&Profile::intent_key(&scope("source"), "1:second")];
        assert!(second.result.is_none());
        assert_ne!(second.target.as_ref().unwrap().phase, Phase::TargetReady);
        p.windows
            .get_mut(&old.scope.key())
            .unwrap()
            .confirm_binding(4, 5)
            .unwrap();
        let ready = p.windows[&old.scope.key()].clone();
        p.preserve_child_ready(&ready);
        assert_eq!(
            p.intents[&Profile::intent_key(&scope("source"), "1:second")]
                .target
                .as_ref()
                .unwrap()
                .phase,
            Phase::TargetReady
        );
        p.validate().unwrap();
    }
    #[test]
    fn legacy_inline_bootstrap_completion_repairs_phase_without_inventing_child_readiness() {
        let mut p = profile();
        let mut allocated = ready();
        allocated.phase = Phase::Assigned;
        p.windows.insert(allocated.scope.key(), allocated.clone());
        for id in ["1:inline-old", "1:pending-old"] {
            request(&mut p, id);
            p.assign_intent(&scope("source"), id, allocated.clone(), false, None)
                .unwrap();
        }
        p.intents
            .get_mut(&Profile::intent_key(&scope("source"), "1:inline-old"))
            .unwrap()
            .result = Some(serde_json::json!({"kind":"inline","scope":allocated.scope}));
        p.windows.get_mut(&allocated.scope.key()).unwrap().phase = Phase::TargetReady;
        assert!(p.reconcile_inline_completions().unwrap());
        assert_eq!(p.windows[&allocated.scope.key()].phase, Phase::InlineReady);
        assert_eq!(
            p.intents[&Profile::intent_key(&scope("source"), "1:pending-old")]
                .target
                .as_ref()
                .unwrap()
                .phase,
            Phase::Assigned
        );
        let entry = p.windows.get_mut(&allocated.scope.key()).unwrap();
        entry.transition_id = "new-real-child".into();
        entry.confirm_binding(5, 6).unwrap();
        assert!(!p.reconcile_inline_completions().unwrap());
        assert_eq!(p.windows[&allocated.scope.key()].phase, Phase::TargetReady);
        assert_eq!(
            p.windows[&allocated.scope.key()].transition_id,
            "new-real-child"
        );
    }
    #[test]
    fn inline_recovery_of_one_request_never_erases_another_actual_ready_snapshot() {
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        for id in ["1:recover-inline", "1:still-pending"] {
            request(&mut p, id);
            p.assign_intent(&scope("source"), id, old.clone(), false, None)
                .unwrap();
        }
        p.windows
            .get_mut(&old.scope.key())
            .unwrap()
            .recover_inline("old-transition")
            .unwrap();
        p.windows.get_mut(&old.scope.key()).unwrap().phase = Phase::InlineReady;
        p.complete_intent(
            &scope("source"),
            "1:recover-inline",
            serde_json::json!({"kind":"inline","scope":old.scope}),
        )
        .unwrap();
        let mut restarted: Profile =
            serde_json::from_slice(&serde_json::to_vec(&p).unwrap()).unwrap();
        restarted.reconcile_inline_completions().unwrap();
        let pending = &restarted.intents[&Profile::intent_key(&scope("source"), "1:still-pending")];
        assert!(pending.result.is_none());
        assert_eq!(pending.target.as_ref().unwrap().phase, Phase::TargetReady);
        assert_eq!(
            pending.target.as_ref().unwrap().transition_id,
            old.transition_id
        );
        assert_eq!(
            restarted.windows[&old.scope.key()].phase,
            Phase::InlineReady
        );
        restarted.validate().unwrap();
    }
    #[test]
    fn confirmed_child_opening_cannot_be_revoked_by_late_local_or_metadata_failure() {
        for carry in [false, true] {
            for retry_legacy_refusal in [false, true] {
                let mut p = profile();
                let old = ready();
                p.windows.insert(old.scope.key(), old.clone());
                p.intent(
                    scope("source"),
                    "1:known-opening".into(),
                    Action::Open {
                        scope: old.scope.clone(),
                        passive: false,
                        carry,
                    },
                )
                .unwrap();
                p.assign_intent(
                    &scope("source"),
                    "1:known-opening",
                    old.clone(),
                    false,
                    None,
                )
                .unwrap();
                let refusal = serde_json::json!({"kind":"refused","reason":"Metadata disconnected after the child was ready"});
                if retry_legacy_refusal {
                    p.intents
                        .get_mut(&Profile::intent_key(&scope("source"), "1:known-opening"))
                        .unwrap()
                        .result = Some(refusal.clone());
                    p.retry_intent(&scope("source"), "1:known-opening").unwrap();
                }
                let before = serde_json::to_value(&p).unwrap();
                assert_eq!(
                    p.complete_intent(&scope("source"), "1:known-opening", refusal),
                    Err("confirmed-opening-cannot-be-refused")
                );
                assert_eq!(serde_json::to_value(&p).unwrap(), before);
                assert!(
                    p.intents[&Profile::intent_key(&scope("source"), "1:known-opening")]
                        .result
                        .is_none()
                );
                p.complete_intent(
                    &scope("source"),
                    "1:known-opening",
                    serde_json::json!({"kind":"detached","scope":old.scope,"label":old.label}),
                )
                .unwrap();
                p.validate().unwrap();
            }
        }
    }
}

#[cfg(test)]
mod passive_reclaim_tests {
    use super::*;
    fn scope(id: &str) -> Scope {
        Scope {
            host_id: "host".into(),
            conversation_id: id.into(),
        }
    }
    fn ready() -> Reservation {
        Reservation {
            scope: scope("target"),
            view_id: "target-view".into(),
            label: "target-child".into(),
            transition_id: "historical-ready".into(),
            creation_agent_id: None,
            phase: Phase::TargetReady,
            binding_revision: Some(2),
            writer_generation: Some(3),
        }
    }
    fn profile() -> Profile {
        Profile {
            origin: "http://localhost".into(),
            intent_epoch: 1,
            catalog_view_id: "catalog".into(),
            windows: BTreeMap::new(),
            intents: BTreeMap::new(),
        }
    }
    fn request(p: &mut Profile, id: &str, passive: bool) {
        p.intent(
            scope("source"),
            id.into(),
            Action::Open {
                scope: scope("target"),
                passive,
                carry: false,
            },
        )
        .unwrap();
    }
    #[test]
    fn fresh_passive_assignment_requires_a_strictly_newer_matching_inline_writer() {
        for (revision, writer, binding_scope, view, fresh) in [
            (0, 0, "target", "target-view", false),
            (2, 3, "target", "target-view", false),
            (1, 2, "target", "target-view", false),
            (3, 3, "target", "target-view", true),
            (2, 4, "target", "target-view", true),
            (3, 4, "target", "target-view", true),
            (3, 2, "target", "target-view", false),
            (1, 4, "target", "target-view", false),
            (3, 4, "other", "target-view", false),
            (3, 4, "target", "other-view", false),
        ] {
            let mut p = profile();
            let old = ready();
            p.windows.insert(old.scope.key(), old.clone());
            request(&mut p, "1:fresh", true);
            let mut proposed = old.clone();
            proposed.transition_id = "fresh-passive".into();
            let observed_scope = scope(binding_scope);
            let hint = (revision != 0).then_some((&observed_scope, view, revision, writer));
            let target = p
                .assign_intent(&scope("source"), "1:fresh", proposed, true, hint)
                .unwrap()
                .target
                .unwrap();
            assert_eq!(
                target.phase,
                if fresh {
                    Phase::Assigned
                } else {
                    Phase::TargetReady
                },
                "{revision}/{writer}/{binding_scope}/{view}"
            );
            assert_eq!(
                target.transition_id,
                if fresh {
                    "fresh-passive"
                } else {
                    "historical-ready"
                }
            );
            assert_eq!(
                serde_json::to_value(&p.windows[&old.scope.key()]).unwrap(),
                serde_json::to_value(&old).unwrap()
            );
            p.validate().unwrap();
        }
    }
    #[test]
    fn ready_after_binding_preflight_and_attached_ready_never_get_reassigned() {
        let mut p = profile();
        let mut current = ready();
        current.confirm_binding(3, 4).unwrap();
        p.windows.insert(current.scope.key(), current.clone());
        request(&mut p, "1:raced", true);
        let mut proposed = current.clone();
        proposed.transition_id = "must-not-replace-raced-ready".into();
        let target_scope = scope("target");
        let first = p
            .assign_intent(
                &scope("source"),
                "1:raced",
                proposed.clone(),
                true,
                Some((&target_scope, "target-view", 2, 3)),
            )
            .unwrap();
        let replay = p
            .assign_intent(
                &scope("source"),
                "1:raced",
                proposed,
                true,
                Some((&target_scope, "target-view", 99, 99)),
            )
            .unwrap();
        for intent in [first, replay] {
            let target = intent.target.unwrap();
            assert_eq!(target.phase, Phase::TargetReady);
            assert_eq!(target.transition_id, "historical-ready");
            assert_eq!(target.binding_revision, Some(3));
            assert_eq!(target.writer_generation, Some(4));
        }
        p.validate().unwrap();
    }
    #[test]
    fn live_passive_and_closed_inline_ready_preserve_their_existing_assignment_rules() {
        for (closed, inline) in [(false, false), (true, true)] {
            let mut p = profile();
            let mut old = ready();
            if inline {
                old.phase = Phase::InlineReady;
            }
            p.windows.insert(old.scope.key(), old.clone());
            request(&mut p, "1:control", true);
            let mut proposed = old.clone();
            proposed.transition_id = "fresh-inline-control".into();
            let target_scope = scope("target");
            let target = p
                .assign_intent(
                    &scope("source"),
                    "1:control",
                    proposed,
                    closed,
                    Some((&target_scope, "target-view", 3, 4)),
                )
                .unwrap()
                .target
                .unwrap();
            assert_eq!(
                target.phase,
                if inline {
                    Phase::Assigned
                } else {
                    Phase::TargetReady
                }
            );
            p.validate().unwrap();
        }
        let mut p = profile();
        let old = ready();
        p.windows.insert(old.scope.key(), old.clone());
        request(&mut p, "1:explicit", false);
        let mut proposed = old;
        proposed.transition_id = "fresh-explicit-control".into();
        let target = p
            .assign_intent(&scope("source"), "1:explicit", proposed, true, None)
            .unwrap()
            .target
            .unwrap();
        assert_eq!(target.phase, Phase::Assigned);
        assert_eq!(target.transition_id, "fresh-explicit-control");
        p.validate().unwrap();
    }
}

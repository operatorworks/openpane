mod intents;
mod types;
mod ui;
pub use types::Command;
use types::UiRecoveryContext;

use crate::chat_window_records::{
    identifier, Action, Intent, IntentRef, Phase, Reservation, Scope, MAX_SAFE_INTEGER,
};
use crate::chat_window_storage::{random_id, Storage};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Mutex};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    nonce: String,
    incarnation: String,
    scope: Option<Scope>,
    view_id: String,
    visible: bool,
    presence_sequence: u64,
    display: Option<Value>,
    ready: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingClose {
    attempt_id: String,
    independent: bool,
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RecoveryAdmission {
    Accepted,
    Superseded,
    Cancelled,
}
struct PendingRecovery {
    sequence: u64,
    initiator: Option<String>,
    context: Option<UiRecoveryContext>,
}
struct RecoveryFloor {
    context: UiRecoveryContext,
    delivery_generation: u64,
}
struct Broker {
    storage: Storage,
    presence_clock: u64,
    documents: BTreeMap<String, Document>,
    opening: BTreeMap<String, Scope>,
    host: Option<UiRecoveryContext>,
    snapshot: Option<Value>,
    reports: BTreeMap<String, Value>,
    child_snapshots: BTreeMap<String, Value>,
    recovery: Option<PendingRecovery>,
    recovery_sequence: u64,
    recovery_cancelled_through: u64,
    recovery_floor: Option<RecoveryFloor>,
    main_closing: bool,
    main_close_requested: bool,
    close_sequence: u64,
    pending_closes: BTreeMap<String, PendingClose>,
}
#[derive(Debug, PartialEq, Eq)]
enum CloseProgress {
    Idle,
    RequestMain,
    Quit,
}
fn apply_close_progress(app: &tauri::AppHandle, progress: CloseProgress) {
    match progress {
        CloseProgress::Idle => {}
        CloseProgress::RequestMain => {
            let _ = app.emit_to("main", "openpane-close-requested", ());
        }
        CloseProgress::Quit => app.exit(0),
    }
}
impl Broker {
    fn abandon_unregistered_openings(&mut self) -> Vec<String> {
        let abandoned: Vec<_> = self
            .opening
            .keys()
            .filter(|label| !self.documents.contains_key(*label))
            .cloned()
            .collect();
        for label in &abandoned {
            self.opening.remove(label);
        }
        abandoned
    }
    fn bind_host(&mut self, host_id: String, profile_id: String) -> Result<(), &'static str> {
        let context = UiRecoveryContext {
            host_id,
            profile_id,
        };
        let changed = self
            .host
            .as_ref()
            .is_some_and(|previous| previous != &context);
        if changed {
            if self.children_open() {
                return Err("host-change-with-live-children");
            }
            self.snapshot = None;
            self.child_snapshots.clear();
            self.reports.clear();
        }
        if changed
            || self
                .recovery
                .as_ref()
                .and_then(|pending| pending.context.as_ref())
                .is_some_and(|saved| saved != &context)
        {
            self.recovery_cancelled_through = self.recovery_sequence;
            self.recovery = None;
        }
        if let Some(pending) = &mut self.recovery {
            pending.context.get_or_insert(context.clone());
        }
        if self
            .recovery_floor
            .as_ref()
            .is_some_and(|floor| floor.context != context)
        {
            self.recovery_floor = None;
        }
        self.host = Some(context);
        Ok(())
    }
    fn require_recovery_context(&self, expected: &UiRecoveryContext) -> Result<(), &'static str> {
        if self.host.as_ref() != Some(expected) {
            return Err("wrong-host");
        }
        Ok(())
    }
    fn request_restore(
        &mut self,
        expected_context: Option<&UiRecoveryContext>,
        initiator: Option<String>,
    ) -> Result<(), &'static str> {
        if let Some(expected) = expected_context {
            self.require_recovery_context(expected)?;
        }
        self.recovery_sequence = self
            .recovery_sequence
            .checked_add(1)
            .ok_or("recovery-sequence-exhausted")?;
        self.recovery = Some(PendingRecovery {
            sequence: self.recovery_sequence,
            context: self.host.clone(),
            initiator,
        });
        Ok(())
    }
    fn recovery_cancelled(&self, sequence: u64) -> Result<bool, &'static str> {
        if sequence == 0 || sequence > self.recovery_sequence {
            return Err("unknown-recovery");
        }
        Ok(sequence <= self.recovery_cancelled_through)
    }
    fn scope_recovery(
        &mut self,
        sequence: u64,
        expected: UiRecoveryContext,
        submitted: bool,
    ) -> Result<RecoveryAdmission, &'static str> {
        let cancelled = self.recovery_cancelled(sequence)?;
        if self.host.as_ref().is_some_and(|bound| bound != &expected) {
            return Err("wrong-host");
        }
        if !submitted && cancelled {
            return Ok(RecoveryAdmission::Cancelled);
        }
        if let Some(pending) = self
            .recovery
            .as_mut()
            .filter(|pending| pending.sequence == sequence)
        {
            if pending
                .context
                .as_ref()
                .is_some_and(|saved| saved != &expected)
            {
                return Err("wrong-host");
            }
            pending.context = Some(expected);
            return Ok(RecoveryAdmission::Accepted);
        }
        if submitted {
            return Ok(RecoveryAdmission::Accepted);
        }
        if self.recovery.as_ref().is_some_and(|pending| {
            pending.sequence > sequence
                && pending
                    .context
                    .as_ref()
                    .is_none_or(|context| context == &expected)
        }) {
            return Ok(RecoveryAdmission::Superseded);
        }
        Ok(RecoveryAdmission::Cancelled)
    }
    fn bound_recovery_floor(&self) -> Option<u64> {
        self.recovery_floor
            .as_ref()
            .filter(|floor| self.host.as_ref() == Some(&floor.context))
            .map(|floor| floor.delivery_generation)
    }
    fn visual_builtin(&self) -> bool {
        self.recovery.is_some() || self.snapshot.is_none() && self.bound_recovery_floor().is_some()
    }
    fn recovery_state(&self) -> Value {
        json!({"pending":self.recovery.is_some(),"sequence":self.recovery_sequence,"initiator":self.recovery.as_ref().and_then(|pending|pending.initiator.as_deref()),"hostId":self.recovery_context().map(|context| &context.host_id),"profileId":self.recovery_context().map(|context| &context.profile_id)})
    }
    fn recovery_context(&self) -> Option<&UiRecoveryContext> {
        self.recovery
            .as_ref()
            .and_then(|pending| pending.context.as_ref())
    }
    fn confirm_restore(
        &mut self,
        sequence: u64,
        delivery_generation: u64,
        expected: UiRecoveryContext,
    ) -> Result<bool, &'static str> {
        if self.host.as_ref().is_some_and(|bound| bound != &expected) {
            return Err("wrong-host");
        }
        let Some(pending) = self
            .recovery
            .as_ref()
            .filter(|pending| pending.sequence == sequence)
        else {
            return Ok(false);
        };
        if pending.context.as_ref() != Some(&expected) {
            return Err("unscoped-recovery");
        }
        self.recovery = None;
        let generation = self
            .recovery_floor
            .as_ref()
            .filter(|floor| floor.context == expected)
            .map_or(delivery_generation, |floor| {
                floor.delivery_generation.max(delivery_generation)
            });
        self.recovery_floor = Some(RecoveryFloor {
            context: expected,
            delivery_generation: generation,
        });
        if self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.pointer("/selection/deliveryGeneration"))
            .and_then(Value::as_u64)
            .is_none_or(|cached| cached < generation)
        {
            self.snapshot = None;
            self.child_snapshots.clear();
        }
        Ok(true)
    }
    fn notify_child_cache(&self, app: &tauri::AppHandle) {
        for target in self
            .documents
            .keys()
            .filter(|target| target.as_str() != "main")
        {
            let _ = app.emit_to(target, "openpane-ui-cache", ());
        }
    }

    fn publish_snapshot(
        &mut self,
        snapshot: Value,
        children: BTreeMap<String, Value>,
    ) -> Result<bool, &'static str> {
        let generation = snapshot
            .pointer("/selection/deliveryGeneration")
            .and_then(Value::as_u64)
            .ok_or("invalid-ui-state")?;
        let floor = self.bound_recovery_floor().unwrap_or(0);
        if generation < floor {
            return Ok(false);
        }
        self.child_snapshots = children;
        self.snapshot = Some(snapshot);
        Ok(true)
    }

    fn document_ready(&self, reservation: &Reservation) -> bool {
        self.documents
            .get(&reservation.label)
            .is_some_and(|document| {
                document.ready
                    && document.scope.as_ref() == Some(&reservation.scope)
                    && document.view_id == reservation.view_id
            })
    }
    fn lookup_window(&self, origin: &str, scope: &Scope) -> Result<Value, &'static str> {
        let Some(reservation) = self.storage.profile(origin)?.windows.get(&scope.key()) else {
            return Ok(json!({"kind":"absent"}));
        };
        let ready = self.document_ready(reservation);
        let kind = if ready {
            "ready"
        } else if self.opening.contains_key(&reservation.label)
            || self.documents.contains_key(&reservation.label)
        {
            "opening"
        } else {
            "closed"
        };
        Ok(json!({"kind":kind,"reservation":reservation}))
    }
    fn children_open(&self) -> bool {
        !self.opening.is_empty() || self.documents.keys().any(|label| label != "main")
    }
    fn is_chat(&self, label: &str) -> bool {
        label != "main"
            && (self.opening.contains_key(label)
                || self
                    .documents
                    .get(label)
                    .is_some_and(|document| document.scope.is_some()))
    }
    fn request_close(&mut self, label: &str) -> Result<(), &'static str> {
        if !self.pending_closes.contains_key(label) {
            self.close_sequence = self
                .close_sequence
                .checked_add(1)
                .ok_or("close-sequence-exhausted")?;
            self.pending_closes.insert(
                label.into(),
                PendingClose {
                    attempt_id: self.close_sequence.to_string(),
                    independent: false,
                },
            );
        }
        Ok(())
    }
    fn close_progress(&mut self) -> Result<CloseProgress, &'static str> {
        if !self.main_closing || self.children_open() {
            return Ok(CloseProgress::Idle);
        }
        if self.documents.is_empty() {
            return Ok(CloseProgress::Quit);
        }
        if self.main_close_requested {
            return Ok(CloseProgress::Idle);
        }
        self.main_close_requested = true;
        self.request_close("main")?;
        Ok(CloseProgress::RequestMain)
    }
    fn begin_close(&mut self, label: &str) -> Result<Vec<String>, &'static str> {
        if label != "main" {
            self.request_close(label)?;
            if let Some(pending) = self.pending_closes.get_mut(label) {
                pending.independent = true;
            }
            return Ok(vec![label.into()]);
        }
        self.main_closing = true;
        let labels: std::collections::BTreeSet<_> = self
            .documents
            .keys()
            .chain(self.opening.keys())
            .filter(|label| label.as_str() != "main")
            .cloned()
            .collect();
        if labels.is_empty() {
            self.main_close_requested = true;
            self.request_close("main")?;
            return Ok(vec!["main".into()]);
        }
        for target in &labels {
            self.request_close(target)?;
        }
        Ok(labels.into_iter().collect())
    }
    fn cancel_close(&mut self) {
        self.main_closing = false;
        self.main_close_requested = false;
        self.pending_closes.retain(|_, pending| pending.independent);
    }
    fn cancel_close_for(&mut self, label: &str, attempt_id: &str) -> Result<(), &'static str> {
        self.authorize_close(label, attempt_id)?;
        if self.main_closing {
            self.cancel_close();
        }
        self.pending_closes.remove(label);
        Ok(())
    }
    fn authorize_close(&self, label: &str, attempt_id: &str) -> Result<(), &'static str> {
        if self
            .pending_closes
            .get(label)
            .is_some_and(|current| current.attempt_id == attempt_id)
        {
            Ok(())
        } else {
            Err("close-request-cancelled")
        }
    }
    fn finish_close(&mut self, label: &str) -> Result<CloseProgress, &'static str> {
        if label == "main" && self.children_open() {
            return Err("children-still-saving");
        }
        self.documents.remove(label);
        self.opening.remove(label);
        self.pending_closes.remove(label);
        if label == "main" {
            self.main_closing = true;
        }
        self.close_progress()
    }
    fn advance_presence(&mut self, label: &str) -> Result<u64, &'static str> {
        if self.presence_clock >= MAX_SAFE_INTEGER {
            return Err("presence-sequence-exhausted");
        }
        self.presence_clock += 1;
        self.documents
            .get_mut(label)
            .ok_or("stale-document")?
            .presence_sequence = self.presence_clock;
        Ok(self.presence_clock)
    }
}
pub struct ChatWindows {
    target: Option<tauri::Url>,
    origin: String,
    instance: String,
    live_relay: bool,
    broker: Mutex<Result<Broker, &'static str>>,
}
impl ChatWindows {
    pub fn new(target: Option<tauri::Url>, directory: &Path, live_relay: bool) -> Self {
        let origin = target
            .as_ref()
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_default();
        let broker = if target.is_none() {
            Err("bundled-inline-only")
        } else {
            Storage::open(directory).and_then(|mut storage| {
                storage.ensure_profile(&origin)?;
                Ok(Broker {
                    storage,
                    presence_clock: 0,
                    documents: BTreeMap::new(),
                    opening: BTreeMap::new(),
                    host: None,
                    snapshot: None,
                    reports: BTreeMap::new(),
                    child_snapshots: BTreeMap::new(),
                    recovery: None,
                    recovery_sequence: 0,
                    recovery_cancelled_through: 0,
                    recovery_floor: None,
                    main_closing: false,
                    main_close_requested: false,
                    close_sequence: 0,
                    pending_closes: BTreeMap::new(),
                })
            })
        };
        Self {
            target,
            origin,
            instance: random_id().unwrap_or_default(),
            live_relay,
            broker: Mutex::new(broker),
        }
    }
    fn admitted(&self, label: &str, url: &tauri::Url, broker: &Broker) -> bool {
        self.target.as_ref() == Some(url) && (label == "main" || broker.opening.contains_key(label))
    }
    fn document<'a>(
        &self,
        broker: &'a Broker,
        label: &str,
        incarnation: &str,
    ) -> Result<&'a Document, &'static str> {
        broker
            .documents
            .get(label)
            .filter(|document| document.incarnation == incarnation)
            .ok_or("stale-document")
    }
    fn context(&self, broker: &Broker, label: &str, document: &Document) -> Option<Value> {
        let UiRecoveryContext {
            host_id,
            profile_id,
        } = broker.host.as_ref()?;
        let mut context = json!({"role": if document.scope.is_some() {"chat"} else {"main"}, "hostId":host_id,"profileId":profile_id,
            "brokerInstance":self.instance,"label":label,"documentIncarnation":document.incarnation,"viewId":document.view_id});
        if let Some(scope) = &document.scope {
            context["scope"] = json!(scope);
        }
        Some(context)
    }
    fn require_main(
        &self,
        broker: &Broker,
        label: &str,
        incarnation: &str,
    ) -> Result<(), &'static str> {
        self.document(broker, label, incarnation)?;
        if label != "main" {
            return Err("main-only");
        }
        Ok(())
    }
    fn require_host(&self, broker: &Broker, scope: &Scope) -> Result<(), &'static str> {
        if broker.host.as_ref().ok_or("ui-context-not-bound")?.host_id != scope.host_id {
            return Err("foreign-host");
        }
        Ok(())
    }
    fn admit_child(
        &self,
        broker: &Broker,
        scope: &Scope,
        intent_ref: Option<&IntentRef>,
    ) -> Result<(), &'static str> {
        if let Some(reference) = intent_ref {
            self.require_host(broker, &reference.source_scope)?;
            broker
                .storage
                .profile(&self.origin)?
                .guard_intent_placement(reference, scope)?;
        }

        if broker.main_closing {
            return Err("main-unavailable");
        }
        self.require_host(broker, scope)?;
        let mut scopes: std::collections::BTreeSet<_> =
            broker.opening.values().map(Scope::key).collect();
        scopes.extend(
            broker
                .documents
                .values()
                .filter_map(|document| document.scope.as_ref().map(Scope::key)),
        );
        scopes.extend(
            broker
                .storage
                .profile(&self.origin)?
                .windows
                .values()
                .filter(|entry| {
                    entry.scope.host_id == scope.host_id
                        && !matches!(
                            entry.phase,
                            Phase::Assigned
                                | Phase::TargetReady
                                | Phase::InlineReady
                                | Phase::Failed
                        )
                })
                .map(|entry| entry.scope.key()),
        );
        if !scopes.contains(&scope.key()) && scopes.len() >= 32 {
            return Err("native-window-limit");
        }
        Ok(())
    }
    fn retire_window_history(
        &self,
        broker: &mut Broker,
        scope: &Scope,
    ) -> Result<(), &'static str> {
        let profile = broker.storage.profile(&self.origin)?;
        if profile.windows.contains_key(&scope.key())
            || profile.windows.len() < crate::chat_window_records::MAX_WINDOWS
        {
            return Ok(());
        }
        let live = broker
            .opening
            .keys()
            .chain(broker.documents.keys())
            .cloned()
            .collect();
        broker
            .storage
            .mutate(&self.origin, |profile| profile.retire_closed_windows(&live))
    }
    fn cancel_reservation(
        &self,
        broker: &mut Broker,
        scope: &Scope,
        transition_id: &str,
        previous: Option<&Reservation>,
    ) -> Result<bool, &'static str> {
        if broker.opening.values().any(|live| live == scope)
            || broker
                .documents
                .values()
                .any(|document| document.scope.as_ref() == Some(scope))
        {
            return Ok(false);
        }
        broker.storage.mutate(&self.origin, |profile| {
            let eligible = profile.windows.get(&scope.key()).is_some_and(|entry| {
                entry.scope == *scope
                    && entry.transition_id == transition_id
                    && entry.phase == Phase::Requested
                    && match previous {
                        None => {
                            entry.binding_revision.is_none() && entry.writer_generation.is_none()
                        }
                        Some(prior) => {
                            matches!(
                                prior.phase,
                                Phase::TargetReady | Phase::InlineReady | Phase::Failed
                            ) && prior.transition_id != entry.transition_id
                                && prior.scope == entry.scope
                                && prior.view_id == entry.view_id
                                && prior.label == entry.label
                                && prior.creation_agent_id == entry.creation_agent_id
                                && prior.binding_revision == entry.binding_revision
                                && prior.writer_generation == entry.writer_generation
                        }
                    }
            }) && !profile.intents.values().any(|intent| {
                intent.target.as_ref().is_some_and(|target| {
                    target.scope == *scope && target.transition_id == transition_id
                })
            });
            if eligible {
                if let Some(prior) = previous {
                    profile.windows.insert(scope.key(), prior.clone());
                } else {
                    profile.windows.remove(&scope.key());
                }
            }
            Ok(eligible)
        })
    }
    fn reserve(
        &self,
        broker: &mut Broker,
        scope: Scope,
        view_id: String,
        creation_agent_id: Option<String>,
        new_transition: bool,
        intent_ref: Option<&IntentRef>,
    ) -> Result<Reservation, &'static str> {
        self.admit_child(broker, &scope, intent_ref)?;
        self.retire_window_history(broker, &scope)?;
        let reservation = Reservation {
            scope,
            view_id,
            creation_agent_id,
            label: format!("chat-{}", random_id()?),
            transition_id: random_id()?,
            phase: Phase::Requested,
            binding_revision: None,
            writer_generation: None,
        };
        let live = broker
            .opening
            .values()
            .any(|scope| scope == &reservation.scope)
            || broker
                .documents
                .values()
                .any(|document| document.scope.as_ref() == Some(&reservation.scope));
        broker.storage.mutate(&self.origin, |profile| {
            let key = reservation.scope.key();
            let mut reserved = profile.reserve(reservation)?;
            if new_transition
                && matches!(
                    reserved.phase,
                    Phase::TargetReady | Phase::InlineReady | Phase::Failed
                )
            {
                if live {
                    return Err("target-still-open");
                }
                profile.preserve_child_ready(&reserved);
                reserved.transition_id = random_id()?;
                reserved.phase = Phase::Requested;
                profile.windows.insert(key, reserved.clone());
            }
            Ok(reserved)
        })
    }
    pub fn restore_builtin(&self, app: &tauri::AppHandle) -> Result<(), &'static str> {
        let mut guard = self
            .broker
            .lock()
            .map_err(|_| "native-broker-unavailable")?;
        let broker = guard.as_mut().map_err(|error| *error)?;
        broker.request_restore(None, None)?;
        for label in broker.documents.keys() {
            let _ = app.emit_to(label, "openpane-ui-wakeup", ());
        }
        Ok(())
    }
    pub fn close_requested(&self, app: &tauri::AppHandle, label: &str) -> bool {
        if let Ok(mut guard) = self.broker.lock() {
            if let Ok(broker) = guard.as_mut() {
                let abandoned = if label == "main" {
                    broker.abandon_unregistered_openings()
                } else {
                    Vec::new()
                };
                let Ok(labels) = broker.begin_close(label) else {
                    return true;
                };
                let quit =
                    broker.main_closing && broker.documents.is_empty() && broker.opening.is_empty();
                let unregistered = label != "main" && !broker.documents.contains_key(label);
                drop(guard);
                for target in &abandoned {
                    if let Some(window) = app.get_webview_window(target) {
                        let _ = window.destroy();
                    }
                }
                if quit {
                    app.exit(0);
                    return true;
                }
                if unregistered {
                    if let Some(window) = app.get_webview_window(label) {
                        let _ = window.destroy();
                    }
                    return true;
                }
                for target in labels {
                    let _ = app.emit_to(&target, "openpane-close-requested", ());
                }
                return true;
            }
        }
        false
    }
    pub fn close_chat_without_saving(&self, app: &tauri::AppHandle, label: &str) {
        let eligible = self
            .broker
            .lock()
            .ok()
            .is_some_and(|guard| guard.as_ref().is_ok_and(|broker| broker.is_chat(label)));
        if !eligible {
            return;
        }
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
    pub fn navigating(&self, app: &tauri::AppHandle, label: &str) {
        if let Ok(mut guard) = self.broker.lock() {
            if let Ok(broker) = guard.as_mut() {
                if label == "main" {
                    broker.cancel_close();
                }
                if let Some(old) = broker.documents.remove(label) {
                    broker.child_snapshots.remove(&old.incarnation);
                    broker.reports.retain(|_, report| {
                        report
                            .pointer("/context/documentIncarnation")
                            .and_then(Value::as_str)
                            != Some(old.incarnation.as_str())
                    });
                    let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                }
            }
        }
    }
    pub fn departed(&self, app: &tauri::AppHandle, label: &str) {
        if let Ok(mut guard) = self.broker.lock() {
            if let Ok(broker) = guard.as_mut() {
                broker.documents.remove(label);
                broker.opening.remove(label);
                broker.pending_closes.remove(label);
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                let progress = broker.close_progress();
                drop(guard);
                if let Ok(progress) = progress {
                    apply_close_progress(app, progress);
                }
            }
        }
    }
    fn run(
        &self,
        app: &tauri::AppHandle,
        window: &tauri::WebviewWindow,
        command: Command,
    ) -> Result<Value, &'static str> {
        let mut guard = self
            .broker
            .lock()
            .map_err(|_| "native-broker-unavailable")?;
        let broker = guard.as_mut().map_err(|error| *error)?;
        let label = window.label();
        if !self.admitted(label, &window.url().map_err(|_| "forbidden")?, broker) {
            return Err("forbidden");
        }
        match &command {
            Command::Reserve { scope, .. }
            | Command::CancelReservation { scope, .. }
            | Command::Phase { scope, .. }
            | Command::RecoverInline { scope, .. }
            | Command::Launch { scope, .. } => self.require_host(broker, scope)?,
            Command::AssignIntent {
                scope,
                source_scope,
                ..
            } => {
                self.require_host(broker, scope)?;
                self.require_host(broker, source_scope)?;
            }
            Command::CompleteIntent { source_scope, .. } => {
                self.require_host(broker, source_scope)?
            }
            _ => {}
        }
        match command {
            Command::Context { nonce } => {
                identifier(&nonce, 200)?;
                let reservation = if label == "main" {
                    None
                } else {
                    Some(
                        broker
                            .storage
                            .profile(&self.origin)?
                            .windows
                            .values()
                            .find(|entry| {
                                entry.label == label
                                    && broker.opening.get(label) == Some(&entry.scope)
                            })
                            .ok_or("unregistered-window")?
                            .clone(),
                    )
                };
                if let Some(entry) = &reservation {
                    self.require_host(broker, &entry.scope)?;
                }
                let view_id = reservation
                    .as_ref()
                    .map(|entry| entry.view_id.clone())
                    .unwrap_or(
                        broker
                            .storage
                            .profile(&self.origin)?
                            .catalog_view_id
                            .clone(),
                    );
                let scope = reservation.as_ref().map(|entry| entry.scope.clone());
                if !broker
                    .documents
                    .get(label)
                    .is_some_and(|document| document.nonce == nonce)
                {
                    broker.documents.insert(
                        label.into(),
                        Document {
                            nonce,
                            incarnation: random_id()?,
                            scope,
                            view_id,
                            visible: true,
                            presence_sequence: 0,
                            display: None,
                            ready: label == "main",
                        },
                    );
                }
                let document = broker.documents.get(label).ok_or("unregistered-window")?;
                Ok(
                    json!({"version":1,"role":if label == "main" {"main"} else {"chat"},"label":label,"brokerInstance":self.instance,
                    "documentIncarnation":document.incarnation,"viewId":document.view_id,"reservation":reservation,"liveRelay":self.live_relay}),
                )
            }
            Command::Reserve {
                incarnation,
                scope,
                view_id,
                creation_agent_id,
                new_transition,
                intent_ref,
            } => {
                self.require_main(broker, label, &incarnation)?;
                if !self.live_relay {
                    return Err("unsupported-live-relay");
                }
                let reservation = self.reserve(
                    broker,
                    scope,
                    view_id,
                    creation_agent_id,
                    new_transition,
                    intent_ref.as_ref(),
                )?;
                Ok(serde_json::to_value(reservation).map_err(|_| "native-serialization-failed")?)
            }
            Command::CancelReservation {
                incarnation,
                scope,
                transition_id,
                previous,
            } => {
                self.require_main(broker, label, &incarnation)?;
                scope.validate()?;
                identifier(&transition_id, 200)?;
                if let Some(prior) = &previous {
                    identifier(&prior.transition_id, 200)?;
                }
                Ok(json!(self.cancel_reservation(
                    broker,
                    &scope,
                    &transition_id,
                    previous.as_ref()
                )?))
            }
            Command::Phase {
                incarnation,
                scope,
                transition_id,
                phase,
            } => {
                self.require_main(broker, label, &incarnation)?;
                let may_restart = !broker.opening.values().any(|live| live == &scope);
                broker.storage.mutate(&self.origin, |profile| {
                    if let Some(previous) = profile.windows.get(&scope.key()).cloned() {
                        profile.preserve_child_ready(&previous);
                    }
                    let entry = profile
                        .windows
                        .get_mut(&scope.key())
                        .ok_or("unknown-reservation")?;
                    if entry.scope != scope || entry.transition_id != transition_id {
                        return Err("stale-transition");
                    }
                    let allowed = (entry.transition_id.starts_with("inline:")
                        && entry.phase == Phase::Failed
                        && phase == Phase::InlineReady)
                        || (phase == Phase::SourceSaved && may_restart)
                        || entry.phase == phase
                        || phase == Phase::Failed
                        || matches!(
                            (&entry.phase, &phase),
                            (Phase::Requested, Phase::SourceSaved)
                                | (Phase::SourceSaved, Phase::TransferCommitted)
                                | (Phase::TransferCommitted, Phase::SourceReleased)
                                | (Phase::Failed, Phase::SourceSaved)
                                | (Phase::TargetReady, Phase::SourceSaved)
                                | (Phase::InlineReady, Phase::SourceSaved)
                        );
                    if !allowed {
                        return Err("invalid-transition-phase");
                    }
                    entry.phase = phase;
                    Ok(())
                })?;
                Ok(json!({"ok":true}))
            }
            Command::RecoverInline {
                incarnation,
                scope,
                expected_transition_id,
                expected_context,
            } => {
                self.require_main(broker, label, &incarnation)?;
                broker.require_recovery_context(&expected_context)?;
                let reservation = broker
                    .storage
                    .profile(&self.origin)?
                    .windows
                    .get(&scope.key())
                    .filter(|entry| entry.scope == scope)
                    .ok_or("stale-recovery-reservation")?
                    .clone();
                if broker.opening.contains_key(&reservation.label)
                    || app.get_webview_window(&reservation.label).is_some()
                {
                    return Err("target-still-open");
                }
                let recovery = broker.storage.mutate(&self.origin, |profile| {
                    profile.preserve_child_ready(&reservation);
                    let entry = profile
                        .windows
                        .get_mut(&scope.key())
                        .ok_or("unknown-reservation")?;
                    entry.recover_inline(&expected_transition_id)
                })?;
                Ok(
                    json!({"scope":scope,"viewId":reservation.view_id,"nativeLabel":reservation.label,"fromTransitionId":recovery.from_transition_id,
                    "transitionId":recovery.transition_id,"targetLabel":"main","creationAgentId":reservation.creation_agent_id}),
                )
            }
            Command::Lookup { incarnation, scope } => {
                scope.validate()?;
                self.require_main(broker, label, &incarnation)?;
                if broker.host.is_some() {
                    self.require_host(broker, &scope)?;
                }
                broker.lookup_window(&self.origin, &scope)
            }
            Command::Launch {
                incarnation,
                scope,
                geometry,
                existing_only,
                intent_ref,
            } => {
                self.require_main(broker, label, &incarnation)?;
                geometry.validate()?;
                if !self.live_relay {
                    return Err("unsupported-live-relay");
                }
                let reservation = broker
                    .storage
                    .profile(&self.origin)?
                    .windows
                    .get(&scope.key())
                    .filter(|entry| entry.scope == scope)
                    .ok_or("unknown-reservation")?
                    .clone();
                if reservation.transition_id.starts_with("inline:") {
                    return Err("inline-recovery-reserved");
                }
                if reservation.phase == Phase::Assigned {
                    return Err("native-window-not-reserved");
                }
                if !existing_only {
                    self.admit_child(broker, &scope, intent_ref.as_ref())?;
                }
                if !existing_only {
                    broker.storage.mutate(&self.origin, |profile| {
                        profile.attach_launched_intents(&reservation);
                        Ok(())
                    })?;
                }
                if let Some(child) = app.get_webview_window(&reservation.label) {
                    drop(guard);
                    child.show().map_err(|_| "window-focus-failed")?;
                    child.set_focus().map_err(|_| "window-focus-failed")?;
                    let _ = app.emit_to(&reservation.label, "openpane-ui-wakeup", ());
                    let guard = self
                        .broker
                        .lock()
                        .map_err(|_| "native-broker-unavailable")?;
                    let broker = guard.as_ref().map_err(|error| *error)?;
                    return if broker.document_ready(&reservation) {
                        Ok(json!({"kind":"detached","scope":scope,"label":reservation.label}))
                    } else {
                        Ok(
                            json!({"kind":"pending","scope":scope,"reason":"Waiting for the assigned editor to become ready"}),
                        )
                    };
                }
                if broker.opening.contains_key(&reservation.label) {
                    return Ok(
                        json!({"kind":"pending","scope":scope,"reason":"Window is opening"}),
                    );
                }
                if existing_only {
                    return Ok(Value::Null);
                }
                if reservation.phase == Phase::InlineReady
                    || reservation.creation_agent_id.is_none()
                        && !matches!(
                            reservation.phase,
                            Phase::SourceReleased | Phase::TargetReady | Phase::Failed
                        )
                {
                    return Err("source-not-released");
                }
                broker
                    .opening
                    .insert(reservation.label.clone(), scope.clone());
                let target = self.target.clone().ok_or("bundled-inline-only")?;
                let child_label = reservation.label.clone();
                drop(guard);
                let result = (|| -> Result<(), &'static str> {
                    add_capability(app, &child_label, &target)?;
                    let admitted = target.clone();
                    let navigation_app = app.clone();
                    let navigation_label = child_label.clone();
                    let mut builder = tauri::WebviewWindowBuilder::new(
                        app,
                        &child_label,
                        tauri::WebviewUrl::External(target),
                    )
                    .title(&geometry.title)
                    .inner_size(geometry.width as f64, geometry.height as f64)
                    .min_inner_size(360.0, 480.0)
                    .disable_drag_drop_handler()
                    .on_navigation(move |url| {
                        if url != &admitted {
                            return false;
                        }
                        navigation_app
                            .state::<ChatWindows>()
                            .navigating(&navigation_app, &navigation_label);
                        true
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
                    #[cfg(target_os = "macos")]
                    if geometry.titlebar == "integrated" {
                        builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
                    }
                    let child = builder.build().map_err(|_| "window-load-failed")?;
                    attach_close(app, &child);
                    Ok(())
                })();
                if result.is_err() {
                    let mut guard = self
                        .broker
                        .lock()
                        .map_err(|_| "native-broker-unavailable")?;
                    if let Ok(broker) = guard.as_mut() {
                        broker.opening.remove(&child_label);
                        let _ = broker.storage.mutate(&self.origin, |profile| {
                            let entry = profile
                                .windows
                                .get_mut(&scope.key())
                                .ok_or("unknown-reservation")?;
                            entry.phase = Phase::Failed;
                            Ok(())
                        });
                    }
                }
                result?;
                Ok(
                    json!({"kind":"pending","scope":scope,"reason":"Waiting for the assigned editor"}),
                )
            }
            Command::CreationRefused { incarnation } => {
                let document = self.document(broker, label, &incarnation)?;
                let scope = document.scope.clone().ok_or("child-required")?;
                if document.ready {
                    return Err("editor-already-ready");
                }
                broker.storage.mutate(&self.origin, |profile| {
                    let entry = profile
                        .windows
                        .get_mut(&scope.key())
                        .ok_or("unknown-reservation")?;
                    if entry.creation_agent_id.is_none() {
                        return Err("creation-required");
                    }
                    entry.phase = Phase::Failed;
                    Ok(())
                })?;
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                Ok(json!({"ok":true}))
            }
            Command::Ready {
                incarnation,
                binding,
                visible,
            } => {
                let document = self.document(broker, label, &incarnation)?;
                if document
                    .scope
                    .as_ref()
                    .is_none_or(|scope| !binding.admits(scope, &document.view_id))
                {
                    return Err("binding-mismatch");
                }
                broker.storage.mutate(&self.origin, |profile| {
                    let entry = profile
                        .windows
                        .get_mut(&binding.scope.key())
                        .ok_or("unknown-reservation")?;
                    if entry.view_id != binding.view_id || entry.label != label {
                        return Err("binding-mismatch");
                    }
                    entry.confirm_binding(binding.revision, binding.writer_generation)?;
                    let ready = entry.clone();
                    profile.preserve_child_ready(&ready);
                    Ok(())
                })?;
                let document = broker.documents.get_mut(label).ok_or("stale-document")?;
                document.ready = true;
                document.visible = visible;
                broker.advance_presence(label)?;
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                if broker.main_closing {
                    broker.request_close(label)?;
                    let _ = app.emit_to(label, "openpane-close-requested", ());
                }
                let _ = app.emit_to(label, "openpane-ui-wakeup", ());
                Ok(json!({"ok":true}))
            }
            command @ (Command::BindUi { .. }
            | Command::PublishUi { .. }
            | Command::ReadUi { .. }
            | Command::Presence { .. }
            | Command::ReportUi { .. }
            | Command::DrainUi { .. }
            | Command::ConfirmUi { .. }) => self.run_ui(app, broker, label, command),
            command @ (Command::IntentContext { .. }
            | Command::PlacementIntent { .. }
            | Command::ReadIntent { .. }
            | Command::PendingIntents { .. }
            | Command::CarryApplied { .. }
            | Command::OwnIntents { .. }
            | Command::RetryIntent { .. }
            | Command::Reservations { .. }
            | Command::AssignIntent { .. }
            | Command::CompleteIntent { .. }) => self.run_intent(app, broker, label, command),
            Command::RestoreBuiltin {
                incarnation,
                expected_context,
                request_id,
            } => {
                self.document(broker, label, &incarnation)?;
                if let Some(id) = request_id.as_ref() {
                    identifier(id, 200)?;
                }
                broker.request_restore(expected_context.as_ref(), request_id)?;
                for target in broker.documents.keys() {
                    let _ = app.emit_to(target, "openpane-ui-wakeup", ());
                }
                Ok(
                    json!({"sequence":broker.recovery_sequence,"hostId":broker.recovery_context().map(|context| &context.host_id),"profileId":broker.recovery_context().map(|context| &context.profile_id)}),
                )
            }
            Command::ReadRecovery { incarnation } => {
                self.require_main(broker, label, &incarnation)?;
                Ok(broker.recovery_state())
            }
            Command::ReadRecoveryCancellation {
                incarnation,
                sequence,
            } => {
                self.require_main(broker, label, &incarnation)?;
                Ok(json!({"cancelled":broker.recovery_cancelled(sequence)?}))
            }
            Command::ScopeRecovery {
                incarnation,
                sequence,
                expected_context,
                submitted,
            } => {
                self.require_main(broker, label, &incarnation)?;
                let admission = broker.scope_recovery(sequence, expected_context, submitted)?;
                Ok(json!({"admission":admission}))
            }
            Command::ConfirmRecovery {
                incarnation,
                sequence,
                delivery_generation,
                expected_context,
            } => {
                self.require_main(broker, label, &incarnation)?;
                if broker.confirm_restore(sequence, delivery_generation, expected_context)? {
                    broker.notify_child_cache(app);
                }
                Ok(json!({"ok":true}))
            }
            Command::CloseCancelled {
                incarnation,
                attempt_id,
            } => {
                self.document(broker, label, &incarnation)?;
                broker.cancel_close_for(label, &attempt_id)?;
                Ok(json!({"ok":true}))
            }
            Command::ReadClose { incarnation } => {
                self.document(broker, label, &incarnation)?;
                Ok(
                    json!({"pending":broker.pending_closes.contains_key(label),"attemptId":broker.pending_closes.get(label).map(|pending| &pending.attempt_id)}),
                )
            }
            Command::CloseReady {
                incarnation,
                attempt_id,
            } => {
                self.document(broker, label, &incarnation)?;
                broker.authorize_close(label, &attempt_id)?;
                if label != "main" {
                    drop(guard);
                    window.destroy().map_err(|_| "window-close-failed")?;
                    // Destroyed removes admission and advances Quit only after destruction succeeds.
                    return Ok(json!({"ok":true}));
                }
                let progress = broker.finish_close(label)?;
                drop(guard);
                apply_close_progress(app, progress);
                Ok(json!({"ok":true}))
            }
        }
    }
}
fn child_ui_state(snapshot: Option<&Value>, child: Option<&Value>) -> Option<Value> {
    let mut scoped = snapshot?.clone();
    let child = child?;
    scoped["envelope"] = child["envelope"].clone();
    scoped["display"] = child["display"].clone();
    scoped["transitions"] = json!([]);
    Some(scoped)
}
#[cfg(test)]
mod ui_tests {
    use super::*;
    #[test]
    fn a_child_never_falls_back_to_main_receipts_or_other_transition_scopes() {
        let common = json!({"version":1,"envelope":{"requestId":"main-only"},"display":{"scope":"main-only"},"transitions":[{"foreignScope":"other"}],"selection":{"revision":4}});
        assert_eq!(child_ui_state(Some(&common), None), None);
        let scoped = child_ui_state(
            Some(&common),
            Some(&json!({"envelope":{"requestId":"child-only"},"display":{"scope":"child-only"}})),
        )
        .unwrap();
        assert_eq!(scoped["envelope"]["requestId"], "child-only");
        assert_eq!(scoped["display"]["scope"], "child-only");
        assert_eq!(scoped["transitions"], json!([]));
        assert_eq!(scoped["selection"], common["selection"]);
        assert_eq!(
            child_ui_state(Some(&common), Some(&Value::Null)).unwrap()["envelope"],
            Value::Null
        );
    }
}
pub fn add_capability(
    app: &tauri::AppHandle,
    label: &str,
    target: &tauri::Url,
) -> Result<(), &'static str> {
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new(format!("desktop-{label}"))
            .local(false)
            .remote(format!("{}/", target.origin().ascii_serialization()))
            .window(label)
            .permission("allow-desktop-window")
            .permission("core:event:allow-listen")
            .permission("core:event:allow-unlisten"),
    )
    .map_err(|_| "native-capability-failed")
}
pub fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, Submenu};
    let menu = Menu::default(app)?;
    let restore = MenuItem::with_id(
        app,
        "openpane-restore",
        "Restore OpenPane appearance",
        true,
        Some("CmdOrCtrl+Shift+Backspace"),
    )?;
    menu.append(&Submenu::with_items(app, "Appearance", true, &[&restore])?)?;
    #[cfg(target_os = "macos")]
    if let Some(application) = menu.items()?.first().and_then(|item| item.as_submenu()) {
        let items = application.items()?;
        if let Some(quit) = items.last() {
            application.remove(quit)?;
        }
        application.append(&MenuItem::with_id(
            app,
            "openpane-quit",
            "Quit OpenPane",
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }
    let force_chat = MenuItem::with_id(
        app,
        "openpane-close-unsaved-chat",
        "Close Chat Without Saving",
        true,
        None::<&str>,
    )?;
    let force_quit = MenuItem::with_id(
        app,
        "openpane-quit-unsaved",
        "Quit Without Saving",
        true,
        None::<&str>,
    )?;
    menu.append(&Submenu::with_items(
        app,
        "Recovery",
        true,
        &[&force_chat, &force_quit],
    )?)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "openpane-restore" => {
            let _ = app.state::<ChatWindows>().restore_builtin(app);
        }
        "openpane-close-unsaved-chat" => {
            if let Some((label, _)) = app
                .webview_windows()
                .into_iter()
                .find(|(label, window)| label != "main" && window.is_focused().unwrap_or(false))
            {
                app.state::<ChatWindows>()
                    .close_chat_without_saving(app, &label);
            }
        }
        "openpane-quit-unsaved" => app.exit(0),
        "openpane-quit" => {
            if !app.state::<ChatWindows>().close_requested(app, "main") {
                app.exit(0);
            }
        }
        _ => {}
    });
    Ok(())
}
pub fn attach_close(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let app = app.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if app.state::<ChatWindows>().close_requested(&app, &label) {
                api.prevent_close();
            }
        }
        tauri::WindowEvent::Destroyed => app.state::<ChatWindows>().departed(&app, &label),
        _ => {}
    });
}
#[tauri::command]
pub async fn desktop_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    command: Value,
) -> Result<Value, &'static str> {
    if serde_json::to_vec(&command)
        .map_err(|_| "invalid-input")?
        .len()
        > 1024 * 1024 + 8192
    {
        return Err("native-request-too-large");
    }
    let command: Command = serde_json::from_value(command).map_err(|_| "invalid-input")?;
    // Webview methods synchronously dispatch to the event loop. Keep command execution
    // on that same thread so a Destroyed callback never waits behind a lock whose
    // holder is itself waiting for a webview dispatch.
    let (send, receive) = std::sync::mpsc::channel();
    let target = app.clone();
    app.run_on_main_thread(move || {
        let result = target.state::<ChatWindows>().run(&target, &window, command);
        let _ = send.send(result);
    })
    .map_err(|_| "native-main-unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        receive.recv().map_err(|_| "native-main-unavailable")
    })
    .await
    .map_err(|_| "native-main-unavailable")??
}

#[cfg(test)]
mod admission_tests {
    fn confirm(broker: &mut super::Broker, sequence: u64, generation: u64) {
        let host = broker.host.clone().unwrap();
        broker.scope_recovery(sequence, host.clone(), true).unwrap();
        broker.confirm_restore(sequence, generation, host).unwrap();
    }

    use super::*;

    #[test]
    fn cancellation_accepts_both_fresh_and_prior_terminal_command_shapes() {
        let mut command = json!({"kind":"cancel-reservation","incarnation":"main","scope":{"hostId":"host","conversationId":"chat"},"transitionId":"replacement"});
        assert!(matches!(
            serde_json::from_value::<Command>(command.clone()).unwrap(),
            Command::CancelReservation { previous: None, .. }
        ));
        command["previous"] = json!({"scope":{"hostId":"host","conversationId":"chat"},"viewId":"view","label":"chat-label","transitionId":"prior","creationAgentId":null,"phase":"target-ready","bindingRevision":3,"writerGeneration":4});
        let Command::CancelReservation {
            previous: Some(prior),
            ..
        } = serde_json::from_value::<Command>(command).unwrap()
        else {
            panic!("Missing prior terminal record");
        };
        assert_eq!(prior.transition_id, "prior");
        assert_eq!(prior.phase, Phase::TargetReady);
    }

    #[test]
    fn cancelling_a_superseded_rollover_restores_the_exact_terminal_record_and_slot() {
        let directory =
            std::env::temp_dir().join(format!("openpane-rollover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            for n in 0..31 {
                windows
                    .reserve(
                        broker,
                        Scope {
                            host_id: "host".into(),
                            conversation_id: format!("occupied-{n}"),
                        },
                        format!("view-{n}"),
                        None,
                        false,
                        None,
                    )
                    .unwrap();
            }
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "old-closed".into(),
            };
            windows
                .reserve(broker, scope.clone(), "old-view".into(), None, false, None)
                .unwrap();
            let prior = broker
                .storage
                .mutate(&windows.origin, |profile| {
                    let entry = profile.windows.get_mut(&scope.key()).unwrap();
                    entry.confirm_binding(3, 4)?;
                    Ok(entry.clone())
                })
                .unwrap();
            let source = Scope {
                host_id: "host".into(),
                conversation_id: "historical-source".into(),
            };
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.intent(
                        source.clone(),
                        "1:historical".into(),
                        Action::Open {
                            scope: scope.clone(),
                            passive: false,
                            carry: false,
                        },
                    )?;
                    profile.assign_intent(&source, "1:historical", prior.clone(), false, None)?;
                    profile.complete_intent(
                        &source,
                        "1:historical",
                        json!({"kind":"detached","scope":scope,"label":prior.label}),
                    )?;
                    Ok(())
                })
                .unwrap();
            let carry_source = Scope {
                host_id: "host".into(),
                conversation_id: "unbound-carry-source".into(),
            };
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.intent(
                        carry_source.clone(),
                        "1:unbound-carry".into(),
                        Action::Open {
                            scope: scope.clone(),
                            passive: false,
                            carry: true,
                        },
                    )?;
                    profile.assign_intent(
                        &carry_source,
                        "1:unbound-carry",
                        prior.clone(),
                        false,
                        None,
                    )?;
                    profile
                        .intents
                        .get_mut(&crate::chat_window_records::Profile::intent_key(
                            &carry_source,
                            "1:unbound-carry",
                        ))
                        .unwrap()
                        .target
                        .as_mut()
                        .unwrap()
                        .phase = Phase::Assigned;
                    let newer = Scope {
                        host_id: "host".into(),
                        conversation_id: "new-explicit-source".into(),
                    };
                    profile.intent(
                        newer.clone(),
                        "1:new-explicit".into(),
                        Action::Open {
                            scope: scope.clone(),
                            passive: false,
                            carry: false,
                        },
                    )?;
                    let mut proposed = prior.clone();
                    proposed.transition_id = "fresh-placeholder".into();
                    profile.assign_intent(&newer, "1:new-explicit", proposed, true, None)?;
                    assert_eq!(
                        profile.windows[&scope.key()].transition_id,
                        prior.transition_id
                    );
                    Ok(())
                })
                .unwrap();
            let history = serde_json::to_value(
                broker
                    .storage
                    .profile(&windows.origin)
                    .unwrap()
                    .intents
                    .values()
                    .filter(|intent| intent.result.is_some())
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            let rolled = windows
                .reserve(broker, scope.clone(), "old-view".into(), None, true, None)
                .unwrap();
            assert_ne!(rolled.transition_id, prior.transition_id);
            assert_eq!(rolled.phase, Phase::Requested);
            assert_eq!(rolled.binding_revision, Some(3));
            assert_eq!(rolled.writer_generation, Some(4));
            let next = Scope {
                host_id: "host".into(),
                conversation_id: "next".into(),
            };
            assert_eq!(
                windows.admit_child(broker, &next, None),
                Err("native-window-limit")
            );

            assert!(!windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, None)
                .unwrap());
            let mut wrong = prior.clone();
            wrong.view_id = "different-view".into();
            assert!(!windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, Some(&wrong))
                .unwrap());
            wrong = prior.clone();
            wrong.binding_revision = Some(2);
            assert!(!windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, Some(&wrong))
                .unwrap());
            wrong = prior.clone();
            wrong.phase = Phase::SourceReleased;
            assert!(!windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, Some(&wrong))
                .unwrap());
            assert!(!windows
                .cancel_reservation(broker, &scope, "stale-replacement", Some(&prior))
                .unwrap());
            broker.opening.insert(rolled.label.clone(), scope.clone());
            assert!(!windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, Some(&prior))
                .unwrap());
            broker.opening.clear();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.windows.get_mut(&scope.key()).unwrap().phase = Phase::SourceSaved;
                    Ok(())
                })
                .unwrap();
            assert!(!windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, Some(&prior))
                .unwrap());
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.windows.get_mut(&scope.key()).unwrap().phase = Phase::Requested;
                    Ok(())
                })
                .unwrap();
            assert!(windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, Some(&prior))
                .unwrap());
            let restored = broker
                .storage
                .profile(&windows.origin)
                .unwrap()
                .windows
                .get(&scope.key())
                .unwrap()
                .clone();
            assert_eq!(
                serde_json::to_value(&restored).unwrap(),
                serde_json::to_value(&prior).unwrap()
            );
            assert_eq!(
                serde_json::to_value(
                    broker
                        .storage
                        .profile(&windows.origin)
                        .unwrap()
                        .intents
                        .values()
                        .filter(|intent| intent.result.is_some())
                        .collect::<Vec<_>>()
                )
                .unwrap(),
                history
            );
            let queued = &broker.storage.profile(&windows.origin).unwrap().intents
                [&crate::chat_window_records::Profile::intent_key(
                    &carry_source,
                    "1:unbound-carry",
                )];
            assert!(queued.result.is_none());
            assert_eq!(queued.target.as_ref().unwrap().phase, Phase::TargetReady);
            assert_eq!(
                queued.target.as_ref().unwrap().transition_id,
                prior.transition_id
            );
            assert!(windows.admit_child(broker, &next, None).is_ok());
            assert!(!windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, Some(&prior))
                .unwrap());
            println!(
                "ROLLOVER_TRACE {}",
                json!({"prior":prior,"rolled":rolled,"restored":restored,"lookup":broker.lookup_window(&windows.origin, &scope).unwrap()["kind"]})
            );
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelling_a_failed_record_rollover_restores_it_instead_of_deleting_it() {
        let directory =
            std::env::temp_dir().join(format!("openpane-failed-rollover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "failed-closed".into(),
            };
            windows
                .reserve(
                    broker,
                    scope.clone(),
                    "failed-view".into(),
                    None,
                    false,
                    None,
                )
                .unwrap();
            let prior = broker
                .storage
                .mutate(&windows.origin, |profile| {
                    let entry = profile.windows.get_mut(&scope.key()).unwrap();
                    entry.phase = Phase::Failed;
                    Ok(entry.clone())
                })
                .unwrap();
            let rolled = windows
                .reserve(
                    broker,
                    scope.clone(),
                    "failed-view".into(),
                    None,
                    true,
                    None,
                )
                .unwrap();
            assert!(windows
                .cancel_reservation(broker, &scope, &rolled.transition_id, Some(&prior))
                .unwrap());
            let restored = broker
                .storage
                .profile(&windows.origin)
                .unwrap()
                .windows
                .get(&scope.key())
                .unwrap()
                .clone();
            assert_eq!(
                serde_json::to_value(&restored).unwrap(),
                serde_json::to_value(prior).unwrap()
            );
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn persisted_phases_without_a_live_document_or_opening_lookup_as_closed() {
        let directory =
            std::env::temp_dir().join(format!("openpane-lookup-phase-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "lookup-phases".into(),
            };
            let reservation = windows
                .reserve(
                    broker,
                    scope.clone(),
                    "lookup-view".into(),
                    None,
                    false,
                    None,
                )
                .unwrap();
            for phase in [
                Phase::Requested,
                Phase::SourceSaved,
                Phase::TransferCommitted,
                Phase::SourceReleased,
                Phase::TargetReady,
                Phase::Failed,
            ] {
                broker
                    .storage
                    .mutate(&windows.origin, |profile| {
                        let entry = profile.windows.get_mut(&scope.key()).unwrap();
                        entry.phase = phase.clone();
                        if phase == Phase::TargetReady {
                            entry.binding_revision = Some(1);
                            entry.writer_generation = Some(1);
                        }
                        Ok(())
                    })
                    .unwrap();
                assert_eq!(
                    broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                    "closed"
                );
            }
            broker.opening.insert(reservation.label, scope.clone());
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                "opening"
            );
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelling_an_untouched_reservation_releases_its_admission_slot() {
        let directory =
            std::env::temp_dir().join(format!("openpane-cancel-slot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            for n in 0..31 {
                windows
                    .reserve(
                        broker,
                        Scope {
                            host_id: "host".into(),
                            conversation_id: format!("admitted-{n}"),
                        },
                        format!("view-{n}"),
                        None,
                        false,
                        None,
                    )
                    .unwrap();
            }
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "cancelled".into(),
            };
            let reservation = windows
                .reserve(
                    broker,
                    scope.clone(),
                    "cancelled-view".into(),
                    None,
                    false,
                    None,
                )
                .unwrap();
            let next = Scope {
                host_id: "host".into(),
                conversation_id: "next".into(),
            };
            assert_eq!(
                windows.admit_child(broker, &next, None),
                Err("native-window-limit")
            );
            assert!(!windows
                .cancel_reservation(broker, &scope, "wrong-transition", None)
                .unwrap());
            assert!(windows
                .cancel_reservation(broker, &scope, &reservation.transition_id, None)
                .unwrap());
            assert!(!windows
                .cancel_reservation(broker, &scope, &reservation.transition_id, None)
                .unwrap());
            assert!(windows.admit_child(broker, &next, None).is_ok());
            assert_eq!(
                broker
                    .storage
                    .profile(&windows.origin)
                    .unwrap()
                    .windows
                    .len(),
                31
            );
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn cancelling_never_removes_staged_live_or_assigned_work() {
        let directory =
            std::env::temp_dir().join(format!("openpane-cancel-preserve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "preserved".into(),
            };
            let reservation = windows
                .reserve(
                    broker,
                    scope.clone(),
                    "preserved-view".into(),
                    None,
                    false,
                    None,
                )
                .unwrap();
            broker
                .opening
                .insert(reservation.label.clone(), scope.clone());
            assert!(!windows
                .cancel_reservation(broker, &scope, &reservation.transition_id, None)
                .unwrap());
            broker.opening.clear();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.windows.get_mut(&scope.key()).unwrap().phase = Phase::SourceSaved;
                    Ok(())
                })
                .unwrap();
            assert!(!windows
                .cancel_reservation(broker, &scope, &reservation.transition_id, None)
                .unwrap());
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.windows.get_mut(&scope.key()).unwrap().phase = Phase::Requested;
                    profile
                        .windows
                        .get_mut(&scope.key())
                        .unwrap()
                        .binding_revision = Some(1);
                    Ok(())
                })
                .unwrap();
            assert!(!windows
                .cancel_reservation(broker, &scope, &reservation.transition_id, None)
                .unwrap());
            let assigned = Scope {
                host_id: "host".into(),
                conversation_id: "assigned".into(),
            };
            let source = Scope {
                host_id: "host".into(),
                conversation_id: "source".into(),
            };
            let target = windows
                .reserve(
                    broker,
                    assigned.clone(),
                    "assigned-view".into(),
                    Some("agent".into()),
                    false,
                    None,
                )
                .unwrap();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.intent(
                        source.clone(),
                        "1:assigned".into(),
                        Action::Create {
                            agent_id: "agent".into(),
                            carry: false,
                        },
                    )?;
                    profile.assign_intent(&source, "1:assigned", target.clone(), false, None)?;
                    Ok(())
                })
                .unwrap();
            assert!(!windows
                .cancel_reservation(broker, &assigned, &target.transition_id, None)
                .unwrap());
            assert_eq!(
                broker
                    .storage
                    .profile(&windows.origin)
                    .unwrap()
                    .windows
                    .len(),
                2
            );
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn focus_only_launch_is_explicit_and_ordinary_launch_defaults_to_creation() {
        let geometry = json!({"width":640,"height":720,"titlebar":"native","title":"Chat"});
        let command = json!({"kind":"launch","incarnation":"main","scope":{"hostId":"host","conversationId":"chat"},"geometry":geometry});
        assert!(matches!(
            serde_json::from_value::<Command>(command.clone()).unwrap(),
            Command::Launch {
                existing_only: false,
                intent_ref: None,
                ..
            }
        ));
        let mut focus = command;
        focus["existingOnly"] = json!(true);
        assert!(matches!(
            serde_json::from_value::<Command>(focus).unwrap(),
            Command::Launch {
                existing_only: true,
                intent_ref: None,
                ..
            }
        ));
    }

    #[test]
    fn forced_chat_close_preserves_main_and_unrelated_setup_windows() {
        let directory =
            std::env::temp_dir().join(format!("openpane-force-chat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "chat".into(),
            };
            for (label, scope) in [
                ("main", None),
                ("provider-setup", None),
                ("ready-chat", Some(scope.clone())),
            ] {
                broker.documents.insert(
                    label.into(),
                    Document {
                        nonce: label.into(),
                        incarnation: label.into(),
                        scope,
                        view_id: label.into(),
                        visible: true,
                        presence_sequence: 0,
                        display: None,
                        ready: true,
                    },
                );
            }
            broker.opening.insert("opening-chat".into(), scope);
            for label in ["main", "provider-setup", "unknown"] {
                assert_eq!(broker.is_chat(label), false);
            }
            assert_eq!(broker.documents.len(), 3);
            assert!(broker.is_chat("ready-chat"));
            assert!(broker.is_chat("ready-chat"));
            assert!(broker.is_chat("opening-chat"));
            assert!(broker.is_chat("opening-chat"));
            assert!(broker.documents.contains_key("main"));
            assert!(broker.documents.contains_key("provider-setup"));
            assert!(broker.documents.contains_key("ready-chat"));
            assert!(broker.opening.contains_key("opening-chat"));
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn normal_quit_refuses_new_child_admission_until_cancelled() {
        let directory =
            std::env::temp_dir().join(format!("openpane-quit-admission-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "chat".into(),
            };
            broker.begin_close("main").unwrap();
            assert_eq!(
                windows.admit_child(broker, &scope, None),
                Err("main-unavailable")
            );
            assert!(windows
                .reserve(broker, scope.clone(), "view".into(), None, false, None)
                .is_err());
            assert!(broker.opening.is_empty());
            assert!(broker
                .storage
                .profile(&windows.origin)
                .unwrap()
                .windows
                .is_empty());
            broker.cancel_close();
            assert!(windows
                .reserve(broker, scope, "view".into(), None, false, None)
                .is_ok());
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn reservation_replay_at_history_capacity_keeps_original_transition() {
        let directory =
            std::env::temp_dir().join(format!("openpane-replay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    for n in 0..crate::chat_window_records::MAX_WINDOWS {
                        let scope = Scope {
                            host_id: "host".into(),
                            conversation_id: format!("saved-{n}"),
                        };
                        profile.reserve(Reservation {
                            scope,
                            view_id: format!("view-{n}"),
                            label: format!("chat-{n}"),
                            transition_id: format!("transition-{n}"),
                            creation_agent_id: None,
                            phase: Phase::TargetReady,
                            binding_revision: Some(1),
                            writer_generation: Some(1),
                        })?;
                    }
                    Ok(())
                })
                .unwrap();
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "saved-0".into(),
            };
            let replay = windows
                .reserve(broker, scope, "view-0".into(), None, false, None)
                .unwrap();
            assert_eq!(replay.label, "chat-0");
            assert_eq!(replay.transition_id, "transition-0");
            assert_eq!(replay.phase, Phase::TargetReady);
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn window_lookup_reports_current_document_readiness_instead_of_historical_phase() {
        let directory =
            std::env::temp_dir().join(format!("openpane-lookup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "chat".into(),
            };
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap(),
                json!({"kind":"absent"})
            );
            let reservation = windows
                .reserve(broker, scope.clone(), "view".into(), None, false, None)
                .unwrap();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.windows.get_mut(&scope.key()).unwrap().phase = Phase::TargetReady;
                    Ok(())
                })
                .unwrap();
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                "closed"
            );
            broker
                .opening
                .insert(reservation.label.clone(), scope.clone());
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                "opening"
            );
            broker.documents.insert(
                reservation.label.clone(),
                Document {
                    nonce: "nonce".into(),
                    incarnation: "incarnation".into(),
                    scope: Some(scope.clone()),
                    view_id: "view".into(),
                    visible: true,
                    presence_sequence: 1,
                    display: None,
                    ready: false,
                },
            );
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                "opening"
            );
            broker.documents.get_mut(&reservation.label).unwrap().ready = true;
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                "ready"
            );
            broker
                .documents
                .get_mut(&reservation.label)
                .unwrap()
                .view_id = "other".into();
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                "opening"
            );
            broker.finish_close(&reservation.label).unwrap();
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                "closed"
            );
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn host_rebind_cancels_old_recovery_and_scoped_requests_require_the_bound_host() {
        let command: Command = serde_json::from_value(json!({"kind":"restore-builtin","incarnation":"document","expectedContext":{"hostId":"host-a","profileId":"profile-a"}})).unwrap();
        assert!(
            matches!(command, Command::RestoreBuiltin { expected_context: Some(context), .. } if context.host_id == "host-a" && context.profile_id == "profile-a")
        );
        assert!(serde_json::from_value::<Command>(json!({"kind":"restore-builtin","incarnation":"document","expectedContext":{"hostId":"host-a"}})).is_err());
        assert!(matches!(
            serde_json::from_value::<Command>(
                json!({"kind":"restore-builtin","incarnation":"document"})
            )
            .unwrap(),
            Command::RestoreBuiltin {
                expected_context: None,
                ..
            }
        ));
        let directory =
            std::env::temp_dir().join(format!("openpane-recovery-host-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            assert_eq!(
                broker.request_restore(
                    Some(&UiRecoveryContext {
                        host_id: "host-a".into(),
                        profile_id: "profile-a".into()
                    }),
                    None
                ),
                Err("wrong-host")
            );
            broker.request_restore(None, None).unwrap();
            broker
                .bind_host("host-a".into(), "profile-a".into())
                .unwrap();
            assert!(
                broker.recovery.is_some(),
                "an initially unbound explicit restore belongs to the first binding"
            );
            let queued_host = broker.host.clone();
            let old_sequence = broker.recovery_sequence;
            broker
                .bind_host("host-b".into(), "profile-b".into())
                .unwrap();
            assert!(
                !broker.recovery.is_some(),
                "a previous host's pending restore cannot replay after rebind"
            );
            assert_eq!(queued_host.unwrap().host_id, "host-a");
            assert_eq!(broker.recovery_sequence, old_sequence);
            assert_eq!(
                broker.request_restore(
                    Some(&UiRecoveryContext {
                        host_id: "host-a".into(),
                        profile_id: "profile-a".into()
                    }),
                    None
                ),
                Err("wrong-host")
            );
            assert_eq!(
                broker.request_restore(
                    Some(&UiRecoveryContext {
                        host_id: "host-b".into(),
                        profile_id: "old-profile-b".into()
                    }),
                    None
                ),
                Err("wrong-host")
            );
            broker
                .request_restore(
                    Some(&UiRecoveryContext {
                        host_id: "host-b".into(),
                        profile_id: "profile-b".into(),
                    }),
                    None,
                )
                .unwrap();
            assert!(broker.recovery_sequence > old_sequence);
            confirm(broker, old_sequence, 2);
            assert!(broker.recovery.is_some());
            broker
                .bind_host("host-b".into(), "new-profile-b".into())
                .unwrap();
            assert!(
                !broker.recovery.is_some(),
                "profile changes also cancel pending recovery"
            );
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn each_explicit_restore_survives_until_its_matching_confirmation() {
        let directory =
            std::env::temp_dir().join(format!("openpane-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker
                .bind_host("host".into(), "first-profile".into())
                .unwrap();
            broker.snapshot = Some(json!({"old":"appearance"}));
            broker
                .bind_host("host".into(), "second-profile".into())
                .unwrap();
            assert!(broker.snapshot.is_none());
            broker.opening.insert(
                "unregistered".into(),
                Scope {
                    host_id: "host".into(),
                    conversation_id: "chat".into(),
                },
            );
            assert!(broker
                .bind_host("other-host".into(), "profile".into())
                .is_err());
            assert_eq!(broker.host.as_ref().unwrap().host_id, "host");
            broker.abandon_unregistered_openings();
            broker
                .bind_host("other-host".into(), "profile".into())
                .unwrap();
            broker.request_restore(None, None).unwrap();
            let first = broker.recovery_sequence;
            broker.request_restore(None, None).unwrap();
            let retry = broker.recovery_sequence;
            assert!(retry > first);
            broker.snapshot = Some(json!({"old":"appearance"}));
            confirm(broker, first, 2);
            assert!(broker.recovery.is_some());
            assert!(broker.snapshot.is_some());
            confirm(broker, retry, 2);
            assert!(!broker.recovery.is_some());
            assert!(broker.snapshot.is_none());
            broker.snapshot = Some(json!({"new":"appearance"}));
            confirm(broker, retry, 2);
            assert!(broker.snapshot.is_some());
            assert!(!broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":1}}),
                    BTreeMap::new()
                )
                .unwrap());
            assert_eq!(broker.snapshot.as_ref().unwrap()["new"], "appearance");
            broker.request_restore(None, None).unwrap();
            let current = broker.recovery_sequence;
            assert!(broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":5}}),
                    BTreeMap::new()
                )
                .unwrap());
            confirm(broker, current, 4);
            assert_eq!(
                broker.snapshot.as_ref().unwrap()["selection"]["deliveryGeneration"],
                5
            );
            assert!(!broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":3}}),
                    BTreeMap::new()
                )
                .unwrap());
            assert_eq!(
                broker.snapshot.as_ref().unwrap()["selection"]["deliveryGeneration"],
                5
            );
            broker.request_restore(None, None).unwrap();
            assert!(broker.recovery.is_some());
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_supersession_distinguishes_unposted_work_from_immutable_submissions() {
        let directory =
            std::env::temp_dir().join(format!("openpane-submission-{}", uuid::Uuid::new_v4()));
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.bind_host("a".into(), "profile-a".into()).unwrap();
            let a = broker.host.clone().unwrap();
            broker.request_restore(None, None).unwrap();
            let first = broker.recovery_sequence;
            assert_eq!(
                broker.scope_recovery(first, a.clone(), false).unwrap(),
                RecoveryAdmission::Accepted
            );
            broker.request_restore(None, None).unwrap();
            let second = broker.recovery_sequence;
            assert_eq!(
                broker.scope_recovery(first, a.clone(), false).unwrap(),
                RecoveryAdmission::Superseded
            );
            assert_eq!(
                broker.scope_recovery(first, a.clone(), true).unwrap(),
                RecoveryAdmission::Accepted
            );
            assert!(!broker.confirm_restore(first, 2, a.clone()).unwrap());
            assert_eq!(broker.recovery.as_ref().unwrap().sequence, second);
            confirm(broker, second, 3);
            assert_eq!(
                broker.scope_recovery(first, a.clone(), false).unwrap(),
                RecoveryAdmission::Cancelled
            );
            assert_eq!(
                broker.scope_recovery(first, a.clone(), true).unwrap(),
                RecoveryAdmission::Accepted
            );
            broker.bind_host("b".into(), "profile-b".into()).unwrap();
            assert_eq!(broker.scope_recovery(first, a, true), Err("wrong-host"));
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn foreign_binding_cancellation_survives_newer_same_profile_restore() {
        for settle_b in [false, true] {
            let directory = std::env::temp_dir().join(format!(
                "openpane-cancelled-sequence-{}",
                uuid::Uuid::new_v4()
            ));
            let windows = ChatWindows::new(
                Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
                &directory,
                true,
            );
            {
                let mut guard = windows.broker.lock().unwrap();
                let broker = guard.as_mut().unwrap();
                broker.bind_host("a".into(), "profile-a".into()).unwrap();
                let a = broker.host.clone().unwrap();
                broker.request_restore(None, None).unwrap();
                let cancelled = broker.recovery_sequence;
                assert_eq!(
                    broker.scope_recovery(cancelled, a.clone(), false).unwrap(),
                    RecoveryAdmission::Accepted
                );
                broker.bind_host("b".into(), "profile-b".into()).unwrap();
                if settle_b {
                    let b = broker.host.clone().unwrap();
                    broker.request_restore(None, None).unwrap();
                    let older_b = broker.recovery_sequence;
                    broker.request_restore(None, None).unwrap();
                    let settled_b = broker.recovery_sequence;
                    confirm(broker, settled_b, 4);
                    broker.bind_host("a".into(), "profile-a".into()).unwrap();
                    broker.bind_host("b".into(), "profile-b".into()).unwrap();
                    broker.request_restore(None, None).unwrap();
                    assert_eq!(broker.scope_recovery(older_b, b.clone(), false).unwrap(), RecoveryAdmission::Cancelled, "B history must be cancelled even when the bind away happened after latest B settled");
                    assert!(broker.recovery_cancelled(older_b).unwrap());
                    assert_eq!(
                        broker.scope_recovery(older_b, b, true).unwrap(),
                        RecoveryAdmission::Accepted
                    );
                }
                broker.bind_host("a".into(), "profile-a".into()).unwrap();
                broker.request_restore(None, None).unwrap();
                let same_profile = broker.recovery_sequence;
                broker.request_restore(None, None).unwrap();
                let latest = broker.recovery_sequence;
                assert_eq!(
                    broker.scope_recovery(cancelled, a.clone(), false).unwrap(),
                    RecoveryAdmission::Cancelled
                );
                assert_eq!(
                    broker.scope_recovery(cancelled, a.clone(), true).unwrap(),
                    RecoveryAdmission::Accepted,
                    "immutable submissions still replay under original authority"
                );
                assert_eq!(
                    broker
                        .scope_recovery(same_profile, a.clone(), false)
                        .unwrap(),
                    RecoveryAdmission::Superseded,
                    "ordinary same-profile supersession stays distinct"
                );
                assert_eq!(
                    broker.scope_recovery(latest, a.clone(), false).unwrap(),
                    RecoveryAdmission::Accepted
                );
                assert!(!broker.confirm_restore(cancelled, 5, a).unwrap());
                assert_eq!(broker.recovery.as_ref().unwrap().sequence, latest);
                assert!(broker.recovery_cancelled(cancelled).unwrap());
                assert!(!broker.recovery_cancelled(latest).unwrap());
                assert_eq!(broker.recovery_cancelled(0), Err("unknown-recovery"));
                assert_eq!(
                    broker.recovery_cancelled(latest + 1),
                    Err("unknown-recovery")
                );
            }
            drop(windows);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn cancellation_history_query_has_an_exact_main_document_wire_shape() {
        let valid =
            json!({"kind":"read-recovery-cancellation","incarnation":"document","sequence":1});
        assert!(matches!(
            serde_json::from_value::<Command>(valid.clone()).unwrap(),
            Command::ReadRecoveryCancellation { sequence: 1, .. }
        ));
        for invalid in [
            json!({"kind":"read-recovery-cancellation","sequence":1}),
            json!({"kind":"read-recovery-cancellation","incarnation":"document"}),
            json!({"kind":"read-recovery-cancellation","incarnation":"document","sequence":-1}),
            json!({"kind":"read-recovery-cancellation","incarnation":"document","sequence":1,"extra":true}),
        ] {
            assert!(serde_json::from_value::<Command>(invalid).is_err());
        }
    }

    #[test]
    fn resolved_startup_restore_is_never_reattributed_to_a_different_first_binding() {
        let directory =
            std::env::temp_dir().join(format!("openpane-pending-profile-{}", uuid::Uuid::new_v4()));
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.request_restore(None, None).unwrap();
            let sequence = broker.recovery_sequence;
            let a = UiRecoveryContext {
                host_id: "a".into(),
                profile_id: "profile-a".into(),
            };
            broker.scope_recovery(sequence, a.clone(), false).unwrap();
            assert_eq!(broker.recovery_context().unwrap().host_id, "a");
            broker.bind_host("b".into(), "profile-b".into()).unwrap();
            assert!(
                broker.recovery.is_none(),
                "a resolved request is cancelled, never advertised under B"
            );
            assert_eq!(
                broker
                    .scope_recovery(
                        sequence,
                        UiRecoveryContext {
                            host_id: "b".into(),
                            profile_id: "profile-b".into()
                        },
                        false
                    )
                    .unwrap(),
                RecoveryAdmission::Cancelled,
                "a delayed unscoped reply cannot claim a cancelled request for B"
            );
            assert_eq!(
                broker.confirm_restore(sequence, 5, a.clone()),
                Err("wrong-host")
            );
            assert_eq!(
                broker.scope_recovery(sequence, a, false),
                Err("wrong-host"),
                "the pre-write hook also rejects after B binds"
            );
            assert!(broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":0}}),
                    BTreeMap::new()
                )
                .unwrap());
            assert!(!broker.visual_builtin());
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn settled_restore_keeps_builtin_visible_until_a_qualifying_snapshot_arrives() {
        let directory =
            std::env::temp_dir().join(format!("openpane-visual-floor-{}", uuid::Uuid::new_v4()));
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.bind_host("a".into(), "profile-a".into()).unwrap();
            broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":1}}),
                    BTreeMap::new(),
                )
                .unwrap();
            broker.request_restore(None, None).unwrap();
            confirm(broker, broker.recovery_sequence, 2);
            assert!(
                broker.recovery.is_none(),
                "the host write is settled and must not be retried"
            );
            assert!(broker.snapshot.is_none());
            assert!(
                broker.visual_builtin(),
                "a child waking after confirmation must remove its old theme"
            );
            assert!(!broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":1}}),
                    BTreeMap::new()
                )
                .unwrap());
            assert!(broker.visual_builtin());
            assert!(broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":3}}),
                    BTreeMap::new()
                )
                .unwrap());
            assert!(!broker.visual_builtin());
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_restore_floor_does_not_cross_the_first_profile_binding() {
        let directory =
            std::env::temp_dir().join(format!("openpane-floor-profile-{}", uuid::Uuid::new_v4()));
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.request_restore(None, None).unwrap();
            broker
                .scope_recovery(
                    broker.recovery_sequence,
                    UiRecoveryContext {
                        host_id: "host-a".into(),
                        profile_id: "profile-a".into(),
                    },
                    false,
                )
                .unwrap();
            broker
                .confirm_restore(
                    broker.recovery_sequence,
                    5,
                    UiRecoveryContext {
                        host_id: "host-a".into(),
                        profile_id: "profile-a".into(),
                    },
                )
                .unwrap();
            broker
                .bind_host("host-b".into(), "profile-b".into())
                .unwrap();
            assert!(broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":0}}),
                    BTreeMap::new()
                )
                .unwrap());
            broker
                .request_restore(
                    Some(&UiRecoveryContext {
                        host_id: "host-b".into(),
                        profile_id: "profile-b".into(),
                    }),
                    None,
                )
                .unwrap();
            let sequence = broker.recovery_sequence;
            assert_eq!(
                broker.confirm_restore(
                    sequence,
                    7,
                    UiRecoveryContext {
                        host_id: "host-a".into(),
                        profile_id: "profile-a".into()
                    }
                ),
                Err("wrong-host")
            );
            assert!(broker.recovery.is_some());
            assert!(broker
                .confirm_restore(
                    sequence,
                    1,
                    UiRecoveryContext {
                        host_id: "host-b".into(),
                        profile_id: "profile-b".into()
                    }
                )
                .unwrap());
            broker.opening.insert(
                "child".into(),
                Scope {
                    host_id: "host-b".into(),
                    conversation_id: "chat".into(),
                },
            );
            assert_eq!(
                broker
                    .bind_host("host-c".into(), "profile-c".into())
                    .unwrap_err(),
                "host-change-with-live-children"
            );
            assert!(!broker
                .publish_snapshot(
                    json!({"selection":{"deliveryGeneration":0}}),
                    BTreeMap::new()
                )
                .unwrap());
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelling_one_independent_close_preserves_another_pending_close() {
        let directory = std::env::temp_dir().join(format!(
            "openpane-independent-close-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            assert_eq!(broker.begin_close("first").unwrap(), vec!["first"]);
            assert_eq!(broker.begin_close("second").unwrap(), vec!["second"]);
            let attempt = broker
                .pending_closes
                .get("first")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            broker.cancel_close_for("first", &attempt).unwrap();
            assert!(!broker.pending_closes.contains_key("first"));
            assert!(broker.pending_closes.contains_key("second"));
            assert!(!broker.main_closing);
            broker.begin_close("main").unwrap();
            let attempt = broker
                .pending_closes
                .get("second")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            broker.cancel_close_for("second", &attempt).unwrap();
            assert!(broker.pending_closes.is_empty());
            assert!(!broker.main_closing);
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelling_quit_or_main_navigation_preserves_an_independent_chat_close() {
        let directory =
            std::env::temp_dir().join(format!("openpane-close-origins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            for label in ["main", "first", "second"] {
                broker.documents.insert(
                    label.into(),
                    Document {
                        nonce: label.into(),
                        incarnation: label.into(),
                        scope: None,
                        view_id: label.into(),
                        visible: true,
                        presence_sequence: 0,
                        display: None,
                        ready: true,
                    },
                );
            }
            broker.begin_close("second").unwrap();
            let independent_attempt = broker
                .pending_closes
                .get("second")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            broker.begin_close("second").unwrap();
            assert_eq!(
                broker
                    .pending_closes
                    .get("second")
                    .map(|pending| &pending.attempt_id),
                Some(&independent_attempt)
            );
            broker.begin_close("main").unwrap();
            let attempt = broker
                .pending_closes
                .get("first")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            broker.cancel_close_for("first", &attempt).unwrap();
            assert_eq!(
                broker
                    .pending_closes
                    .get("second")
                    .map(|pending| &pending.attempt_id),
                Some(&independent_attempt)
            );
            assert!(!broker.main_closing);
            assert!(!broker.pending_closes.contains_key("first"));
            assert!(broker.pending_closes.contains_key("second"));
            broker.begin_close("main").unwrap();
            broker.cancel_close();
            assert_eq!(
                broker
                    .pending_closes
                    .get("second")
                    .map(|pending| &pending.attempt_id),
                Some(&independent_attempt)
            );
            assert!(!broker.main_closing);
            assert!(!broker.pending_closes.contains_key("first"));
            assert!(broker.pending_closes.contains_key("second"));
            broker.finish_close("second").unwrap();
            assert!(!broker.pending_closes.contains_key("second"));
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelled_quit_rejects_a_late_close_completion_but_preserves_independent_close() {
        let directory = std::env::temp_dir().join(format!(
            "openpane-close-completion-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            for label in ["main", "first", "second"] {
                broker.documents.insert(
                    label.into(),
                    Document {
                        nonce: label.into(),
                        incarnation: label.into(),
                        scope: None,
                        view_id: label.into(),
                        visible: true,
                        presence_sequence: 0,
                        display: None,
                        ready: true,
                    },
                );
            }
            broker.begin_close("main").unwrap();
            let second_attempt = broker
                .pending_closes
                .get("second")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            assert!(broker.authorize_close("second", &second_attempt).is_ok());
            let attempt = broker
                .pending_closes
                .get("first")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            broker.cancel_close_for("first", &attempt).unwrap();
            assert!(
                windows.document(broker, "second", "second").is_ok(),
                "document identity remains valid after quit cancellation"
            );
            assert_eq!(
                broker.authorize_close("second", &second_attempt),
                Err("close-request-cancelled")
            );
            assert!(broker.documents.contains_key("second"));
            broker.begin_close("second").unwrap();
            broker.begin_close("main").unwrap();
            let attempt = broker
                .pending_closes
                .get("first")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            broker.cancel_close_for("first", &attempt).unwrap();
            let second_attempt = broker
                .pending_closes
                .get("second")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            assert!(broker.authorize_close("second", &second_attempt).is_ok());
            assert!(broker.documents.contains_key("second"));
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn quit_keeps_main_registered_until_children_finish_and_can_be_cancelled() {
        let directory =
            std::env::temp_dir().join(format!("openpane-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            for label in ["main", "first", "second"] {
                broker.documents.insert(
                    label.into(),
                    Document {
                        nonce: label.into(),
                        incarnation: label.into(),
                        scope: None,
                        view_id: label.into(),
                        visible: true,
                        presence_sequence: 0,
                        display: None,
                        ready: true,
                    },
                );
            }
            assert_eq!(broker.begin_close("main").unwrap(), vec!["first", "second"]);
            assert!(broker.pending_closes.contains_key("first"));
            assert!(broker.pending_closes.contains_key("second"));
            assert!(broker.documents.contains_key("main"));
            assert_eq!(
                broker.finish_close("main").unwrap_err(),
                "children-still-saving"
            );
            assert_eq!(broker.finish_close("first").unwrap(), CloseProgress::Idle);
            broker.cancel_close();
            assert!(broker.pending_closes.is_empty());
            assert!(!broker.main_closing);
            assert_eq!(broker.finish_close("second").unwrap(), CloseProgress::Idle);
            assert!(broker.documents.contains_key("main"));
            broker.opening.insert(
                "still-opening".into(),
                Scope {
                    host_id: "host".into(),
                    conversation_id: "opening".into(),
                },
            );
            assert_eq!(
                broker.abandon_unregistered_openings(),
                vec!["still-opening"]
            );
            assert_eq!(broker.begin_close("main").unwrap(), vec!["main"]);
            assert_eq!(broker.close_progress().unwrap(), CloseProgress::Idle);
            assert_eq!(broker.close_progress().unwrap(), CloseProgress::Idle);
            assert!(broker.documents.contains_key("main"));
            assert_eq!(broker.finish_close("main").unwrap(), CloseProgress::Quit);
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn inline_intents_at_the_child_limit_do_not_overadmit_detached_windows() {
        for admitted in [31, 32] {
            let directory =
                std::env::temp_dir().join(format!("openpane-assigned-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let windows = ChatWindows::new(
                Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
                &directory,
                true,
            );
            {
                let mut guard = windows.broker.lock().unwrap();
                let broker = guard.as_mut().unwrap();
                broker.host = Some(UiRecoveryContext {
                    host_id: "host".into(),
                    profile_id: "profile".into(),
                });
                for n in 0..admitted {
                    windows
                        .reserve(
                            broker,
                            Scope {
                                host_id: "host".into(),
                                conversation_id: format!("native-{n}"),
                            },
                            format!("view-{n}"),
                            None,
                            false,
                            None,
                        )
                        .unwrap();
                }
                let source = Scope {
                    host_id: "host".into(),
                    conversation_id: "source".into(),
                };
                let scope = Scope {
                    host_id: "host".into(),
                    conversation_id: "inline-or-detached".into(),
                };
                let target = broker
                    .storage
                    .mutate(&windows.origin, |profile| {
                        profile.intent(
                            source.clone(),
                            "1:allocated".into(),
                            Action::Create {
                                agent_id: "agent".into(),
                                carry: false,
                            },
                        )?;
                        Ok(profile
                            .assign_intent(
                                &source,
                                "1:allocated",
                                Reservation {
                                    scope: scope.clone(),
                                    view_id: "allocated-view".into(),
                                    label: "allocated-label".into(),
                                    transition_id: "allocated-transition".into(),
                                    creation_agent_id: Some("agent".into()),
                                    phase: Phase::Assigned,
                                    binding_revision: None,
                                    writer_generation: None,
                                },
                                false,
                                None,
                            )?
                            .target
                            .unwrap())
                    })
                    .unwrap();
                assert_eq!(target.phase, Phase::Assigned);
                let reserved = windows.reserve(
                    broker,
                    scope.clone(),
                    target.view_id.clone(),
                    Some("agent".into()),
                    false,
                    None,
                );
                if admitted == 32 {
                    assert!(matches!(reserved, Err("native-window-limit")));
                    broker
                        .storage
                        .mutate(&windows.origin, |profile| {
                            profile.complete_intent(
                                &source,
                                "1:allocated",
                                json!({"kind":"inline","scope":scope}),
                            )
                        })
                        .unwrap();
                    assert_eq!(
                        broker.storage.profile(&windows.origin).unwrap().windows[&scope.key()]
                            .phase,
                        Phase::InlineReady
                    );
                } else {
                    assert_eq!(reserved.unwrap().phase, Phase::Requested);
                }
                assert!(matches!(
                    windows.reserve(
                        broker,
                        Scope {
                            host_id: "host".into(),
                            conversation_id: "overflow".into()
                        },
                        "overflow-view".into(),
                        None,
                        false,
                        None
                    ),
                    Err("native-window-limit")
                ));
            }
            drop(windows);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn overlapping_reservations_keep_the_committed_transition_and_enforce_live_capacity() {
        let directory = std::env::temp_dir().join(format!(
            "openpane-native-admission-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    for n in 0..32 {
                        profile.reserve(Reservation {
                            scope: Scope {
                                host_id: "archived-host".into(),
                                conversation_id: format!("old-{n}"),
                            },
                            view_id: format!("old-view-{n}"),
                            label: format!("old-label-{n}"),
                            transition_id: format!("old-transition-{n}"),
                            creation_agent_id: None,
                            phase: Phase::Requested,
                            binding_revision: None,
                            writer_generation: None,
                        })?;
                    }
                    Ok(())
                })
                .unwrap();
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "one".into(),
            };
            let first = windows
                .reserve(broker, scope.clone(), "view".into(), None, true, None)
                .unwrap();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.windows.get_mut(&scope.key()).unwrap().phase = Phase::TransferCommitted;
                    Ok(())
                })
                .unwrap();
            let second = windows
                .reserve(broker, scope.clone(), "view".into(), None, true, None)
                .unwrap();
            assert_eq!(first.transition_id, second.transition_id);
            assert_eq!(second.phase, Phase::TransferCommitted);
            for n in 1..32 {
                windows
                    .reserve(
                        broker,
                        Scope {
                            host_id: "host".into(),
                            conversation_id: format!("chat-{n}"),
                        },
                        format!("view-{n}"),
                        None,
                        false,
                        None,
                    )
                    .unwrap();
            }
            assert!(matches!(
                windows.reserve(
                    broker,
                    Scope {
                        host_id: "host".into(),
                        conversation_id: "overflow".into()
                    },
                    "extra".into(),
                    None,
                    false,
                    None
                ),
                Err("native-window-limit")
            ));
            assert!(matches!(
                windows.require_host(
                    broker,
                    &Scope {
                        host_id: "other".into(),
                        conversation_id: "one".into()
                    }
                ),
                Err("foreign-host")
            ));
            assert_eq!(
                broker
                    .storage
                    .profile(&windows.origin)
                    .unwrap()
                    .windows
                    .len(),
                64
            );
            let document = Document {
                nonce: "nonce".into(),
                incarnation: "old".into(),
                scope: None,
                view_id: "main".into(),
                visible: true,
                presence_sequence: 0,
                display: None,
                ready: true,
            };
            broker.documents.insert("main".into(), document.clone());
            let old = broker.advance_presence("main").unwrap();
            broker.documents.insert(
                "main".into(),
                Document {
                    incarnation: "replacement".into(),
                    ..document
                },
            );
            assert!(broker.advance_presence("main").unwrap() > old);
            assert!(windows.document(broker, "main", "old").is_err());
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn a_registered_ready_child_cannot_be_retagged_as_a_fresh_reservation() {
        let directory = std::env::temp_dir().join(format!(
            "openpane-live-reservation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "still-live".into(),
            };
            let reservation = windows
                .reserve(broker, scope.clone(), "live-view".into(), None, false, None)
                .unwrap();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile
                        .windows
                        .get_mut(&scope.key())
                        .unwrap()
                        .confirm_binding(2, 3)
                })
                .unwrap();
            let before = serde_json::to_value(
                &broker.storage.profile(&windows.origin).unwrap().windows[&scope.key()],
            )
            .unwrap();
            broker.documents.insert(
                reservation.label.clone(),
                Document {
                    nonce: "live-nonce".into(),
                    incarnation: "live-incarnation".into(),
                    scope: Some(scope.clone()),
                    view_id: reservation.view_id.clone(),
                    visible: true,
                    presence_sequence: 0,
                    display: None,
                    ready: true,
                },
            );
            assert_eq!(
                windows
                    .reserve(broker, scope.clone(), reservation.view_id, None, true, None)
                    .unwrap_err(),
                "target-still-open"
            );
            assert_eq!(
                serde_json::to_value(
                    &broker.storage.profile(&windows.origin).unwrap().windows[&scope.key()]
                )
                .unwrap(),
                before
            );
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn assignment_accepts_optional_view_and_rejects_split_observation_hints() {
        let mut command = json!({"kind":"assign-intent","incarnation":"main","sourceScope":{"hostId":"host","conversationId":"source"},"requestId":"1:atomic","scope":{"hostId":"host","conversationId":"target"},"viewId":null,"creationAgentId":null});
        assert!(matches!(
            serde_json::from_value::<Command>(command.clone()).unwrap(),
            Command::AssignIntent { view_id: None, .. }
        ));
        command["viewId"] = json!("indexeddb-view");
        assert!(
            matches!(serde_json::from_value::<Command>(command.clone()).unwrap(), Command::AssignIntent { view_id: Some(view_id), .. } if view_id == "indexeddb-view")
        );
        command["observedReadyTransitionId"] = json!("obsolete-split-observation");
        assert!(serde_json::from_value::<Command>(command).is_err());
    }
    #[test]
    fn assigning_current_opening_is_atomic_with_ready_and_close() {
        for at_assignment in ["opening", "ready", "closed", "reopened"] {
            let directory = std::env::temp_dir().join(format!(
                "openpane-atomic-assignment-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir(&directory).unwrap();
            let windows = ChatWindows::new(
                Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
                &directory,
                true,
            );
            {
                let mut guard = windows.broker.lock().unwrap();
                let broker = guard.as_mut().unwrap();
                broker.host = Some(UiRecoveryContext {
                    host_id: "host".into(),
                    profile_id: "profile".into(),
                });
                let scope = Scope {
                    host_id: "host".into(),
                    conversation_id: "target".into(),
                };
                let source = Scope {
                    host_id: "host".into(),
                    conversation_id: "source".into(),
                };
                let original = windows
                    .reserve(
                        broker,
                        scope.clone(),
                        "atomic-view".into(),
                        None,
                        false,
                        None,
                    )
                    .unwrap();
                broker.opening.insert(original.label.clone(), scope.clone());
                if at_assignment != "opening" {
                    broker
                        .storage
                        .mutate(&windows.origin, |profile| {
                            let entry = profile.windows.get_mut(&scope.key()).unwrap();
                            entry.confirm_binding(2, 3)?;
                            let ready = entry.clone();
                            profile.preserve_child_ready(&ready);
                            Ok(())
                        })
                        .unwrap();
                }
                if matches!(at_assignment, "closed" | "reopened") {
                    broker.opening.remove(&original.label);
                }
                let expected = if at_assignment == "reopened" {
                    let next = windows
                        .reserve(
                            broker,
                            scope.clone(),
                            original.view_id.clone(),
                            None,
                            true,
                            None,
                        )
                        .unwrap();
                    broker.opening.insert(next.label.clone(), scope.clone());
                    next
                } else {
                    original.clone()
                };
                let closed = !broker.opening.values().any(|live| live == &scope)
                    && !broker
                        .documents
                        .values()
                        .any(|document| document.scope.as_ref() == Some(&scope));
                let assigned = broker
                    .storage
                    .mutate(&windows.origin, |profile| {
                        profile.intent(
                            source.clone(),
                            "1:atomic".into(),
                            Action::Open {
                                scope: scope.clone(),
                                passive: false,
                                carry: false,
                            },
                        )?;
                        let mut proposed = expected.clone();
                        proposed.transition_id = "fresh-closed-attempt".into();
                        profile.assign_intent(&source, "1:atomic", proposed, closed, None)
                    })
                    .unwrap()
                    .target
                    .unwrap();
                if at_assignment == "closed" {
                    assert_eq!(assigned.transition_id, "fresh-closed-attempt");
                    assert_eq!(assigned.phase, Phase::Assigned);
                } else {
                    assert_eq!(assigned.transition_id, expected.transition_id);
                    assert_eq!(
                        assigned.phase,
                        if at_assignment == "ready" {
                            Phase::TargetReady
                        } else {
                            Phase::Requested
                        }
                    );
                }
                if at_assignment == "opening" {
                    broker
                        .storage
                        .mutate(&windows.origin, |profile| {
                            let entry = profile.windows.get_mut(&scope.key()).unwrap();
                            entry.confirm_binding(2, 3)?;
                            let ready = entry.clone();
                            profile.preserve_child_ready(&ready);
                            Ok(())
                        })
                        .unwrap();
                    broker.opening.remove(&original.label);
                    assert_eq!(
                        broker.lookup_window(&windows.origin, &scope).unwrap()["kind"],
                        "closed"
                    );
                    let intent = broker
                        .storage
                        .profile(&windows.origin)
                        .unwrap()
                        .intents
                        .get(&crate::chat_window_records::Profile::intent_key(
                            &source, "1:atomic",
                        ))
                        .unwrap();
                    assert_eq!(intent.target.as_ref().unwrap().phase, Phase::TargetReady);
                }
                broker
                    .storage
                    .profile(&windows.origin)
                    .unwrap()
                    .validate()
                    .unwrap();
            }
            drop(windows);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn delegated_intent_fences_reserve_and_launch_admission_after_child_ready() {
        let directory =
            std::env::temp_dir().join(format!("openpane-intent-fence-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut lock = windows.broker.lock().unwrap();
            let broker = lock.as_mut().unwrap();
            broker.host = Some(UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile".into(),
            });
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "target".into(),
            };
            let source = Scope {
                host_id: "host".into(),
                conversation_id: "source".into(),
            };
            let first = windows
                .reserve(
                    broker,
                    scope.clone(),
                    "fenced-view".into(),
                    None,
                    false,
                    None,
                )
                .unwrap();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.intent(
                        source.clone(),
                        "1:fenced".into(),
                        Action::Open {
                            scope: scope.clone(),
                            passive: false,
                            carry: true,
                        },
                    )?;
                    profile.assign_intent(&source, "1:fenced", first.clone(), false, None)?;
                    Ok(())
                })
                .unwrap();
            let reference = IntentRef {
                source_scope: source.clone(),
                request_id: "1:fenced".into(),
            };
            windows
                .reserve(
                    broker,
                    scope.clone(),
                    first.view_id.clone(),
                    None,
                    false,
                    Some(&reference),
                )
                .unwrap();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    let entry = profile.windows.get_mut(&scope.key()).unwrap();
                    entry.confirm_binding(2, 3)?;
                    let ready = entry.clone();
                    profile.preserve_child_ready(&ready);
                    Ok(())
                })
                .unwrap();
            let before =
                serde_json::to_value(broker.storage.profile(&windows.origin).unwrap()).unwrap();
            assert_eq!(
                windows
                    .reserve(
                        broker,
                        scope.clone(),
                        first.view_id.clone(),
                        None,
                        true,
                        Some(&reference)
                    )
                    .unwrap_err(),
                "intent-already-ready"
            );
            assert_eq!(
                windows.admit_child(broker, &scope, Some(&reference)),
                Err("intent-already-ready")
            );
            let wrong = IntentRef {
                source_scope: Scope {
                    host_id: "foreign".into(),
                    conversation_id: "source".into(),
                },
                request_id: reference.request_id.clone(),
            };
            assert!(windows.admit_child(broker, &scope, Some(&wrong)).is_err());
            assert_eq!(
                serde_json::to_value(broker.storage.profile(&windows.origin).unwrap()).unwrap(),
                before
            );
            // An ordinary new catalog open still has explicit permission to reopen the closed chat.
            let explicit = windows
                .reserve(broker, scope.clone(), first.view_id, None, true, None)
                .unwrap();
            assert_ne!(explicit.transition_id, first.transition_id);
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn creating_launch_reattaches_unready_handoff_after_inline_recovery_but_preserves_old_ready() {
        for already_ready in [false, true] {
            let directory = std::env::temp_dir()
                .join(format!("openpane-intent-recovery-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let windows = ChatWindows::new(
                Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
                &directory,
                true,
            );
            {
                let mut lock = windows.broker.lock().unwrap();
                let broker = lock.as_mut().unwrap();
                broker.host = Some(UiRecoveryContext {
                    host_id: "host".into(),
                    profile_id: "profile".into(),
                });
                let scope = Scope {
                    host_id: "host".into(),
                    conversation_id: "target".into(),
                };
                let source = Scope {
                    host_id: "host".into(),
                    conversation_id: "source".into(),
                };
                let first = windows
                    .reserve(
                        broker,
                        scope.clone(),
                        "recovered-view".into(),
                        None,
                        false,
                        None,
                    )
                    .unwrap();
                broker
                    .storage
                    .mutate(&windows.origin, |profile| {
                        profile.intent(
                            source.clone(),
                            "1:recover".into(),
                            Action::Open {
                                scope: scope.clone(),
                                passive: false,
                                carry: true,
                            },
                        )?;
                        profile.assign_intent(&source, "1:recover", first.clone(), false, None)?;
                        let entry = profile.windows.get_mut(&scope.key()).unwrap();
                        entry.phase = Phase::SourceReleased;
                        let launched = entry.clone();
                        profile.attach_launched_intents(&launched);
                        if already_ready {
                            let entry = profile.windows.get_mut(&scope.key()).unwrap();
                            entry.confirm_binding(2, 3)?;
                            let ready = entry.clone();
                            profile.preserve_child_ready(&ready);
                        }
                        let entry = profile.windows.get_mut(&scope.key()).unwrap();
                        entry.phase = Phase::Failed;
                        entry.recover_inline(&first.transition_id)?;
                        entry.phase = Phase::InlineReady;
                        Ok(())
                    })
                    .unwrap();
                let canonical = directory.join("chat-windows-v1.json");
                let backup = directory.join("before-completion.json");
                std::fs::rename(&canonical, &backup).unwrap();
                std::fs::create_dir(&canonical).unwrap();
                let completion = if already_ready {
                    json!({"kind":"detached","scope":scope,"label":first.label})
                } else {
                    json!({"kind":"inline","scope":scope})
                };
                assert!(broker
                    .storage
                    .mutate(&windows.origin, |profile| profile.complete_intent(
                        &source,
                        "1:recover",
                        completion
                    ))
                    .is_err());
                std::fs::remove_dir(&canonical).unwrap();
                std::fs::rename(&backup, &canonical).unwrap();
                assert!(broker.storage.profile(&windows.origin).unwrap().intents
                    [&crate::chat_window_records::Profile::intent_key(&source, "1:recover")]
                    .result
                    .is_none());
                let second = windows
                    .reserve(
                        broker,
                        scope.clone(),
                        first.view_id.clone(),
                        None,
                        true,
                        None,
                    )
                    .unwrap();
                assert_ne!(second.transition_id, first.transition_id);
                windows.admit_child(broker, &scope, None).unwrap();
                broker
                    .storage
                    .mutate(&windows.origin, |profile| {
                        let entry = profile.windows.get_mut(&scope.key()).unwrap();
                        entry.phase = Phase::SourceReleased;
                        let committed = entry.clone();
                        profile.attach_launched_intents(&committed);
                        let entry = profile.windows.get_mut(&scope.key()).unwrap();
                        entry.confirm_binding(5, 6)?;
                        let ready = entry.clone();
                        profile.preserve_child_ready(&ready);
                        Ok(())
                    })
                    .unwrap();
                let saved = &broker.storage.profile(&windows.origin).unwrap().intents
                    [&crate::chat_window_records::Profile::intent_key(&source, "1:recover")];
                assert!(saved.result.is_none());
                assert_eq!(saved.target.as_ref().unwrap().phase, Phase::TargetReady);
                assert_eq!(
                    &saved.target.as_ref().unwrap().transition_id,
                    if already_ready {
                        &first.transition_id
                    } else {
                        &second.transition_id
                    }
                );
            }
            drop(windows);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn delayed_cancel_from_previous_quit_does_not_cancel_new_quit() {
        let directory =
            std::env::temp_dir().join(format!("openpane-close-attempt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            for label in ["main", "first", "second"] {
                broker.documents.insert(
                    label.into(),
                    Document {
                        nonce: label.into(),
                        incarnation: label.into(),
                        scope: None,
                        view_id: label.into(),
                        visible: true,
                        presence_sequence: 0,
                        display: None,
                        ready: true,
                    },
                );
            }
            broker.begin_close("main").unwrap();
            let first_quit = broker.pending_closes.clone();
            broker.begin_close("main").unwrap();
            assert_eq!(
                broker.pending_closes, first_quit,
                "repeated Quit keeps the active attempts"
            );
            let second_attempt = broker
                .pending_closes
                .get("second")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            let attempt = broker
                .pending_closes
                .get("first")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            broker.cancel_close_for("first", &attempt).unwrap();
            assert_eq!(
                broker.authorize_close("second", &second_attempt),
                Err("close-request-cancelled")
            );
            // Hold delivery of that rejection while the user starts Quit again.
            broker.begin_close("main").unwrap();
            let current = broker
                .pending_closes
                .get("second")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            assert_ne!(second_attempt, current);
            assert_eq!(
                broker.authorize_close("second", &second_attempt),
                Err("close-request-cancelled")
            );
            assert_eq!(
                broker.cancel_close_for("second", &second_attempt),
                Err("close-request-cancelled")
            );
            assert!(broker.authorize_close("second", &current).is_ok());
            assert!(
                broker.main_closing,
                "the previous close-ready rejection must not cancel the new Quit"
            );
            assert!(broker.pending_closes.contains_key("first"));
            assert!(broker.pending_closes.contains_key("second"));
            broker.documents.get_mut("second").unwrap().incarnation = "reloaded-second".into();
            assert_eq!(
                windows.document(broker, "second", "second").err(),
                Some("stale-document")
            );
            assert!(windows
                .document(broker, "second", "reloaded-second")
                .is_ok());
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn close_wire_requires_an_attempt_id_alongside_the_document_incarnation() {
        for kind in ["close-ready", "close-cancelled"] {
            assert!(serde_json::from_value::<Command>(
                json!({"kind":kind,"incarnation":"document","attemptId":"42"})
            )
            .is_ok());
            assert!(serde_json::from_value::<Command>(
                json!({"kind":kind,"incarnation":"document"})
            )
            .is_err());
            assert!(
                serde_json::from_value::<Command>(json!({"kind":kind,"attemptId":"42"})).is_err()
            );
        }
    }
    #[test]
    fn repeated_main_only_quit_replays_the_same_pending_attempt_after_undelivered_cancel() {
        let directory =
            std::env::temp_dir().join(format!("openpane-repeat-main-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            broker.documents.insert(
                "main".into(),
                Document {
                    nonce: "main".into(),
                    incarnation: "main".into(),
                    scope: None,
                    view_id: "main".into(),
                    visible: true,
                    presence_sequence: 0,
                    display: None,
                    ready: true,
                },
            );
            assert_eq!(broker.begin_close("main").unwrap(), vec!["main"]);
            let attempt = broker
                .pending_closes
                .get("main")
                .map(|pending| &pending.attempt_id)
                .unwrap()
                .clone();
            // prepare failed, but cancellation never reached the broker.
            assert_eq!(
                broker.begin_close("main").unwrap(),
                vec!["main"],
                "explicit Quit again must wake cancellation retry"
            );
            assert_eq!(
                broker
                    .pending_closes
                    .get("main")
                    .map(|pending| &pending.attempt_id),
                Some(&attempt)
            );
            broker.cancel_close_for("main", &attempt).unwrap();
            assert!(!broker.main_closing);
            assert!(!broker.pending_closes.contains_key("main"));
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn inline_recovery_requires_exact_profile_and_restore_wake_correlates_initiator() {
        let command: Command = serde_json::from_value(json!({"kind":"recover-inline","incarnation":"document","scope":{"hostId":"host","conversationId":"chat"},"expectedTransitionId":"closed","expectedContext":{"hostId":"host","profileId":"profile-a"}})).unwrap();
        assert!(
            matches!(command, Command::RecoverInline { expected_context, .. } if expected_context.profile_id == "profile-a")
        );
        assert!(serde_json::from_value::<Command>(json!({"kind":"recover-inline","incarnation":"document","scope":{"hostId":"host","conversationId":"chat"},"expectedTransitionId":"closed"})).is_err());
        let command: Command = serde_json::from_value(
            json!({"kind":"restore-builtin","incarnation":"document","requestId":"request-1"}),
        )
        .unwrap();
        assert!(
            matches!(command, Command::RestoreBuiltin { request_id: Some(id), .. } if id == "request-1")
        );
        let directory =
            std::env::temp_dir().join(format!("openpane-inline-profile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let windows = ChatWindows::new(
            Some("http://127.0.0.1:17777/browser.html".parse().unwrap()),
            &directory,
            true,
        );
        {
            let mut guard = windows.broker.lock().unwrap();
            let broker = guard.as_mut().unwrap();
            let a = UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile-a".into(),
            };
            let b = UiRecoveryContext {
                host_id: "host".into(),
                profile_id: "profile-b".into(),
            };
            broker
                .bind_host(a.host_id.clone(), a.profile_id.clone())
                .unwrap();
            assert!(broker.require_recovery_context(&a).is_ok());
            broker
                .bind_host(b.host_id.clone(), b.profile_id.clone())
                .unwrap();
            assert_eq!(
                broker.require_recovery_context(&a).unwrap_err(),
                "wrong-host"
            );
            assert!(broker.require_recovery_context(&b).is_ok());
            assert!(broker.recovery.is_none());
            broker
                .request_restore(Some(&b), Some("request-1".into()))
                .unwrap();
            assert_eq!(
                broker.recovery_state(),
                json!({"pending":true,"sequence":1,"initiator":"request-1","hostId":"host","profileId":"profile-b"})
            );
            broker.request_restore(None, None).unwrap();
            assert_eq!(broker.recovery_state()["initiator"], Value::Null);
        }
        drop(windows);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

mod intents;
mod types;
mod ui;
pub use types::Command;

use crate::chat_window_records::{identifier, Action, Intent, Phase, Reservation, Scope};
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
struct Broker {
    storage: Storage,
    presence_clock: u64,
    documents: BTreeMap<String, Document>,
    opening: BTreeMap<String, Scope>,
    host: Option<(String, String)>,
    snapshot: Option<Value>,
    reports: BTreeMap<String, Value>,
    child_snapshots: BTreeMap<String, Value>,
    local_builtin: bool,
    recovery_sequence: u64,
    main_closing: bool,
    main_close_requested: bool,
    pending_closes: std::collections::BTreeSet<String>,
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
        if self
            .host
            .as_ref()
            .is_some_and(|previous| previous != &(host_id.clone(), profile_id.clone()))
        {
            if self.children_open() {
                return Err(
                    "Close chat windows and restart OpenPane after the host identity changes.",
                );
            }
            self.snapshot = None;
            self.child_snapshots.clear();
            self.reports.clear();
        }
        self.host = Some((host_id, profile_id));
        Ok(())
    }
    fn request_restore(&mut self) -> Result<(), &'static str> {
        self.recovery_sequence = self
            .recovery_sequence
            .checked_add(1)
            .ok_or("recovery-sequence-exhausted")?;
        self.local_builtin = true;
        Ok(())
    }
    fn confirm_restore(&mut self, sequence: u64) {
        if self.recovery_sequence == sequence {
            self.local_builtin = false;
        }
    }

    fn lookup_window(&self, origin: &str, scope: &Scope) -> Result<Value, &'static str> {
        let Some(reservation) = self.storage.profile(origin)?.windows.get(&scope.key()) else {
            return Ok(json!({"kind":"absent"}));
        };
        let ready = self
            .documents
            .get(&reservation.label)
            .is_some_and(|document| {
                document.ready
                    && document.scope.as_ref() == Some(scope)
                    && document.view_id == reservation.view_id
            });
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
    fn close_progress(&mut self) -> CloseProgress {
        if !self.main_closing || self.children_open() {
            return CloseProgress::Idle;
        }
        if self.documents.is_empty() {
            return CloseProgress::Quit;
        }
        if self.main_close_requested {
            return CloseProgress::Idle;
        }
        self.main_close_requested = true;
        self.pending_closes.insert("main".into());
        CloseProgress::RequestMain
    }
    fn begin_close(&mut self, label: &str) -> Vec<String> {
        if label != "main" {
            self.pending_closes.insert(label.into());
            return vec![label.into()];
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
            if self.main_close_requested {
                return Vec::new();
            }
            self.main_close_requested = true;
            self.pending_closes.insert("main".into());
            return vec!["main".into()];
        }
        self.pending_closes.extend(labels.iter().cloned());
        labels.into_iter().collect()
    }
    fn cancel_close(&mut self) {
        self.main_closing = false;
        self.main_close_requested = false;
        self.pending_closes.clear();
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
        Ok(self.close_progress())
    }
    fn advance_presence(&mut self, label: &str) -> Result<u64, &'static str> {
        if self.presence_clock >= 9_007_199_254_740_991 {
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
                    local_builtin: false,
                    recovery_sequence: 0,
                    main_closing: false,
                    main_close_requested: false,
                    pending_closes: std::collections::BTreeSet::new(),
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
        let (host_id, profile_id) = broker.host.as_ref()?;
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
        if broker.host.as_ref().ok_or("ui-context-not-bound")?.0 != scope.host_id {
            return Err("foreign-host");
        }
        Ok(())
    }
    fn admit_child(&self, broker: &Broker, scope: &Scope) -> Result<(), &'static str> {
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
                            Phase::Assigned | Phase::TargetReady | Phase::Failed
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
    fn reserve(
        &self,
        broker: &mut Broker,
        scope: Scope,
        view_id: String,
        creation_agent_id: Option<String>,
        new_transition: bool,
    ) -> Result<Reservation, &'static str> {
        self.admit_child(broker, &scope)?;
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
            .any(|scope| scope == &reservation.scope);
        broker.storage.mutate(&self.origin, |profile| {
            let key = reservation.scope.key();
            let mut reserved = profile.reserve(reservation)?;
            if new_transition && matches!(reserved.phase, Phase::TargetReady | Phase::Failed) {
                if live {
                    return Err("target-still-open");
                }
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
        broker.request_restore()?;
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
                let labels = broker.begin_close(label);
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
        if label == "main" {
            return;
        }
        let progress = if let Ok(mut guard) = self.broker.lock() {
            if let Ok(broker) = guard.as_mut() {
                broker.documents.remove(label);
                broker.opening.remove(label);
                broker.close_progress()
            } else {
                CloseProgress::Idle
            }
        } else {
            CloseProgress::Idle
        };
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
        apply_close_progress(app, progress);
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
                apply_close_progress(app, progress);
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
            } => {
                self.require_main(broker, label, &incarnation)?;
                if !self.live_relay {
                    return Err("unsupported-live-relay");
                }
                let reservation =
                    self.reserve(broker, scope, view_id, creation_agent_id, new_transition)?;
                Ok(serde_json::to_value(reservation).map_err(|_| "native-serialization-failed")?)
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
                    let entry = profile
                        .windows
                        .get_mut(&scope.key())
                        .ok_or("unknown-reservation")?;
                    if entry.scope != scope || entry.transition_id != transition_id {
                        return Err("stale-transition");
                    }
                    let allowed = (entry.transition_id.starts_with("inline:")
                        && entry.phase == Phase::Failed
                        && phase == Phase::TargetReady)
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
            } => {
                self.require_main(broker, label, &incarnation)?;
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
                self.admit_child(broker, &scope)?;
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
                    return if broker
                        .documents
                        .get(&reservation.label)
                        .is_some_and(|document| {
                            document.ready
                                && document.scope.as_ref() == Some(&reservation.scope)
                                && document.view_id == reservation.view_id
                        }) {
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
                if reservation.creation_agent_id.is_none()
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
                if binding.schema_version != 1
                    || binding.kind != "editing"
                    || document.scope.as_ref() != Some(&binding.scope)
                    || document.view_id != binding.view_id
                    || binding.revision == 0
                    || binding.writer_generation == 0
                    || binding.revision > 9_007_199_254_740_991
                    || binding.writer_generation > 9_007_199_254_740_991
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
                    entry.confirm_binding(binding.revision, binding.writer_generation)
                })?;
                let document = broker.documents.get_mut(label).ok_or("stale-document")?;
                document.ready = true;
                document.visible = visible;
                broker.advance_presence(label)?;
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                if broker.main_closing {
                    broker.pending_closes.insert(label.into());
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
            Command::RestoreBuiltin { incarnation } => {
                self.document(broker, label, &incarnation)?;
                broker.request_restore()?;
                for target in broker.documents.keys() {
                    let _ = app.emit_to(target, "openpane-ui-wakeup", ());
                }
                Ok(json!({"sequence":broker.recovery_sequence}))
            }
            Command::ReadRecovery { incarnation } => {
                self.require_main(broker, label, &incarnation)?;
                Ok(json!({"pending":broker.local_builtin,"sequence":broker.recovery_sequence}))
            }
            Command::ConfirmRecovery {
                incarnation,
                sequence,
            } => {
                self.require_main(broker, label, &incarnation)?;
                broker.confirm_restore(sequence);
                Ok(json!({"ok":true}))
            }
            Command::CloseCancelled { incarnation } => {
                self.document(broker, label, &incarnation)?;
                broker.cancel_close();
                Ok(json!({"ok":true}))
            }
            Command::ReadClose { incarnation } => {
                self.document(broker, label, &incarnation)?;
                Ok(json!({"pending":broker.pending_closes.contains(label)}))
            }
            Command::CloseReady { incarnation } => {
                self.document(broker, label, &incarnation)?;
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
    use super::*;
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
            broker.host = Some(("host".into(), "profile".into()));
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "chat".into(),
            };
            broker.begin_close("main");
            assert_eq!(windows.admit_child(broker, &scope), Err("main-unavailable"));
            assert!(windows
                .reserve(broker, scope.clone(), "view".into(), None, false)
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
                .reserve(broker, scope, "view".into(), None, false)
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
            broker.host = Some(("host".into(), "profile".into()));
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
                .reserve(broker, scope, "view-0".into(), None, false)
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
            broker.host = Some(("host".into(), "profile".into()));
            let scope = Scope {
                host_id: "host".into(),
                conversation_id: "chat".into(),
            };
            assert_eq!(
                broker.lookup_window(&windows.origin, &scope).unwrap(),
                json!({"kind":"absent"})
            );
            let reservation = windows
                .reserve(broker, scope.clone(), "view".into(), None, false)
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
            assert_eq!(broker.host.as_ref().unwrap().0, "host");
            broker.abandon_unregistered_openings();
            broker
                .bind_host("other-host".into(), "profile".into())
                .unwrap();
            broker.request_restore().unwrap();
            let first = broker.recovery_sequence;
            broker.request_restore().unwrap();
            let retry = broker.recovery_sequence;
            assert!(retry > first);
            broker.confirm_restore(first);
            assert!(broker.local_builtin);
            broker.confirm_restore(retry);
            assert!(!broker.local_builtin);
            broker.request_restore().unwrap();
            assert!(broker.local_builtin);
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
            assert_eq!(broker.begin_close("main"), vec!["first", "second"]);
            assert!(broker.pending_closes.contains("first"));
            assert!(broker.pending_closes.contains("second"));
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
            assert_eq!(broker.begin_close("main"), vec!["main"]);
            assert_eq!(broker.close_progress(), CloseProgress::Idle);
            assert_eq!(broker.close_progress(), CloseProgress::Idle);
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
                broker.host = Some(("host".into(), "profile".into()));
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
                        Phase::TargetReady
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
                        false
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
            broker.host = Some(("host".into(), "profile".into()));
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
                .reserve(broker, scope.clone(), "view".into(), None, true)
                .unwrap();
            broker
                .storage
                .mutate(&windows.origin, |profile| {
                    profile.windows.get_mut(&scope.key()).unwrap().phase = Phase::TransferCommitted;
                    Ok(())
                })
                .unwrap();
            let second = windows
                .reserve(broker, scope.clone(), "view".into(), None, true)
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
                    false
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
}

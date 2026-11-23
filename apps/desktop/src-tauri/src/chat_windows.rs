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
    documents: BTreeMap<String, Document>,
    opening: BTreeMap<String, Scope>,
    host: Option<(String, String)>,
    snapshot: Option<Value>,
    reports: BTreeMap<String, Value>,
    child_snapshots: BTreeMap<String, Value>,
    local_builtin: bool,
    main_closing: bool,
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
                    documents: BTreeMap::new(),
                    opening: BTreeMap::new(),
                    host: None,
                    snapshot: None,
                    reports: BTreeMap::new(),
                    child_snapshots: BTreeMap::new(),
                    local_builtin: false,
                    main_closing: false,
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
    fn reserve(
        &self,
        broker: &mut Broker,
        scope: Scope,
        view_id: String,
        creation_agent_id: Option<String>,
        new_transition: bool,
    ) -> Result<Reservation, &'static str> {
        let host = broker.host.as_ref().ok_or("ui-context-not-bound")?;
        if scope.host_id != host.0 {
            return Err("foreign-host");
        }
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
            if new_transition {
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
        broker.local_builtin = true;
        for label in broker.documents.keys() {
            let _ = app.emit_to(label, "openpane-ui-wakeup", ());
        }
        Ok(())
    }
    pub fn close_requested(&self, app: &tauri::AppHandle, label: &str) {
        if let Ok(mut guard) = self.broker.lock() {
            if let Ok(broker) = guard.as_mut() {
                if label == "main" {
                    broker.main_closing = true;
                }
                let labels: Vec<_> = if label == "main" {
                    broker.documents.keys().cloned().collect()
                } else {
                    vec![label.into()]
                };
                if broker.main_closing && broker.documents.is_empty() {
                    drop(guard);
                    app.exit(0);
                    return;
                }
                if label != "main" && !broker.documents.contains_key(label) {
                    drop(guard);
                    if let Some(window) = app.get_webview_window(label) {
                        let _ = window.destroy();
                    }
                    return;
                }
                for target in labels {
                    let _ = app.emit_to(&target, "openpane-close-requested", ());
                }
            }
        }
    }
    pub fn departed(&self, app: &tauri::AppHandle, label: &str) {
        if let Ok(mut guard) = self.broker.lock() {
            if let Ok(broker) = guard.as_mut() {
                broker.documents.remove(label);
                broker.opening.remove(label);
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                if broker.main_closing && broker.documents.is_empty() {
                    app.exit(0);
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
                    let allowed = (phase == Phase::SourceSaved && may_restart)
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
                    .filter(|entry| {
                        entry.scope == scope && entry.transition_id == expected_transition_id
                    })
                    .ok_or("stale-recovery-reservation")?
                    .clone();
                if broker.opening.contains_key(&reservation.label)
                    || app.get_webview_window(&reservation.label).is_some()
                {
                    return Err("target-still-open");
                }
                let transition_id = format!("inline:{}", reservation.transition_id);
                identifier(&transition_id, 200)?;
                broker.storage.mutate(&self.origin, |profile| {
                    profile
                        .windows
                        .get_mut(&scope.key())
                        .ok_or("unknown-reservation")?
                        .phase = Phase::Failed;
                    Ok(())
                })?;
                Ok(
                    json!({"scope":scope,"viewId":reservation.view_id,"nativeLabel":reservation.label,"fromTransitionId":reservation.transition_id,
                    "transitionId":transition_id,"targetLabel":"main","creationAgentId":reservation.creation_agent_id}),
                )
            }
            Command::Lookup { incarnation, scope } => {
                self.require_main(broker, label, &incarnation)?;
                let entry = broker
                    .storage
                    .profile(&self.origin)?
                    .windows
                    .get(&scope.key());
                Ok(
                    json!({"reservation":entry,"live":entry.is_some_and(|entry|broker.opening.contains_key(&entry.label))}),
                )
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
                if let Some(child) = app.get_webview_window(&reservation.label) {
                    child.show().map_err(|_| "window-focus-failed")?;
                    child.set_focus().map_err(|_| "window-focus-failed")?;
                    let _ = app.emit_to(&reservation.label, "openpane-ui-wakeup", ());
                    return if broker
                        .documents
                        .get(&reservation.label)
                        .is_some_and(|document| document.ready)
                    {
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
                    let mut builder = tauri::WebviewWindowBuilder::new(
                        app,
                        &child_label,
                        tauri::WebviewUrl::External(target),
                    )
                    .title(&geometry.title)
                    .inner_size(geometry.width as f64, geometry.height as f64)
                    .min_inner_size(360.0, 480.0)
                    .disable_drag_drop_handler()
                    .on_navigation(move |url| url == &admitted)
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
                    entry.binding_revision = Some(binding.revision);
                    entry.writer_generation = Some(binding.writer_generation);
                    entry.phase = Phase::TargetReady;
                    Ok(())
                })?;
                let document = broker.documents.get_mut(label).ok_or("stale-document")?;
                document.ready = true;
                document.visible = visible;
                document.presence_sequence += 1;
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
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
            command @ (Command::PlacementIntent { .. }
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
                broker.local_builtin = true;
                for target in broker.documents.keys() {
                    let _ = app.emit_to(target, "openpane-ui-wakeup", ());
                }
                Ok(json!({"ok":true}))
            }
            Command::CloseReady { incarnation } => {
                self.document(broker, label, &incarnation)?;
                broker.documents.remove(label);
                broker.opening.remove(label);
                if label == "main" {
                    broker.main_closing = true;
                }
                let quit = broker.main_closing && broker.documents.is_empty();
                drop(guard);
                if quit {
                    app.exit(0);
                } else if label != "main" {
                    window.destroy().map_err(|_| "window-close-failed")?;
                }
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
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "openpane-restore" => {
            let _ = app.state::<ChatWindows>().restore_builtin(app);
        }
        "openpane-quit" => app.state::<ChatWindows>().close_requested(app, "main"),
        _ => {}
    });
    Ok(())
}
pub fn attach_close(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let app = app.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            app.state::<ChatWindows>().close_requested(&app, &label);
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

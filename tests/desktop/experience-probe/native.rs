use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager};

struct Probe {
    started: Instant,
    url: tauri::Url,
    children: Mutex<HashMap<String, u64>>,
    generation: Mutex<u64>,
}
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Command {
    Context,
    Open { slot: u64 },
    Read,
    Close { slot: u64 },
    Publish { generation: u64 },
    Interaction { action: String },
    Minimize,
    Minimized,
}
#[tauri::command]
async fn desktop_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    probe: tauri::State<'_, Probe>,
    command: Command,
) -> Result<serde_json::Value, String> {
    if window.url().map_err(|e| e.to_string())? != probe.url {
        return Err("forbidden-url".into());
    }
    let label = window.label();
    let slot = probe.children.lock().unwrap().get(label).copied();
    if label != "main" && slot.is_none() {
        return Err("unregistered-window".into());
    }
    match command {
        Command::Context => Ok(
            serde_json::json!({"role": if slot.is_some() {"chat"} else {"main"}, "label": label, "slot": slot}),
        ),
        Command::Close { slot } => {
            if label != "main" || slot > 7 {
                return Err("forbidden".into());
            }
            if let Some(child) = app.get_webview_window(&format!("probe-chat-{slot}")) {
                child.close().map_err(|e| e.to_string())?;
            }
            Ok(serde_json::json!({"closed": slot}))
        }
        Command::Read => {
            Ok(serde_json::json!({"generation": *probe.generation.lock().unwrap(), "slot": slot}))
        }
        Command::Open { slot: requested } => {
            if label != "main" || requested > 7 {
                return Err("forbidden".into());
            }
            let child_label = format!("probe-chat-{requested}");
            if let Some(child) = app.get_webview_window(&child_label) {
                child.set_focus().map_err(|e| e.to_string())?;
                return Ok(serde_json::json!({"label": child_label, "reused": true}));
            }
            probe
                .children
                .lock()
                .unwrap()
                .insert(child_label.clone(), requested);
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new(format!("probe-{requested}"))
                    .local(false)
                    .remote(format!("{}/", probe.url.origin().ascii_serialization()))
                    .window(&child_label)
                    .permission("allow-desktop-window")
                    .permission("core:event:allow-listen")
                    .permission("core:event:allow-unlisten"),
            )
            .map_err(|e| e.to_string())?;
            let target = probe.url.clone();
            tauri::WebviewWindowBuilder::new(
                &app,
                &child_label,
                tauri::WebviewUrl::External(target.clone()),
            )
            .title(format!("OpenPane native probe · chat {requested}"))
            .inner_size(400.0, 500.0)
            .on_navigation(move |url| url == &target)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"label": child_label, "reused": false}))
        }
        Command::Publish { generation } => {
            if label != "main" {
                return Err("forbidden".into());
            }
            *probe.generation.lock().unwrap() = generation;
            for label in probe.children.lock().unwrap().keys() {
                app.emit_to(label, "probe-wakeup", ())
                    .map_err(|e| e.to_string())?;
            }
            Ok(serde_json::json!({"generation": generation}))
        }
        Command::Interaction { action } => {
            if slot.is_none() || !["send", "stop", "approve"].contains(&action.as_str()) {
                return Err("forbidden".into());
            }
            Ok(
                serde_json::json!({"slot": slot, "action": action, "generation": *probe.generation.lock().unwrap()}),
            )
        }
        Command::Minimized => {
            if label != "main" {
                return Err("forbidden".into());
            }
            let minimized = window.is_minimized().map_err(|e| e.to_string())?;
            Ok(
                serde_json::json!({"minimized": minimized, "sampleAtMs": probe.started.elapsed().as_secs_f64() * 1000.0}),
            )
        }
        Command::Minimize => {
            if label != "main" {
                return Err("forbidden".into());
            }
            window.minimize().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"minimized": true}))
        }
    }
}
fn target_for_denial(app: &tauri::App) -> String {
    app.state::<Probe>().url.to_string()
}
fn main() {
    let url: tauri::Url = std::env::args().nth(1).expect("probe URL").parse().unwrap();
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/browser.html");
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![desktop_window])
        .setup(move |app| {
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("probe-main")
                    .local(false)
                    .remote(format!("{}/", url.origin().ascii_serialization()))
                    .window("main")
                    .permission("allow-desktop-window")
                    .permission("core:event:allow-listen")
                    .permission("core:event:allow-unlisten"),
            )?;
            app.manage(Probe {
                started: Instant::now(),
                url: url.clone(),
                children: Mutex::new(HashMap::new()),
                generation: Mutex::new(0),
            });
            let target = url.clone();
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("OpenPane native experience probe")
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .on_navigation(move |url| url == &target)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            let denied_url: tauri::Url =
                format!("{}?wrong-document", target_for_denial(&app)).parse()?;
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("probe-denied")
                    .local(false)
                    .remote(format!("{}/", denied_url.origin().ascii_serialization()))
                    .window("probe-forbidden")
                    .permission("allow-desktop-window"),
            )?;
            tauri::WebviewWindowBuilder::new(
                app,
                "probe-forbidden",
                tauri::WebviewUrl::External(denied_url),
            )
            .title("OpenPane rejected-document probe")
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("native probe");
}

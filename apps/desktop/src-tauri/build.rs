fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "native_access",
            "provider_setup",
            "desktop_window",
        ]),
    ))
    .expect("desktop permissions");
}

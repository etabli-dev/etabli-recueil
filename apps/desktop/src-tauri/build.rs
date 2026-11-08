fn main() {
    // Declaring the commands generates an `allow-<command>` permission for each, so that the
    // capability file can grant them one by one instead of the window getting every command.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["shell_state", "check_server_url", "save_connection", "connection"]),
    ))
    .expect("the Tauri build script failed");
}

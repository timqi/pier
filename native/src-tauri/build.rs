fn main() {
    // The app's commands become `allow-<command>` permissions, so a capability
    // grants each webview only the ones it names.
    let commands =
        &["list", "add", "close", "rename", "reorder", "select", "popup", "set_badge", "notify", "page_title"];
    let manifest = tauri_build::AppManifest::new().commands(commands);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri-build failed");
}

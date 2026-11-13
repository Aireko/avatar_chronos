mod ffi;

// Each command is a thin wrapper around the C backend (see ffi.rs). Commands
// without `async` run on the main thread, which is fine for quick C calls. For
// slow C work, make the command `async` (with owned arguments such as `String`)
// and run the call in `tauri::async_runtime::spawn_blocking` so the UI stays
// responsive. Learn more at https://tauri.app/develop/calling-rust/

#[tauri::command]
fn backend_version() -> String {
    ffi::version()
}

#[tauri::command]
fn greet(name: &str) -> Result<String, ffi::BackendError> {
    ffi::greet(name)
}

#[tauri::command]
fn identicon(seed: &str) -> Result<ffi::Identicon, ffi::BackendError> {
    ffi::identicon(seed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![backend_version, greet, identicon])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

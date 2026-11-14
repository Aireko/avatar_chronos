mod ffi;

#[tauri::command]
fn backend_version() -> String {
    ffi::version()
}

#[tauri::command]
fn export_graph() -> i32 {
    ffi::export_graph()
}

pub fn run() {
    tauri::Builder::default().invoke_handler(tauri::generate_handler![
        backend_version,
        export_graph
    ]);
}

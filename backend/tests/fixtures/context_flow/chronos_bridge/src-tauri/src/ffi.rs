pub fn version() -> String {
    unsafe { string_from_c(chronos_version()) }
}

pub fn export_graph() -> i32 {
    unsafe { chronos_export_graph() }
}

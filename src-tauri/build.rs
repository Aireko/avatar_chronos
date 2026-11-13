use std::path::PathBuf;

fn main() {
    build_c_backend();
    tauri_build::build()
}

/// Compiles every `.c` file in `../backend/src` into a static library and links
/// it into this crate. The Rust bindings for it live in `src/ffi.rs`.
fn build_c_backend() {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"),
    );
    let backend_dir = manifest_dir
        .parent()
        .expect("src-tauri has a parent directory")
        .join("backend");
    let include_dir = backend_dir.join("include");
    let src_dir = backend_dir.join("src");

    // Rebuild whenever anything in the C backend changes (directories are scanned recursively).
    println!("cargo::rerun-if-changed={}", include_dir.display());
    println!("cargo::rerun-if-changed={}", src_dir.display());

    let mut sources: Vec<PathBuf> = std::fs::read_dir(&src_dir)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", src_dir.display()))
        .map(|entry| entry.expect("cannot read directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "c"))
        .collect();
    sources.sort(); // deterministic build order
    assert!(!sources.is_empty(), "no .c files in {}", src_dir.display());

    cc::Build::new()
        .files(&sources)
        .include(&include_dir)
        .compile("avatar_backend");
}

use std::path::PathBuf;

fn main() {
    build_c_backend();
    tauri_build::build()
}

/// Compiles every `.c` file in `../backend/src` into a static library and links
/// it into this crate. Headers come from `backend/include`.
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

    println!("cargo::rerun-if-changed={}", include_dir.display());
    println!("cargo::rerun-if-changed={}", src_dir.display());

    let mut sources: Vec<PathBuf> = std::fs::read_dir(&src_dir)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", src_dir.display()))
        .map(|entry| entry.expect("cannot read directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "c"))
        .collect();
    sources.sort();
    assert!(!sources.is_empty(), "no .c files in {}", src_dir.display());

    let mut build = cc::Build::new();
    let packages = backend_dir.parent().unwrap().join("node_modules");
    let runtime = packages.join("tree-sitter/vendor/tree-sitter/lib");
    let runtime_source = runtime.join("src/lib.c");
    assert!(runtime_source.is_file(), "install npm dependencies before compiling the backend");
    println!("cargo::rerun-if-changed={}", runtime.display());
    build.files(&sources).include(&include_dir).include(runtime.join("include"));
    if build.get_compiler().is_like_msvc() {
        build.flag_if_supported("/std:c11");
    } else {
        build.flag_if_supported("-std=c11");
    }
    build.compile("avatar_backend");
    let mut runtime_build = cc::Build::new();
    runtime_build.file(runtime_source)
        .include(runtime.join("include"))
        .include(runtime.join("src"))
        .warnings(false)
        .compile("chronos_tree_sitter");
    for (name, directory) in [
        ("c", "tree-sitter-c/src"),
        ("rust", "tree-sitter-rust/src"),
        ("javascript", "tree-sitter-javascript/src"),
        ("typescript", "tree-sitter-typescript/typescript/src"),
        ("tsx", "tree-sitter-typescript/tsx/src"),
    ] {
        let source = packages.join(directory);
        println!("cargo::rerun-if-changed={}", source.display());
        let mut grammar = cc::Build::new();
        grammar.file(source.join("parser.c")).include(&source).warnings(false);
        let scanner = source.join("scanner.c");
        if scanner.is_file() {
            grammar.file(scanner);
        }
        grammar.compile(&format!("chronos_grammar_{name}"));
    }
}
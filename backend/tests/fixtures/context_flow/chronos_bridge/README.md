# Chronos bridge fixture

A small, real-source fixture for the `invoke` -> registered Tauri command ->
FFI bridge pattern:

```text
src/backend.ts
  call<string>("backend_version")        frontend callsite + command string
src-tauri/src/lib.rs
  #[tauri::command] fn backend_version   command
  generate_handler![backend_version]     registration
  ffi::version()                         Rust dispatch
src-tauri/src/ffi.rs
  chronos_version()                      FFI call
backend/src/avatar.c
  chronos_version                        C symbol
```

`test_context_bridge` parses these files, builds a `RepositoryIndex`, and
requires each bridge edge to point at bytes present in this fixture. The
frontend uses a thin `call` wrapper around `invoke`, like the real app, so the
detector must support both direct `invoke("...")` calls and wrapper calls.
`export_graph` deliberately names both the Tauri command and its FFI wrapper,
so the resolver must prefer the registered command and follow the `ffi::`
qualifier rather than treating the repeated short name as ambiguous.

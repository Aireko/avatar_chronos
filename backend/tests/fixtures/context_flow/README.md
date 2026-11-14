# Context flow fixtures

## `test_context_flow` graph

A synthetic six-file index used to lock down the deterministic flow rules:

```text
app/main.c      main -> alpha, helper, save (ambiguous)
app/core.c      alpha -> beta, helper
                beta  -> gamma, helper
lib/remote.c    gamma -> alpha, helper
app/util.c      helper (fan-in 10) <- main, alpha, beta, gamma, f1..f6
app/save_a.c    save
app/save_b.c    save
```

- `alpha -> beta -> gamma -> alpha` is a cycle. The displayed flow is
  `main -> alpha -> beta -> gamma`; the back-edge to `alpha` is collapsed.
- `helper` has ten callers. Its fan-in penalty keeps it below `alpha`, and it
  does not expand its incoming callers while it is not a seed.
- The two `save` definitions make `main`'s call ambiguous. Ambiguous calls are
  not followed, so no flow targets either `save`.
- `gamma` lives in `lib/` while `beta` lives in `app/`, so the last hop is a
  cross-module transition.

Task-mode tests confirm that callers (`beta` from a changed `gamma`) outrank
the incidental `helper` neighbor.

## `chronos_bridge` fixture

The second fixture is described in
[`chronos_bridge/README.md`](chronos_bridge/README.md). It mirrors the real
Chronos path: frontend `call`/`invoke` wrapper -> `backend_version` and
`export_graph` Tauri commands -> registered handlers -> `ffi::` wrappers ->
`chronos_*` C symbols. `export_graph` intentionally reuses the same short name
in the command and the FFI wrapper to test qualifier-based resolution.

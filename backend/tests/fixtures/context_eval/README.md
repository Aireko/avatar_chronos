# Context evaluation fixture

`test_context_eval` is a small hand-labeled evaluation set. It reuses the
synthetic multi-module graph from the views tests and the Chronos bridge
fixture.

## Labels

| Task | Mode | Required evidence | Expected unresolved |
| --- | --- | --- | --- |
| Onboarding | `onboarding` | `main -> alpha`, `beta -> gamma`, unresolved `main -> missing` | 1 |
| Change impact | task seed `gamma` | `gamma` source, `beta -> gamma`, `gamma -> alpha`, `gamma -> helper` | 1 |
| Symbol review | `ReviewContext` for `gamma` | incoming `beta -> gamma`, outgoing `gamma -> alpha`, `gamma -> helper` | 0 |
| Chronos bridge | bridge discovery | invoke/registration/dispatch/FFI edges for `backend_version` and `export_graph` | 0 |

## Golden output

`golden/` contains byte-compared documents:

- `onboarding-brief.json`
- `onboarding-graph.json`
- `change-brief.json`
- `change-graph.json`
- `review-context.json`

Regenerate after an intentional output change:

```bash
make -C backend .build/test_context_eval
cd backend && .build/test_context_eval --write-golden
```

## Metrics

The report prints an approximate token count using `(bytes + 3) / 4`:

- compiler tokens use the rendered brief text and evidence IDs, not the full
  JSON evidence catalog;
- baseline tokens use the same task prompt overhead plus the full relevant
  files;
- symbol review uses the review-context JSON bytes;
- retained evidence and unresolved counts come from semantic assertions, not
  from the golden text.

The baseline is intentionally conservative: it includes every relevant file
in full. The compiler is expected to use fewer tokens while retaining all
labeled evidence.

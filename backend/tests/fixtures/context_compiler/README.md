# Context compiler fixture (schema version 1)

This fixture is the agreed request, graph, and brief for sprint slice 1. It is
small on purpose: one review target (`pay`), one cross-module call
(`pay -> validate`), one budget omission, one unresolved call, and one
unavailable relationship.

| File | Contract |
| --- | --- |
| `request.json` | `ContextRequest` (pinned head, optional base, review mode, one symbol anchor) |
| `context-graph.json` | `ContextGraph` consumed through the `minikv-ui` v1 adapter |
| `context-brief.json` | `ContextBrief`, rendered from the same evidence catalog |
| `brief.txt` | Human-readable rendering of the brief |

Regenerate after an intentional contract change:

```bash
make -C backend .build/test_context_contract
cd backend && .build/test_context_contract --write-fixtures
```

`test_context_contract` validates the in-memory contract objects and then
compares the committed files byte-for-byte with their serialization.

## Stable IDs

IDs never depend on array position or discovery order.

| Object | Format | Example |
| --- | --- | --- |
| Scope | compact JSON array | `["project"]`, `["module","shared/checks"]`, `["file","payments/payment.c"]`, `["symbol",[...]]` |
| Symbol | indexer symbol tuple | `["payments/payment.c","pay","function","definition",0,35]` |
| Call evidence | length-framed `call:v1:` string | `call:v1:<callerLen>:<callerId><calleeLen>:<calleeKey>:<start>:<end>` |
| Source evidence | length-framed `source:v1:` string | `source:v1:<len>:<symbolId>` |
| Contains evidence | length-framed `contains:v1:` string | `contains:v1:<parentLen>:<parentId><childLen>:<childId>` |
| Change evidence | length-framed `change:v1:` string | `change:v1:<beforeLen>:<beforeId><afterLen>:<afterId>` |

A symbol scope uses the indexer's logical ID when it is unique, so unchanged
symbols keep the same scope ID across a base/head pair. When logical identity
is ambiguous it falls back to the full versioned symbol tuple. The full tuple
is always present in `symbol.ref.id`.

Length framing makes the IDs unambiguous without escaping a second time. The
same evidence ID is used by the graph edge, the brief item, and the indexer's
`ContextCandidate.id`. Opening an evidence ID returns the pinned location, not
the current working tree.

## Relation states

`state` is separate from discovery `coverage`:

| State | Meaning |
| --- | --- |
| `selected` | Discovered, resolved, and inside the active budget. |
| `omitted` | Discovered and resolved, but excluded by `maxItems` or `maxSourceBytes`. |
| `unresolved` | A call site exists, but no unique indexed target exists. |
| `ambiguous` | A call site exists with two or more indexed candidates. |
| `unavailable` | Discovery evidence is missing. This is not a budget result. |

The fixture deliberately contains `selected`, `omitted`, `unresolved`, and
`unavailable` edges. `context-brief.json` also lists the omitted evidence in
`omittedEvidenceIds`; it never reports an omission as an unresolved call.

## Views share evidence

Every graph edge carries `evidenceId`, and every brief `evidenceIds` entry
must resolve in that document's `evidence` catalog. The graph contains only
pinned locations and calls, never source text. Source is fetched by evidence
ID, which keeps the initial graph payload small and lets the graph reveal
evidence that the agent brief had to omit.

## Mock UI adapter

The UI mock contract (`contracts/README.md` and `src/contracts/types.ts` on the
`ui-mockup` branch) is a different schema from the indexer graph. The compiler
does not silently reuse the indexer's `graph.json` shape as if it were the UI
shape. Instead, `context-graph.json` declares an explicit adapter:

```json
"adapter": {
  "name": "minikv-ui",
  "schemaVersion": 1,
  "graphSchemaVersion": 1,
  "briefSchemaVersion": 1,
  "reviewContextSchemaVersion": 1
}
```

An adapter for `minikv-ui` maps compiler scopes to UI nodes, call edges to UI
edges, and `evidenceId` to the pinned source request. Review mode additionally
reuses `ReviewContext` / `review-context.json` v1 from `context_package.h` for
the single selected symbol.

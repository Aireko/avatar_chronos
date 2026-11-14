# Context views fixture

`test_context_views` builds a synthetic five-file index and checks both views
produced from one flow run:

```text
app/main.c      main -> alpha, helper, missing (unresolved)
app/core.c      alpha -> beta
                beta  -> gamma, helper
lib/remote.c    gamma -> alpha, helper          cycle gamma -> alpha -> beta -> gamma
app/util.c      helper <- f1, f2, f3            fan-in
tests/test_main.c  test_main -> main
```

Default onboarding run:

- entry point: `main`
- top flows: `main -> alpha`, `main -> alpha -> beta`,
  `main -> alpha -> beta -> gamma`, `main -> helper`
- edit locations: `main`, `alpha`
- test location: `test_main`
- unresolved: `missing`

The test asserts:

- graph and brief point at the same evidence catalog;
- a brief source ID resolves to the same pinned file/range as the graph
  evidence;
- a brief flow ID resolves to a graph call edge with the same callsite;
- serialized graph JSON contains no source text;
- template-rendered entry, flow, edit, test, and unresolved text;
- a tight budget reports omitted evidence while the graph still exposes
  omitted call edges;
- task mode uses `gamma` as a task anchor and ranks direct caller `beta` as a
  likely edit location.

The synthetic source bytes are `x`-filled buffers because the test exercises
view construction, not parsing. Parsing is covered by the flow and bridge
fixtures.

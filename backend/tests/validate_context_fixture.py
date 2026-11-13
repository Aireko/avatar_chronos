#!/usr/bin/env python3
"""Validate the context compiler contract fixture.

This is intentionally a separate consumer from the C serializer. It checks the
properties that matter to both the agent brief and the UI graph:

  * stable, unique node/edge/evidence IDs;
  * every displayed relationship resolves to an evidence ID;
  * omitted-by-budget, unresolved, and unavailable stay distinct;
  * the graph payload carries no source text;
  * the brief and graph share one evidence catalog.
"""

from __future__ import annotations

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "context_compiler"
RELATION_STATES = {"selected", "omitted", "unresolved", "ambiguous", "unavailable"}
EVIDENCE_KINDS = {"call", "contains", "change", "source"}


def load(name: str):
    with (FIXTURE / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    request = load("request.json")
    graph = load("context-graph.json")
    brief = load("context-brief.json")
    errors: list[str] = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    check(request["schemaVersion"] == 1, "request schemaVersion must be 1")
    check(graph["schemaVersion"] == 1, "graph schemaVersion must be 1")
    check(brief["schemaVersion"] == 1, "brief schemaVersion must be 1")
    check(request["mode"] in {"onboarding", "task", "review"}, "request mode is invalid")
    check(request["head"]["commitSha"] == graph["revision"]["commitSha"],
          "request and graph head revisions differ")
    check(request["base"]["commitSha"] == graph["comparison"]["base"]["commitSha"],
          "request and graph base revisions differ")

    adapter = graph.get("adapter", {})
    check(adapter.get("name") == "minikv-ui", "missing mock UI adapter name")
    check(adapter.get("schemaVersion") == 1, "missing mock UI adapter version")
    check(adapter.get("graphSchemaVersion") == 1, "missing graph schema adapter version")
    check(adapter.get("briefSchemaVersion") == 1, "missing brief schema adapter version")
    check(adapter.get("reviewContextSchemaVersion") == 1,
          "missing review-context schema adapter version")

    nodes = graph["nodes"]["items"]
    edges = graph["edges"]["items"]
    graph_evidence = graph["evidence"]["items"]
    brief_evidence = brief["evidence"]["items"]

    node_ids = [node["id"] for node in nodes]
    edge_ids = [edge["id"] for edge in edges]
    evidence_ids = [item["id"] for item in graph_evidence]
    check(len(node_ids) == len(set(node_ids)), "graph node IDs are not unique")
    check(len(edge_ids) == len(set(edge_ids)), "graph edge IDs are not unique")
    check(len(evidence_ids) == len(set(evidence_ids)), "graph evidence IDs are not unique")
    check(set(evidence_ids) == {item["id"] for item in brief_evidence},
          "brief and graph evidence catalogs differ")

    for node in nodes:
        check(node["kind"] in {"project", "module", "file", "symbol"},
              f"node {node['id']} has an invalid kind")
        check(node["state"] in {"selected", "omitted"},
              f"node {node['id']} has a non-display state")
        if node["kind"] == "project":
            check(node["parentId"] is None, "project root must not have a parent")
        else:
            check(node["parentId"] in node_ids, f"node {node['id']} has an unknown parent")

    for item in graph_evidence:
        check(item["kind"] in EVIDENCE_KINDS, f"evidence {item['id']} has an invalid kind")
        check(item["state"] in RELATION_STATES, f"evidence {item['id']} has an invalid state")
        if item["kind"] == "call":
            check(item["call"] is not None, f"call evidence {item['id']} has no call")
            check(item["location"] is not None, f"call evidence {item['id']} has no location")
        if item["kind"] == "source":
            check(item["location"] is not None, f"source evidence {item['id']} has no location")

    for edge in edges:
        check(edge["state"] in RELATION_STATES, f"edge {edge['id']} has an invalid state")
        check(isinstance(edge.get("evidenceId"), str) and edge["evidenceId"] != "",
              f"edge {edge['id']} has no evidence ID")
        check(edge["evidenceId"] in set(evidence_ids),
              f"edge {edge['id']} references unknown evidence {edge['evidenceId']}")
        if edge["state"] in {"selected", "omitted"}:
            check(edge["to"] in node_ids, f"edge {edge['id']} has an unknown target")
        if edge["state"] in {"unresolved", "ambiguous"}:
            check(edge["to"] is None, f"edge {edge['id']} must have a null target")
        if edge["kind"] == "call":
            check(edge["call"] is not None, f"call edge {edge['id']} has no call")
            check(edge["call"]["callSite"]["range"]["startByte"]
                  <= edge["call"]["callSite"]["range"]["endByte"],
                  f"call edge {edge['id']} has an inverted range")

    for section in brief["sections"]:
        for item in section["items"]:
            check(item["state"] in RELATION_STATES,
                  f"brief item {section['id']} has an invalid state")
            for evidence_id in item["evidenceIds"]:
                check(evidence_id in set(evidence_ids),
                      f"brief item {section['id']} references unknown evidence {evidence_id}")

    omitted = brief["omittedEvidenceIds"]
    for evidence_id in omitted:
        check(evidence_id in set(evidence_ids),
              f"omitted evidence {evidence_id} is not in the catalog")
        match = next((item for item in graph_evidence if item["id"] == evidence_id), None)
        check(match is not None and match["state"] == "omitted",
              f"omitted evidence {evidence_id} is not marked omitted")

    edge_states = {edge["state"] for edge in edges}
    for required in ("selected", "omitted", "unresolved", "unavailable"):
        check(required in edge_states, f"fixture does not exercise the {required!r} state")
    check("selected" not in omitted, "selected evidence must not be reported as omitted")

    def has_source_key(value) -> bool:
        if isinstance(value, dict):
            return "source" in value or any(has_source_key(child) for child in value.values())
        if isinstance(value, list):
            return any(has_source_key(child) for child in value)
        return False

    check(not has_source_key(graph), "graph payload must not embed source text")
    check(brief["budget"]["usedSourceBytes"] <= request["budget"]["maxSourceBytes"],
          "brief exceeded its source byte budget")

    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(
        "context fixture passed: "
        f"{len(nodes)} nodes, {len(edges)} edges, {len(evidence_ids)} evidence items"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

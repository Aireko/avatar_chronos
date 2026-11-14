import { compileMultiViews, type ChronosGraph } from "../backend";
import { aiService } from "../ai/aiService";
import { headDiff } from "./git";

export interface BNode {
  id: string;
  label: string;
  role: "caller" | "changed" | "callee";
  file?: string;
}
export interface Blast {
  nodes: BNode[];
  edges: { from: string; to: string }[];
  brief: string;
  diff: string;
  hasCallGraph: boolean;
}
export interface Finding {
  function: string;
  file: string;
  line?: number;
  severity: "high" | "medium" | "low";
  problem: string;
  affects: string[];
}

export const short = (label: string) => (label.split(/[.:#/]/).pop() ?? label).replace(/\(.*$/, "").trim();
const MAX = 6;

/** Maps the functions changed in HEAD to their callers and callees. */
export async function analyze(repo: string, graph: ChronosGraph): Promise<Blast> {
  const head = graph.commits.find((c) => c.hash === graph.head);
  const targets = (head?.filesChanged ?? []).flatMap((f) =>
    f.symbolsTouched
      .filter((s) => s.changeType !== "DELETED")
      .map((s) => ({ path: f.path, qualifiedName: s.name })),
  ).slice(0, 8);

  const diff = await headDiff(repo).catch(() => "");
  const changed: BNode[] = targets.map((t) => ({
    id: `t:${t.path}:${t.qualifiedName}`,
    label: t.qualifiedName,
    role: "changed",
    file: t.path,
  }));

  let brief = "";
  const nodes: BNode[] = [...changed];
  const edges: Blast["edges"] = [];
  let hasCallGraph = false;

  if (targets.length) {
    try {
      const views = await compileMultiViews(repo, { revision: "HEAD", mode: "task", targets });
      brief = JSON.stringify(views.brief).slice(0, 6000);

      const seen = new Set(nodes.map((n) => n.id));
      const count = { caller: 0, callee: 0 };
      for (const flow of views.flows ?? []) {
        const seed = flow.nodes.find((n) => n.isSeed);
        const mine = seed && changed.find((c) => short(c.label) === short(seed.name));
        if (!mine) continue;
        for (const n of flow.nodes) {
          if (n.isSeed || n.hop > 1) continue;
          if (changed.some((c) => short(c.label) === short(n.name))) continue;
          const role = n.viaIncoming ? "caller" : "callee";
          if (count[role] >= MAX) continue;
          const id = `${role}:${n.name}`;
          if (!seen.has(id)) {
            seen.add(id);
            nodes.push({ id, label: n.name, role });
            count[role]++;
          }
          edges.push(role === "caller" ? { from: id, to: mine.id } : { from: mine.id, to: id });
        }
      }
      hasCallGraph = true;
    } catch (e) {
      console.warn("[blast] compile failed", e);
    }
  }
  return { nodes, edges, brief, diff, hasCallGraph };
}

const SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          function: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          problem: { type: "string" },
          affects: { type: "array", items: { type: "string" } },
        },
        required: ["function", "file", "severity", "problem", "affects"],
      },
    },
  },
  required: ["findings"],
};

export async function reviewBlast(blast: Blast): Promise<Finding[]> {
  const callers = blast.nodes.filter((n) => n.role === "caller").map((n) => n.label);
  const callees = blast.nodes.filter((n) => n.role === "callee").map((n) => n.label);
  const prompt = [
    "Changed functions: " + blast.nodes.filter((n) => n.role === "changed").map((n) => `${n.label} (${n.file})`).join(", "),
    "Functions that call them: " + (callers.join(", ") || "none found"),
    "Functions they call: " + (callees.join(", ") || "none found"),
    "Context brief:\n" + blast.brief,
    "Diff:\n" + blast.diff.slice(0, 12000),
  ].join("\n\n");

  const res = await aiService.generate({
    system:
      "You are a strict code reviewer. Report only REAL bugs introduced by this change that could crash, corrupt data, " +
      "or break the functions that call the changed code. No style or naming comments. For each bug name the function " +
      "containing it, the file, the line if known, what is wrong, and which of the listed callers/callees it affects. " +
      "If you find no real bugs, return an empty findings array.",
    prompt,
    think: false,
    format: SCHEMA,
    options: { temperature: 0.1, numPredict: 1500 },
  });
  const parsed = JSON.parse(res.content) as { findings?: Finding[] };
  return (parsed.findings ?? []).map((f) => ({ ...f, affects: f.affects ?? [] }));
}

/* ---------- draw-in timing for the blast radius map (pure; see BlastMap and push.css) ----------
   The map draws itself in like the main map: the functions you changed land first, then
   the pen draws each call line out from them, and each neighbour lands once its line has
   reached it. Delays are staggered but capped, so a big map still finishes quickly. */
/** Gap between two changed functions landing. */
export const NODE_STEP = 50;
/** Gap between two call lines starting. */
export const EDGE_STEP = 30;
/** How long a call line takes to draw (keep in sync with .push-edge in push.css). */
export const EDGE_MS = 300;
/** Pause between the last changed function landing and the first line starting. */
export const EDGE_LEAD = 120;
/** Only this many items per group are staggered; the rest share the last slot. */
export const MAX_STAGGER = 6;
/** Nothing waits longer than this before it starts. */
export const MAX_DELAY = 700;

export interface DrawDelays {
  /** Delay (ms) for each node, by id. */
  nodes: Record<string, number>;
  /** Delay (ms) for each edge, in the order given. */
  edges: number[];
}

const cap = (ms: number) => Math.min(Math.round(ms), MAX_DELAY);

export function drawDelays(
  nodes: readonly Pick<BNode, "id" | "role">[],
  edges: readonly { from: string; to: string }[],
): DrawDelays {
  const out: DrawDelays = { nodes: {}, edges: [] };
  const changed = nodes.filter((n) => n.role === "changed");
  changed.forEach((n, i) => {
    out.nodes[n.id] = cap(Math.min(i, MAX_STAGGER) * NODE_STEP);
  });

  const lastChanged = changed.length ? Math.min(changed.length - 1, MAX_STAGGER) * NODE_STEP : 0;
  const edgeStart = (changed.length ? lastChanged : 0) + EDGE_LEAD;
  // A neighbour lands as the first line into it is nearly drawn.
  const arrival = new Map<string, number>();
  edges.forEach((e, i) => {
    // Lines start early enough that the neighbour they reach still lands within MAX_DELAY,
    // so a capped neighbour never pops in ahead of its own line.
    const d = Math.min(cap(edgeStart + Math.min(i, MAX_STAGGER) * EDGE_STEP), Math.floor(MAX_DELAY - EDGE_MS * 0.7));
    out.edges.push(d);
    for (const id of [e.from, e.to]) {
      const at = d + EDGE_MS * 0.7;
      if (!arrival.has(id) || at < arrival.get(id)!) arrival.set(id, at);
    }
  });

  // Callers and callees with no line (rare) land in turn after the changed ones.
  let loose = 0;
  for (const n of nodes) {
    if (n.role === "changed") continue;
    const at = arrival.get(n.id) ?? edgeStart + Math.min(loose++, MAX_STAGGER) * NODE_STEP;
    out.nodes[n.id] = cap(at);
  }
  return out;
}

/** Delay (ms) for the i-th item of a list easing in, e.g. the review's findings. */
export function listDelay(i: number, step = 50, max = MAX_STAGGER): number {
  return Math.max(0, Math.min(i, max)) * step;
}

import { short, type BNode, type Blast, type Finding } from "./blast";

const NW = 200, NH = 40, GAP = 18, W = 700;
const COL = { caller: 20, changed: 250, callee: 480 } as const;

function tone(n: BNode, findings: Finding[] | null): "bad" | "warn" | "ok" | "pending" {
  if (!findings) return "pending";
  const s = short(n.label);
  if (findings.some((f) => short(f.function) === s)) return "bad";
  if (findings.some((f) => f.affects.some((a) => short(a) === s))) return "warn";
  return "ok";
}

export function BlastMap({ blast, findings }: { blast: Blast; findings: Finding[] | null }) {
  const roles = ["caller", "changed", "callee"] as const;
  const rows = Math.max(1, ...roles.map((r) => blast.nodes.filter((n) => n.role === r).length));
  const H = rows * (NH + GAP) + GAP;
  const pos = new Map<string, { x: number; y: number }>();

  for (const r of roles) {
    const list = blast.nodes.filter((n) => n.role === r);
    const offset = ((rows - list.length) * (NH + GAP)) / 2;
    list.forEach((n, i) => pos.set(n.id, { x: COL[r], y: GAP + offset + i * (NH + GAP) }));
  }

  return (
    <svg className="push-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Blast radius map">
      {roles.map((r) => (
        <text key={r} className="push-col" x={COL[r] + NW / 2} y={12} textAnchor="middle">
          {r === "caller" ? "affected callers" : r === "changed" ? "you changed" : "depends on"}
        </text>
      ))}
      {blast.edges.map((e, i) => {
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
        const mx = (x1 + x2) / 2;
        return <path key={i} className="push-edge" d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} />;
      })}
      {blast.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const t = tone(n, findings);
        const label = short(n.label);
        return (
          <g key={n.id} className={`push-node ${n.role} ${t}`} transform={`translate(${p.x},${p.y + 12})`}>
            <rect width={NW} height={NH} rx={12} />
            <text x={NW / 2} y={NH / 2 + 5} textAnchor="middle">
              {label.length > 24 ? label.slice(0, 23) + "…" : label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
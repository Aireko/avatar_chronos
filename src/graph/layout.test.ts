import { describe, expect, it } from "vitest";
import type { Branch, Commit } from "../backend";
import {
  COL_W,
  CULL_BLOCK,
  DRAW_TAIL_MS,
  LEGEND_ALL,
  PAD_L,
  RowPacker,
  cameraAt,
  cullLayout,
  drawDelayAt,
  fitText,
  layoutGraph,
  legendRows,
  visibleColumns,
  type Lane,
  drawDelay,
  drawInWindow,
  easeOut,
  fitAxis,
  fitZoom,
  glideMs,
  laneSpans,
  scribbleLoop,
  scrollForWindow,
  visibleWindow,
  wheelZoomFactor,
} from "./layout";

describe("drawInWindow", () => {
  it("staggers only the columns around the focus that fit on screen", () => {
    const win = drawInWindow(5000, 9999, COL_W * 10);
    expect(win.from).toBe(5000 - 6);
    expect(win.to).toBe(5000 + 6);
    expect(drawDelay(win, win.from)).toBe(0);
    expect(drawDelay(win, win.from + 2)).toBe(2 * win.step);
    expect(drawDelay(win, win.from - 1)).toBeNull();
    expect(drawDelay(win, win.to + 1)).toBeNull();
  });

  it("clamps to the ends of the history", () => {
    const win = drawInWindow(9999, 9999, COL_W * 10);
    expect(win.to).toBe(9999);
    expect(win.from).toBe(9999 - 6);
    const small = drawInWindow(0, 2, 4000);
    expect(small).toMatchObject({ from: 0, to: 2 });
  });

  it("caps the span and the total stagger when zoomed far out", () => {
    const win = drawInWindow(500, 1000, 4000, 0.1);
    expect(win.to - win.from).toBeLessThanOrEqual(48);
    expect((win.to - win.from) * win.step).toBeLessThanOrEqual(840);
  });

  it("draws nothing for an empty history", () => {
    const win = drawInWindow(0, -1, 1000);
    expect(drawDelay(win, 0)).toBeNull();
  });
});

describe("scribbleLoop", () => {
  it("is the same loop for the same commit, and a different one for another", () => {
    expect(scribbleLoop(30, "a")).toBe(scribbleLoop(30, "a"));
    expect(scribbleLoop(30, "a")).not.toBe(scribbleLoop(30, "b"));
  });

  it("is an open pen stroke that stays near its radius", () => {
    const d = scribbleLoop(30, "abc");
    expect(d.startsWith("M ")).toBe(true);
    expect(d).not.toContain("Z");
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      const r = Math.hypot(nums[i], nums[i + 1]);
      expect(r).toBeLessThan(30 * 1.3);
      expect(r).toBeGreaterThan(30 * 0.75);
    }
  });
});

describe("camera glide", () => {
  const from = { zoom: 0.5, x: 100, y: 200 };
  const to = { zoom: 2, x: 300, y: 600 };

  it("starts and ends exactly on its shots", () => {
    expect(cameraAt(from, to, 0)).toEqual(from);
    expect(cameraAt(from, to, 1)).toEqual(to);
    expect(cameraAt(from, to, 1.4)).toEqual(to);
    expect(cameraAt(from, to, -0.2)).toEqual(from);
  });

  it("zooms geometrically and eases out", () => {
    const mid = cameraAt({ zoom: 1, x: 0, y: 0 }, { zoom: 4, x: 0, y: 0 }, 0.5);
    expect(mid.zoom).toBeCloseTo(4 ** easeOut(0.5));
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });

  it("takes longer for longer pans, within the motion budget", () => {
    expect(glideMs(from, from)).toBe(200);
    expect(glideMs({ zoom: 1, x: 0, y: 0 }, { zoom: 1, x: 600, y: 0 })).toBe(230);
    expect(glideMs({ zoom: 1, x: 0, y: 0 }, { zoom: 1, x: 90000, y: 0 })).toBe(280);
  });
});

describe("fitting the whole history", () => {
  it("fits the tighter side, rounded down, within the zoom range", () => {
    expect(fitZoom(1000, 400, 1040, 2000, 20, 0.45, 1)).toBe(1);
    expect(fitZoom(2000, 400, 1040, 2000, 20, 0.45, 1)).toBe(0.5);
    expect(fitZoom(3000, 400, 1040, 2000, 20, 0.45, 1)).toBe(0.45);
    expect(fitZoom(1000, 1000, 799, 799, 0, 0.1, 1)).toBe(0.79);
  });

  it("centres an axis that fits, and stays near the current spot when it does not", () => {
    expect(fitAxis(0, 400, 1000, 20, 1, 9999)).toBe(200);
    // 5000px at zoom 0.5 is 2500px: too wide for a 1000px view, so keep near where we are.
    expect(fitAxis(0, 5000, 1000, 0, 0.5, 3000)).toBe(3000);
    expect(fitAxis(0, 5000, 1000, 0, 0.5, 50)).toBe(1000);
    expect(fitAxis(0, 5000, 1000, 0, 0.5, 9000)).toBe(4000);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in for wheel up and out for wheel down, about 12% a notch", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeCloseTo(1 / 1.12, 1);
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1);
  });

  it("treats line and page deltas like pixels and caps huge jumps", () => {
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48));
    expect(wheelZoomFactor(10000)).toBe(wheelZoomFactor(240));
    expect(wheelZoomFactor(1, 2)).toBe(wheelZoomFactor(240));
  });
});

describe("minimap overview", () => {
  it("squeezes each branch row to one stroke from its oldest to newest commit", () => {
    const spans = laneSpans([
      { lane: 0, row: 0, x: 300, y: 10, color: "a" },
      { lane: 0, row: 0, x: 100, y: 10, color: "a" },
      { lane: 1, row: 1, x: 200, y: 50, color: "b" },
      { lane: 0, row: 0, x: 500, y: 10, color: "a" },
    ]);
    expect(spans).toEqual([
      { key: "0:0", color: "a", x1: 100, x2: 500, y: 10 },
      { key: "1:1", color: "b", x1: 200, x2: 200, y: 50 },
    ]);
  });

  it("measures the on-screen window as fractions and scrolls back to it", () => {
    expect(visibleWindow(250, 250, 1000)).toEqual({ start: 0.25, size: 0.25 });
    expect(visibleWindow(0, 1200, 1000)).toEqual({ start: 0, size: 1 });
    expect(visibleWindow(900, 250, 1000).start).toBe(0.75);
    expect(scrollForWindow(0.25, 250, 1000)).toBe(250);
    expect(scrollForWindow(-0.1, 250, 1000)).toBe(0);
    expect(scrollForWindow(0.9, 250, 1000)).toBe(750);
    expect(scrollForWindow(0.5, 1200, 1000)).toBe(0);
  });
});

/* ---------- a big synthetic history ---------- */
/**
 * `prs` pull requests merged into main one after another, each a short branch of `perPr`
 * commits that was deleted after merging, plus a release branch. Newest first, like git log.
 */
function prHistory(prs: number, perPr = 3): { commits: Commit[]; branches: Branch[]; head: string } {
  const oldestFirst: Commit[] = [];
  const make = (hash: string, parents: string[], message: string): Commit => ({
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    author: "dev",
    timestamp: oldestFirst.length,
    message,
    refs: [],
    filesChanged: [],
  });
  const root = make("root", [], "Initial commit");
  oldestFirst.push(root);
  let main = root.hash;
  for (let pr = 0; pr < prs; pr++) {
    let tip = main;
    for (let k = 0; k < perPr; k++) {
      const c = make(`pr${pr}-${k}`, [tip], `Work on feature ${pr} part ${k}`);
      oldestFirst.push(c);
      tip = c.hash;
    }
    const merge = make(`m${pr}`, [main, tip], `Merge pull request #${pr} from team/feature-${pr}`);
    oldestFirst.push(merge);
    main = merge.hash;
  }
  const branches: Branch[] = [
    { name: "main", commitHash: main, isHead: true },
    { name: "release", commitHash: `pr${Math.floor(prs / 2)}-1`, isHead: false },
  ];
  return { commits: oldestFirst.reverse(), branches, head: main };
}

describe("a 20k-commit history", () => {
  const { commits, branches, head } = prHistory(5000, 3); // 20,001 commits
  const t0 = performance.now();
  const layout = layoutGraph(commits, branches, head);
  const firstMs = performance.now() - t0;

  it("lays out every commit, one per column", () => {
    expect(layout.nodes.length).toBe(20001);
    layout.nodes.forEach((n, i) => expect(n.col).toBe(i));
  });

  it("gives every line the columns it spans, covering its newer end", () => {
    for (const e of layout.edges) {
      expect(e.from).toBeLessThanOrEqual(e.to);
      expect(e.order).toBeGreaterThanOrEqual(e.from);
      expect(e.order).toBeLessThanOrEqual(e.to);
    }
  });

  it("marks only lines a branch still points at as named", () => {
    expect(layout.lanes.length).toBeGreaterThan(5000);
    expect(
      layout.lanes
        .filter((l) => l.named)
        .map((l) => l.name)
        .sort(),
    ).toEqual(["main", "release"]);
  });

  it("draws about one screenful, wherever the map is scrolled", () => {
    const pad = 280;
    for (const zoom of [0.45, 1, 2.4]) {
      for (const left of [0, 123456, 2_000_000 * zoom]) {
        const range = visibleColumns(left, 1920, zoom, pad, layout.nodes.length - 1);
        const drawn = cullLayout(layout, range);
        // Far out, ~21 columns fit on a 1920px screen; with the blocks either side that stays small.
        expect(drawn.nodes.length).toBeLessThanOrEqual(1920 / (COL_W * zoom) + 4 * CULL_BLOCK + 4);
        expect(drawn.edges.length).toBeLessThan(drawn.nodes.length * 3 + 10);
        // Every line touching a drawn commit is drawn too.
        const cols = new Set(drawn.nodes.map((n) => n.col));
        const keys = new Set(drawn.edges.map((e) => e.key));
        for (const e of layout.edges) {
          if (cols.has(e.from) || cols.has(e.to)) expect(keys.has(e.key)).toBe(true);
        }
      }
    }
  });

  it("lays out again faster once the commits have been seen", () => {
    const t1 = performance.now();
    const again = layoutGraph(commits, branches, head);
    const againMs = performance.now() - t1;
    expect(again.nodes[123].shape).toBe(layout.nodes[123].shape);
    // Generous bounds: these guard against going quadratic again, not against a slow machine.
    expect(firstMs).toBeLessThan(5000);
    expect(againMs).toBeLessThan(5000);
  });
});

describe("visibleColumns", () => {
  const pad = 280;

  it("always covers what is on screen, with room either side", () => {
    for (const zoom of [0.45, 0.8, 1, 1.7, 2.4]) {
      for (let left = 0; left < 40000; left += 777) {
        const r = visibleColumns(left, 1300, zoom, pad, 9999);
        const firstOnScreen = Math.floor((left / zoom - pad - PAD_L) / COL_W);
        const lastOnScreen = Math.ceil(((left + 1300) / zoom - pad - PAD_L) / COL_W);
        expect(r.from).toBeLessThanOrEqual(Math.max(0, firstOnScreen - 1));
        expect(r.to).toBeGreaterThanOrEqual(Math.min(9999, lastOnScreen + 1));
      }
    }
  });

  it("only moves a block at a time, so a slow pan rarely redraws", () => {
    let changes = 0;
    let prev = visibleColumns(0, 1300, 1, pad, 9999);
    for (let left = 0; left <= COL_W * CULL_BLOCK * 10; left += 4) {
      const r = visibleColumns(left, 1300, 1, pad, 9999);
      if (r.from !== prev.from || r.to !== prev.to) changes++;
      prev = r;
    }
    // Ten blocks' worth of panning: about ten redraws (the two ends cross block edges together or apart).
    expect(changes).toBeLessThanOrEqual(21);
  });

  it("stays inside the history, even scrolled past either end", () => {
    expect(visibleColumns(0, 1300, 1, pad, -1)).toEqual({ from: 0, to: -1 });
    const end = visibleColumns(1e9, 1300, 1, pad, 50);
    expect(end.from).toBeLessThanOrEqual(end.to);
    expect(end.to).toBe(50);
    expect(visibleColumns(0, 1300, 1, pad, 50).from).toBe(0);
  });
});

describe("RowPacker", () => {
  it("agrees with checking every span on the row", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const packer = new RowPacker();
    const naive: [number, number][][] = [];
    for (let i = 0; i < 3000; i++) {
      const s = rand(4000);
      const e = s + rand(60);
      const row = rand(6);
      const expected = (naive[row] ?? []).every(([a, b]) => s - b >= 2 || a - e >= 2);
      expect(packer.fits(row, s, e)).toBe(expected);
      if (expected) {
        packer.add(row, s, e);
        (naive[row] ??= []).push([s, e]);
      }
    }
    expect(packer.count).toBe(naive.length);
  });
});

describe("fitText", () => {
  const measure = (t: string) => t.length * 10;

  it("keeps text that fits and cuts the rest to the longest prefix that does", () => {
    expect(fitText("short", "f", 100, measure)).toBe("short");
    // 9 characters and "…" make 100px, which fits; 10 would not.
    expect(fitText("abcdefghijklmnop", "f", 100, measure)).toBe("abcdefghi…");
    expect(fitText("abcd efghijklmnop", "f", 60, measure)).toBe("abcd…");
    expect(fitText("abcdefghijklmnop", "f", 5, measure)).toBe("a…");
  });
});

describe("drawDelayAt", () => {
  it("delays a draw-in still to come and joins one under way", () => {
    expect(drawDelayAt(undefined, 1000)).toBeNull();
    expect(drawDelayAt(1200, 1000)).toBe(200);
    expect(drawDelayAt(1000, 1000, 320)).toBe(320);
    expect(drawDelayAt(900, 1000)).toBe(-100);
  });

  it("skips one that finished long ago", () => {
    expect(drawDelayAt(1000 - DRAW_TAIL_MS - 1, 1000)).toBeNull();
    expect(drawDelayAt(1000 - DRAW_TAIL_MS - 1, 1000, 400)).toBe(-DRAW_TAIL_MS + 399);
  });
});

describe("legendRows", () => {
  const lane = (index: number, named: boolean): Lane => ({
    index,
    name: `l${index}`,
    color: "c",
    on: "o",
    isHead: false,
    named,
    y: 0,
    tip: `t${index}`,
  });

  it("lists every line on a small map", () => {
    const lanes = Array.from({ length: LEGEND_ALL }, (_, i) => lane(i, i < 2));
    expect(legendRows(lanes, 0)).toEqual({ rows: lanes, hidden: 0 });
  });

  it("folds merged lines on a big map, and lists more of them on request", () => {
    const lanes = Array.from({ length: 5000 }, (_, i) => lane(i, i < 3 || i === 4000));
    const folded = legendRows(lanes, 0);
    expect(folded.rows.map((l) => l.index)).toEqual([0, 1, 2, 4000]);
    expect(folded.hidden).toBe(4996);
    const more = legendRows(lanes, 40);
    expect(more.rows.length).toBe(44);
    expect(more.hidden).toBe(4956);
    expect(legendRows(lanes, 1e9).hidden).toBe(0);
  });
});

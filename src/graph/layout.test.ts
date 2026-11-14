import { describe, expect, it } from "vitest";
import type { Branch, Commit } from "../backend";
import {
  COL_W,
  CULL_BLOCK,
  DRAW_TAIL_MS,
  LINES,
  NO_DRAW,
  LEGEND_ALL,
  PAD_L,
  RowPacker,
  cameraAt,
  carryIds,
  entrances,
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
  withPinned,
} from "./layout";
// The tests run in node; the project has no @types/node (as in vite.config.ts). Vitest leaves
// CSS out of `?raw` imports, so the theme colours are read from the file itself.
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

const graphCss: string = readFileSync(new URL("./graph.css", import.meta.url), "utf8");

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
    text: "t",
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

/* ---------- lettering in the lane pens ---------- */
type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const luminance = ([r, g, b]: Rgb) => {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** color-mix(in srgb, a p, b) */
const mix = (a: Rgb, b: Rgb, p: number): Rgb => a.map((v, i) => v * p + b[i] * (1 - p)) as Rgb;

/** One theme's custom properties from graph.css, with var() references resolved. */
function themeVars(theme: string): (name: string) => Rgb {
  // The block that defines the colours (not the one-line color-scheme rule above it).
  const start = graphCss.search(new RegExp(`\\.app\\[data-theme="${theme}"\\] \\{\\s*--paper:`));
  expect(start).toBeGreaterThan(-1);
  const block = graphCss.slice(start, graphCss.indexOf("}", start));
  const raw = new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const get = (name: string): Rgb => {
    const value = raw.get(name);
    if (value === undefined) throw new Error(`${theme} has no ${name}`);
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    return ref ? get(ref[1]) : toRgb(value);
  };
  return get;
}

describe("lane lettering", () => {
  for (const theme of ["paper", "board"]) {
    it(`clears WCAG AA on --paper and --wash in the ${theme} theme`, () => {
      const v = themeVars(theme);
      for (let i = 0; i < LINES.length; i++) {
        for (const ground of ["--paper", "--wash"]) {
          expect(contrast(v(`--pen-${i}-text`), v(ground)), `--pen-${i}-text on ${ground}`).toBeGreaterThanOrEqual(4.5);
          // The fallback when only --line is set (.ticket-line, .lane-text): 66% pen, 34% ink.
          const fallback = mix(v(`--pen-${i}`), v("--ink"), 0.66);
          expect(contrast(fallback, v(ground)), `pen ${i} mixed with ink on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  it("letters each line in its own pen's text shade", () => {
    LINES.forEach((style, i) => {
      expect(style.color).toBe(`var(--pen-${i})`);
      expect(style.text).toBe(`var(--pen-${i}-text)`);
    });
  });
});

/* ---------- drawing pinned commits and their entrances ---------- */
describe("withPinned", () => {
  const col = (c: number) => ({ col: c });
  const run = [10, 11, 12, 13].map(col);
  const range = { from: 10, to: 13 };

  it("draws the run alone when nothing is pinned outside it", () => {
    const out = withPinned(run, range, [run[1], undefined]);
    expect(out.nodes).toBe(run);
    expect(out.outside).toEqual([]);
  });

  it("keeps column order with pinned commits on either side, each once", () => {
    const before = col(3);
    const after = col(40);
    const out = withPinned(run, range, [after, before, after]);
    expect(out.nodes.map((n) => n.col)).toEqual([3, 10, 11, 12, 13, 40]);
    expect(out.outside).toEqual([before, after]);
  });
});

describe("entrances", () => {
  it("keeps an element's entrance for as long as it stays drawn", () => {
    const born = new Map([["n:a", 1000]]);
    const first = entrances(new Map(), born, 1000);
    expect(first("n:a", 320)).toEqual({ cls: " draw", delay: "320ms" });
    expect(first("n:b")).toBe(NO_DRAW);
    // A later render, mid draw-in, without n:b: the same entry for n:a, so its animation is untouched.
    const again = entrances(first.kept, born, 1300);
    expect(again("n:a", 320)).toBe(first.kept.get("n:a"));
    expect([...again.kept.keys()]).toEqual(["n:a"]);
  });

  it("joins a draw-in under way for an element drawn for the first time mid-intro", () => {
    const take = entrances(new Map(), new Map([["e:x", 1000]]), 1200);
    expect(take("e:x")).toEqual({ cls: " draw", delay: "-200ms" });
  });

  it("keeps a commit pinned outside the range booked, so entering the range does not replay it", () => {
    const born = new Map([["n:far", 1000]]);
    const pinned = entrances(new Map(), born, 1000);
    const at = pinned("n:far", 320);
    // Panned into the range 100ms later: still the same entry, not a fresh one.
    const later = entrances(pinned.kept, born, 1100);
    expect(later("n:far", 320)).toBe(at);
  });
});

/* ---------- regression pass: the map on a big history ---------- */
describe("the map on a 12k-commit history", () => {
  const { commits, branches, head } = prHistory(3000, 3); // 12,001 commits
  const layout = layoutGraph(commits, branches, head);
  const lastCol = layout.nodes.length - 1;
  const pad = 280;

  // One expect per check rather than one per element: tens of thousands of expect calls are
  // slow enough to time out when the suite shares a busy machine.
  const SLOW = 30_000;

  it("gives every line, hop and commit a real lane, so pointing at the legend dims the rest", () => {
    const lanes = layout.lanes.length;
    const real = (lane: number) => lane >= 0 && lane < lanes;
    expect(layout.nodes.filter((n) => !real(n.lane)).map((n) => n.id)).toEqual([]);
    // Each line is drawn in the pen of the lane it is tagged with, so it dims with that lane.
    const offEdges = layout.edges.filter((e) => !real(e.lane) || e.color !== layout.lanes[e.lane].color);
    expect(offEdges.map((e) => e.key)).toEqual([]);
    const offBridges = layout.bridges.filter((b) => !real(b.lane) || b.color !== layout.lanes[b.lane].color);
    expect(offBridges.map((b) => b.key)).toEqual([]);
  }, SLOW);

  it("letters every flag and lane in the text shade of the pen it is drawn with", () => {
    const textOf = (color: string) => color.replace(/\)$/, "-text)");
    expect(layout.lanes.filter((lane) => lane.text !== textOf(lane.color)).map((l) => l.name)).toEqual([]);
    const flags = layout.nodes.flatMap((n) => n.flags);
    expect(flags.filter((f) => f.text !== textOf(f.color)).map((f) => f.name)).toEqual([]);
    expect(flags.length).toBeGreaterThan(3000);
  }, SLOW);

  it("folds the legend to the branches that still exist", () => {
    const { rows, hidden } = legendRows(layout.lanes, 0);
    expect(rows.map((l) => l.name).sort()).toEqual(["main", "release"]);
    expect(hidden).toBe(layout.lanes.length - 2);
    // The tips the legend flies to are all on the map.
    for (const lane of rows) expect(layout.byHash.has(lane.tip)).toBe(true);
  });

  it("fits as far out as the map goes, staying near where the view is", () => {
    const z = fitZoom(layout.width, layout.height, 1600, 900, 24, 0.45, 1);
    expect(z).toBe(0.45);
    const here = pad + layout.nodes[6000].x;
    expect(fitAxis(pad, pad + layout.width, 1600, 24, z, here)).toBe(here);
    // Near the start it stops at the edge rather than showing empty sheet.
    expect(fitAxis(pad, pad + layout.width, 1600, 24, z, 0)).toBeCloseTo(pad + (800 - 24) / z);
  });

  it("finds head for the go-to-head key and draws it in the range opened around it", () => {
    const home = layout.byHash.get(head)!;
    expect(home.col).toBe(lastCol);
    const left = Math.max(0, home.x + pad - 1600 / 2);
    const range = visibleColumns(left, 1600, 1, pad, lastCol);
    expect(range.from).toBeLessThanOrEqual(home.col);
    expect(range.to).toBe(lastCol);
    const win = drawInWindow(home.col, lastCol, 1600, 1);
    expect(win.to).toBe(lastCol);
    // Only a screenful staggers in, and all of it lies inside what is drawn.
    expect(win.to - win.from).toBeLessThanOrEqual(12);
    expect(win.from).toBeGreaterThanOrEqual(range.from);
  });

  it("has no broken numbers in any path", () => {
    const broken = /NaN|Infinity|undefined/;
    expect(layout.edges.filter((e) => broken.test(e.d)).map((e) => e.key)).toEqual([]);
    const bad = layout.nodes
      .slice(-200)
      .filter((n) => /NaN/.test(n.shape) || !Number.isFinite(n.x) || !Number.isFinite(n.y));
    expect(bad.map((n) => n.id)).toEqual([]);
    expect(scribbleLoop(30, layout.nodes[lastCol].id)).not.toMatch(/NaN/);
  }, SLOW);

  it("keeps the identities of replayed commits after a rebase, so they glide", () => {
    // Rebase the last pull request onto main before its merge, dropping the merge commit.
    const last = 2999;
    const replayed: Commit[] = [];
    let parent = `m${last - 1}`;
    for (let k = 0; k < 3; k++) {
      const old = commits.find((c) => c.hash === `pr${last}-${k}`)!;
      const c = { ...old, hash: `${old.hash}'`, parents: [parent] };
      replayed.unshift(c);
      parent = c.hash;
    }
    const kept = commits.filter((c) => c.hash !== `m${last}` && !c.hash.startsWith(`pr${last}-`));
    const next = [...replayed, ...kept];
    const ids = carryIds(commits, new Map(), next);
    for (let k = 0; k < 3; k++) expect(ids.get(`pr${last}-${k}'`)).toBe(`pr${last}-${k}`);
    const moved = layoutGraph(next, [{ name: "main", commitHash: parent, isHead: true }, branches[1]], parent, ids);
    // The same keys before and after: the circles and the line between them glide, not redraw.
    const key = `pr${last}-0>pr${last}-1`;
    expect(layout.edges.some((e) => e.key === key)).toBe(true);
    expect(moved.edges.some((e) => e.key === key)).toBe(true);
    expect(moved.nodes[moved.nodes.length - 1].id).toBe(`pr${last}-2`);
    // Everything older stays where it was.
    expect(moved.nodes[100].id).toBe(layout.nodes[100].id);
    expect(moved.nodes[100].x).toBe(layout.nodes[100].x);
  }, SLOW);
});

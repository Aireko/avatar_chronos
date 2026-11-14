// Small hand-drawn icons for the toolbar tools. Strokes use currentColor so
// they follow the paper / blackboard theme.

const common = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function FolderIcon() {
  return (
    <svg {...common}>
      <path d="M3.2 6.4c0-1 .7-1.6 1.6-1.6h4.1l2 2.3h8.2c.9 0 1.6.7 1.6 1.5l-.2 9.8c0 .9-.7 1.5-1.6 1.5H4.9c-.9.1-1.6-.6-1.6-1.5z" />
    </svg>
  );
}

export function ExplorerIcon() {
  return (
    <svg {...common}>
      <path d="M3.2 6.4c0-1 .7-1.6 1.6-1.6h4.1l2 2.3h8.2c.9 0 1.6.7 1.6 1.5v2" />
      <path d="M3.3 6.6l-.1 11.3c0 .9.7 1.4 1.5 1.4h6.6" />
      <circle cx="16.4" cy="15.4" r="3.4" />
      <path d="M18.9 18l2.4 2.5" />
    </svg>
  );
}

export function SparkIcon() {
  return (
    <svg {...common}>
      <path d="M11.6 3.2c.5 3.6 1.8 5.4 5.4 6.2-3.5.9-4.9 2.6-5.6 6.3-.6-3.6-2-5.3-5.6-6.2 3.6-.8 5.2-2.6 5.8-6.3z" />
      <path d="M18.6 14.6c.2 1.7.9 2.5 2.5 2.9-1.6.4-2.3 1.2-2.6 2.9-.3-1.7-1-2.5-2.6-2.9 1.6-.4 2.4-1.2 2.7-2.9z" />
    </svg>
  );
}

export function ReviewIcon() {
  return (
    <svg {...common}>
      <circle cx="6.2" cy="5.8" r="2.1" />
      <circle cx="6.1" cy="18.3" r="2.1" />
      <path d="M6.2 8v8.1" />
      <path d="M17.9 16.2V10c0-2-1.2-3.1-3.2-3.1H11" />
      <path d="M12.9 4.9 10.8 6.9l2.2 2" />
      <path d="m15.4 18.4 1.9 1.8 3.3-3.6" />
    </svg>
  );
}

export function ReloadIcon() {
  return (
    <svg {...common}>
      <path d="M19.4 12.2c-.1 4.2-3.4 7.3-7.5 7.3-4.2 0-7.5-3.3-7.4-7.6.1-4.1 3.5-7.3 7.6-7.2 2.4 0 4.3 1.1 5.7 2.8" />
      <path d="M18.4 3.6l-.3 4.3-4.2-.4" />
    </svg>
  );
}

/** Chalk on a board (switch to blackboard) or a sun over paper (switch to paper). */
export function ThemeIcon({ to }: { to: "paper" | "board" }) {
  return to === "board" ? (
    <svg {...common}>
      <path d="M3.6 5.3c5.6-.4 11.2-.4 16.8.1l-.2 11.2c-5.5.3-11 .3-16.5 0z" />
      <path d="M7 10.4c1.6-1.1 3-1.1 4.4.1 1.2 1 2.6 1 4.1-.2" />
      <path d="M8.2 19.6l1.4-2.9M15.8 19.6l-1.4-2.9" />
    </svg>
  ) : (
    <svg {...common}>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 3.2v2.1M12 18.7v2.1M3.2 12h2.1M18.7 12h2.1M5.8 5.8l1.5 1.5M16.7 16.7l1.5 1.5M5.8 18.2l1.5-1.5M16.7 7.3l1.5-1.5" />
    </svg>
  );
}

export function PeopleIcon() {
  return (
    <svg {...common}>
      <circle cx="9" cy="8.2" r="3.2" />
      <path d="M3.2 19.6c.4-3.4 2.6-5.3 5.8-5.3s5.4 1.9 5.9 5.2" />
      <circle cx="17.2" cy="9.4" r="2.4" />
      <path d="M16.4 14.4c2.6-.2 4.2 1.3 4.6 4.3" />
    </svg>
  );
}

/** A wobbly magnifying glass for "Find a commit". */
export function SearchIcon() {
  return (
    <svg {...common}>
      <path d="M10.6 4.2c3.6-.1 6.3 2.6 6.3 6.1.1 3.5-2.7 6.3-6.2 6.3-3.6.1-6.4-2.7-6.4-6.2 0-3.4 2.8-6.2 6.3-6.2z" />
      <path d="M15.3 15.1l5.1 5.2" />
      <path d="M7.6 9.3c.4-1.3 1.4-2.1 2.7-2.3" />
    </svg>
  );
}

/** A small chevron, drawn like the rest (for the recent-repositories dropdown). */
export function ChevronIcon() {
  return (
    <svg {...common} width={16} height={16}>
      <path d="M6.2 9.4c2 1.9 3.9 3.8 5.9 5.6 1.9-2 3.8-3.8 5.8-5.7" />
    </svg>
  );
}

/** A branch peeling off a line, for the branch key in the toolbar. */
export function BranchIcon() {
  return (
    <svg {...common} width={18} height={18}>
      <circle cx="6.4" cy="5.6" r="2.2" />
      <circle cx="6.3" cy="18.4" r="2.2" />
      <circle cx="17.6" cy="7.8" r="2.2" />
      <path d="M6.4 7.9v8.2" />
      <path d="M17.5 10.1c-.2 3.6-2.6 4.9-6.2 5.3-2.3.3-3.9.9-4.6 1.4" />
    </svg>
  );
}

/** An arrow lifting off a line: the work going up to the remote. */
export function PushIcon() {
  return (
    <svg {...common} width={18} height={18}>
      <path d="M12.1 15.6c-.1-3.6 0-7.2-.1-10.8" />
      <path d="M7.6 8.8c1.6-1.6 3-3 4.4-4.4 1.5 1.5 2.9 2.9 4.4 4.5" />
      <path d="M4.2 19.6c5.2-.3 10.4-.3 15.6.1" />
    </svg>
  );
}

/** A small plus, drawn like the rest (for "New branch…"). */
export function PlusIcon() {
  return (
    <svg {...common} width={16} height={16}>
      <path d="M12.1 5.2c-.1 4.6 0 9.1-.2 13.7" />
      <path d="M5.2 12.2c4.6-.2 9.1-.1 13.6 0" />
    </svg>
  );
}

/** A hand-drawn warning sign for the error banner. */
export function WarnIcon() {
  return (
    <svg {...common}>
      <path d="M11.4 3.6c.3-.5 1-.5 1.3 0l8.3 15.1c.3.5-.1 1.1-.7 1.1H3.6c-.6 0-.9-.6-.6-1.1z" />
      <path d="M12.1 9.4l-.2 4.9" />
      <path d="M12 17.1v.1" />
    </svg>
  );
}

// ---- Empty-state doodles. Bigger sketches whose strokes draw themselves in
// (each path has pathLength=1; see .doodle in tools.css). Colours come from
// classes so both themes recolour them. ----

const doodle = {
  className: "doodle",
  viewBox: "0 0 160 90",
  fill: "none",
  strokeWidth: 2.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** A little commit history: a main line with a branch peeling off it. */
export function HistoryDoodle() {
  return (
    <svg {...doodle} width={176} height={99}>
      <path className="d-ink" pathLength={1} d="M14 62c34-1.6 70 1.4 132-.6" />
      <path className="d-pen-a" pathLength={1} d="M48 61.6c10-1.2 13-27.4 32-28.6 14-.6 26 .8 40-.4" />
      <path className="d-soft d-dash" pathLength={1} d="M120 32.6c12 .4 18 4 26 6" />
      <circle className="d-dot d-ink" cx="20" cy="61.8" r="5.2" />
      <circle className="d-dot d-ink" cx="48" cy="61.4" r="5.2" />
      <circle className="d-dot d-ink" cx="88" cy="62.2" r="5.2" />
      <circle className="d-dot d-pen-a" cx="82" cy="32.8" r="5.2" />
      <circle className="d-dot d-pen-a" cx="118" cy="32.4" r="5.2" />
      <circle className="d-dot d-ink" cx="138" cy="61.8" r="5.2" />
    </svg>
  );
}

/** A magnifying glass over an empty, dashed line: nothing found here. */
export function EmptyScopeDoodle() {
  return (
    <svg {...doodle} width={176} height={99}>
      <path className="d-soft d-dash" pathLength={1} d="M18 78c40-1.4 84 1 124-.4" />
      <path className="d-ink" pathLength={1} d="M80.6 18.4c11.6-.6 20.4 8 20.2 19.4-.2 11-9.4 19.6-20.6 19.2-11-.4-19.2-9-18.8-20 .2-10 8.6-18 19.2-18.6z" />
      <path className="d-ink" pathLength={1} d="M95.4 52.2l13.8 14.4" />
      <path className="d-pen-a" pathLength={1} d="M74.6 32.6c.8-4.2 4.4-6.2 7.8-5.4 3.6.8 5 4.6 3 7.4-1.6 2.2-4.4 2.8-4.6 6.2" />
      <path className="d-pen-a" pathLength={1} d="M80.8 46.2v.2" />
    </svg>
  );
}

/**
 * "Open in the editor": a pen arrow leaving a little sheet, drawn at the size of the
 * text it sits in (the ticket's file rows). Replaces the "↗" glyph, which Patrick Hand
 * doesn't have and so came out in a crisp system symbol font.
 */
export function OpenFileIcon() {
  return (
    <svg
      className="open-file-icon"
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.1 2.4H3.3c-.7 0-1 .4-1 1.1l.1 7.3c0 .6.4 1 1 1l7.2-.1c.6 0 1-.4 1-1V8" />
      <path d="M6.6 7.5 11.7 2.3" />
      <path d="M8.4 2.2l3.4-.1.1 3.3" />
    </svg>
  );
}

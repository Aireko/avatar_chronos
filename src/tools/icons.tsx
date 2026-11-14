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

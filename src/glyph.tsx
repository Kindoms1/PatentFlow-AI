import type { ReactNode } from "react";

export function Glyph({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] ?? paths.dot}
    </svg>
  );
}

const paths: Record<string, ReactNode> = {
  dot: <circle cx="12" cy="12" r="2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  chat: <path d="M5 6h14v9H8l-3 3z" />,
  skill: <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />,
  panel: <path d="M4 5h16v14H4zM14 5v14" />,
  search: <><circle cx="11" cy="11" r="5" /><path d="M15 15l4 4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
  chevron: <path d="M8 10l4 4 4-4" />,
  arrow: <path d="M12 17V7M8 11l4-4 4 4" />,
  close: <path d="M7 7l10 10M17 7L7 17" />,
  file: <path d="M7 4h7l4 4v12H7zM14 4v4h4" />,
  doc: <path d="M7 4h10v16H7zM9 8h6M9 12h6M9 16h4" />,
  tree: <path d="M12 4v16M12 8h5M12 14H7" />,
  chart: <path d="M5 18V9M12 18V6M19 18v-7" />,
  image: <path d="M5 6h14v12H5zM8 14l2.5-3 2 2.2L15 10l4 4" />,
  diff: <path d="M8 7h10M8 12h10M8 17h6" />,
  check: <path d="M5 12l4 4 10-10" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  book: <path d="M5 4h6a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3zM5 4v16M19 4h-6a3 3 0 0 0-3 3v13h6a3 3 0 0 1 3-3z" />,
  sidebar: <><rect x="4" y="5" width="16" height="14" rx="2.5" /><path d="M9.5 5v14" /></>,
  radar: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><path d="M12 12l5.5-5.5" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  info: <><circle cx="12" cy="12" r="8" /><path d="M12 11v5M12 8h.01" /></>,
};

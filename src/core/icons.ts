// Inline SVG icons (stroke style, inherit currentColor).
const svg = (body: string, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  files: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', 24),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 24),
  git: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5"/>', 24),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', 24),
  chevronRight: svg('<path d="m9 6 6 6-6 6"/>'),
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>', 14),
  newFile: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>'),
  newFolder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  collapse: svg('<path d="M4 6h16M4 12h10M4 18h6"/>'),
  split: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  discard: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  openFile: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>'),
  caseSensitive: '<span class="txt-icon">Aa</span>',
  wholeWord: '<span class="txt-icon"><u>ab</u></span>',
  regex: '<span class="txt-icon">.*</span>',
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  branch: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 4-6 3-12 8"/>', 14),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  terminal: svg('<path d="m5 8 4 4-4 4M12 17h7"/>'),
  replaceAll: svg('<path d="M4 7h11l-3-3M20 17H9l3 3"/>'),
};

/** Colored file-type badge, cheaper than an icon theme and easy to restyle in style.css. */
const FILE_COLORS: Record<string, string> = {
  ts: "#3178c6", tsx: "#3178c6", js: "#e8c22e", jsx: "#e8c22e", mjs: "#e8c22e", cjs: "#e8c22e",
  rs: "#dea584", py: "#4b8bbe", go: "#00add8", java: "#b07219", kt: "#a97bff", swift: "#f05138",
  c: "#888", h: "#888", cpp: "#f34b7d", cs: "#178600", rb: "#cc342d", php: "#777bb4",
  html: "#e34c26", css: "#563d7c", scss: "#c6538c", json: "#cbcb41", jsonc: "#cbcb41",
  md: "#519aba", mdx: "#519aba", yml: "#cb171e", yaml: "#cb171e", toml: "#9c4221",
  sh: "#89e051", zsh: "#89e051", sql: "#e38c00", vue: "#41b883", svelte: "#ff3e00",
  lock: "#777", txt: "#999", zig: "#ec915c", lua: "#000080", dart: "#00b4ab",
};

export function fileIcon(name: string) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const color = FILE_COLORS[ext] ?? "var(--fg-dim)";
  return `<span class="file-icon" style="color:${color}">${icons.file}</span>`;
}

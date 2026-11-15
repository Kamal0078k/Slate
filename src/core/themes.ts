// Theme engine. Slate ships no themes except "default" (VS Code's dark look, from the
// stylesheet). Every other theme is a file in ~/.config/slate/themes/<name>.toml:
//
//   name = "Steins Amoled"        # display name (optional)
//   appearance = "dark"           # "dark" | "light"
//   glow = false                  # glowing accent text
//   [colors]   background, foreground, panel, dim, border, accent, accent_foreground,
//              selection, hover, selected, red, green, yellow, blue, magenta, cyan, orange,
//              sidebar_background, statusbar_background, widget_background,
//              input_background, tab_active_foreground, cursor
//   [syntax]   keyword, string, number, type, function, comment, variable, operator,
//              tag, attribute, constant, regexp, delimiter, heading
//   [editor]   any Monaco color id, e.g. "editor.lineHighlightBackground" = "#..."
//   [ui]       any CSS variable, e.g. "--tab-border-top" = "#..."
//   [terminal] background, foreground, cursor, selection and the 16 ANSI colors:
//              black, red, green, yellow, blue, magenta, cyan, white, bright_black, ...
//
// Only `background`, `foreground` and `accent` are needed; everything else is derived.
import { monaco } from "./monaco";

export interface ThemeFile {
  name?: string;
  appearance?: "dark" | "light";
  glow?: boolean;
  colors?: Record<string, string>;
  syntax?: Record<string, string>;
  editor?: Record<string, string>;
  ui?: Record<string, string>;
  terminal?: Record<string, string>;
}

export interface ResolvedTheme {
  name: string;
  light: boolean;
  glow: boolean;
  monacoTheme: string;
  vars: Record<string, string>;
  /** Terminal palette: background, foreground, cursor, selection + 16 ANSI colors. */
  terminal: Record<string, string>;
}

let current: ResolvedTheme | null = null;
/** The theme last applied (terminals read their colors from it). */
export const currentTheme = () => current;

/** ANSI colors from the theme's [colors] when its [terminal] table leaves them out. */
function terminalPalette(c: Colors, light: boolean, own: Colors = {}): Colors {
  const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
  const base: Colors = {
    background: c.background,
    foreground: c.foreground,
    cursor: c.cursor ?? c.accent,
    selection: c.selection,
    black: light ? mix(c.foreground, 80, "#000000") : mix(c.foreground, 15, c.background),
    red: c.red, green: c.green, yellow: c.yellow, blue: c.blue, magenta: c.magenta, cyan: c.cyan,
    white: light ? mix(c.foreground, 30, c.background) : c.foreground,
    bright_black: c.dim,
    bright_red: c.orange ?? c.red, bright_green: c.green, bright_yellow: c.yellow, bright_blue: c.blue,
    bright_magenta: c.magenta, bright_cyan: c.cyan,
    bright_white: light ? c.foreground : mix(c.foreground, 70, "#ffffff"),
  };
  const out: Colors = {};
  for (const [k, v] of Object.entries({ ...base, ...own })) if (v) out[k] = toHex(v);
  return out;
}

/** VS Code's own dark terminal colors, for the built-in "default" theme. */
const DEFAULT_TERMINAL: Colors = {
  background: "#1e1e1e", foreground: "#cccccc", cursor: "#aeafad", selection: "#264f78",
  black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8",
  magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5", bright_black: "#666666",
  bright_red: "#f14c4c", bright_green: "#23d18b", bright_yellow: "#f5f543", bright_blue: "#3b8eea",
  bright_magenta: "#d670d6", bright_cyan: "#29b8db", bright_white: "#e5e5e5",
};

export const DEFAULT_THEME = "default";

let themeFiles: Record<string, ThemeFile> = {};
const pluginThemes = new Map<string, { light: boolean }>();

export function setThemeFiles(themes: Record<string, ThemeFile>) {
  themeFiles = themes ?? {};
}
export function registerPluginTheme(name: string, base: string) {
  pluginThemes.set(name, { light: base === "vs" || base === "hc-light" });
}
export const pluginThemeNames = () => [...pluginThemes.keys()];
export const themeNames = (): string[] => [DEFAULT_THEME, ...Object.keys(themeFiles), ...pluginThemes.keys()];
export const themeLabel = (name: string) => themeFiles[name]?.name ?? name;
export const themeExists = (name: string) => name === DEFAULT_THEME || name in themeFiles || pluginThemes.has(name);

/** Older/herdr-style names accepted in [theme.custom]. */
const ALIASES: Record<string, string> = {
  text: "foreground", panel_bg: "background", editor_bg: "background", sidebar_bg: "sidebar_background",
  selection_bg: "selection", active_row_bg: "selected",
};

type Colors = Record<string, string>;

/** Fills in every color the UI and editor need from the few a theme defines. */
function completeColors(c: Colors, light: boolean): Colors {
  const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
  const bg = c.background ?? (light ? "#ffffff" : "#1e1e1e");
  const fg = c.foreground ?? (light ? "#333333" : "#cccccc");
  const accent = c.accent ?? "#0078d4";
  const panel = c.panel ?? mix(bg, 88, light ? "#000000" : "#ffffff");
  return {
    background: bg,
    foreground: fg,
    accent,
    panel,
    dim: c.dim ?? mix(fg, 55, bg),
    border: c.border ?? mix(fg, 18, bg),
    accent_foreground: c.accent_foreground ?? bg,
    selection: c.selection ?? mix(accent, 30, bg),
    hover: c.hover ?? mix(fg, 7, panel),
    selected: c.selected ?? mix(c.selection ?? accent, 60, panel),
    red: c.red ?? "#e06c75",
    green: c.green ?? "#98c379",
    yellow: c.yellow ?? "#e5c07b",
    blue: c.blue ?? "#61afef",
    magenta: c.magenta ?? "#c678dd",
    cyan: c.cyan ?? "#56b6c2",
    orange: c.orange ?? c.yellow ?? "#d19a66",
    sidebar_background: c.sidebar_background ?? panel,
    statusbar_background: c.statusbar_background ?? panel,
    widget_background: c.widget_background ?? panel,
    input_background: c.input_background ?? bg,
    tab_active_foreground: c.tab_active_foreground ?? fg,
    cursor: c.cursor ?? accent,
  };
}

// Monaco only accepts hex colors; derived values (color-mix) are resolved through the DOM.
function toHex(color: string): string {
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  probe.style.color = color;
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const m = rgb.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  const scale = rgb.startsWith("color(") ? 255 : 1; // color(srgb r g b) uses 0..1
  const [r, g, b] = m.slice(0, 3).map((v) => Math.round(v * scale));
  const alpha = m.length > 3 ? m[3] : 1;
  const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha < 1 ? hex(Math.round(alpha * 255)) : ""}`;
}

function uiVars(c: Colors, light: boolean): Record<string, string> {
  return {
    "--bg": c.background,
    "--fg": c.foreground,
    "--fg-dim": c.dim,
    "--fg-strong": light ? "#000000" : `color-mix(in srgb, ${c.foreground} 70%, #ffffff)`,
    "--border": c.border,
    "--accent": c.accent,
    "--accent-fg": c.accent_foreground,
    "--focus": c.accent,
    "--activitybar-bg": c.panel,
    "--activitybar-fg": c.dim,
    "--activitybar-active": c.foreground,
    "--sidebar-bg": c.sidebar_background,
    "--tabs-bg": c.panel,
    "--tab-bg": c.panel,
    "--tab-active-bg": c.background,
    "--tab-active-fg": c.tab_active_foreground,
    "--tab-border-top": c.accent,
    "--hover-bg": c.hover,
    "--selected-bg": c.selected,
    "--selected-focus-bg": c.selection,
    "--input-bg": c.input_background,
    "--input-border": c.border,
    "--statusbar-bg": c.statusbar_background,
    "--statusbar-fg": c.dim,
    "--statusbar-hover": c.hover,
    "--widget-bg": c.widget_background,
    "--widget-shadow": light ? "rgba(0,0,0,0.16)" : "rgba(0,0,0,0.55)",
    "--match-bg": `color-mix(in srgb, ${c.accent} 30%, transparent)`,
    "--git-modified": c.yellow,
    "--git-added": c.green,
    "--git-untracked": c.cyan,
    "--git-deleted": c.red,
    "--git-conflict": c.red,
  };
}

function monacoTheme(c: Colors, syntax: Colors, editor: Colors, light: boolean): monaco.editor.IStandaloneThemeData {
  const h = toHex;
  const t: Colors = {
    keyword: c.magenta, string: c.green, number: c.orange, type: c.yellow, function: c.blue, comment: c.dim,
    variable: c.foreground, operator: c.cyan, tag: c.red, attribute: c.yellow, constant: c.orange,
    regexp: c.red, delimiter: c.dim, heading: c.accent,
    ...syntax,
  };
  const fg = (x: string) => h(x).slice(1, 7);
  const a = (x: string, alpha: string) => h(x).slice(0, 7) + alpha;
  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: "", foreground: fg(c.foreground) },
    { token: "comment", foreground: fg(t.comment), fontStyle: "italic" },
    { token: "keyword", foreground: fg(t.keyword) },
    { token: "storage", foreground: fg(t.keyword) },
    { token: "string", foreground: fg(t.string) },
    { token: "string.escape", foreground: fg(c.cyan) },
    { token: "number", foreground: fg(t.number) },
    { token: "constant", foreground: fg(t.constant) },
    { token: "regexp", foreground: fg(t.regexp) },
    { token: "type", foreground: fg(t.type) },
    { token: "type.identifier", foreground: fg(t.type) },
    { token: "function", foreground: fg(t.function) },
    { token: "identifier", foreground: fg(t.variable) },
    { token: "variable", foreground: fg(t.variable) },
    { token: "delimiter", foreground: fg(t.delimiter) },
    { token: "operator", foreground: fg(t.operator) },
    { token: "tag", foreground: fg(t.tag) },
    { token: "attribute.name", foreground: fg(t.attribute) },
    { token: "attribute.value", foreground: fg(t.string) },
    { token: "key", foreground: fg(c.blue) },
    { token: "string.key.json", foreground: fg(c.blue) },
    { token: "string.value.json", foreground: fg(t.string) },
    { token: "markup.heading", foreground: fg(t.heading), fontStyle: "bold" },
  ];
  return {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules,
    colors: {
      "editor.background": h(c.background),
      "editor.foreground": h(c.foreground),
      "editorCursor.foreground": h(c.cursor),
      "editor.lineHighlightBackground": a(c.selection, "55"),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": a(c.selection, "cc"),
      "editor.inactiveSelectionBackground": a(c.selection, "77"),
      "editor.selectionHighlightBackground": a(c.accent, "22"),
      "editor.wordHighlightBackground": a(c.accent, "1f"),
      "editor.findMatchBackground": a(c.accent, "55"),
      "editor.findMatchHighlightBackground": a(c.accent, "26"),
      "editorLineNumber.foreground": a(c.dim, "99"),
      "editorLineNumber.activeForeground": h(c.accent),
      "editorIndentGuide.background1": a(c.border, "aa"),
      "editorIndentGuide.activeBackground1": h(c.border),
      "editorBracketMatch.background": a(c.accent, "22"),
      "editorBracketMatch.border": a(c.accent, "88"),
      "editorWhitespace.foreground": a(c.dim, "44"),
      "editorWidget.background": h(c.widget_background),
      "editorWidget.border": h(c.border),
      "editorSuggestWidget.background": h(c.widget_background),
      "editorSuggestWidget.selectedBackground": h(c.selection),
      "editorHoverWidget.background": h(c.widget_background),
      "input.background": h(c.input_background),
      "input.border": h(c.border),
      focusBorder: a(c.accent, "aa"),
      "list.hoverBackground": h(c.hover),
      "list.activeSelectionBackground": h(c.selection),
      "list.highlightForeground": h(c.accent),
      "minimap.background": h(c.background),
      "scrollbarSlider.background": a(c.dim, "33"),
      "scrollbarSlider.hoverBackground": a(c.dim, "55"),
      "scrollbarSlider.activeBackground": a(c.dim, "77"),
      "editorOverviewRuler.border": "#00000000",
      "editorGutter.background": h(c.background),
      "diffEditor.insertedTextBackground": a(c.green, "2a"),
      "diffEditor.removedTextBackground": a(c.red, "2e"),
      "diffEditor.insertedLineBackground": a(c.green, "14"),
      "diffEditor.removedLineBackground": a(c.red, "18"),
      ...Object.fromEntries(Object.entries(editor).map(([k, v]) => [k, h(v)])),
    },
  };
}

/** Editor colors that must be see-through so a background image shows behind the text. */
const TRANSPARENT = {
  "editor.background": "#00000000",
  "editorGutter.background": "#00000000",
  "minimap.background": "#00000000",
};
/** Overlays that sit on top of scrolled code must stay solid, or text shows through. */
const solidOverlays = (bg: string, border: string) => ({
  "editorStickyScroll.background": bg,
  "editorStickyScrollGutter.background": bg,
  "editorStickyScrollHover.background": bg,
  "editorStickyScroll.border": border,
  "editorStickyScroll.shadow": "#00000066",
});

let seq = 0;

/** Builds `name` with [theme.custom] overrides and registers the Monaco theme. */
export function resolveTheme(name: string, custom: Record<string, string>, transparent = false): ResolvedTheme {
  const rawVars: Record<string, string> = {};
  const customColors: Colors = {};
  for (const [k, v] of Object.entries(custom ?? {})) {
    if (k.startsWith("--")) rawVars[k] = v;
    else customColors[ALIASES[k] ?? k] = v;
  }

  const file = themeFiles[name];
  if (file) {
    const light = file.appearance === "light";
    const colors = completeColors({ ...file.colors, ...customColors }, light);
    const data = monacoTheme(colors, file.syntax ?? {}, file.editor ?? {}, light);
    if (transparent) Object.assign(data.colors, TRANSPARENT, solidOverlays(toHex(colors.background), toHex(colors.border)));
    const id = `slate-theme-${++seq}`; // fresh id so edits to the file always apply
    monaco.editor.defineTheme(id, data);
    current = {
      name, light, glow: !!file.glow, monacoTheme: id,
      vars: { ...uiVars(colors, light), ...file.ui, ...rawVars },
      terminal: terminalPalette(colors, light, file.terminal ?? {}),
    };
    return current;
  }

  const plugin = pluginThemes.get(name);
  if (plugin) {
    current = { name, light: plugin.light, glow: false, monacoTheme: name, vars: rawVars, terminal: { ...DEFAULT_TERMINAL } };
    return current;
  }

  // "default": VS Code's dark look; colors come from the stylesheet.
  const vars: Record<string, string> = { ...rawVars };
  const set = (key: string, ...cssVars: string[]) => {
    if (customColors[key]) for (const v of cssVars) vars[v] = customColors[key];
  };
  set("accent", "--accent", "--focus", "--tab-border-top");
  set("background", "--bg");
  set("foreground", "--fg");
  set("border", "--border");
  set("sidebar_background", "--sidebar-bg");
  let monacoId = "vs-dark";
  if (transparent) {
    monacoId = "slate-default-transparent";
    monaco.editor.defineTheme(monacoId, { base: "vs-dark", inherit: true, rules: [], colors: { ...TRANSPARENT, ...solidOverlays("#1e1e1e", "#2b2b2b") } });
  }
  current = { name: DEFAULT_THEME, light: false, glow: false, monacoTheme: monacoId, vars, terminal: { ...DEFAULT_TERMINAL } };
  return current;
}

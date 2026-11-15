// Effective configuration (config.toml merged over defaults by the Rust side) and how it maps
// onto Monaco and the UI. Keys use the TOML names, e.g. settings.get("files.auto_save").
import { monaco } from "./monaco";
import { ensureFamilies, MONO_FALLBACK, UI_FALLBACK, withFallback } from "./fonts";
import { state } from "./state";
import { DEFAULT_THEME, resolveTheme, setThemeFiles, ThemeFile, themeExists } from "./themes";
import { bus } from "./util";

let config: Record<string, any> = {};
/** Runtime overrides (zoom, palette toggles, theme preview). Not written to disk. */
const session: Record<string, unknown> = {};
let userCss = "";
let themeWarning: string | null = null;

function lookup(obj: Record<string, any>, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export const settings = {
  get<T = unknown>(key: string, fallback?: T): T {
    if (key in session) return session[key] as T;
    const v = lookup(config, key);
    return (v === undefined ? fallback : v) as T;
  },
  /** The whole effective config (read-only copy). */
  all(): Record<string, any> {
    return structuredClone(config);
  },
  setSession(key: string, value: unknown) {
    if (value === undefined) delete session[key];
    else session[key] = value;
    applySettings();
  },
  get themeWarning() {
    return themeWarning;
  },
};

export function loadSettings(effective: Record<string, any>, css: string | null, themes: Record<string, ThemeFile> = {}) {
  config = effective ?? {};
  setThemeFiles(themes);
  userCss = css ?? "";
  applySettings();
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function camelize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelize(x)]));
  return v;
}

// [editor] keys that are Slate's own rather than Monaco options.
const NON_MONACO = new Set(["format_on_save"]);

/** Monaco options from the [editor] table (snake_case -> camelCase), plus session overrides. */
export function editorOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
  const editor: Record<string, unknown> = { ...(config.editor ?? {}) };
  for (const k of NON_MONACO) delete editor[k];
  for (const [k, v] of Object.entries(session)) {
    if (!k.startsWith("editor.")) continue;
    const path = k.slice(7).split(".");
    let obj: any = editor;
    for (const part of path.slice(0, -1)) obj = obj[part] = { ...(obj[part] ?? {}) };
    obj[path[path.length - 1]] = v;
  }
  const opts = camelize(editor) as Record<string, unknown>;
  opts.fontFamily = withFallback(opts.fontFamily as string, MONO_FALLBACK);
  return { ...opts, automaticLayout: true, fixedOverflowWidgets: true };
}

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
prefersDark.addEventListener("change", () => settings.get("theme.auto_switch") && applySettings());

export function activeThemeName(): string {
  if (session["theme.name"]) return session["theme.name"] as string;
  if (settings.get("theme.auto_switch")) {
    return settings.get<string>(prefersDark.matches ? "theme.dark_name" : "theme.light_name", DEFAULT_THEME);
  }
  return settings.get<string>("theme.name", DEFAULT_THEME);
}

let styleEl: HTMLStyleElement | null = null;
let themeVarsSet = new Set<string>();

export function applySettings() {
  const name = activeThemeName();
  themeWarning = themeExists(name) ? null : `theme "${name}" not found in themes/; using default`;
  const theme = resolveTheme(name, settings.get<Record<string, string>>("theme.custom", {}), state.backdrop || state.layoutBackdrop);
  monaco.editor.setTheme(theme.monacoTheme);

  const root = document.documentElement;
  root.dataset.theme = theme.light ? "light" : "dark";
  root.classList.toggle("theme-glow", theme.glow);
  // Only clear the variables the previous theme set; the layout engine owns others
  // (pane frames, editor opacity, terminal padding, tab height).
  for (const prop of themeVarsSet) if (!(prop in theme.vars)) root.style.removeProperty(prop);
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  themeVarsSet = new Set(Object.keys(theme.vars));
  root.style.setProperty("--font-ui", withFallback(settings.get<string>("ui.font_family", ""), UI_FALLBACK));
  void ensureFamilies(settings.get<string>("ui.font_family", ""), settings.get<string>("editor.font_family", ""));
  root.style.setProperty("--font-size-ui", `${settings.get<number>("ui.font_size", 13)}px`);
  // Pane frames and tab height come from the layout's editor block (src/ui/sidebar.ts).
  root.style.setProperty("--section-marker", JSON.stringify(settings.get<string>("ui.section_marker", "")));

  styleEl ??= document.head.appendChild(document.createElement("style"));
  styleEl.textContent = userCss;
  bus.emit("settings");
}

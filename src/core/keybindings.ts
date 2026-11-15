// Global key handling. Bindings are resolved before Monaco sees the key, so user and
// plugin bindings can override anything, including Monaco's own shortcuts.
import { executeCommand } from "./commands";
import { isMac } from "./util";

export interface Keybinding {
  key: string;
  command: string;
  args?: unknown;
}

/** Named actions for the [keys] table in config.toml (default keys live in the default config). */
export const ACTIONS: Record<string, string> = {
  quick_open: "workbench.action.quickOpen",
  command_palette: "workbench.action.showCommands",
  go_to_line: "workbench.action.gotoLine",
  go_to_symbol: "workbench.action.gotoSymbol",
  open_folder: "workbench.action.files.openFolder",
  new_file: "workbench.action.files.newUntitledFile",
  save: "workbench.action.files.save",
  save_as: "workbench.action.files.saveAs",
  save_all: "workbench.action.files.saveAll",
  close_editor: "workbench.action.closeActiveEditor",
  reopen_closed_editor: "workbench.action.reopenClosedEditor",
  split_right: "workbench.action.splitEditor",
  split_down: "workbench.action.splitEditorDown",
  focus_group_1: "workbench.action.focusFirstEditorGroup",
  focus_group_2: "workbench.action.focusSecondEditorGroup",
  focus_group_3: "workbench.action.focusThirdEditorGroup",
  next_editor: "workbench.action.nextEditor",
  previous_editor: "workbench.action.previousEditor",
  toggle_sidebar: "workbench.action.toggleSidebarVisibility",
  show_explorer: "workbench.view.explorer",
  find_in_files: "workbench.action.findInFiles",
  replace_in_files: "workbench.action.replaceInFiles",
  show_scm: "workbench.view.scm",
  open_config: "workbench.action.openConfig",
  zoom_in: "workbench.action.zoomIn",
  zoom_out: "workbench.action.zoomOut",
  zoom_reset: "workbench.action.zoomReset",
  toggle_word_wrap: "editor.action.toggleWordWrap",
  reload_window: "workbench.action.reloadWindow",
  copy_path: "copyFilePath",
  copy_relative_path: "copyRelativeFilePath",
  copy_reference: "copyFileReference",
  toggle_terminal: "terminal.toggle",
  new_terminal: "terminal.new",
  background_random: "background.random",
  background_next: "background.next",
  background_previous: "background.previous",
  background_select: "background.select",
  background_toggle_focus: "background.toggleFocus",
};

/** Commands whose keys work even while a terminal has focus. */
const TERMINAL_KEYS = new Set(["terminal.toggle", "terminal.new"]);

let configBindings: Keybinding[] = [];
const pluginBindings: Keybinding[] = [];
let table = new Map<string, Keybinding>();

const ALIASES: Record<string, string> = {
  esc: "escape", return: "enter", arrowup: "up", arrowdown: "down", arrowleft: "left",
  arrowright: "right", del: "delete", backslash: "\\", plus: "=", " ": "space",
};

/** "Cmd+Shift+P" -> "shift+meta+p" (canonical modifier order). */
export function normalizeKey(key: string): string {
  let ctrl = false, alt = false, shift = false, meta = false, k = "";
  for (const raw of key.toLowerCase().split("+")) {
    const p = raw.trim();
    if (p === "mod") isMac ? (meta = true) : (ctrl = true);
    else if (p === "cmd" || p === "meta" || p === "win" || p === "super") meta = true;
    else if (p === "ctrl" || p === "control") ctrl = true;
    else if (p === "alt" || p === "option" || p === "opt") alt = true;
    else if (p === "shift") shift = true;
    else k = ALIASES[p] ?? p;
  }
  return [ctrl && "ctrl", alt && "alt", shift && "shift", meta && "meta", k].filter(Boolean).join("+");
}

const CODE_MAP: Record<string, string> = {
  Backslash: "\\", Slash: "/", Comma: ",", Period: ".", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "enter", NumpadEnter: "enter", Escape: "escape", Tab: "tab", Space: "space",
  Backspace: "backspace", Delete: "delete", PageUp: "pageup", PageDown: "pagedown",
  Home: "home", End: "end", NumpadAdd: "=", NumpadSubtract: "-",
};

/** Physical-key based so Shift/Option don't change the key name (works on any layout's letters). */
export function eventToKey(e: KeyboardEvent): string {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return "";
  let k: string;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) k = e.code.slice(6);
  else if (/^F\d{1,2}$/.test(e.code)) k = e.code.toLowerCase();
  else k = CODE_MAP[e.code] ?? e.key.toLowerCase();
  return [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta", k]
    .filter(Boolean)
    .join("+");
}

function rebuild() {
  table = new Map();
  // Plugin bindings first so the user's config always wins.
  for (const b of [...pluginBindings, ...configBindings]) {
    if (b.key) table.set(normalizeKey(b.key), b);
  }
}

export interface KeysConfig {
  [action: string]: unknown;
  bind?: { key: string; command: string; args?: unknown }[];
  command?: { key: string; command: string; type?: string; description?: string }[];
}

/** Applies the effective [keys] table: named actions, [[keys.bind]] and [[keys.command]]. */
export function setConfigKeybindings(keys: KeysConfig) {
  const list: Keybinding[] = [];
  for (const [action, value] of Object.entries(keys ?? {})) {
    const command = ACTIONS[action];
    if (!command) continue;
    for (const key of Array.isArray(value) ? value : [value]) if (typeof key === "string" && key) list.push({ key, command });
  }
  for (const b of keys?.bind ?? []) list.push({ key: b.key, command: b.command, args: b.args });
  for (const c of keys?.command ?? []) {
    const type = c.type ?? "shell";
    if (type === "shell") list.push({ key: c.key, command: "sumi.runShellCommand", args: c.command });
    else list.push({ key: c.key, command: c.command });
  }
  configBindings = list;
  rebuild();
}

export function addPluginKeybinding(b: Keybinding) {
  pluginBindings.push(b);
  rebuild();
  return {
    dispose: () => {
      pluginBindings.splice(pluginBindings.indexOf(b), 1);
      rebuild();
    },
  };
}

/** Human label for the key currently bound to a command, e.g. "⇧⌘P". */
export function keyLabelFor(command: string): string {
  for (const [key, b] of table) if (b.command === command) return formatKey(key);
  return "";
}

export function formatKey(key: string): string {
  const parts = key.split("+");
  const k = parts.pop()!;
  const name = k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
  if (isMac) {
    const sym: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
    const keySym: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", enter: "↩", escape: "⎋", backspace: "⌫", tab: "⇥" };
    return parts.map((p) => sym[p]).join("") + (keySym[k] ?? name);
  }
  const names: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" };
  return [...parts.map((p) => names[p]), name].join("+");
}

export function installKeybindings() {
  rebuild();
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      const key = eventToKey(e);
      if (!key) return;
      const binding = table.get(key);
      if (!binding) return;
      // In a terminal the shell gets the keys (Ctrl+C, Ctrl+R, Esc, Option+…), except Sumi's
      // ⌘ shortcuts (Ctrl+Shift on Windows/Linux) and the terminal toggles themselves.
      const inTerminal = !!(e.target as HTMLElement | null)?.closest?.(".terminal-host");
      if (inTerminal && !(isMac ? e.metaKey : e.ctrlKey && e.shiftKey) && !TERMINAL_KEYS.has(binding.command)) return;
      e.preventDefault();
      e.stopPropagation();
      void executeCommand(binding.command, binding.args);
    },
    true,
  );
}

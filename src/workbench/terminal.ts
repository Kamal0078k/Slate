// One integrated terminal: xterm.js (the terminal VS Code uses) on top of a shell running in a
// pseudo-terminal on the Rust side (src-tauri/src/pty.rs). Shown as a tab in editor groups.
import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ILink } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ensureFamilies, MONO_FALLBACK, withFallback } from "../core/fonts";
import { monaco } from "../core/monaco";
import { settings } from "../core/settings";
import { state } from "../core/state";
import { currentTheme } from "../core/themes";
import { basename, bus, h, isInside, isMac } from "../core/util";

type TermEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };

let seq = 0;
const sessions = new Set<TerminalSession>();

/** Keys that stay with Slate while a terminal has focus (everything else goes to the shell). */
export const isSlateKeyInTerminal = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey && e.shiftKey);

export class TerminalSession {
  readonly id = ++seq;
  readonly el = h("div.terminal-host");
  readonly term: Terminal;
  private fit = new FitAddon();
  private ptyId: number | null = null;
  private resizeObserver: ResizeObserver;
  title: string;
  exited = false;
  /** Called when the shell exits (the tab closes itself). */
  onExit: (code: number | null) => void = () => {};
  onTitle: () => void = () => {};

  constructor(readonly cwd: string | null) {
    this.title = basename(process_shell());
    this.term = new Terminal({ ...terminalOptions(), allowProposedApi: true });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void invoke("exec", { argv: [isMac ? "open" : "xdg-open", uri], cwd: null, env: null })));
    this.term.registerLinkProvider(fileLinkProvider(this));
    this.term.onTitleChange((t) => {
      this.title = t || this.title;
      this.onTitle();
    });
    this.term.onData((data) => {
      if (this.ptyId != null) void invoke("term_write", { id: this.ptyId, data }).catch(() => undefined);
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId != null) void invoke("term_resize", { id: this.ptyId, cols, rows }).catch(() => undefined);
    });
    // ⌘K clears like iTerm/VS Code; other Slate shortcuts are left to the global handler.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key.toLowerCase() === "k" && (isMac ? e.metaKey : e.ctrlKey && e.shiftKey) && !e.altKey) {
        this.term.clear();
        return false;
      }
      return !isSlateKeyInTerminal(e);
    });
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.el);
    sessions.add(this);
  }

  /** Opens xterm in its element (must be in the document) and starts the shell. */
  async start() {
    this.term.open(this.el);
    try {
      this.term.loadAddon(new WebglAddon());
    } catch {
      /* WebGL unavailable: xterm's DOM renderer still works */
    }
    this.layout();
    const channel = new Channel<TermEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "data") this.term.write(ev.data);
      else {
        this.exited = true;
        this.ptyId = null;
        this.onExit(ev.code);
      }
    };
    const t = settings.get<{ shell?: string; args?: string[] }>("terminal", {}) ?? {};
    try {
      this.ptyId = await invoke<number>("term_spawn", {
        options: { cwd: this.cwd, cols: this.term.cols, rows: this.term.rows, shell: t.shell ?? "", args: t.args ?? [], env: {} },
        onEvent: channel,
      });
    } catch (e) {
      this.term.write(`\r\n\x1b[31mCould not start the shell: ${e}\x1b[0m\r\n`);
    }
  }

  layout() {
    if (!this.el.isConnected || !this.el.offsetWidth || !this.el.offsetHeight) return;
    try {
      this.fit.fit();
    } catch {
      /* not rendered yet */
    }
  }

  focus() {
    this.term.focus();
  }

  applySettings() {
    Object.assign(this.term.options, terminalOptions());
    this.layout();
  }

  dispose() {
    sessions.delete(this);
    this.resizeObserver.disconnect();
    if (this.ptyId != null) void invoke("term_kill", { id: this.ptyId }).catch(() => undefined);
    this.ptyId = null;
    this.term.dispose();
    this.el.remove();
  }
}

function process_shell() {
  return settings.get<string>("terminal.shell", "") || "terminal";
}

function terminalOptions() {
  const t = settings.get<Record<string, any>>("terminal", {}) ?? {};
  const pal = currentTheme()?.terminal ?? {};
  // Over a layout background image (herdr's terminal_opacity), the terminal is see-through
  // and the pane's tint shows behind it.
  const seeThrough = state.backdrop || state.layoutBackdrop;
  const fontFamily = withFallback(t.font_family || settings.get<string>("editor.font_family", ""), MONO_FALLBACK);
  const fontSize = t.font_size || settings.get<number>("editor.font_size", 14);
  return {
    fontFamily,
    fontSize,
    lineHeight: t.line_height || 1,
    cursorStyle: (t.cursor_style ?? "block") as "block" | "underline" | "bar",
    cursorBlink: t.cursor_blink ?? true,
    scrollback: t.scrollback ?? 10000,
    macOptionIsMeta: t.mac_option_is_meta ?? true,
    allowTransparency: seeThrough,
    drawBoldTextInBrightColors: false,
    theme: {
      background: seeThrough ? "#00000000" : pal.background,
      foreground: pal.foreground,
      cursor: pal.cursor,
      cursorAccent: pal.background,
      selectionBackground: pal.selection,
      black: pal.black, red: pal.red, green: pal.green, yellow: pal.yellow, blue: pal.blue,
      magenta: pal.magenta, cyan: pal.cyan, white: pal.white,
      brightBlack: pal.bright_black, brightRed: pal.bright_red, brightGreen: pal.bright_green,
      brightYellow: pal.bright_yellow, brightBlue: pal.bright_blue, brightMagenta: pal.bright_magenta,
      brightCyan: pal.bright_cyan, brightWhite: pal.bright_white,
    },
  };
}

/**
 * `path`, `path:line` and `path:line:col` in terminal output become links that open the file
 * in the editor (relative paths resolve against the terminal's folder).
 */
function fileLinkProvider(session: TerminalSession) {
  const re = /(?:^|[\s'"(\[])((?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::(\d+))?/g;
  return {
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      const line = session.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links: ILink[] = [];
      for (const m of line.matchAll(re)) {
        const text = m[0].replace(/^[\s'"(\[]/, "");
        const start = (m.index ?? 0) + m[0].length - text.length;
        const rel = m[1];
        const base = session.cwd ?? state.root ?? "";
        const path = rel.startsWith("/") ? rel : `${base}/${rel.replace(/^\.\//, "")}`;
        if (!state.root || !isInside(state.root, path)) continue; // only files in the open folder
        links.push({
          range: { start: { x: start + 1, y }, end: { x: start + text.length, y } },
          text,
          decorations: { underline: true, pointerCursor: true },
          activate: async () => {
            const { openFile } = await import("./groups");
            const lineNo = m[2] ? Number(m[2]) : 0;
            const col = m[3] ? Number(m[3]) : 1;
            await openFile(path, { selection: lineNo ? new monaco.Range(lineNo, col, lineNo, col) : undefined }).catch(() => undefined);
          },
        });
      }
      callback(links);
    },
  };
}

// Theme, font and [terminal] changes apply to every open terminal.
bus.on("settings", () => {
  const families = settings.get<string>("terminal.font_family", "");
  void ensureFamilies(families).then(() => sessions.forEach((s) => s.applySettings()));
  sessions.forEach((s) => s.applySettings());
});
document.fonts?.addEventListener?.("loadingdone", () => sessions.forEach((s) => s.applySettings()));

/** Kills every shell (window reload / close). */
export function disposeAllTerminals() {
  for (const s of [...sessions]) s.dispose();
}
window.addEventListener("beforeunload", disposeAllTerminals);

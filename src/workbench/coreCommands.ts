// Built-in commands. Ids follow VS Code where an equivalent exists, so keybindings.json
// written for VS Code mostly carries over.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../core/api";
import { allCommands, executeCommand, registerCommand } from "../core/commands";
import { fileIcon } from "../core/icons";
import { keyLabelFor } from "../core/keybindings";
import { monaco } from "../core/monaco";
import { activeThemeName, settings } from "../core/settings";
import { DEFAULT_THEME, themeLabel, themeNames } from "../core/themes";
import { state } from "../core/state";
import { copyText, basename, bus, dirname, fuzzyMatch, isMac, join, relative } from "../core/util";
import { loadedPlugins } from "../plugins/host";
import { confirmDialog, notify } from "../ui/notify";
import { QuickPickItem, showInput, showQuickPick } from "../ui/quickpick";
import { showView, toggleSidebar } from "../ui/sidebar";
import { languageName } from "../ui/statusbar";
import { focusSearch } from "../views/search";
import { focusedExplorerPath } from "../views/explorer";
import { commit, refreshGit, stage } from "../views/scm";
import { Doc, newUntitled, saveDoc } from "./documents";
import {
  activeCodeEditor,
  allGroups,
  dirtyDocs,
  getActiveGroup,
  openFile,
  removeGroup,
  reopenClosed,
  setActiveGroup,
  splitGroup,
  swapDocument,
  newTerminal,
  openTerminal,
  toggleTerminal,
} from "./groups";
import { openFolder, recentFolders } from "./workspace";

// ---- quick open (files, ">" commands, ":" line) ------------------------------------------

const recentFiles = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(`sumi.recentFiles:${state.root}`) ?? "[]");
  } catch {
    return [];
  }
};

bus.on("active-editor", () => {
  const doc = getActiveGroup()?.activeDoc();
  if (!doc || doc.untitled || !state.root) return;
  const list = [doc.path, ...recentFiles().filter((p) => p !== doc.path)].slice(0, 50);
  try {
    localStorage.setItem(`sumi.recentFiles:${state.root}`, JSON.stringify(list));
  } catch {
    /* ignore */
  }
});

const recentCommands: string[] = (() => {
  try {
    return JSON.parse(localStorage.getItem("sumi.recentCommands") ?? "[]");
  } catch {
    return [];
  }
})();

function commandItems(query: string): QuickPickItem[] {
  const seen = new Set<string>();
  const items: (QuickPickItem & { score: number })[] = [];
  const add = (id: string, label: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const m = fuzzyMatch(query.trim(), label);
    if (!m) return;
    const recent = recentCommands.indexOf(id);
    items.push({
      kind: "command",
      id,
      label,
      detail: keyLabelFor(id),
      highlights: m.indices,
      description: recent >= 0 && !query.trim() ? "recently used" : undefined,
      score: m.score + (recent >= 0 ? 100 - recent : 0),
    });
  };
  for (const c of allCommands()) add(c.id, c.title);
  for (const a of activeCodeEditor()?.getSupportedActions() ?? []) if (a.label) add(a.id, a.label);
  return items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/** search.exclude applies to Go to File too, like VS Code. */
const quickOpenExclude = () => settings.get<string[]>("search.exclude", []).join(",");

async function fileItems(query: string): Promise<QuickPickItem[]> {
  if (!state.root) return [{ kind: "none", label: "Open a folder to search files", iconHtml: "" }];
  // "path:line" or "path:line:col" jumps to a location.
  const loc = query.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const q = (loc ? loc[1] : query).trim();
  const line = loc ? Number(loc[2]) : undefined;
  const col = loc?.[3] ? Number(loc[3]) : undefined;
  const toItem = (path: string, description?: string): QuickPickItem => {
    const name = basename(path);
    return {
      kind: "file",
      path,
      line,
      col,
      label: name,
      description: description ?? relative(state.root, dirname(path)).replace(/^\.$/, ""),
      iconHtml: fileIcon(name),
      highlights: fuzzyMatch(q.split(/[\\/]/).pop() ?? "", name)?.indices ?? [],
    };
  };
  if (!q) {
    const recent = recentFiles();
    const rest = (await api.findFiles(state.root, "", 40, quickOpenExclude())).map((r) => join(state.root!, r)).filter((p) => !recent.includes(p));
    return [...recent.map((p) => toItem(p)), ...rest.map((p) => toItem(p))];
  }
  const found = await api.findFiles(state.root, q, 80, quickOpenExclude());
  return found.map((rel) => toItem(join(state.root!, rel)));
}

export async function showQuickOpen(prefix = "") {
  const item = await showQuickPick<QuickPickItem>({
    value: prefix,
    placeholder: "Search files by name (append : to go to line, or start with > for commands)",
    items: async (q) => {
      if (q.startsWith(">")) return commandItems(q.slice(1));
      if (q.startsWith(":")) {
        const ed = activeCodeEditor();
        const n = parseInt(q.slice(1), 10);
        const lines = ed?.getModel()?.getLineCount() ?? 0;
        if (!ed) return [{ kind: "none", label: "Open a text editor first to go to a line." }];
        return [
          n
            ? { kind: "line", line: Math.min(n, lines), label: `Go to line ${Math.min(n, lines)}` }
            : { kind: "none", label: `Current line: ${ed.getPosition()?.lineNumber}. Type a line number between 1 and ${lines} to navigate to.` },
        ];
      }
      return fileItems(q);
    },
  });
  if (!item) return;
  if (item.kind === "command") {
    recentCommands.splice(0, recentCommands.length, item.id, ...recentCommands.filter((c) => c !== item.id).slice(0, 20));
    try {
      localStorage.setItem("sumi.recentCommands", JSON.stringify(recentCommands));
    } catch {
      /* ignore */
    }
    // Let the quick pick close and focus return to the editor before running.
    setTimeout(() => {
      activeCodeEditor()?.focus();
      void executeCommand(item.id);
    }, 0);
  } else if (item.kind === "file") {
    const selection = item.line ? new monaco.Range(item.line, item.col ?? 1, item.line, item.col ?? 1) : undefined;
    await openFile(item.path, { selection });
  } else if (item.kind === "line") {
    const ed = activeCodeEditor();
    if (!ed) return;
    ed.setPosition({ lineNumber: item.line, column: 1 });
    ed.revealLineInCenter(item.line);
    ed.focus();
  }
}

// ---- save --------------------------------------------------------------------------------

async function save(doc: Doc | null, saveAs = false) {
  if (!doc) return;
  if (settings.get("editor.format_on_save") && !saveAs) {
    const ed = activeCodeEditor();
    if (ed?.getModel() === doc.model) await ed.getAction("editor.action.formatDocument")?.run().catch(() => undefined);
  }
  const target = await saveDoc(doc, saveAs);
  if (target && target !== doc.path) await swapDocument(doc, target);
}

// ---- config ------------------------------------------------------------------------------

/** Diagnostics from the last config load (shown by "Config: Check"). */
export const configStatus = { diagnostics: [] as string[], path: "", exists: false, layouts: [] as string[] };

async function openConfigFile() {
  const path = await api.ensureConfigFile();
  await openFile(path);
}

async function showDefaultConfig() {
  const text = await api.defaultConfig();
  getActiveGroup().openDoc(newUntitled(text, "ini"), { focus: true });
}

const THEME_TEMPLATE = (name: string) => `# Sumi theme. Only background, foreground and accent are required; anything left out
# is derived from them. Select it with "Config: Color Theme" or [theme] name = "${name}".
name = "${name}"
appearance = "dark"        # "dark" or "light"
glow = false               # glowing accent text

[colors]
background = "#1e1e1e"
foreground = "#cccccc"
accent = "#0078d4"
# panel = "#181818"              # sidebar, tab bar, status bar
# dim = "#8b8b8b"                # secondary text
# border = "#2b2b2b"
# accent_foreground = "#ffffff"  # text on accent (buttons)
# selection = "#264f78"
# hover = "#2a2d2e"
# selected = "#37373d"
# red = "#f14c4c"
# green = "#73c991"
# yellow = "#e2c08d"
# blue = "#3794ff"
# magenta = "#c586c0"
# cyan = "#4ec9b0"
# orange = "#ce9178"
# sidebar_background = "#181818"
# statusbar_background = "#181818"
# widget_background = "#252526"  # quick pick, menus, editor widgets
# input_background = "#313131"
# tab_active_foreground = "#ffffff"
# cursor = "#0078d4"

[syntax]
# keyword = "#c586c0"
# string = "#ce9178"
# number = "#b5cea8"
# type = "#4ec9b0"
# function = "#dcdcaa"
# comment = "#6a9955"
# variable = "#9cdcfe"
# operator = "#d4d4d4"
# tag = "#569cd6"
# attribute = "#9cdcfe"
# constant = "#4fc1ff"
# regexp = "#d16969"
# delimiter = "#808080"
# heading = "#569cd6"

[editor]
# Any Monaco color id, e.g.
# "editor.lineHighlightBackground" = "#2a2d2e"

[ui]
# Any Sumi CSS variable, e.g.
# "--tab-border-top" = "#0078d4"
`;

// ---- registration ------------------------------------------------------------------------

export function registerCoreCommands() {
  const r = registerCommand;
  const group = () => getActiveGroup();
  const doc = () => group()?.activeDoc() ?? null;

  r("workbench.action.quickOpen", "Go to File...", () => showQuickOpen(""));
  r("workbench.action.showCommands", "Show All Commands", () => showQuickOpen(">"));
  r("workbench.action.gotoLine", "Go to Line/Column...", () => showQuickOpen(":"));
  r("workbench.action.gotoSymbol", "Go to Symbol in Editor...", () => activeCodeEditor()?.getAction("editor.action.quickOutline")?.run());

  r("workbench.action.files.openFolder", "File: Open Folder...", async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Open Folder" });
    if (typeof dir === "string") await openFolder(dir);
  });
  r("workbench.action.openRecent", "File: Open Recent...", async () => {
    const item = await showQuickPick({
      placeholder: "Select a folder to open",
      items: recentFolders().map((p) => ({ label: basename(p), description: p, path: p })),
      matchOnDescription: true,
    });
    if (item) await openFolder(item.path);
  });
  r("workbench.action.files.newUntitledFile", "File: New Untitled Text File", () => group().openDoc(newUntitled(), { focus: true }));
  r("workbench.action.files.save", "File: Save", () => save(doc()));
  r("workbench.action.files.saveAs", "File: Save As...", () => save(doc(), true));
  r("workbench.action.files.saveAll", "File: Save All", async () => {
    for (const d of dirtyDocs()) if (!d.untitled) await save(d);
  });
  r("workbench.action.files.revert", "File: Revert File", async () => {
    const d = doc();
    if (!d || d.untitled) return;
    const content = (await api.readFile(d.path)).content;
    d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: content }], () => null);
    d.savedVersion = d.model.getAlternativeVersionId();
    bus.emit("doc-dirty", d);
  });

  r("workbench.action.closeActiveEditor", "View: Close Editor", () => {
    const g = group();
    if (g.active) return g.closeTab(g.active);
    if (allGroups().length > 1) removeGroup(g);
  });
  r("workbench.action.closeAllEditors", "View: Close All Editors", async () => {
    for (const g of allGroups()) if (!(await g.closeAll())) return;
  });
  r("workbench.action.closeOtherEditors", "View: Close Other Editors in Group", () => group().closeAll(group().active ?? undefined));
  r("workbench.action.closeEditorsInGroup", "View: Close All Editors in Group", () => group().closeAll());
  r("workbench.action.reopenClosedEditor", "View: Reopen Closed Editor", reopenClosed);
  r("workbench.action.keepEditor", "View: Keep Editor", () => {
    const t = group().active;
    if (t) {
      t.preview = false;
      group().renderTabs();
    }
  });

  r("workbench.action.splitEditor", "View: Split Editor Right", () => splitGroup(group(), "row"));
  r("workbench.action.splitEditorDown", "View: Split Editor Down", () => splitGroup(group(), "col"));
  r("workbench.action.openToSide", "Open to the Side", async (path?: string) => {
    if (typeof path !== "string") return;
    const groups = allGroups();
    const i = groups.indexOf(group());
    const target = groups[i + 1] ?? splitGroup(group(), "row", null);
    await openFile(path, { group: target });
  }, true);
  ["First", "Second", "Third", "Fourth"].forEach((n, i) =>
    r(`workbench.action.focus${n}EditorGroup`, `View: Focus ${n} Editor Group`, () => {
      const g = allGroups()[i];
      if (g) setActiveGroup(g);
      else if (i === allGroups().length) splitGroup(allGroups()[i - 1], "row");
    }),
  );
  const cycle = (d: number) => {
    const g = group();
    if (!g.tabs.length) return;
    const i = g.active ? g.tabs.indexOf(g.active) : 0;
    g.activate(g.tabs[(i + d + g.tabs.length) % g.tabs.length]);
    g.focus();
  };
  r("workbench.action.nextEditor", "View: Open Next Editor", () => cycle(1));
  r("workbench.action.previousEditor", "View: Open Previous Editor", () => cycle(-1));

  r("workbench.action.toggleSidebarVisibility", "View: Toggle Primary Side Bar Visibility", () => toggleSidebar());
  r("workbench.view.explorer", "View: Show Explorer", () => showView("explorer"));
  r("workbench.view.search", "View: Show Search", () => showView("search"));
  r("workbench.view.scm", "View: Show Source Control", () => showView("scm"));
  const selectionText = () => {
    const ed = activeCodeEditor();
    const sel = ed?.getSelection();
    const text = sel && !sel.isEmpty() ? ed!.getModel()!.getValueInRange(sel) : "";
    return text.includes("\n") ? "" : text;
  };
  r("workbench.action.findInFiles", "Search: Find in Files", () => {
    showView("search");
    focusSearch({ query: selectionText() });
  });
  r("workbench.action.replaceInFiles", "Search: Replace in Files", () => {
    showView("search");
    focusSearch({ query: selectionText(), replace: true });
  });
  r("workbench.action.findInFolder", "Search: Find in Folder", (folder?: string) => {
    showView("search");
    focusSearch({ folder });
  }, true);
  r("workbench.files.action.revealActiveFileInExplorer", "File: Reveal Active File in Explorer View", () => {
    const d = doc();
    if (d && !d.untitled) {
      showView("explorer", false);
      bus.emit("reveal", d.path);
    }
  });
  // Copy path commands, like VS Code: they act on the explorer selection when the explorer
  // has focus, otherwise on the active editor's file.
  const targetPath = () => {
    const fromTree = focusedExplorerPath();
    if (fromTree) return fromTree;
    const d = doc();
    return d && !d.untitled ? d.path : null;
  };
  const copy = async (text: string) => {
    await copyText(text);
    notify(`Copied ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`, "info", 1800);
  };
  r("copyFilePath", "File: Copy Path", () => {
    const p = targetPath();
    if (p) return copy(p);
  });
  r("copyRelativeFilePath", "File: Copy Relative Path", () => {
    const p = targetPath();
    if (p) return copy(relative(state.root, p));
  });
  // path:line (or path:start-end for a multi-line selection): the format compilers, grep and
  // test runners print, clickable in terminals and understood by coding agents.
  r("copyFileReference", "File: Copy Reference (relative path:line)", () => {
    const fromTree = focusedExplorerPath();
    if (fromTree) return copy(relative(state.root, fromTree));
    const d = doc();
    const sel = activeCodeEditor()?.getSelection();
    if (!d || d.untitled || !sel) return;
    let end = sel.endLineNumber;
    if (end > sel.startLineNumber && sel.endColumn === 1) end--; // whole-line selections end at col 1 of the next line
    const lines = end > sel.startLineNumber ? `${sel.startLineNumber}-${end}` : `${sel.startLineNumber}`;
    return copy(`${relative(state.root, d.path)}:${lines}`);
  });

  // Terminals (tabs in editor groups; src/workbench/terminal.ts).
  r("terminal.toggle", "Terminal: Toggle Terminal", () => toggleTerminal());
  r("terminal.new", "Terminal: Create New Terminal", () => newTerminal());
  r("terminal.newHere", "Terminal: New Terminal in Active Editor Group", () => openTerminal(group()));
  r("terminal.openInFolder", "Terminal: Open in Folder of Active File", () => {
    const d = doc();
    return openTerminal(group(), d && !d.untitled ? dirname(d.path) : state.root);
  });
  r("terminal.clear", "Terminal: Clear", () => {
    const t = group().active;
    if (t?.kind === "terminal") t.session.term.clear();
  });
  r("terminal.kill", "Terminal: Kill the Active Terminal", () => {
    const t = group().active;
    if (t?.kind === "terminal") return group().closeTab(t, true);
  });

  // Configuration (config.toml), modeled on herdr.
  r("workbench.action.openConfig", "Config: Open config.toml", openConfigFile);
  r("workbench.action.reloadConfig", "Config: Reload", () => executeCommand("sumi.reloadConfig"));
  r("workbench.action.checkConfig", "Config: Check (show problems)", async () => {
    const items = configStatus.diagnostics.length
      ? configStatus.diagnostics.map((d) => ({ label: d }))
      : [{ label: configStatus.exists ? `config ok: ${configStatus.path}` : `no config file; using defaults (${configStatus.path})` }];
    const pick = await showQuickPick({ placeholder: "config.toml diagnostics (Enter opens the file)", items });
    if (pick) await openConfigFile();
  });
  r("workbench.action.showDefaultConfig", "Config: Show Default Config", showDefaultConfig);
  r("workbench.action.openUserStyle", "Config: Open style.css (custom CSS)", () => openFile(join(state.configDir, "style.css")));
  r("workbench.action.openPluginsFolder", "Plugins: Open Plugins Folder", () => {
    const dir = join(state.configDir, "plugins");
    void api.exec(isMac ? ["open", dir] : navigator.userAgent.includes("Windows") ? ["explorer", dir] : ["xdg-open", dir]);
  });
  r("workbench.action.newPlugin", "Plugins: Create New Plugin...", async () => {
    const name = await showInput({ prompt: "Plugin file name (e.g. my-plugin)", validate: (v) => (/^[\w.-]+$/.test(v) ? null : "Use letters, digits, dot, dash or underscore.") });
    if (!name) return;
    const id = name.replace(/\.js$/, "");
    const dir = join(join(state.configDir, "plugins"), id);
    await api.writeFile(join(dir, "sumi-plugin.toml"), `id = "${id}"\nname = "${id}"\nversion = "0.1.0"\nmin_sumi_version = "0.1.0"\nmain = "index.js"\ndescription = ""\n`);
    const main = join(dir, "index.js");
    await api.writeFile(
      main,
      `// Reload the window (F5) after editing. Settings for this plugin go in [plugins.${id}] in config.toml.\nexport function activate(sumi) {\n  sumi.commands.register("${id}.hello", "${id}: Say Hello", () => {\n    sumi.ui.notify(\`Hello from ${id}! config: \${JSON.stringify(sumi.plugin.config())}\`);\n  });\n}\n`,
    );
    await openFile(main);
  });
  r("workbench.action.showPlugins", "Plugins: Show Loaded Plugins", async () => {
    await showQuickPick({
      placeholder: loadedPlugins.length ? "Loaded plugins" : "No plugins loaded",
      items: loadedPlugins.map((p) => ({ label: `${p.name} ${p.version}`, description: p.error ? `failed: ${p.error}` : "active" })),
    });
  });
  // Scrolls the active editor for 2 seconds and reports how often the window updates
  // (requestAnimationFrame cadence): ~60 on a capped WebKit, ~120 on a ProMotion screen when
  // uncapped. Moves by elapsed time (same speed at any refresh rate) and turns around at the
  // end of the file so every frame really moves the view.
  r("developer.measureScrollFps", "Developer: Measure Scroll FPS", async () => {
    const ed = activeCodeEditor();
    if (!ed) return notify("Open a file first, then run this.", "warning");
    const start = ed.getScrollTop();
    const maxTop = Math.max(0, ed.getScrollHeight() - ed.getLayoutInfo().height);
    if (maxTop < 200) return notify("Open a longer file (a few hundred lines) for a useful measurement.", "warning");
    const speed = 1800; // px per second
    const gaps: number[] = [];
    let last = performance.now();
    const t0 = last;
    let top = Math.min(start, maxTop);
    let dir = 1;
    await new Promise<void>((done) => {
      setTimeout(done, 4000); // safety: frames stop arriving if the window is in the background
      const step = (t: number) => {
        const dt = t - last;
        gaps.push(dt);
        last = t;
        top += dir * speed * (dt / 1000);
        if (top >= maxTop) { top = maxTop; dir = -1; }
        if (top <= 0) { top = 0; dir = 1; }
        ed.setScrollTop(top);
        if (t - t0 < 2000) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    ed.setScrollTop(start);
    const sorted = gaps.slice(2).sort((a, b) => a - b);
    if (sorted.length < 10) return notify("The window got almost no frames (is it in the background?). Click into Sumi and run it again.", "warning");
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const slow = sorted.filter((g) => g > 1.5 * median).length;
    const focused = document.hasFocus() ? "" : " (window wasn't focused, so this may be throttled)";
    notify(`Window updates at ≈ ${Math.round(1000 / median)} fps (median frame ${median.toFixed(1)} ms, ${slow} late frames of ${sorted.length})${focused}.`, "info", 12000);
  });

  // Records 10 seconds of REAL wheel events on the active editor (synthetic events take a
  // different path in WebKit), then opens a report: event values, distance per event, event
  // rhythm, frame cadence meanwhile, and how Monaco is likely classifying the input.
  r("developer.recordMouseWheel", "Developer: Record Mouse Wheel (10 s)", async () => {
    const ed = activeCodeEditor();
    if (!ed) return notify("Open a long file first, then run this.", "warning");
    const node = ed.getDomNode()!;
    type Rec = { t: number; deltaY: number; deltaMode: number; wheelDeltaY: number | null; moved: number; trusted: boolean };
    const recs: Rec[] = [];
    const frames: number[] = [];
    let current: Rec | null = null;
    // Each scroll change is credited to the wheel event that caused it (Monaco handles the
    // event after this listener, so the position can't be read inside it).
    let lastTop = ed.getScrollTop();
    const scrollSub = ed.onDidScrollChange((e) => {
      if (!e.scrollTopChanged) return;
      if (current) current.moved += Math.round(e.scrollTop - lastTop);
      lastTop = e.scrollTop;
    });
    const onWheel = (e: WheelEvent) => {
      const legacy = (e as unknown as { wheelDeltaY?: number }).wheelDeltaY;
      lastTop = ed.getScrollTop();
      current = { t: performance.now(), deltaY: e.deltaY, deltaMode: e.deltaMode, wheelDeltaY: legacy ?? null, moved: 0, trusted: e.isTrusted };
      recs.push(current);
    };
    node.addEventListener("wheel", onWheel, { capture: true, passive: true });
    notify("Recording for 10 seconds: scroll this file with your MOUSE WHEEL now (single clicks, then fast spins).", "info", 10000);
    // A timer ends the recording (animation frames stop when the window is in the background);
    // frames are only sampled to report the update rate.
    let last = performance.now();
    let recording = true;
    const step = (t: number) => {
      frames.push(t - last);
      last = t;
      if (recording) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    await new Promise((r) => setTimeout(r, 10000));
    recording = false;
    node.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
    scrollSub.dispose();
    if (!recs.length) return notify("No wheel events were recorded. Run it again and scroll over the editor.", "warning");

    const med = (xs: number[]) => { const s2 = [...xs].sort((a, b) => a - b); return s2[Math.floor(s2.length / 2)] ?? 0; };
    const pct = (xs: number[], p: number) => { const s2 = [...xs].sort((a, b) => a - b); return s2[Math.min(s2.length - 1, Math.floor(s2.length * p))] ?? 0; };
    const legacy = recs.map((r) => r.wheelDeltaY).filter((v): v is number => v != null);
    const normalized = legacy.map((v) => v / 120); // what Monaco uses per event
    const fractional = normalized.filter((v) => Math.abs(v - Math.round(v)) > 1e-6).length;
    const gaps = recs.slice(1).map((r, i) => r.t - recs[i].t);
    const isolatedGaps = gaps.filter((g) => g > 120).length;
    const movedAbs = recs.map((r) => Math.abs(r.moved));
    const frameMed = med(frames.slice(2)) || 1000;
    const values = [...new Set(legacy.map((v) => Math.abs(v)))].sort((a, b) => a - b);
    const lines = [
      `# Sumi mouse-wheel recording (${new Date().toLocaleString()})`,
      ``,
      `Events: ${recs.length} (${recs.filter((r) => r.trusted).length} real)  |  deltaMode: ${[...new Set(recs.map((r) => r.deltaMode))].join(", ")} (0 = pixels, 1 = lines)`,
      `Window update rate while recording: ≈ ${Math.round(1000 / frameMed)} fps (median frame ${frameMed.toFixed(1)} ms)  |  focused: ${document.hasFocus()}`,
      ``,
      `## What each event says`,
      `wheelDeltaY (Monaco divides by 120): median ${med(legacy.map(Math.abs))}, distinct values: ${values.slice(0, 20).join(", ")}${values.length > 20 ? " …" : ""}`,
      `deltaY: median ${med(recs.map((r) => Math.abs(r.deltaY))).toFixed(2)}, max ${pct(recs.map((r) => Math.abs(r.deltaY)), 1).toFixed(2)}`,
      `Fractional normalized values: ${fractional} of ${normalized.length} (many fractions push Monaco to classify input as a TRACKPAD; whole numbers as a MOUSE WHEEL)`,
      ``,
      `## What the editor did`,
      `Pixels moved per event: median ${med(movedAbs)}, p90 ${pct(movedAbs, 0.9)}, max ${pct(movedAbs, 1)}  (current mouse_wheel_scroll_sensitivity: ${ed.getOption(monaco.editor.EditorOption.mouseWheelScrollSensitivity)})`,
      `Smooth scrolling: ${ed.getOption(monaco.editor.EditorOption.smoothScrolling)}`,
      ``,
      `## Event rhythm`,
      `Time between events: median ${med(gaps).toFixed(1)} ms, p90 ${pct(gaps, 0.9).toFixed(1)} ms  |  separate clicks (gap > 120 ms): ${isolatedGaps}`,
      ``,
      `## Raw events (time ms, deltaY, wheelDeltaY, px moved)`,
      ...recs.slice(0, 200).map((r) => `${(r.t - recs[0].t).toFixed(1)}\t${r.deltaY.toFixed(2)}\t${r.wheelDeltaY ?? "-"}\t${r.moved}`),
    ];
    group().openDoc(newUntitled(lines.join("\n"), "markdown"), { focus: true });
  });
  r("workbench.action.reloadWindow", "Developer: Reload Window", async () => {
    const dirty = dirtyDocs().length;
    if (dirty && !(await confirmDialog(`You have ${dirty} unsaved file${dirty === 1 ? "" : "s"}. Reload and lose those changes?`))) return;
    location.reload();
  });

  const fontSize = () => settings.get<number>("editor.font_size", 13);
  r("workbench.action.zoomIn", "View: Zoom In", () => settings.setSession("editor.font_size", fontSize() + 1));
  r("workbench.action.zoomOut", "View: Zoom Out", () => settings.setSession("editor.font_size", Math.max(6, fontSize() - 1)));
  r("workbench.action.zoomReset", "View: Reset Zoom", () => settings.setSession("editor.font_size", undefined));
  r("editor.action.toggleWordWrap", "View: Toggle Word Wrap", () =>
    settings.setSession("editor.word_wrap", settings.get("editor.word_wrap") === "off" ? "on" : "off"),
  );
  r("editor.action.toggleMinimap", "View: Toggle Minimap", () =>
    settings.setSession("editor.minimap.enabled", !settings.get("editor.minimap.enabled", true)),
  );
  r("editor.action.toggleRenderWhitespace", "View: Toggle Render Whitespace", () =>
    settings.setSession("editor.render_whitespace", settings.get("editor.render_whitespace") === "all" ? "selection" : "all"),
  );

  r("workbench.action.selectTheme", "Config: Color Theme", async () => {
    const before = activeThemeName();
    const items = themeNames().map((id) => ({
      label: themeLabel(id),
      description: [id !== themeLabel(id) ? id : "", id === before ? "current" : "", id === DEFAULT_THEME ? "built-in" : ""].filter(Boolean).join(" · "),
      id,
    }));
    const pick = await showQuickPick({
      placeholder: "Select Color Theme (Up/Down to preview). Theme files live in ~/.config/sumi/themes",
      items,
      onActive: (item) => item && settings.setSession("theme.name", item.id),
    });
    if (pick) {
      // With a layout active, the choice belongs to that layout ([layouts.<name>] in config.toml),
      // since the layout's own theme would otherwise win over a shared [theme].
      const layout = settings.get<string>("layout", "");
      const base = layout ? ["layouts", layout, "theme"] : ["theme"];
      await api.configSet([...base, "name"], pick.id);
      if (settings.get("theme.auto_switch")) await api.configSet([...base, "auto_switch"], false);
    }
    settings.setSession("theme.name", undefined);
  });
  r("workbench.action.selectLayout", "Config: Layout", async () => {
    const current = settings.get<string>("layout", "");
    const items = [{ label: "(none)", description: "Sumi defaults", id: "" }, ...configStatus.layouts.map((id) => ({ label: id, description: id === current ? "current" : "", id }))];
    const pick = await showQuickPick({ placeholder: "Select a layout (a named config) from ~/.config/sumi/layouts", items });
    if (pick) await api.configSet(["layout"], pick.id);
  });
  r("workbench.action.createTheme", "Config: Create Theme...", async () => {
    const name = await showInput({ prompt: "Theme name (file name in ~/.config/sumi/themes)", validate: (v) => (/^[\w.-]+$/.test(v) ? null : "Use letters, digits, dot, dash or underscore.") });
    if (!name) return;
    const path = join(join(state.configDir, "themes"), `${name}.toml`);
    await api.writeFile(path, THEME_TEMPLATE(name));
    await openFile(path);
  });
  r("workbench.action.openLayout", "Config: Open Current Layout File", async () => {
    const current = settings.get<string>("layout", "");
    if (!current) return notify('No layout selected. Set layout = "<name>" in config.toml or run "Config: Layout".', "warning");
    const dir = join(state.configDir, "layouts");
    const names = new Set((await api.readDir(dir).catch(() => [])).map((e) => e.name));
    return openFile(join(dir, names.has(`${current}.json`) ? `${current}.json` : `${current}.toml`));
  });

  // [[keys.command]] type = "shell": run detached from the folder root with context env vars.
  r("sumi.runShellCommand", "Run Shell Command", async (command?: string) => {
    if (typeof command !== "string") return;
    const ed = activeCodeEditor();
    const pos = ed?.getPosition();
    const sel = ed?.getSelection();
    const d = doc();
    const env: Record<string, string> = {
      SUMI_ROOT: state.root ?? "",
      SUMI_FILE: d && !d.untitled ? d.path : "",
      SUMI_LINE: String(pos?.lineNumber ?? ""),
      SUMI_COLUMN: String(pos?.column ?? ""),
      SUMI_SELECTION: sel && !sel.isEmpty() ? ed!.getModel()!.getValueInRange(sel) : "",
    };
    const shell = navigator.userAgent.includes("Windows") ? ["cmd.exe", "/d", "/c", command] : ["/bin/sh", "-c", command];
    const r2 = await api.exec(shell, state.root ?? undefined, env);
    if (r2.code !== 0) notify(`${command}\nexited ${r2.code}: ${(r2.stderr || r2.stdout).trim().slice(0, 400)}`, "error");
  }, true);

  r("editor.action.changeLanguageMode", "Change Language Mode", async () => {
    const model = activeCodeEditor()?.getModel();
    if (!model) return;
    const pick = await showQuickPick({
      placeholder: "Select Language Mode",
      items: monaco.languages.getLanguages().map((l) => ({ label: languageName(l.id), description: `(${l.id})`, id: l.id })),
    });
    if (pick) {
      monaco.editor.setModelLanguage(model, pick.id);
      bus.emit("language-changed");
    }
  });
  r("editor.action.changeIndentation", "Change Indentation", async () => {
    const ed = activeCodeEditor();
    const model = ed?.getModel();
    if (!ed || !model) return;
    const items = [
      ...[2, 4, 8].map((n) => ({ label: `Indent Using Spaces: ${n}`, insertSpaces: true, size: n })),
      ...[2, 4, 8].map((n) => ({ label: `Indent Using Tabs: ${n}`, insertSpaces: false, size: n })),
      { label: "Detect Indentation from Content", action: "editor.action.detectIndentation" },
      { label: "Convert Indentation to Spaces", action: "editor.action.indentationToSpaces" },
      { label: "Convert Indentation to Tabs", action: "editor.action.indentationToTabs" },
    ];
    const pick = await showQuickPick<QuickPickItem>({ placeholder: "Select Action", items });
    if (!pick) return;
    if (pick.action) await ed.getAction(pick.action)?.run();
    else model.updateOptions({ insertSpaces: pick.insertSpaces, tabSize: pick.size, indentSize: pick.size });
    bus.emit("settings");
  }, true);
  r("editor.action.changeEOL", "Change End of Line Sequence", async () => {
    const model = activeCodeEditor()?.getModel();
    if (!model) return;
    const pick = await showQuickPick({ placeholder: "Select End of Line Sequence", items: [{ label: "LF", eol: 0 }, { label: "CRLF", eol: 1 }] });
    if (pick) {
      model.pushEOL(pick.eol);
      bus.emit("cursor");
    }
  });

  r("git.refresh", "Git: Refresh", () => refreshGit());
  r("git.commit", "Git: Commit", () => {
    showView("scm");
    return commit();
  });
  r("git.stageAll", "Git: Stage All Changes", () => stage(state.git?.files.filter((f) => !f.staged).map((f) => f.path) ?? []));
  r("git.stage", "Git: Stage Changes of Active File", () => {
    const d = doc();
    if (d && !d.untitled) return stage([d.path]);
  });
  r("git.openChange", "Git: Open Changes", () => {
    const d = doc();
    if (!d || d.untitled) return;
    const staged = !state.git?.files.some((f) => f.path === d.path && !f.staged);
    return group().openDiff(d.path, staged);
  });
  r("git.openFile", "Git: Open File", () => {
    const t = group().active;
    if (t?.kind === "diff") return openFile(t.path);
  });

}

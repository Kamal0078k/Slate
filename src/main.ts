import "./core/migrate"; // first: carries saved state over from the former name (Slate)
import "./styles.css";
import { loadFonts } from "./core/fonts";
import { installEditorWheel } from "./workbench/wheel";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./core/api";
import { registerCommand, setCommandFallback } from "./core/commands";
import { installKeybindings, setConfigKeybindings } from "./core/keybindings";
import { applySettings, loadSettings, settings } from "./core/settings";
import { state } from "./core/state";
import { bus, debounce } from "./core/util";
import { loadPlugins } from "./plugins/host";
import { confirmDialog, notify } from "./ui/notify";
import { clearImageCache, initSidebar, registerView, setLayout } from "./ui/sidebar";
import { reloadWidgets } from "./ui/widgets";
import { initStatusBar } from "./ui/statusbar";
import { initBackdrop } from "./ui/backdrop";
import { explorerView } from "./views/explorer";
import { scmView, refreshGit } from "./views/scm";
import { searchView } from "./views/search";
import { configStatus, registerCoreCommands } from "./workbench/coreCommands";
import { Doc, isDirty, saveDoc } from "./workbench/documents";
import { activeCodeEditor, allGroups, dirtyDocs, initLayout } from "./workbench/groups";
import { onFsChanged, openFolder, recentFolders, updateTitle } from "./workbench/workspace";

let lastSummary = "";

/** Loads config.toml (merged over defaults) and style.css; plugins only on the first load.
 *  Like herdr, problems never block startup: they show as one compact warning. */
async function reloadConfig(first = false) {
  const loaded = await api.loadConfig(first);
  state.configDir = loaded.dir;
  Object.assign(configStatus, { diagnostics: loaded.diagnostics, path: loaded.path, exists: loaded.exists });
  try {
    setLayout(loaded.tree, (loaded.config.layout as string) ?? "");
  } finally {
    // Theme, fonts and settings apply even if rendering the layout failed.
    loadSettings(loaded.config, loaded.style, loaded.themes);
  }
  if (!first) void reloadWidgets();
  configStatus.layouts = loaded.layouts;
  setConfigKeybindings(loaded.config.keys ?? {});
  for (const g of allGroups()) g.refreshWatermark();
  if (first) await loadPlugins(loaded.plugins);
  // Theme names can come from plugins, so check after they load.
  if (settings.themeWarning) configStatus.diagnostics.push(settings.themeWarning);
  const d = configStatus.diagnostics;
  const summary = !d.length
    ? ""
    : d.length === 1
      ? `config.toml: ${d[0]}`
      : d.every((x) => x.startsWith("unknown config key"))
        ? "config.toml has unknown keys; run \"Config: Check\""
        : `config.toml has ${d.length} problems; run "Config: Check"`;
  if (summary && summary !== lastSummary) notify(summary, "warning", 8000);
  lastSummary = summary;
}

// Monaco cancels its own pending WebKit clipboard writes on every keypress; those
// cancellations surface as unhandled "Canceled" rejections. They are expected, so drop them.
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason instanceof Error && e.reason.name === "Canceled") e.preventDefault();
});

if (import.meta.env.DEV) {
  const send = (level: string, args: unknown[]) =>
    void invoke("frontend_log", {
      level,
      message: args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    }).catch(() => undefined);
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      send(level, args);
    };
  }
  window.addEventListener("error", (e) => send("uncaught", [e.error ?? e.message]));
  // Test hook for dev self-tests only.
  void import("./workbench/groups").then((g) => ((window as any).__sumiDebug = { groups: g }));
  window.addEventListener("unhandledrejection", (e) => !e.defaultPrevented && send("unhandled-rejection", [e.reason]));
}

async function boot() {
  void loadFonts();
  initLayout();
  registerView(explorerView);
  registerView(searchView);
  registerView(scmView);
  registerCoreCommands();
  initStatusBar();
  installKeybindings();
  installEditorWheel();

  // Unknown command ids fall through to Monaco actions, so keybindings.json can bind
  // things like "editor.action.copyLinesDownAction" exactly as in VS Code.
  setCommandFallback((id, args) => {
    const ed = activeCodeEditor();
    if (!ed) return false;
    const action = ed.getAction(id);
    if (action) void action.run(args);
    else ed.trigger("keyboard", id, args);
    return true;
  });

  try {
    await reloadConfig(true);
  } catch (e) {
    notify(`Could not load config: ${e}`, "error");
  }
  const winInfo = await invoke<{ titlebarHidden: boolean }>("window_info").catch(() => ({ titlebarHidden: false }));
  document.documentElement.classList.toggle("titlebar-hidden", winInfo.titlebarHidden);
  // An image behind the editor (layout node background) switches the editor to see-through.
  // Listen before the first layout render: that render is what reports it.
  bus.on("layout-backdrop", () => applySettings());
  initSidebar();
  initBackdrop();
  applySettings(); // in case the first render's report came before the theme existed

  // Live reload: config.toml / style.css changes (from Sumi or any other editor) apply at
  // once; plugin changes need a window reload, like herdr's startup-only settings.
  registerCommand("sumi.reloadConfig", "Reload Config", async () => {
    await reloadConfig();
    notify(configStatus.diagnostics.length ? "Config reloaded with problems." : "Config reloaded.");
  }, true);
  const onConfigChanged = debounce(() => void reloadConfig(), 150);
  await listen<string[] | null>("config-changed", (e) => {
    // A replaced background image keeps its path, so drop the decoded copies.
    if (e.payload?.some((p) => /[\\/]backgrounds[\\/]/.test(p))) clearImageCache();
    onConfigChanged();
  });
  await api.watchConfig().catch((e) => console.warn("config watching unavailable", e));

  // Auto save.
  const timers = new Map<Doc, number>();
  bus.on("doc-dirty", (doc: Doc) => {
    if (settings.get("files.auto_save") !== "after_delay" || doc.untitled || !isDirty(doc)) return;
    clearTimeout(timers.get(doc));
    timers.set(doc, window.setTimeout(() => isDirty(doc) && void saveDoc(doc), settings.get<number>("files.auto_save_delay", 1000)));
  });

  await listen<string[]>("fs-changed", (e) => onFsChanged(e.payload));
  const refreshOnFocus = debounce(() => state.root && void refreshGit(), 300);
  window.addEventListener("focus", refreshOnFocus);

  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    const dirty = dirtyDocs();
    if (!dirty.length) return;
    const ok = await confirmDialog(`You have ${dirty.length} unsaved file${dirty.length === 1 ? "" : "s"}. Quit without saving?`);
    if (!ok) event.preventDefault();
  });

  const initial = (await api.initialFolder()) ?? recentFolders()[0];
  if (initial) {
    try {
      await openFolder(initial);
    } catch {
      /* folder moved or deleted */
    }
  }
  updateTitle();
  document.body.classList.add("ready");
  if (import.meta.env.DEV) {
    console.log(
      `ready: root=${state.root} git=${state.git ? `${state.git.branch}/${state.git.files.length} changes` : "none"} ` +
        `groups=${allGroups().length} explorerRows=${document.querySelectorAll(".tree .row").length} ` +
        `activity=${document.querySelectorAll(".activity").length} plugins=${(window as any).sumiPlugins?.map((p: any) => p.name + (p.error ? "!" : "")).join(",")}`,
    );
    if (await invoke<boolean>("dev_selftest")) await (await import("./selftest")).runSelfTest();
  }
}

boot().catch((e) => {
  console.error(e);
  notify(`Startup failed: ${e}`, "error", 0);
});

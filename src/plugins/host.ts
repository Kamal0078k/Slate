// Plugin host. Each plugin is an ES module in ~/.config/sumi/plugins that exports
// `activate(sumi)` (and optionally `deactivate()`). The `sumi` object below is the whole
// plugin API. Plugins run in the window with full access, so only install code you trust.
import { api, PluginInfo } from "../core/api";
import { allCommands, executeCommand, registerCommand } from "../core/commands";
import { addPluginKeybinding, Keybinding } from "../core/keybindings";
import { monaco } from "../core/monaco";
import { settings } from "../core/settings";
import { registerPluginTheme } from "../core/themes";
import { state } from "../core/state";
import { bus, Disposable } from "../core/util";
import { getDoc } from "../workbench/documents";
import { activeCodeEditor, allGroups, getActiveGroup, openFile } from "../workbench/groups";
import { notify } from "../ui/notify";
import { QuickPickItem, showInput, showQuickPick } from "../ui/quickpick";
import { registerView, showView, View } from "../ui/sidebar";
import { registerWidget } from "../ui/widgets";
import { createStatusBarItem, StatusBarItemOptions } from "../ui/statusbar";

export const SUMI_VERSION = "0.1.0";

export function createSumiApi(info: PluginInfo, subscriptions: Disposable[]) {
  const pluginName = info.id;
  const track = <T extends Disposable>(d: T) => (subscriptions.push(d), d);
  const on = (event: string) => (cb: (...a: any[]) => void) => track(bus.on(event, cb));

  return {
    version: SUMI_VERSION,
    /** This plugin: id, folder, a private data folder, and its [plugins.<id>] config table. */
    plugin: {
      id: info.id,
      name: info.name,
      version: info.version,
      dir: info.dir,
      dataDir: info.dataDir,
      config: () => (settings.get<Record<string, unknown>>(`plugins.${info.id}`, {}) ?? {}),
    },
    /** The Monaco namespace: languages, themes, completion providers, decorations... */
    monaco,
    commands: {
      register: (id: string, title: string, run: (...a: any[]) => unknown) => track(registerCommand(id, title, run)),
      execute: (id: string, ...args: unknown[]) => executeCommand(id, ...args),
      list: () => allCommands().map((c) => ({ id: c.id, title: c.title })),
    },
    keybindings: {
      add: (b: Keybinding) => track(addPluginKeybinding(b)),
    },
    workspace: {
      root: () => state.root,
      git: () => state.git,
      openFile: (path: string, opts?: { line?: number; column?: number; preview?: boolean }) =>
        openFile(path, {
          preview: opts?.preview,
          selection: opts?.line ? new monaco.Range(opts.line, opts.column ?? 1, opts.line, opts.column ?? 1) : undefined,
        }),
      readFile: async (path: string) => getDoc(path)?.model.getValue() ?? (await api.readFile(path)).content,
      writeFile: (path: string, content: string) => api.writeFile(path, content),
      readDir: (path: string) => api.readDir(path),
      findFiles: (query: string, limit = 50) => (state.root ? api.findFiles(state.root, query, limit) : Promise.resolve([])),
      onDidChangeFiles: on("fs-changed"),
      onDidOpenFolder: on("workspace"),
    },
    editor: {
      /** The focused Monaco code editor (full Monaco API). */
      active: () => activeCodeEditor(),
      activePath: () => getActiveGroup()?.activeDoc()?.path ?? null,
      all: () => allGroups().map((g) => g.editor),
      onDidChangeActive: on("active-editor"),
      onDidChangeCursor: on("cursor"),
      onDidSave: on("doc-saved"),
      onDidOpen: (cb: (path: string) => void) => track(bus.on("doc-opened", (d: { path: string }) => cb(d.path))),
    },
    ui: {
      statusBarItem: (opts?: StatusBarItemOptions) => track(createStatusBarItem(opts)),
      quickPick: <T extends QuickPickItem>(items: T[] | ((q: string) => T[] | Promise<T[]>), opts: { placeholder?: string } = {}) =>
        showQuickPick({ items, placeholder: opts.placeholder }),
      input: (prompt: string, value?: string) => showInput({ prompt, value }),
      notify: (message: string, kind?: "info" | "warning" | "error") => notify(message, kind),
      /** Adds a sidebar view with its own activity bar icon. `render` gets a plain DOM element. */
      registerView: (view: View) => track(registerView(view)),
      /** A widget layouts can place: { "widget": name, "props": {...} }. */
      registerWidget: (name: string, mount: (el: HTMLElement, sumi: unknown) => unknown) => track(registerWidget(name, mount)),
      showView: (id: string) => showView(id),
      /** Defines a Monaco theme and makes it selectable via "workbench.colorTheme". */
      defineTheme: (name: string, data: monaco.editor.IStandaloneThemeData) => {
        monaco.editor.defineTheme(name, data);
        registerPluginTheme(name, data.base);
      },
      addStyle: (css: string) => {
        const el = document.head.appendChild(document.createElement("style"));
        el.textContent = css;
        return track({ dispose: () => el.remove() });
      },
    },
    settings: {
      get: <T = unknown>(key: string, fallback?: T) => settings.get<T>(key, fallback),
      all: () => settings.all(),
      onDidChange: on("settings"),
    },
    /** Run any program (argv array, no shell), like a herdr plugin command. */
    exec: (argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
      api.exec(argv, opts.cwd ?? state.root ?? undefined, opts.env),
    log: (...args: unknown[]) => console.log(`[${pluginName}]`, ...args),
  };
}

export type SumiApi = ReturnType<typeof createSumiApi>;

export interface LoadedPlugin {
  name: string;
  version: string;
  error?: string;
  subscriptions: Disposable[];
  deactivate?: () => unknown;
}

export const loadedPlugins: LoadedPlugin[] = [];

export async function loadPlugins(plugins: PluginInfo[]) {
  for (const info of plugins) {
    const { id: name, source } = info;
    const entry: LoadedPlugin = { name, version: info.version, subscriptions: [] };
    loadedPlugins.push(entry);
    const url = URL.createObjectURL(new Blob([`${source}\n//# sourceURL=sumi-plugin://${name}`], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ url);
      const activate = mod.activate ?? mod.default;
      if (typeof activate !== "function") throw new Error("plugin does not export activate(sumi)");
      await activate(createSumiApi(info, entry.subscriptions));
      entry.deactivate = mod.deactivate;
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
      console.error(`plugin ${name} failed`, e);
      notify(`Plugin ${name} failed to load: ${entry.error}`, "error");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

(window as any).sumiPlugins = loadedPlugins;

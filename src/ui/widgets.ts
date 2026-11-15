// Widgets: JS modules in ~/.config/sumi/widgets/<name>/main.js that a layout places in a
// block, like the herdr app's mods. A widget exports `mount(el, sumi)` (or a default
// function) and may return a cleanup function. `sumi` is the plugin API plus:
//   sumi.widget = { name, props, dir }   this copy's block props and folder
//   sumi.theme()                          current colors by name (background, accent, ...)
// Saving a widget's main.js remounts every copy in place. Plugins can also register
// widgets in code with sumi.ui.registerWidget(name, mount).
import { invoke } from "@tauri-apps/api/core";
import { createSumiApi } from "../plugins/host";
import { h, type Disposable } from "../core/util";

export type WidgetMount = (el: HTMLElement, sumi: any) => unknown;

interface Instance {
  el: HTMLElement;
  name: string;
  propsKey: string;
  source: string;
  cleanup?: () => void;
  subscriptions: Disposable[];
  used: boolean;
}

const instances = new Map<string, Instance>(); // by block id
const registered = new Map<string, WidgetMount>(); // from plugins

export function registerWidget(name: string, mount: WidgetMount): Disposable {
  registered.set(name, mount);
  void reloadWidgets(true);
  return { dispose: () => registered.delete(name) };
}

/** Current theme colors by name, read from the CSS variables. */
export function themeColors(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--bg"), foreground: v("--fg"), dim: v("--fg-dim"), muted: v("--fg-dim"),
    border: v("--border"), accent: v("--accent"), accent_foreground: v("--accent-fg"),
    panel: v("--sidebar-bg"), chrome: v("--sidebar-bg"), surface: v("--widget-bg"),
    hover: v("--hover-bg"), selected: v("--selected-bg"), selection: v("--selected-focus-bg"),
    red: v("--git-deleted"), green: v("--git-added"), yellow: v("--git-modified"), cyan: v("--git-untracked"),
  };
}

async function load(inst: Instance, props: unknown, blockId: string) {
  inst.cleanup?.();
  inst.subscriptions.forEach((d) => d.dispose());
  inst.subscriptions = [];
  inst.el.replaceChildren();
  let mount: WidgetMount | undefined = registered.get(inst.name);
  let dir = "";
  if (!mount) {
    try {
      const w = await invoke<{ source: string; dir: string }>("load_widget", { name: inst.name });
      inst.source = w.source;
      dir = w.dir;
      const url = URL.createObjectURL(new Blob([`${w.source}\n//# sourceURL=sumi-widget://${inst.name}`], { type: "text/javascript" }));
      try {
        const mod = await import(/* @vite-ignore */ url);
        mount = mod.mount ?? mod.default;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      inst.el.append(h("div.widget-error", null, `widget ${inst.name}: ${e instanceof Error ? e.message : e}`));
      console.error(`widget ${inst.name}`, e);
      return;
    }
  }
  if (typeof mount !== "function") {
    inst.el.append(h("div.widget-error", null, `widget ${inst.name}: main.js must export mount(el, sumi)`));
    return;
  }
  const api = createSumiApi(
    { id: `widget:${inst.name}`, name: inst.name, version: "", description: "", dir, dataDir: "", source: "" },
    inst.subscriptions,
  ) as any;
  api.widget = { name: inst.name, props, dir, block: blockId };
  api.theme = themeColors;
  try {
    const result = await mount(inst.el, api);
    if (typeof result === "function") inst.cleanup = result as () => void;
    else if (result && typeof (result as Disposable).dispose === "function") inst.cleanup = () => (result as Disposable).dispose();
  } catch (e) {
    inst.el.append(h("div.widget-error", null, `widget ${inst.name}: ${e instanceof Error ? e.message : e}`));
    console.error(`widget ${inst.name}`, e);
  }
}

/** The element for a widget block; reused across layout re-renders while name/props match. */
export function mountWidget(blockId: string, name: string, props: unknown): HTMLElement {
  const propsKey = JSON.stringify(props ?? {});
  let inst = instances.get(blockId);
  if (inst && (inst.name !== name || inst.propsKey !== propsKey)) {
    inst.cleanup?.();
    inst.subscriptions.forEach((d) => d.dispose());
    instances.delete(blockId);
    inst = undefined;
  }
  if (!inst) {
    inst = { el: h("div.widget", { "data-widget": name }), name, propsKey, source: "", subscriptions: [], used: true };
    instances.set(blockId, inst);
    void load(inst, props ?? {}, blockId);
  }
  inst.used = true;
  return inst.el;
}

/** Drops widgets whose blocks left the layout. Call after each layout render. */
export function pruneWidgets() {
  for (const [id, inst] of instances) {
    if (!inst.el.isConnected) {
      inst.cleanup?.();
      inst.subscriptions.forEach((d) => d.dispose());
      instances.delete(id);
    }
  }
}

/** Remounts widgets whose main.js changed on disk (hot reload). */
export async function reloadWidgets(force = false) {
  for (const [id, inst] of instances) {
    if (registered.has(inst.name) && !force) continue;
    let source = "";
    if (!registered.has(inst.name)) {
      try {
        source = (await invoke<{ source: string }>("load_widget", { name: inst.name })).source;
      } catch {
        source = "";
      }
    }
    if (force || source !== inst.source) await load(inst, JSON.parse(inst.propsKey), id);
  }
}

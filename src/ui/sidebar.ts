// Layout engine, modeled on the herdr app's layouts: the whole window is a tree of nodes.
//
//   row / column   children side by side / stacked, with optional gap, divider, resizing
//   stack          shows one child at a time ("active"), optional header ("title" | "tabs")
//   block          shows content:
//                    { "view": "explorer" | "search" | "scm" | <plugin view id> }
//                    { "editor": true }       the editor groups (one per layout)
//                    { "statusbar": true }    { "activitybar": true }
//                    { "widget": "<name>", "props": {...} }   widgets/<name>/main.js
//
// Any node: id, size {px|weight}, min, max, hidden, background (color name, #hex,
// {gradient, angle} or {image, fit}), border {width, color}, radius, padding, window_drag.
// The editor block can frame its panes: "panes": {gap, radius, border, focus, header:{height}}.
//
// A layout comes from layouts/<name>.json. Without one, Sumi builds a plain tree from the
// [ui] settings (sidebar_position, sidebar_sections, activity_bar, pane_style, ...).
// Sizes, hidden nodes and stack choices people change are remembered per layout.
import { invoke } from "@tauri-apps/api/core";
import { settings } from "../core/settings";
import { state } from "../core/state";
import { bus, h, isMac } from "../core/util";
import { mountWidget, pruneWidgets } from "./widgets";

export interface ViewAction {
  icon: string;
  title: string;
  run: () => unknown;
}

export interface View {
  id: string;
  title: string;
  icon: string;
  /** Called once, the first time the view is shown. */
  render(container: HTMLElement): void;
  onShow?(): void;
  actions?: ViewAction[];
  /** Small count shown in the view header (e.g. number of git changes). */
  badge?(): string;
  order?: number;
}

export interface LayoutNode {
  id?: string;
  type?: "row" | "column" | "stack" | "block";
  children?: LayoutNode[];
  content?: { view?: string; editor?: boolean; statusbar?: boolean; activitybar?: boolean; widget?: string; props?: unknown; spacer?: boolean };
  size?: { px?: number; weight?: number };
  min?: number;
  max?: number;
  hidden?: boolean;
  background?: string | { gradient?: string[]; angle?: number; image?: string; fit?: "cover" | "contain" };
  border?: { width?: number; color?: string };
  radius?: number;
  padding?: number | number[];
  gap?: number;
  divider?: { width?: number; color?: string };
  resizable?: boolean;
  window_drag?: boolean;
  active?: string;
  header?: "title" | "tabs" | false;
  title?: string;
  panes?: {
    gap?: number;
    radius?: number;
    background?: string;
    border?: { width?: number; color?: string };
    focus?: { width?: number; color?: string };
    header?: { height?: number; style?: "classic" | "pills" };
  };
  // root only
  editor_opacity?: number;
}

interface NodeState {
  px?: number;
  weight?: number;
  hidden?: boolean;
  active?: string;
}

const views: View[] = [];
const containers = new Map<string, HTMLElement>();
let customTree: LayoutNode | null = null;
let layoutName = "";
let tree: LayoutNode = {};
let nodeState: Record<string, NodeState> = {};
const previousActive = new Map<string, string>(); // stack id -> child shown before a temporary switch
/** Stack children shown by a command (e.g. ⇧⌘F): not remembered, Escape undoes them. */
const temporaryActive = new Map<string, string>();
let initialized = false;

const $ = (id: string) => document.getElementById(id)!;

// ---- views registry -------------------------------------------------------------------------

export function registerView(view: View) {
  views.push(view);
  views.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  if (initialized) render();
  return {
    dispose: () => {
      views.splice(views.indexOf(view), 1);
      render();
    },
  };
}

function container(id: string) {
  let el = containers.get(id);
  if (!el) {
    el = h("div.view", { "data-view": id });
    containers.set(id, el);
    views.find((v) => v.id === id)?.render(el);
  }
  return el;
}

// ---- the tree ----------------------------------------------------------------------------------

/** A plain window built from the [ui] shorthand settings (used when no layout file is set). */
function defaultTree(): LayoutNode {
  const ui = <T>(k: string, d: T) => settings.get<T>(`ui.${k}`, d);
  const known = views.map((v) => v.id);
  const sections = ui<string[]>("sidebar_sections", ["explorer"]).filter((id) => known.includes(id));
  const others = known.filter((id) => !sections.includes(id));
  const viewBlock = (id: string, extra: Partial<LayoutNode> = {}): LayoutNode => ({ id: `view-${id}`, type: "block", content: { view: id }, ...extra });
  const titlebarHidden = document.documentElement.classList.contains("titlebar-hidden");
  const right = ui<string>("sidebar_position", "left") === "right";
  const sidebarHidden = nodeState.sidebar?.hidden ?? false;

  let sidebarChildren: LayoutNode[];
  if (sections.length > 1) {
    sidebarChildren = sections.map((id, i) =>
      i === 0
        ? { id: `stack-${id}`, type: "stack", active: id, header: "title", size: { weight: 1 }, children: [id, ...others].map((v) => viewBlock(v)) }
        : viewBlock(id, { size: { weight: 1 }, header: "title" }),
    );
  } else {
    const first = sections[0] ?? known[0];
    sidebarChildren = [{ id: "sidebar-stack", type: "stack", active: first, header: "title", size: { weight: 1 }, children: known.map((v) => viewBlock(v)) }];
  }
  // Room for the macOS window buttons when the title bar is hidden.
  const dragStrip: LayoutNode = { id: "window-controls", type: "block", size: { px: 34 }, window_drag: true, resizable: false, content: { spacer: true } };
  if (titlebarHidden && !right) sidebarChildren.unshift(dragStrip);

  const framed = ui<string>("pane_style", "flush") === "framed";
  const gap = ui("pane_gap", 8);
  const editor: LayoutNode = {
    id: "editor",
    type: "block",
    content: { editor: true },
    padding: framed ? gap : 0,
    panes: framed
      ? { gap, radius: ui("pane_radius", 3), border: { width: 1, color: "border" }, focus: { width: 1, color: "accent" }, header: { height: ui("tab_height", 35) } }
      : { header: { height: ui("tab_height", 35) } },
  };
  const workChildren: LayoutNode[] = [];
  if (titlebarHidden && (right || sidebarHidden)) workChildren.push({ ...dragStrip, id: "window-strip", background: "sidebar" });
  workChildren.push(editor);

  const row: LayoutNode[] = [];
  if (ui("activity_bar", true)) {
    row.push({ id: "activitybar", type: "block", size: { px: 48 }, resizable: false, background: "activitybar", content: { activitybar: true }, padding: titlebarHidden && !right ? [34, 0, 0, 0] : 0 });
  }
  row.push({ id: "sidebar", type: "column", size: { px: ui("sidebar_width", 260) }, min: 170, max: 700, background: "sidebar", children: sidebarChildren });
  row.push({ id: "work", type: "column", size: { weight: 1 }, children: workChildren });
  if (right) row.reverse();
  return {
    id: "root",
    type: "column",
    children: [
      { id: "main", type: "row", size: { weight: 1 }, divider: { width: 1, color: "border" }, children: row },
      { id: "status", type: "block", size: { px: 22 }, resizable: false, content: { statusbar: true } },
    ],
  };
}

/** Gives every node an id (path based when missing) so state can be remembered. */
function withIds(node: LayoutNode, path = "root"): LayoutNode {
  const id = node.id ?? path;
  return { ...node, id, children: node.children?.map((c, i) => withIds(c, `${id}.${c.id ?? i}`)) };
}

function ensureEditor(root: LayoutNode): LayoutNode {
  const has = (n: LayoutNode): boolean => !!n.content?.editor || !!n.children?.some(has);
  if (has(root)) return root;
  const editor: LayoutNode = { id: "editor", type: "block", content: { editor: true }, size: { weight: 1 } };
  return root.type === "block" ? { id: "root", type: "row", children: [root, editor] } : { ...root, children: [...(root.children ?? []), editor] };
}

const stateKey = () => `sumi.layout.v2:${layoutName || "default"}`;

function loadState() {
  try {
    nodeState = JSON.parse(localStorage.getItem(stateKey()) ?? "{}") ?? {};
  } catch {
    nodeState = {};
  }
}
function saveState() {
  try {
    localStorage.setItem(stateKey(), JSON.stringify(nodeState));
  } catch {
    /* ignore */
  }
}
const st = (id: string) => (nodeState[id] ??= {});

/** Called on every config load with the active layout file's tree (or null). */
export function setLayout(next: LayoutNode | null, name: string) {
  const changed = name !== layoutName;
  customTree = next;
  layoutName = name;
  if (changed) {
    loadState();
    previousActive.clear();
    temporaryActive.clear();
  }
  if (initialized) render();
}

// ---- painting ------------------------------------------------------------------------------------

/** Theme color names usable in layouts (herdr's names included), mapped to CSS variables. */
const COLOR_NAMES: Record<string, string> = {
  background: "--bg", canvas: "--bg", editor: "--bg",
  chrome: "--sidebar-bg", panel: "--sidebar-bg", sidebar: "--sidebar-bg",
  surface: "--widget-bg", popover: "--widget-bg", widget: "--widget-bg",
  raised: "--hover-bg", hover: "--hover-bg", selected: "--selected-bg",
  border: "--border", input: "--input-border",
  foreground: "--fg", muted: "--fg-dim", dim: "--fg-dim", accent: "--accent",
  statusbar: "--statusbar-bg", activitybar: "--activitybar-bg", tabs: "--tabs-bg",
};
export const colorValue = (c?: string) => (!c ? "" : COLOR_NAMES[c] ? `var(${COLOR_NAMES[c]})` : c);

const imageUrls = new Map<string, Promise<string | null>>();

/** Forgets decoded background images, so a replaced image file is read again on the next render. */
export function clearImageCache() {
  const old = [...imageUrls.values()];
  imageUrls.clear();
  // Revoke after the re-render has swapped in the new images.
  setTimeout(() => old.forEach((p) => void p.then((url) => url && URL.revokeObjectURL(url))), 5000);
}

/**
 * Background images, decoded once. SVGs are drawn into a bitmap first: WebKit can otherwise
 * re-render the vector (and any picture embedded in it) when content above it repaints,
 * which is what made a see-through editor scroll heavily.
 */
function imageUrl(path: string): Promise<string | null> {
  let p = imageUrls.get(path);
  if (!p) {
    // Absolute or ~/ paths as given (Rust expands ~); others are relative to the config folder.
    const abs = path.startsWith("/") || path.startsWith("~") ? path : `${state.configDir}/${path}`;
    const isSvg = path.toLowerCase().endsWith(".svg");
    p = invoke<ArrayBuffer>("read_image", { path: abs })
      .then(async (bytes) => {
        const blob = new Blob([bytes], isSvg ? { type: "image/svg+xml" } : undefined);
        if (!isSvg) return URL.createObjectURL(blob);
        const svgUrl = URL.createObjectURL(blob);
        try {
          const img = new Image();
          img.src = svgUrl;
          await img.decode();
          // Big enough for a sharp full-window background on a Retina screen, no bigger.
          const scale = Math.min(2, 2 * Math.max(screen.width / img.naturalWidth, screen.height / img.naturalHeight, 0.5));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.naturalWidth * scale);
          canvas.height = Math.round(img.naturalHeight * scale);
          canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
          const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
          return png ? URL.createObjectURL(png) : svgUrl;
        } finally {
          setTimeout(() => URL.revokeObjectURL(svgUrl), 0);
        }
      })
      .catch((e) => {
        console.warn(`layout image ${path}: ${e}`);
        return null;
      });
    imageUrls.set(path, p);
  }
  return p;
}

function paint(el: HTMLElement, node: LayoutNode) {
  const bg = node.background;
  if (typeof bg === "string") el.style.background = colorValue(bg);
  else if (bg?.gradient) el.style.background = `linear-gradient(${bg.angle ?? 180}deg, ${bg.gradient.map(colorValue).join(", ")})`;
  else if (bg?.image) {
    // The image gets its own element (and GPU layer), so scrolling the editor above it
    // composites over a finished bitmap instead of repainting the background.
    el.classList.add("has-image");
    const layer = h("div.node-image");
    el.prepend(layer);
    void imageUrl(bg.image).then((url) => {
      if (!url) return;
      layer.style.backgroundImage = `url("${url}")`;
      layer.style.backgroundSize = bg.fit === "contain" ? "contain" : "cover";
    });
  }
  if (node.border) el.style.border = `${node.border.width ?? 1}px solid ${colorValue(node.border.color ?? "border")}`;
  if (node.radius) el.style.borderRadius = `${node.radius}px`;
  const p = node.padding;
  if (typeof p === "number" && p) el.style.padding = `${p}px`;
  else if (Array.isArray(p)) el.style.padding = p.map((v) => `${v}px`).join(" ");
  if (node.window_drag) el.setAttribute("data-tauri-drag-region", "");
}

// ---- rendering ---------------------------------------------------------------------------------

const isVisible = (n: LayoutNode) => !(st(n.id!).hidden ?? n.hidden);

function sizeStyle(el: HTMLElement, node: LayoutNode, dir: "row" | "column" | null) {
  const s = st(node.id!);
  const px = s.px ?? node.size?.px;
  const weight = s.weight ?? node.size?.weight;
  el.style.flex = px != null ? `0 0 ${px}px` : `${weight ?? 1} 1 0`;
  if (dir === "row") {
    if (node.min != null) el.style.minWidth = `${node.min}px`;
    if (node.max != null) el.style.maxWidth = `${node.max}px`;
  } else if (dir === "column") {
    if (node.min != null) el.style.minHeight = `${node.min}px`;
    if (node.max != null) el.style.maxHeight = `${node.max}px`;
  }
}

function viewHeader(view: View) {
  return h(
    "header.section-header",
    null,
    h("span.section-title", null, view.title.toUpperCase()),
    h("span.section-actions", null, ...(view.actions ?? []).map((a) => h("button.icon-btn", { html: a.icon, title: a.title, onclick: () => a.run() }))),
    h("span.count.section-badge", { "data-badge": view.id }),
  );
}

let editorUnderImage = false;
let shownViews: string[] = [];

function build(node: LayoutNode, dir: "row" | "column" | null, inStackWithHeader = false): HTMLElement {
  const type = node.type ?? "block";
  const el = h("div", { className: `node node-${type}`, "data-node": node.id });
  sizeStyle(el, node, dir);
  paint(el, node);

  if (type === "row" || type === "column") {
    const visible = (node.children ?? []).filter(isVisible);
    visible.forEach((child, i) => {
      el.append(build(child, type));
      if (i < visible.length - 1) el.append(separator(node, type, child, visible[i + 1]));
    });
  } else if (type === "stack") {
    const kids = node.children ?? [];
    const s = st(node.id!);
    const pick = (id?: string) => (id ? kids.find((c) => c.id === id || c.content?.view === id) : undefined);
    const active = pick(temporaryActive.get(node.id!)) ?? pick(s.active) ?? pick(node.active) ?? kids[0];
    const activeView = views.find((v) => v.id === active?.content?.view);
    if (node.header === "tabs") {
      el.append(
        h(
          "header.section-header.stack-tabs",
          null,
          ...kids.map((c) => {
            const title = c.title ?? views.find((v) => v.id === c.content?.view)?.title ?? c.id!;
            return h("button", { className: `stack-tab${c === active ? " active" : ""}`, onclick: () => setStackActive(node.id!, c.id!) }, title.toUpperCase());
          }),
          activeView ? h("span.section-actions", null, ...(activeView.actions ?? []).map((a) => h("button.icon-btn", { html: a.icon, title: a.title, onclick: () => a.run() }))) : null,
        ),
      );
    } else if (node.header === "title" && activeView) {
      el.append(viewHeader(activeView));
    }
    if (active) el.append(build({ ...active, size: { weight: 1 } }, "column", node.header === "title" || node.header === "tabs"));
  } else {
    const c = node.content ?? {};
    if (c.view) {
      const view = views.find((v) => v.id === c.view);
      if (view) {
        shownViews.push(view.id);
        if (!inStackWithHeader && node.header !== false && node.header !== undefined) el.append(viewHeader(view));
        el.append(container(view.id));
      }
    } else if (c.editor) {
      el.classList.add("editor-block");
      el.append($("editor-area"));
      applyPanes(node.panes);
    } else if (c.statusbar) {
      el.append($("statusbar"));
    } else if (c.activitybar) {
      el.append($("activitybar"));
    } else if (c.widget) {
      el.classList.add("widget-block");
      el.append(mountWidget(node.id!, c.widget, c.props ?? {}));
    }
  }
  return el;
}

/** Pane frame settings from the editor block, as CSS variables. */
function applyPanes(p: LayoutNode["panes"]) {
  const root = document.documentElement;
  const framed = !!p && (p.border !== undefined || p.radius !== undefined || p.gap !== undefined);
  root.classList.toggle("panes-framed", framed);
  const set = (k: string, v: string | null) => (v == null ? root.style.removeProperty(k) : root.style.setProperty(k, v));
  set("--pane-gap", framed ? `${p?.gap ?? 8}px` : null);
  set("--pane-radius", framed ? `${p?.radius ?? 0}px` : null);
  set("--pane-border", framed && p?.border ? `${p.border.width ?? 1}px solid ${colorValue(p.border.color ?? "border")}` : framed ? "0" : null);
  set("--pane-focus-color", framed && p?.focus ? colorValue(p.focus.color ?? "accent") : null);
  set("--pane-bg", p?.background ? colorValue(p.background) : null);
  set("--tab-height", p?.header?.height ? `${p.header.height}px` : `${settings.get<number>("ui.tab_height", 35)}px`);
  // "pills": herdr-style rounded tabs; "classic": VS Code-style tabs (default).
  root.classList.toggle("tabs-pills", p?.header?.style === "pills");
}

function separator(parent: LayoutNode, dir: "row" | "column", a: LayoutNode, b: LayoutNode) {
  const thickness = parent.gap ?? parent.divider?.width ?? 0;
  const sep = h("div", { className: `node-sep node-sep-${dir}` });
  sep.style.flex = `0 0 ${thickness}px`;
  if (parent.divider && !parent.gap) sep.style.background = colorValue(parent.divider.color ?? "border");
  const resizable = parent.resizable !== false && a.resizable !== false && b.resizable !== false;
  if (resizable) {
    sep.classList.add("resizable");
    sep.addEventListener("mousedown", (e) => dragSeparator(e, sep, dir, a, b));
  }
  return sep;
}

function dragSeparator(e: MouseEvent, sep: HTMLElement, dir: "row" | "column", a: LayoutNode, b: LayoutNode) {
  e.preventDefault();
  const aEl = sep.previousElementSibling as HTMLElement;
  const bEl = sep.nextElementSibling as HTMLElement;
  const horizontal = dir === "row";
  const size = (el: HTMLElement) => (horizontal ? el.offsetWidth : el.offsetHeight);
  const start = horizontal ? e.clientX : e.clientY;
  const sa = size(aEl);
  const sb = size(bEl);
  const aPx = (st(a.id!).px ?? a.size?.px) != null;
  const bPx = (st(b.id!).px ?? b.size?.px) != null;
  const wa = st(a.id!).weight ?? a.size?.weight ?? 1;
  const wb = st(b.id!).weight ?? b.size?.weight ?? 1;
  document.body.classList.add(horizontal ? "resizing-h" : "resizing-v");
  const move = (ev: MouseEvent) => {
    const d = Math.max(40 - sa, Math.min(sb - 40, (horizontal ? ev.clientX : ev.clientY) - start));
    if (aPx) {
      st(a.id!).px = clamp(a, sa + d);
      aEl.style.flex = `0 0 ${st(a.id!).px}px`;
    } else if (bPx) {
      st(b.id!).px = clamp(b, sb - d);
      bEl.style.flex = `0 0 ${st(b.id!).px}px`;
    } else {
      const total = wa + wb;
      st(a.id!).weight = (total * (sa + d)) / (sa + sb);
      st(b.id!).weight = total - st(a.id!).weight!;
      aEl.style.flex = `${st(a.id!).weight} 1 0`;
      bEl.style.flex = `${st(b.id!).weight} 1 0`;
    }
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.classList.remove("resizing-h", "resizing-v");
    saveState();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
const clamp = (n: LayoutNode, v: number) => Math.round(Math.max(n.min ?? 40, Math.min(n.max ?? 4000, v)));

function nodeHasImageAbove(root: LayoutNode): boolean {
  // Is the editor block inside (or itself) a node with an image background?
  const walk = (n: LayoutNode, underImage: boolean): boolean => {
    const here = underImage || (typeof n.background === "object" && !!n.background?.image);
    if (n.content?.editor) return here;
    return !!n.children?.filter(isVisible).some((c) => walk(c, here));
  };
  return walk(root, false);
}

export function render() {
  if (!initialized) return;
  tree = withIds(ensureEditor(customTree ?? defaultTree()));
  shownViews = [];
  const rootEl = build({ ...tree, size: { weight: 1 } }, null);
  $("layout-root").replaceChildren(rootEl);
  pruneWidgets();

  // The editor sits over an image: make it see-through and tint panes like herdr's
  // terminal_opacity (root "editor_opacity", default 1 = solid).
  const under = nodeHasImageAbove(tree);
  document.documentElement.classList.toggle("layout-backdrop", under);
  document.documentElement.style.setProperty("--editor-opacity", String(tree.editor_opacity ?? 1));
  // herdr's terminal_padding: [vertical, horizontal] space around terminal text.
  const tp = (tree as { terminal_padding?: number | number[] }).terminal_padding;
  const pad = Array.isArray(tp) ? tp.map((v) => `${v}px`).join(" ") : tp != null ? `${tp}px` : "";
  if (pad) document.documentElement.style.setProperty("--terminal-padding", pad);
  else document.documentElement.style.removeProperty("--terminal-padding");
  if (under !== editorUnderImage) {
    editorUnderImage = under;
    state.layoutBackdrop = under;
    bus.emit("layout-backdrop");
  }
  renderActivityBar();
  updateBadges();
}

function renderActivityBar() {
  $("activitybar").replaceChildren(
    ...views.map((v) =>
      h("button", {
        className: `activity${shownViews.includes(v.id) ? " active" : ""}`,
        title: v.title,
        html: v.icon,
        onclick: () => (shownViews.includes(v.id) ? toggleSidebar() : showView(v.id)),
      }),
    ),
  );
}

/** Refreshes the count badges in view headers. */
export function updateBadges() {
  document.querySelectorAll<HTMLElement>(".section-badge").forEach((el) => {
    const text = views.find((v) => v.id === el.dataset.badge)?.badge?.() ?? "";
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  });
}

// ---- navigation ---------------------------------------------------------------------------------

function findPath(node: LayoutNode, test: (n: LayoutNode) => boolean, path: LayoutNode[] = []): LayoutNode[] | null {
  const here = [...path, node];
  if (test(node)) return here;
  for (const c of node.children ?? []) {
    const p = findPath(c, test, here);
    if (p) return p;
  }
  return null;
}

/** A deliberate choice (a stack tab click): remembered across restarts. */
function setStackActive(stackId: string, childId: string) {
  temporaryActive.delete(stackId);
  previousActive.delete(stackId);
  st(stackId).active = childId;
  saveState();
  render();
}

/** Shows a view: activates it in its stack and unhides its ancestors. */
export function showView(id: string, focus = true) {
  const view = views.find((v) => v.id === id);
  if (!view) return;
  const path = findPath(tree, (n) => n.content?.view === id);
  if (path) {
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (st(n.id!).hidden ?? n.hidden) st(n.id!).hidden = false;
      if (n.type === "stack" && path[i + 1]) {
        // Shown by a command: temporary. The remembered choice stays, Escape returns to it.
        const childId = path[i + 1].id!;
        const remembered = st(n.id!).active ?? n.active ?? n.children?.[0]?.id;
        const rememberedChild = n.children?.find((c) => c.id === remembered || c.content?.view === remembered);
        if (rememberedChild?.id === childId) {
          temporaryActive.delete(n.id!);
          previousActive.delete(n.id!);
        } else {
          if (!temporaryActive.has(n.id!) && rememberedChild) previousActive.set(n.id!, rememberedChild.id!);
          temporaryActive.set(n.id!, childId);
        }
      }
    }
    saveState();
    render();
  }
  view.onShow?.();
  if (focus) containers.get(id)?.querySelector<HTMLElement>("input, textarea, [tabindex]")?.focus();
}

/** Shows/hides the node with id "sidebar" (herdr's convention). */
export function toggleSidebar(show?: boolean) {
  const sidebar = findPath(tree, (n) => n.id === "sidebar")?.pop();
  if (!sidebar) return;
  const hidden = st("sidebar").hidden ?? sidebar.hidden ?? false;
  st("sidebar").hidden = show === undefined ? !hidden : !show;
  saveState();
  render();
}

export function initSidebar() {
  initialized = true;
  loadState();
  render();
  for (const id of shownViews) views.find((v) => v.id === id)?.onShow?.();

  // Escape inside a view that was switched to temporarily returns its stack to before.
  $("layout-root").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const viewEl = (e.target as HTMLElement).closest<HTMLElement>(".view[data-view]");
    if (!viewEl) return;
    const path = findPath(tree, (n) => n.content?.view === viewEl.dataset.view);
    const stack = path?.slice().reverse().find((n) => n.type === "stack");
    if (stack && temporaryActive.has(stack.id!)) {
      temporaryActive.delete(stack.id!);
      previousActive.delete(stack.id!);
      render();
      e.preventDefault();
    }
  });
}

// Live config reload re-lays out the window ([ui] settings feed the default tree), but only
// when something layout-related changed (not on zoom or theme previews).
let lastSignature = "";
bus.on("settings", () => {
  if (!initialized) return;
  const signature = JSON.stringify([settings.get("ui"), customTree, layoutName]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  render();
});
void isMac;

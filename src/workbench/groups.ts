// Editor groups (tabs + one editor each) arranged in a split layout, like VS Code.
import { api } from "../core/api";
import { icons, fileIcon } from "../core/icons";
import { keyLabelFor } from "../core/keybindings";
import { languageForPath, monaco } from "../core/monaco";
import { editorOptions, settings } from "../core/settings";
import { state } from "../core/state";
import { copyText, basename, bus, debounce, dirname, h, relative } from "../core/util";
import { askSave, contextMenu } from "../ui/notify";
import { diffLines } from "./dirtydiff";
import { Doc, docName, isDirty, newUntitled, openDoc, releaseDoc, retainDoc, saveDoc } from "./documents";
import { TerminalSession } from "./terminal";

interface FileTab {
  kind: "file";
  id: number;
  doc: Doc;
  preview: boolean;
  viewState: monaco.editor.ICodeEditorViewState | null;
}

interface DiffTab {
  kind: "diff";
  id: number;
  key: string;
  path: string;
  staged: boolean;
  original: monaco.editor.ITextModel;
  /** Working-tree diffs edit the real document; staged diffs show a read-only index snapshot. */
  modifiedDoc: Doc | null;
  modifiedModel: monaco.editor.ITextModel;
  preview: boolean;
  viewState: monaco.editor.IDiffEditorViewState | null;
}

interface TerminalTab {
  kind: "terminal";
  id: number;
  session: TerminalSession;
  preview: false;
  viewState: null;
}

/**
 * A tab can have a hidden "twin": ⌃` flips a file tab into a terminal in the same spot and
 * back again. The hidden side stays alive (the file keeps its edits, the shell keeps running).
 */
export type Tab = (FileTab | DiffTab | TerminalTab) & { twin?: Tab };

interface GroupNode {
  kind: "group";
  group: EditorGroup;
  parent: SplitNode | null;
  size: number;
}
interface SplitNode {
  kind: "split";
  dir: "row" | "col";
  children: LayoutNode[];
  parent: SplitNode | null;
  size: number;
}
type LayoutNode = GroupNode | SplitNode;

let tabSeq = 1;
let rootNode: LayoutNode;
let activeGroup: EditorGroup;
const closedStack: string[] = [];
let dragging: { tab: Tab; from: EditorGroup } | null = null;

export class EditorGroup {
  readonly el = h("div.group");
  readonly tabsEl = h("div.tabs");
  readonly bodyEl = h("div.group-body");
  readonly editorHost = h("div.editor-host");
  readonly diffHost = h("div.editor-host", { hidden: true });
  readonly termHost = h("div.editor-host.terminal-area", { hidden: true });
  readonly emptyEl = h("div.watermark");
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  diff: monaco.editor.IStandaloneDiffEditor | null = null;
  tabs: Tab[] = [];
  active: Tab | null = null;
  node!: GroupNode;
  private mru: Tab[] = [];
  private decorations: monaco.editor.IEditorDecorationsCollection;

  constructor() {
    const actions = h(
      "div.tab-actions",
      null,
      h("button.icon-btn", { html: icons.split, title: "Split Editor Right", onclick: () => splitGroup(this, "row") }),
    );
    const tabBar = h("div.tabbar", null, this.tabsEl, actions);
    // Empty tab-bar space drags the window (matters when the title bar is hidden).
    this.tabsEl.setAttribute("data-tauri-drag-region", "");
    this.bodyEl.append(this.editorHost, this.diffHost, this.termHost, this.emptyEl);
    this.el.append(tabBar, this.bodyEl);
    this.editor = monaco.editor.create(this.editorHost, { ...editorOptions(), model: null });
    this.decorations = this.editor.createDecorationsCollection();
    this.watchEditor(this.editor);
    this.el.addEventListener("mousedown", () => setActiveGroup(this, false), true);

    // Tab drag and drop (reorder, or move to another group).
    tabBar.addEventListener("dragover", (e) => {
      if (!dragging) return;
      e.preventDefault();
      tabBar.classList.add("drop-target");
    });
    tabBar.addEventListener("dragleave", () => tabBar.classList.remove("drop-target"));
    tabBar.addEventListener("drop", (e) => {
      tabBar.classList.remove("drop-target");
      if (!dragging) return;
      e.preventDefault();
      const target = (e.target as HTMLElement).closest<HTMLElement>(".tab");
      const idx = target ? this.tabs.findIndex((t) => String(t.id) === target.dataset.id) : this.tabs.length;
      moveTab(dragging.tab, dragging.from, this, idx);
      dragging = null;
    });
    // Double-click empty tab bar space: new untitled file (VS Code behavior).
    this.tabsEl.addEventListener("dblclick", (e) => {
      // With a hidden title bar, double-click zooms the window instead (macOS convention).
      if (e.target === this.tabsEl && !document.documentElement.classList.contains("titlebar-hidden")) {
        this.openDoc(newUntitled(), { focus: true });
      }
    });
    this.renderWatermark();
    this.update();
  }

  private watchEditor(ed: monaco.editor.ICodeEditor) {
    ed.onDidFocusEditorWidget(() => setActiveGroup(this, false));
    ed.onDidChangeCursorSelection(() => this === activeGroup && bus.emit("cursor"));
    ed.onDidChangeModelContent(() => {
      // Editing a preview tab pins it, like VS Code.
      if (this.active?.preview) {
        this.active.preview = false;
        this.renderTabs();
      }
    });
  }

  private ensureDiff() {
    if (this.diff) return this.diff;
    this.diff = monaco.editor.createDiffEditor(this.diffHost, {
      ...editorOptions(),
      originalEditable: false,
      renderSideBySide: true,
      ignoreTrimWhitespace: false,
      renderMarginRevertIcon: true,
    });
    this.watchEditor(this.diff.getModifiedEditor());
    this.diff.getOriginalEditor().onDidFocusEditorWidget(() => setActiveGroup(this, false));
    return this.diff;
  }

  /** The focused code editor: the plain editor, or the modified side of a diff. */
  codeEditor(): monaco.editor.ICodeEditor | null {
    if (!this.active || this.active.kind === "terminal") return null;
    return this.active.kind === "diff" ? this.diff!.getModifiedEditor() : this.editor;
  }

  activeDoc(): Doc | null {
    if (!this.active || this.active.kind === "terminal") return null;
    return this.active.kind === "file" ? this.active.doc : this.active.modifiedDoc;
  }

  // ---- opening ---------------------------------------------------------------------------

  /** Shows a document in this group. Takes ownership of one reference on `doc`. */
  openDoc(doc: Doc, opts: { preview?: boolean; focus?: boolean; selection?: monaco.IRange } = {}) {
    let tab = this.tabs.find((t): t is FileTab => t.kind === "file" && t.doc === doc);
    if (tab) {
      releaseDoc(doc);
      if (!opts.preview) tab.preview = false;
    } else {
      tab = { kind: "file", id: tabSeq++, doc, preview: !!opts.preview, viewState: null };
      this.insertTab(tab, !!opts.preview);
    }
    this.activate(tab);
    if (opts.selection) {
      this.editor.setSelection(opts.selection);
      this.editor.revealRangeInCenterIfOutsideViewport(opts.selection, monaco.editor.ScrollType.Immediate);
    }
    if (opts.focus !== false) this.editor.focus();
    return tab;
  }

  async openDiff(path: string, staged: boolean, opts: { preview?: boolean; focus?: boolean } = {}) {
    const key = `${staged ? "index" : "worktree"}:${path}`;
    let tab = this.tabs.find((t): t is DiffTab => t.kind === "diff" && t.key === key);
    if (!tab) {
      const root = state.git?.root ?? state.root!;
      const lang = languageForPath(path);
      const original = await api.gitFileContent(root, path, staged ? "HEAD" : "INDEX").catch(() => "");
      const originalModel = monaco.editor.createModel(original, lang, monaco.Uri.from({ scheme: "git", path, query: `${key}#${tabSeq}` }));
      let modifiedDoc: Doc | null = null;
      let modifiedModel: monaco.editor.ITextModel;
      if (staged) {
        const indexText = await api.gitFileContent(root, path, "INDEX").catch(() => "");
        modifiedModel = monaco.editor.createModel(indexText, lang, monaco.Uri.from({ scheme: "git-index", path, query: String(tabSeq) }));
      } else {
        modifiedDoc = await openDoc(path).catch(() => null);
        modifiedModel = modifiedDoc?.model ?? monaco.editor.createModel("", lang, monaco.Uri.from({ scheme: "deleted", path, query: String(tabSeq) }));
      }
      tab = { kind: "diff", id: tabSeq++, key, path, staged, original: originalModel, modifiedDoc, modifiedModel, preview: !!opts.preview, viewState: null };
      this.insertTab(tab, !!opts.preview);
    } else if (!opts.preview) {
      tab.preview = false;
    }
    this.activate(tab);
    if (opts.focus !== false) this.diff!.getModifiedEditor().focus();
  }

  private insertTab(tab: Tab, preview: boolean) {
    const previewTab = preview ? this.tabs.find((t) => t.preview) : undefined;
    if (previewTab && !(previewTab.kind === "file" && isDirty(previewTab.doc))) {
      const i = this.tabs.indexOf(previewTab);
      this.tabs.splice(i, 0, tab);
      this.disposeTab(previewTab);
    } else {
      const i = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
      this.tabs.splice(i, 0, tab);
    }
  }

  // ---- activation ------------------------------------------------------------------------

  private saveViewState() {
    const t = this.active;
    if (t?.kind === "file") t.viewState = this.editor.saveViewState();
    else if (t?.kind === "diff" && this.diff) t.viewState = this.diff.saveViewState();
  }

  activate(tab: Tab | null) {
    if (tab !== this.active) this.saveViewState();
    this.active = tab;
    if (tab) this.mru = [tab, ...this.mru.filter((t) => t !== tab)];
    if (tab?.kind === "file") {
      if (this.editor.getModel() !== tab.doc.model) {
        this.editor.setModel(tab.doc.model);
        if (tab.viewState) this.editor.restoreViewState(tab.viewState);
      }
    } else if (tab?.kind === "diff") {
      const diff = this.ensureDiff();
      const current = diff.getModel();
      if (current?.original !== tab.original || current?.modified !== tab.modifiedModel) {
        diff.setModel({ original: tab.original, modified: tab.modifiedModel });
        if (tab.viewState) diff.restoreViewState(tab.viewState);
      }
      diff.getModifiedEditor().updateOptions({ readOnly: tab.staged || !tab.modifiedDoc });
    } else if (tab?.kind === "terminal") {
      // Only the active terminal is shown; its element moves here if the tab came from another group.
      for (const el of [...this.termHost.children] as HTMLElement[]) el.hidden = el !== tab.session.el;
      if (tab.session.el.parentElement !== this.termHost) this.termHost.append(tab.session.el);
      tab.session.el.hidden = false;
    }
    if (tab?.kind !== "file") this.editor.setModel(null);
    this.update();
    if (this === activeGroup) bus.emit("active-editor");
    this.updateDirtyDiff();
    scheduleSessionSave();
  }

  private update() {
    const kind = this.active?.kind;
    this.editorHost.hidden = kind !== "file";
    this.diffHost.hidden = kind !== "diff";
    this.termHost.hidden = kind !== "terminal";
    if (this.active?.kind === "terminal") requestAnimationFrame(() => (this.active as TerminalTab | null)?.session?.layout());
    this.emptyEl.hidden = !!kind;
    this.renderTabs();
  }

  /** The most recently shown tab in this pane matching `test` (other than the active one). */
  recentTab(test: (t: Tab) => boolean): Tab | undefined {
    return this.mru.find((t) => t !== this.active && test(t)) ?? this.tabs.find((t) => t !== this.active && test(t));
  }

  focus() {
    if (this.active?.kind === "terminal") this.active.session.focus();
    else if (this.active) this.codeEditor()?.focus();
    else this.el.focus();
  }

  // ---- closing ---------------------------------------------------------------------------

  /** Returns false if the user cancelled. */
  async closeTab(tab: Tab, force = false): Promise<boolean> {
    if (!force && tab.kind === "file" && isDirty(tab.doc) && tab.doc.refs === 1) {
      const choice = await askSave(docName(tab.doc));
      if (choice === "cancel") return false;
      if (choice === "save") {
        const saved = await saveDoc(tab.doc);
        if (saved === null) return false;
      }
    }
    if (!this.tabs.includes(tab)) return true;
    // Closing one side of a flipped tab brings the other side back in its place
    // (⌘W on the terminal returns to the file).
    const twin = tab.twin;
    if (twin && !this.tabs.includes(twin)) {
      tab.twin = undefined;
      twin.twin = undefined;
      this.tabs[this.tabs.indexOf(tab)] = twin;
      this.mru = this.mru.filter((t) => t !== tab);
      this.disposeTab(tab);
      this.activate(twin);
      this.focus();
      scheduleSessionSave();
      return true;
    }
    if (tab.kind === "file" && !tab.doc.untitled) {
      closedStack.push(tab.doc.path);
      if (closedStack.length > 50) closedStack.shift();
    }
    const wasActive = tab === this.active;
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.mru = this.mru.filter((t) => t !== tab);
    if (wasActive) this.activate(this.mru[0] ?? null);
    this.disposeTab(tab);
    this.renderTabs();
    if (!this.tabs.length && allGroups().length > 1) removeGroup(this);
    scheduleSessionSave();
    return true;
  }

  async closeAll(except?: Tab): Promise<boolean> {
    for (const tab of [...this.tabs]) {
      if (tab === except) continue;
      if (!(await this.closeTab(tab))) return false;
    }
    return true;
  }

  /** Releases a tab's models without touching the tab list. */
  private disposeTab(tab: Tab) {
    this.tabs = this.tabs.filter((t) => t !== tab);
    this.mru = this.mru.filter((t) => t !== tab);
    if (tab.kind === "file") releaseDoc(tab.doc);
    else if (tab.kind === "terminal") tab.session.dispose();
    else {
      if (this.diff?.getModel()?.original === tab.original) this.diff.setModel(null);
      tab.original.dispose();
      if (tab.modifiedDoc) releaseDoc(tab.modifiedDoc);
      else tab.modifiedModel.dispose();
    }
  }

  /** Takes a tab out of this group without releasing its models (for moving between groups). */
  detachTab(tab: Tab) {
    this.saveViewState();
    const wasActive = tab === this.active;
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.mru = this.mru.filter((t) => t !== tab);
    if (wasActive) {
      if (tab.kind === "diff") this.diff?.setModel(null);
      this.activate(this.mru[0] ?? null);
    }
    this.renderTabs();
  }

  attachTab(tab: Tab, index: number) {
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    this.activate(tab);
  }

  /** Puts `next` in `current`'s place in the tab bar (`current` stays alive, just hidden). */
  replaceTab(current: Tab, next: Tab) {
    const i = this.tabs.indexOf(current);
    if (i < 0) return;
    this.tabs[i] = next;
    this.mru = this.mru.filter((t) => t !== current);
    this.activate(next);
  }

  dispose() {
    for (const t of [...this.tabs]) {
      if (t.twin && !this.tabs.includes(t.twin)) this.disposeTab(t.twin); // hidden side too
      this.disposeTab(t);
    }
    this.editor.dispose();
    this.diff?.dispose();
    this.el.remove();
  }

  // ---- rendering -------------------------------------------------------------------------

  tabTitle(tab: Tab) {
    if (tab.kind === "file") return docName(tab.doc);
    if (tab.kind === "terminal") return tab.session.title;
    return `${basename(tab.path)} (${tab.staged ? "Index" : "Working Tree"})`;
  }

  renderTabs() {
    const names = this.tabs.map((t) => this.tabTitle(t));
    this.tabsEl.replaceChildren(
      ...this.tabs.map((tab, i) => {
        const dirty = tab.kind === "file" ? isDirty(tab.doc) : tab.kind === "diff" ? !!tab.modifiedDoc && isDirty(tab.modifiedDoc) : false;
        const path = tab.kind === "file" ? tab.doc.path : tab.kind === "diff" ? tab.path : "";
        const duplicate = names.filter((n) => n === names[i]).length > 1;
        const cls = ["tab", tab === this.active && "active", tab.preview && "preview", dirty && "dirty", tab.kind === "diff" && "diff"]
          .filter(Boolean)
          .join(" ");
        const el = h(
          "div",
          {
            className: cls,
            draggable: true,
            title: tab.kind === "terminal" ? `Terminal: ${names[i]}` : tab.kind === "file" && tab.doc.untitled ? names[i] : relative(state.root, path),
            "data-id": tab.id,
            onmousedown: (e: MouseEvent) => {
              if (e.button === 0) {
                this.activate(tab);
                setActiveGroup(this);
              }
            },
            onauxclick: (e: MouseEvent) => e.button === 1 && void this.closeTab(tab),
            ondblclick: () => {
              tab.preview = false;
              this.renderTabs();
            },
            ondragstart: (e: DragEvent) => {
              dragging = { tab, from: this };
              e.dataTransfer!.effectAllowed = "move";
            },
            ondragend: () => (dragging = null),
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              this.tabMenu(tab, e.clientX, e.clientY);
            },
          },
          h("span.tab-icon", { html: tab.kind === "terminal" ? `<span class="file-icon">${icons.terminal}</span>` : fileIcon(path) }),
          h("span.tab-label", null, names[i]),
          duplicate && tab.kind === "file" && !tab.doc.untitled ? h("span.tab-desc", null, basename(dirname(path))) : null,
          h("button.tab-close", {
            html: icons.close,
            title: "Close",
            onmousedown: (e: MouseEvent) => e.stopPropagation(),
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              void this.closeTab(tab);
            },
          }),
        );
        return el;
      }),
    );
    this.tabsEl.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private tabMenu(tab: Tab, x: number, y: number) {
    const path = tab.kind === "file" ? tab.doc.path : tab.kind === "diff" ? tab.path : "";
    const isFile = tab.kind !== "terminal" && !(tab.kind === "file" && tab.doc.untitled);
    contextMenu(x, y, [
      { label: "Close", action: () => this.closeTab(tab), keybinding: keyLabelFor("workbench.action.closeActiveEditor") },
      { label: "Close Others", action: () => this.closeAll(tab) },
      { label: "Close to the Right", action: async () => {
        for (const t of this.tabs.slice(this.tabs.indexOf(tab) + 1)) if (!(await this.closeTab(t))) return;
      } },
      { label: "Close All", action: () => this.closeAll() },
      { separator: true },
      { label: "Copy Path", disabled: !isFile, keybinding: keyLabelFor("copyFilePath"), action: () => copyText(path) },
      { label: "Copy Relative Path", disabled: !isFile, keybinding: keyLabelFor("copyRelativeFilePath"), action: () => copyText(relative(state.root, path)) },
      { label: "Reveal in Explorer", disabled: !isFile, action: () => bus.emit("reveal", path) },
      { separator: true },
      { label: "Split Right", action: () => splitGroup(this, "row", tab) },
      { label: "Split Down", action: () => splitGroup(this, "col", tab) },
    ]);
  }

  private renderWatermark() {
    const row = (label: string, cmd: string) =>
      h("div.wm-row", null, h("span", null, label), h("kbd", null, keyLabelFor(cmd)));
    this.emptyEl.replaceChildren(
      h(
        "div.wm-inner",
        null,
        h("div.wm-logo", null, "Slate"),
        row("Show All Commands", "workbench.action.showCommands"),
        row("Go to File", "workbench.action.quickOpen"),
        row("Find in Files", "workbench.action.findInFiles"),
        row("Open Folder", "workbench.action.files.openFolder"),
        row("Split Editor", "workbench.action.splitEditor"),
        row("Toggle Sidebar", "workbench.action.toggleSidebarVisibility"),
      ),
    );
  }

  refreshWatermark() {
    this.renderWatermark();
  }

  /** Re-reads the git side of open diff tabs after staging, commits or external changes. */
  async refreshDiffTabs() {
    const root = state.git?.root ?? state.root;
    if (!root) return;
    for (const tab of this.tabs) {
      if (tab.kind !== "diff") continue;
      const original = await api.gitFileContent(root, tab.path, tab.staged ? "HEAD" : "INDEX").catch(() => "");
      if (tab.original.getValue() !== original) tab.original.setValue(original);
      if (tab.staged) {
        const index = await api.gitFileContent(root, tab.path, "INDEX").catch(() => "");
        if (tab.modifiedModel.getValue() !== index) tab.modifiedModel.setValue(index);
      }
    }
  }

  // ---- git gutter markers ----------------------------------------------------------------

  updateDirtyDiff = debounce(async () => {
    const tab = this.active;
    if (tab?.kind !== "file" || tab.doc.untitled || !state.git || !settings.get("scm.diff_decorations")) {
      this.decorations.clear();
      return;
    }
    const path = tab.doc.path;
    const status = state.git.files.find((f) => f.path === path && !f.staged);
    const tracked = !status || status.status !== "U";
    if (!tracked) return this.decorations.clear();
    const base = await baseContent(path);
    if (this.active !== tab || base === null) return;
    const hunks = diffLines(base.split(/\r?\n/), tab.doc.model.getLinesContent());
    if (!hunks) return this.decorations.clear();
    const colors = { added: "#2ea04399", modified: "#1b81a899", deleted: "#f8514999" };
    this.decorations.set(
      hunks.map((hk) => ({
        range: new monaco.Range(hk.start, 1, Math.max(hk.start, hk.end), 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `dd dd-${hk.kind}`,
          overviewRuler: { color: colors[hk.kind], position: monaco.editor.OverviewRulerLane.Left },
        },
      })),
    );
  }, 250);
}

// Index content per file, used as the base for gutter markers. Cleared on every git change.
const baseCache = new Map<string, Promise<string | null>>();
function baseContent(path: string) {
  let p = baseCache.get(path);
  if (!p) {
    const root = state.git?.root ?? state.root;
    p = root ? api.gitFileContent(root, path, "INDEX").catch(() => null) : Promise.resolve(null);
    baseCache.set(path, p);
  }
  return p;
}

bus.on("git", () => {
  baseCache.clear();
  for (const g of allGroups()) {
    g.updateDirtyDiff();
    g.refreshDiffTabs();
  }
});
bus.on("doc-dirty", (doc: Doc) => {
  for (const g of allGroups()) {
    if (g.tabs.some((t) => (t.kind === "file" ? t.doc : t.kind === "diff" ? t.modifiedDoc : null) === doc)) g.renderTabs();
    if (g.activeDoc() === doc) g.updateDirtyDiff();
  }
});
bus.on("settings", () => {
  for (const g of allGroups()) {
    g.editor.updateOptions(editorOptions());
    g.diff?.updateOptions(editorOptions());
    g.updateDirtyDiff();
  }
});

// ---- layout ----------------------------------------------------------------------------

const area = () => document.getElementById("editor-area")!;

export function initLayout() {
  const g = new EditorGroup();
  rootNode = g.node = { kind: "group", group: g, parent: null, size: 1 };
  activeGroup = g;
  g.el.classList.add("active-group");
  renderLayout();
}

export function allGroups(): EditorGroup[] {
  const out: EditorGroup[] = [];
  const walk = (n: LayoutNode) => (n.kind === "group" ? out.push(n.group) : n.children.forEach(walk));
  if (rootNode) walk(rootNode);
  return out;
}

export const getActiveGroup = () => activeGroup;

export function setActiveGroup(g: EditorGroup, focus = true) {
  if (activeGroup !== g) {
    activeGroup?.el.classList.remove("active-group");
    activeGroup = g;
    g.el.classList.add("active-group");
    bus.emit("active-editor");
  }
  if (focus) g.focus();
}

function renderLayout() {
  const build = (node: LayoutNode): HTMLElement => {
    if (node.kind === "group") {
      node.group.el.style.flex = `${node.size} 1 0`;
      return node.group.el;
    }
    const el = h("div", { className: `split split-${node.dir}` });
    el.style.flex = `${node.size} 1 0`;
    node.children.forEach((child, i) => {
      const childEl = build(child);
      el.append(childEl);
      if (i < node.children.length - 1) {
        const sash = h("div", { className: `sash ${node.dir === "row" ? "sash-v" : "sash-h"}` });
        sash.addEventListener("mousedown", (e) => startSashDrag(e, node, i, el));
        el.append(sash);
      }
    });
    return el;
  };
  // Keep the background layers (when [ui.background] area = "editor" puts them here).
  const keep = [...area().querySelectorAll(":scope > #backdrop, :scope > #backdrop-overlay")];
  area().replaceChildren(...keep, build(rootNode));
}

function startSashDrag(e: MouseEvent, node: SplitNode, i: number, container: HTMLElement) {
  e.preventDefault();
  const a = node.children[i];
  const b = node.children[i + 1];
  const elems = [...container.children].filter((c) => !c.classList.contains("sash")) as HTMLElement[];
  const horizontal = node.dir === "row";
  const pxA = horizontal ? elems[i].offsetWidth : elems[i].offsetHeight;
  const pxB = horizontal ? elems[i + 1].offsetWidth : elems[i + 1].offsetHeight;
  const total = a.size + b.size;
  const start = horizontal ? e.clientX : e.clientY;
  document.body.classList.add(horizontal ? "resizing-h" : "resizing-v");
  const move = (ev: MouseEvent) => {
    const delta = (horizontal ? ev.clientX : ev.clientY) - start;
    const newA = Math.max(120, Math.min(pxA + pxB - 120, pxA + delta));
    a.size = (total * newA) / (pxA + pxB);
    b.size = total - a.size;
    elems[i].style.flex = `${a.size} 1 0`;
    elems[i + 1].style.flex = `${b.size} 1 0`;
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.classList.remove("resizing-h", "resizing-v");
    scheduleSessionSave();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function replaceNode(old: LayoutNode, next: LayoutNode) {
  const parent = old.parent;
  next.parent = parent;
  if (!parent) rootNode = next;
  else parent.children[parent.children.indexOf(old)] = next;
}

/** Splits `group`, opening `tab` (default: the active tab) in the new group. */
export function splitGroup(group: EditorGroup, dir: "row" | "col", tab: Tab | null = group.active, newShare = 0.5): EditorGroup {
  const ng = new EditorGroup();
  const node = group.node;
  const newNode: GroupNode = { kind: "group", group: ng, parent: null, size: node.size };
  ng.node = newNode;
  if (node.parent && node.parent.dir === dir) {
    const p = node.parent;
    newNode.size = node.size * newShare;
    node.size *= 1 - newShare;
    p.children.splice(p.children.indexOf(node) + 1, 0, newNode);
    newNode.parent = p;
  } else {
    const split: SplitNode = { kind: "split", dir, children: [node, newNode], parent: null, size: node.size };
    replaceNode(node, split);
    node.parent = newNode.parent = split;
    node.size = 2 * (1 - newShare);
    newNode.size = 2 * newShare;
  }
  renderLayout();
  if (tab?.kind === "file") {
    const vs = group.active === tab ? group.editor.saveViewState() : tab.viewState;
    ng.openDoc(retainDoc(tab.doc), { focus: false });
    if (vs) ng.editor.restoreViewState(vs);
  } else if (tab?.kind === "diff") {
    void ng.openDiff(tab.path, tab.staged, { focus: false });
  } else if (tab?.kind === "terminal") {
    void openTerminal(ng, tab.session.cwd); // splitting a terminal starts a new one beside it
  }
  setActiveGroup(ng);
  scheduleSessionSave();
  return ng;
}

export function removeGroup(group: EditorGroup) {
  const node = group.node;
  const parent = node.parent;
  if (!parent) return;
  const i = parent.children.indexOf(node);
  parent.children.splice(i, 1);
  const sibling = parent.children[Math.max(0, i - 1)];
  sibling.size += node.size;
  if (parent.children.length === 1) {
    const only = parent.children[0];
    only.size = parent.size;
    replaceNode(parent, only);
  }
  group.dispose();
  renderLayout();
  if (activeGroup === group) {
    const next = allGroups()[0];
    activeGroup = null as unknown as EditorGroup;
    setActiveGroup(next);
  }
  scheduleSessionSave();
}

function moveTab(tab: Tab, from: EditorGroup, to: EditorGroup, index: number) {
  if (from === to) {
    const cur = from.tabs.indexOf(tab);
    from.tabs.splice(cur, 1);
    from.tabs.splice(index > cur ? index - 1 : index, 0, tab);
    from.renderTabs();
    return;
  }
  // A group can only show a document once; focus the existing tab instead of duplicating.
  const doc = tab.kind === "file" ? tab.doc : null;
  const existing = doc && to.tabs.find((t) => t.kind === "file" && t.doc === doc);
  if (existing) {
    void from.closeTab(tab, true);
    to.activate(existing);
  } else {
    from.detachTab(tab);
    to.attachTab(tab, index);
    if (!from.tabs.length && allGroups().length > 1) removeGroup(from);
  }
  setActiveGroup(to);
}

// ---- high level helpers used by commands -----------------------------------------------

export async function openFile(path: string, opts: { preview?: boolean; focus?: boolean; selection?: monaco.IRange; group?: EditorGroup } = {}) {
  const doc = await openDoc(path);
  const group = opts.group ?? activeGroup;
  group.openDoc(doc, opts);
  setActiveGroup(group, opts.focus !== false);
  return group;
}

export function activeCodeEditor() {
  return activeGroup?.codeEditor() ?? null;
}

export function reopenClosed() {
  const path = closedStack.pop();
  if (path) void openFile(path);
}

/** After a save-as or rename, point every tab showing `oldDoc` at the document for `newPath`. */
export async function swapDocument(oldDoc: Doc, newPath: string) {
  for (const g of allGroups()) {
    for (const tab of g.tabs) {
      if (tab.kind !== "file" || tab.doc !== oldDoc) continue;
      const doc = await openDoc(newPath);
      if (isDirty(oldDoc)) {
        doc.model.setValue(oldDoc.model.getValue());
      }
      tab.doc = doc;
      tab.viewState = g.active === tab ? g.editor.saveViewState() : tab.viewState;
      releaseDoc(oldDoc);
      if (g.active === tab) {
        g.editor.setModel(doc.model);
        if (tab.viewState) g.editor.restoreViewState(tab.viewState);
      }
      g.renderTabs();
    }
  }
  bus.emit("active-editor");
}

/** Close tabs whose files were deleted (path or anything under it). */
export function closeTabsUnder(path: string) {
  for (const g of allGroups()) {
    for (const tab of [...g.tabs]) {
      if (tab.kind === "terminal") continue;
      const p = tab.kind === "file" ? tab.doc.path : tab.path;
      if (p === path || p.startsWith(path + "/") || p.startsWith(path + "\\")) void g.closeTab(tab, true);
    }
  }
}

export function dirtyDocs(): Doc[] {
  const seen = new Set<Doc>();
  for (const g of allGroups()) for (const t of g.tabs) if (t.kind === "file" && isDirty(t.doc)) seen.add(t.doc);
  return [...seen];
}

// ---- session ---------------------------------------------------------------------------

interface SavedNode {
  kind: "group" | "split";
  size: number;
  dir?: "row" | "col";
  children?: SavedNode[];
  files?: string[];
  active?: number;
}

const SESSION_KEY = "slate.layout";

export const scheduleSessionSave = debounce(saveSession, 400);

function saveSession() {
  if (!state.root || !rootNode) return;
  // Panes with nothing restorable (terminals, untitled files) are left out, so they don't
  // come back as empty panes; a split left with one pane collapses into it.
  const ser = (n: LayoutNode): SavedNode | null => {
    if (n.kind === "split") {
      const children = n.children.map(ser).filter((c): c is SavedNode => !!c);
      if (!children.length) return null;
      if (children.length === 1) return { ...children[0], size: n.size };
      return { kind: "split", size: n.size, dir: n.dir, children };
    }
    const files = n.group.tabs.filter((t): t is FileTab => t.kind === "file" && !t.doc.untitled);
    if (!files.length) return null;
    const active = n.group.active?.kind === "file" ? files.indexOf(n.group.active as FileTab) : -1;
    return { kind: "group", size: n.size, files: files.map((t) => t.doc.path), active };
  };
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}");
    all[state.root] = ser(rootNode) ?? { kind: "group", size: 1, files: [], active: -1 };
    localStorage.setItem(SESSION_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

/** Closes everything and restores the saved layout for the current folder. */
export async function restoreSession() {
  for (const g of allGroups()) g.dispose();
  let saved: SavedNode | undefined;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}")[state.root ?? ""];
  } catch {
    saved = undefined;
  }
  const opens: Promise<void>[] = [];
  const build = (s: SavedNode | undefined, parent: SplitNode | null): LayoutNode => {
    if (s?.kind === "split" && s.children?.length) {
      const node: SplitNode = { kind: "split", dir: s.dir ?? "row", children: [], parent, size: s.size || 1 };
      node.children = s.children.map((c) => build(c, node));
      return node;
    }
    const g = new EditorGroup();
    const node: GroupNode = { kind: "group", group: g, parent, size: s?.size || 1 };
    g.node = node;
    const files = s?.files ?? [];
    opens.push(
      (async () => {
        for (const path of files) {
          try {
            const doc = await openDoc(path);
            g.openDoc(doc, { focus: false });
          } catch {
            /* file gone */
          }
        }
        const active = g.tabs[s?.active ?? -1] ?? g.tabs[g.tabs.length - 1] ?? null;
        g.activate(active);
      })(),
    );
    return node;
  };
  rootNode = build(saved, null);
  activeGroup = allGroups()[0];
  activeGroup.el.classList.add("active-group");
  renderLayout();
  await Promise.all(opens);
  bus.emit("active-editor");
}


// ---- terminals ---------------------------------------------------------------------------

/**
 * Opens a terminal in `group` (default: the active one) and starts the shell. With `replace`,
 * the terminal takes that tab's place and the two become twins (⌃` flips between them).
 */
export async function openTerminal(group: EditorGroup = activeGroup, cwd: string | null = state.root, replace?: Tab) {
  const session = new TerminalSession(cwd);
  const tab: Tab = { kind: "terminal", id: tabSeq++, session, preview: false, viewState: null };
  session.onTitle = () => groupOf(tab)?.renderTabs();
  // The shell exited (e.g. `exit`): close its tab, like VS Code (a flipped tab shows its file
  // again). If it exits while hidden behind its file, just unlink it.
  session.onExit = () => {
    const g = groupOf(tab);
    if (g) return void g.closeTab(tab, true);
    const visibleTwin = tab.twin;
    if (visibleTwin) visibleTwin.twin = undefined;
    tab.twin = undefined;
    session.dispose();
  };
  if (replace && group.tabs.includes(replace)) {
    replace.twin = tab;
    tab.twin = replace;
    group.replaceTab(replace, tab);
  } else {
    const i = group.active ? group.tabs.indexOf(group.active) + 1 : group.tabs.length;
    group.tabs.splice(i, 0, tab);
    group.activate(tab);
  }
  setActiveGroup(group, false);
  await session.start();
  session.focus();
  return tab;
}

function groupOf(tab: Tab) {
  return allGroups().find((g) => g.tabs.includes(tab));
}

export function terminalTabs(): { group: EditorGroup; tab: TerminalTab }[] {
  return allGroups().flatMap((group) => group.tabs.filter((t): t is TerminalTab => t.kind === "terminal").map((tab) => ({ group, tab })));
}

/** Whether keyboard focus is inside a terminal. */
export const terminalFocused = () => !!(document.activeElement as HTMLElement | null)?.closest?.(".terminal-host");

/**
 * ⌃`: flips the tab you're on, in place. A file becomes a terminal in the same spot; pressed
 * again it flips back to the file, and again to the same terminal (no new shell). In an empty
 * pane it opens a terminal there.
 */
export async function toggleTerminal() {
  const g = activeGroup;
  const current = g.active;
  if (!current) return void (await openTerminal(g));
  if (current.twin) {
    g.replaceTab(current, current.twin);
    g.focus();
    return;
  }
  if (current.kind === "terminal") return; // a separate terminal tab (⌃⇧`): nothing to flip to
  await openTerminal(g, state.root, current);
}

/** ⌃⇧`: another terminal tab in the pane you're in. */
export async function newTerminal() {
  const current = activeGroup.active;
  await openTerminal(activeGroup, current?.kind === "terminal" ? current.session.cwd : state.root);
}

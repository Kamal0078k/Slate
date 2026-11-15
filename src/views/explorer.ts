// File explorer: lazy tree, git colors, context menu with create/rename/delete.
import { api, DirEntry } from "../core/api";
import { executeCommand } from "../core/commands";
import { keyLabelFor } from "../core/keybindings";
import { fileIcon, icons } from "../core/icons";
import { state } from "../core/state";
import { copyText, basename, bus, dirname, h, isInside, isMac, join, relative } from "../core/util";
import { closeTabsUnder, getActiveGroup, openFile, swapDocument } from "../workbench/groups";
import { getDoc } from "../workbench/documents";
import { confirmDialog, contextMenu, notify } from "../ui/notify";
import { showInput } from "../ui/quickpick";
import { View } from "../ui/sidebar";

const expanded = new Set<string>();
const children = new Map<string, DirEntry[]>();
let selected: string | null = null;
let treeEl: HTMLElement;
let gitColors = new Map<string, string>();

async function load(dir: string) {
  try {
    children.set(dir, await api.readDir(dir));
  } catch {
    children.delete(dir);
    expanded.delete(dir);
  }
}

export async function setExplorerRoot() {
  expanded.clear();
  children.clear();
  if (state.root) {
    expanded.add(state.root);
    try {
      const saved = JSON.parse(localStorage.getItem("slate.expanded") ?? "{}")[state.root] ?? [];
      for (const d of saved) expanded.add(d);
    } catch {
      /* ignore */
    }
    await Promise.all([...expanded].map(load));
  }
  render();
}

/** Re-reads the given directories (or all expanded ones) and re-renders. */
export async function refreshExplorer(dirs?: string[]) {
  const targets = dirs ? dirs.filter((d) => expanded.has(d)) : [...expanded];
  await Promise.all(targets.map(load));
  render();
}

function persistExpanded() {
  if (!state.root) return;
  try {
    const all = JSON.parse(localStorage.getItem("slate.expanded") ?? "{}");
    all[state.root] = [...expanded].filter((d) => d !== state.root);
    localStorage.setItem("slate.expanded", JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

async function toggle(dir: string) {
  if (expanded.has(dir)) expanded.delete(dir);
  else {
    expanded.add(dir);
    if (!children.has(dir)) await load(dir);
  }
  persistExpanded();
  render();
}

function render() {
  if (!treeEl) return;
  if (!state.root) {
    treeEl.replaceChildren(
      h(
        "div.empty-view",
        null,
        h("p", null, "You have not yet opened a folder."),
        h("button.btn", { onclick: () => executeCommand("workbench.action.files.openFolder") }, "Open Folder"),
      ),
    );
    return;
  }
  const active = getActiveGroup()?.activeDoc()?.path;
  const rows: HTMLElement[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of children.get(dir) ?? []) {
      const open = entry.isDir && expanded.has(entry.path);
      const color = gitColors.get(entry.path);
      const row = h(
        "div",
        {
          className: ["row", entry.path === selected && "selected", entry.path === active && "active-file", color && `git-${color}`]
            .filter(Boolean)
            .join(" "),
          style: { paddingLeft: `${depth * 12 + 6}px` },
          "data-path": entry.path,
          "data-dir": entry.isDir ? "1" : "",
          title: relative(state.root, entry.path),
        },
        h("span.twist", { html: entry.isDir ? (open ? icons.chevronDown : icons.chevronRight) : "" }),
        h("span.row-icon", { html: entry.isDir ? "" : fileIcon(entry.name) }),
        h("span.row-label", null, entry.name),
        color ? h("span.git-badge", null, color === "dir" ? "●" : color) : null,
      );
      rows.push(row);
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk(state.root, 0);
  treeEl.replaceChildren(...rows);
}

function entryFromEvent(e: Event) {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
  return row ? { path: row.dataset.path!, isDir: row.dataset.dir === "1" } : null;
}

/** Folder a new file should go in: the selected folder, or the selected file's folder. */
function targetDir(entry: { path: string; isDir: boolean } | null) {
  if (!state.root) return null;
  if (!entry) return state.root;
  return entry.isDir ? entry.path : dirname(entry.path);
}

const validName = (v: string) => (!v.trim() ? "A file or folder name must be provided." : null);

export async function newFile(dir = targetDir(selectedEntry())) {
  if (!dir) return;
  const name = await showInput({ prompt: `New file in ${relative(state.root, dir) || basename(dir)} (use / for subfolders)`, validate: validName });
  if (!name) return;
  const path = join(dir, name.trim());
  try {
    await api.createFile(path);
    await afterChange([dir, dirname(path)]);
    expanded.add(dirname(path));
    selected = path;
    await openFile(path);
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function newFolder(dir = targetDir(selectedEntry())) {
  if (!dir) return;
  const name = await showInput({ prompt: "New folder name", validate: validName });
  if (!name) return;
  const path = join(dir, name.trim());
  try {
    await api.createDir(path);
    expanded.add(dir);
    expanded.add(path);
    await afterChange([dir, path]);
  } catch (e) {
    notify(String(e), "error");
  }
}

async function rename(path: string) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const value = await showInput({
    prompt: "New name",
    value: name,
    selection: [0, dot > 0 ? dot : name.length],
    validate: validName,
  });
  if (!value || value === name) return;
  const to = join(dirname(path), value.trim());
  try {
    await api.renamePath(path, to);
    const doc = getDoc(path);
    if (doc) await swapDocument(doc, to);
    selected = to;
    await afterChange([dirname(path)]);
  } catch (e) {
    notify(String(e), "error");
  }
}

async function remove(path: string, isDir: boolean) {
  const ok = await confirmDialog(`Are you sure you want to delete '${basename(path)}'${isDir ? " and its contents" : ""}?\n\nYou can restore it from the Trash.`);
  if (!ok) return;
  try {
    await api.deletePath(path);
    closeTabsUnder(path);
    await afterChange([dirname(path)]);
  } catch (e) {
    notify(String(e), "error");
  }
}

async function afterChange(dirs: string[]) {
  await api.invalidateIndex();
  await refreshExplorer(dirs);
}

function selectedEntry() {
  if (!selected) return null;
  const row = treeEl?.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(selected)}"]`);
  return row ? { path: selected, isDir: row.dataset.dir === "1" } : null;
}

/** The selected explorer item, but only while the explorer has keyboard focus. */
export function focusedExplorerPath(): string | null {
  return treeEl && treeEl.contains(document.activeElement) ? selected : null;
}

export function collapseAll() {
  if (!state.root) return;
  expanded.clear();
  expanded.add(state.root);
  persistExpanded();
  render();
}

/** Expands parent folders of `path` and scrolls it into view. */
export async function reveal(path: string) {
  if (!state.root || !isInside(state.root, path)) return;
  let dir = dirname(path);
  const chain: string[] = [];
  while (dir.length >= state.root.length && dir !== state.root) {
    chain.unshift(dir);
    dir = dirname(dir);
  }
  for (const d of chain) {
    expanded.add(d);
    if (!children.has(d)) await load(d);
  }
  selected = path;
  persistExpanded();
  render();
  treeEl.querySelector(".row.selected")?.scrollIntoView({ block: "center" });
}

function revealInOs(path: string) {
  const argv = isMac ? ["open", "-R", path] : navigator.userAgent.includes("Windows") ? ["explorer", "/select,", path] : ["xdg-open", dirname(path)];
  void api.exec(argv);
}

export const explorerView: View = {
  id: "explorer",
  title: "Explorer",
  icon: icons.files,
  order: 1,
  actions: [
    { icon: icons.newFile, title: "New File", run: () => newFile() },
    { icon: icons.newFolder, title: "New Folder", run: () => newFolder() },
    { icon: icons.refresh, title: "Refresh", run: () => refreshExplorer() },
    { icon: icons.collapse, title: "Collapse All", run: collapseAll },
  ],
  render(container) {
    treeEl = h("div.tree", { tabIndex: 0 });
    container.append(treeEl);
    treeEl.addEventListener("click", (e) => {
      const entry = entryFromEvent(e);
      if (!entry) return;
      selected = entry.path;
      if (entry.isDir) void toggle(entry.path);
      else {
        render();
        void openFile(entry.path, { preview: true, focus: false });
      }
    });
    treeEl.addEventListener("dblclick", (e) => {
      const entry = entryFromEvent(e);
      if (entry && !entry.isDir) void openFile(entry.path, { preview: false });
    });
    treeEl.addEventListener("keydown", (e) => {
      const entry = selectedEntry();
      if (!entry) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void rename(entry.path);
      } else if ((e.key === "Backspace" && e.metaKey) || e.key === "Delete") {
        e.preventDefault();
        void remove(entry.path, entry.isDir);
      }
    });
    treeEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const entry = entryFromEvent(e);
      if (entry) {
        selected = entry.path;
        render();
      }
      const dir = targetDir(entry);
      contextMenu(e.clientX, e.clientY, [
        { label: "New File...", action: () => newFile(dir) },
        { label: "New Folder...", action: () => newFolder(dir) },
        { separator: true },
        ...(entry
          ? [
              { label: "Open to the Side", disabled: entry.isDir, action: () => executeCommand("workbench.action.openToSide", entry.path) },
              { label: isMac ? "Reveal in Finder" : "Reveal in File Manager", action: () => revealInOs(entry.path) },
              { label: "Find in Folder...", disabled: !entry.isDir, action: () => executeCommand("workbench.action.findInFolder", entry.path) },
              { separator: true },
              { label: "Copy Path", keybinding: keyLabelFor("copyFilePath"), action: () => copyText(entry.path) },
              { label: "Copy Relative Path", keybinding: keyLabelFor("copyRelativeFilePath"), action: () => copyText(relative(state.root, entry.path)) },
              { separator: true },
              { label: "Rename...", keybinding: "↩", action: () => rename(entry.path) },
              { label: "Delete", keybinding: isMac ? "⌘⌫" : "Del", action: () => remove(entry.path, entry.isDir) },
            ]
          : [{ label: "Refresh", action: () => refreshExplorer() }]),
      ]);
    });
    render();
  },
};

bus.on("active-editor", () => render());
bus.on("reveal", (path: string) => void reveal(path));
bus.on("git", () => {
  gitColors = new Map();
  for (const f of state.git?.files ?? []) {
    const letter = f.status === "U" ? "U" : f.status === "D" ? "D" : f.status === "A" ? "A" : f.status === "C" ? "C" : "M";
    if (!gitColors.has(f.path) || !f.staged) gitColors.set(f.path, letter);
    // Mark parent folders so changes inside collapsed folders are visible.
    let dir = dirname(f.path);
    while (state.root && dir.length > state.root.length && !gitColors.has(dir)) {
      gitColors.set(dir, "dir");
      dir = dirname(dir);
    }
  }
  render();
});

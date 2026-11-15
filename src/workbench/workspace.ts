// Opening folders and keeping editor state in sync with the disk.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../core/api";
import { state } from "../core/state";
import { basename, bus, debounce, dirname, isInside } from "../core/util";
import { refreshExplorer, setExplorerRoot } from "../views/explorer";
import { refreshGit } from "../views/scm";
import { confirmDialog } from "../ui/notify";
import { allDocs, docName, isDirty, reloadFromDisk } from "./documents";
import { dirtyDocs, getActiveGroup, restoreSession } from "./groups";

export function recentFolders(): string[] {
  try {
    return JSON.parse(localStorage.getItem("slate.recentFolders") ?? "[]");
  } catch {
    return [];
  }
}

export async function openFolder(path: string) {
  const root = await api.openWorkspace(path);
  if (root === state.root) return;
  const dirty = dirtyDocs().length;
  if (dirty && !(await confirmDialog(`You have ${dirty} unsaved file${dirty === 1 ? "" : "s"}. Open another folder and discard them?`))) return;
  state.root = root;
  try {
    localStorage.setItem("slate.recentFolders", JSON.stringify([root, ...recentFolders().filter((p) => p !== root)].slice(0, 15)));
  } catch {
    /* ignore */
  }
  await api.invalidateIndex();
  await api.watchWorkspace(root).catch((e) => console.warn("file watching unavailable", e));
  await Promise.all([setExplorerRoot(), refreshGit()]);
  await restoreSession();
  bus.emit("workspace", root);
  updateTitle();
}

export const updateTitle = debounce(() => {
  const doc = getActiveGroup()?.activeDoc();
  const parts = [doc ? `${isDirty(doc) ? "● " : ""}${docName(doc)}` : null, state.root ? basename(state.root) : null, "Slate"];
  void getCurrentWindow().setTitle(parts.filter(Boolean).join(" — "));
}, 50);

bus.on("active-editor", updateTitle);
bus.on("doc-dirty", updateTitle);

// ---- file watcher --------------------------------------------------------------------------

const pendingPaths = new Set<string>();

const flush = debounce(async () => {
  const paths = [...pendingPaths];
  pendingPaths.clear();
  if (!state.root) return;
  const fileChanges = paths.filter((p) => !/[\\/]\.git[\\/]/.test(p));
  if (fileChanges.length) {
    await api.invalidateIndex();
    const dirs = new Set(fileChanges.map(dirname));
    await refreshExplorer([...dirs]);
    const open = new Set(allDocs().map((d) => d.path));
    for (const p of fileChanges) if (open.has(p)) await reloadFromDisk(p);
  }
  bus.emit("fs-changed", paths);
  await refreshGit();
}, 200);

export function onFsChanged(paths: string[]) {
  for (const p of paths) if (state.root && (isInside(state.root, p) || /[\\/]\.git[\\/]/.test(p))) pendingPaths.add(p);
  if (pendingPaths.size) flush();
}

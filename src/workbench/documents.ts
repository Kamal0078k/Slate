// Open documents: one Monaco model per file, shared by every tab/split showing it.
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../core/api";
import { languageForPath, monaco } from "../core/monaco";
import { settings } from "../core/settings";
import { state } from "../core/state";
import { basename, bus, dirname } from "../core/util";

export interface Doc {
  /** Absolute path, or "untitled:Untitled-N". */
  path: string;
  model: monaco.editor.ITextModel;
  savedVersion: number;
  untitled: boolean;
  /** Number of tabs (and diff views) holding this document. */
  refs: number;
}

const docs = new Map<string, Doc>();
let untitledSeq = 1;

export const getDoc = (path: string) => docs.get(path);
export const allDocs = () => [...docs.values()];
export const isDirty = (doc: Doc) => doc.model.getAlternativeVersionId() !== doc.savedVersion;
export const docName = (doc: Doc) => (doc.untitled ? doc.path.slice("untitled:".length) : basename(doc.path));

function track(doc: Doc) {
  doc.model.onDidChangeContent(() => bus.emit("doc-dirty", doc));
  docs.set(doc.path, doc);
  bus.emit("doc-opened", doc);
  return doc;
}

const pending = new Map<string, Promise<Doc>>();

/** Opens (or reuses) a document and takes one reference on it. */
export async function openDoc(path: string): Promise<Doc> {
  const existing = docs.get(path);
  if (existing) {
    existing.refs++;
    return existing;
  }
  let p = pending.get(path);
  if (!p) {
    p = (async () => {
      const file = await api.readFile(path);
      if (file.binary) throw new Error(`${basename(path)} is a binary file`);
      if (file.tooLarge) throw new Error(`${basename(path)} is too large to open (over 50 MB)`);
      const model = monaco.editor.createModel(file.content, languageForPath(path), monaco.Uri.file(path));
      return track({ path, model, savedVersion: model.getAlternativeVersionId(), untitled: false, refs: 0 });
    })().finally(() => pending.delete(path));
    pending.set(path, p);
  }
  const doc = await p;
  doc.refs++;
  return doc;
}

export function newUntitled(content = "", language = "plaintext"): Doc {
  const path = `untitled:Untitled-${untitledSeq++}`;
  const model = monaco.editor.createModel(content, language, monaco.Uri.parse(path));
  return track({ path, model, savedVersion: model.getAlternativeVersionId(), untitled: true, refs: 1 });
}

export function retainDoc(doc: Doc) {
  doc.refs++;
  return doc;
}

export function releaseDoc(doc: Doc) {
  if (--doc.refs > 0) return;
  docs.delete(doc.path);
  doc.model.dispose();
  bus.emit("doc-closed", doc);
}

function applySaveParticipants(model: monaco.editor.ITextModel) {
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  if (settings.get("files.trim_trailing_whitespace")) {
    for (let line = 1; line <= model.getLineCount(); line++) {
      const text = model.getLineContent(line);
      const trimmed = text.trimEnd();
      if (trimmed.length !== text.length) {
        edits.push({ range: new monaco.Range(line, trimmed.length + 1, line, text.length + 1), text: "" });
      }
    }
  }
  if (settings.get("files.insert_final_newline")) {
    const last = model.getLineCount();
    if (model.getLineContent(last).length > 0) {
      const col = model.getLineMaxColumn(last);
      edits.push({ range: new monaco.Range(last, col, last, col), text: model.getEOL() });
    }
  }
  if (edits.length) model.pushEditOperations([], edits, () => null);
}

/**
 * Writes a document to disk. Untitled documents (or `saveAs`) ask for a path and return the
 * new path; the caller is responsible for swapping tabs over to the new document.
 */
export async function saveDoc(doc: Doc, saveAs = false): Promise<string | null> {
  let target = doc.path;
  if (doc.untitled || saveAs) {
    const chosen = await saveDialog({
      defaultPath: doc.untitled ? (state.root ?? undefined) : doc.path,
      title: "Save As",
    });
    if (!chosen) return null;
    target = chosen;
  }
  applySaveParticipants(doc.model);
  const content = doc.model.getValue();
  await api.writeFile(target, content);
  if (target === doc.path) {
    doc.savedVersion = doc.model.getAlternativeVersionId();
    bus.emit("doc-dirty", doc);
  }
  bus.emit("doc-saved", target, dirname(target));
  return target;
}

/** Re-reads a clean document after the file changed on disk (e.g. edited by a terminal tool). */
export async function reloadFromDisk(path: string) {
  const doc = docs.get(path);
  if (!doc || doc.untitled || isDirty(doc)) return;
  let content: string;
  try {
    const file = await api.readFile(path);
    if (file.binary || file.tooLarge) return;
    content = file.content;
  } catch {
    return; // deleted: keep the buffer, like VS Code
  }
  const model = doc.model;
  const old = model.getValue();
  if (old === content || isDirty(doc)) return;
  // Replace only the changed middle so cursors and scroll position stay put.
  let start = 0;
  const min = Math.min(old.length, content.length);
  while (start < min && old[start] === content[start]) start++;
  let endOld = old.length;
  let endNew = content.length;
  while (endOld > start && endNew > start && old[endOld - 1] === content[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(endOld));
  model.pushEditOperations([], [{ range, text: content.slice(start, endNew) }], () => null);
  doc.savedVersion = model.getAlternativeVersionId();
  bus.emit("doc-dirty", doc);
}

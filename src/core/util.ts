// Small shared helpers: events, paths, JSONC, DOM.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Native clipboard write (works without a user gesture, unlike navigator.clipboard). */
export const copyText = (text: string) => writeText(text);

export interface Disposable { dispose(): void }

type Listener = (...args: any[]) => void;
const listeners = new Map<string, Set<Listener>>();

/** App-wide event bus. Events: workspace, active-editor, cursor, doc-dirty, doc-saved,
 *  doc-opened, git, settings, fs-changed. */
export const bus = {
  on(event: string, fn: Listener): Disposable {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(fn);
    return { dispose: () => listeners.get(event)?.delete(fn) };
  },
  emit(event: string, ...args: unknown[]) {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        console.error(`[bus:${event}]`, e);
      }
    });
  },
};

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p.slice(0, i + 1) : p.slice(0, i);
};
export const sep = (p: string) => (p.includes("\\") && !p.includes("/") ? "\\" : "/");
export const join = (dir: string, name: string) => (dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep(dir) + name);
export const relative = (root: string | null, p: string) =>
  root && (p === root || p.startsWith(root + "/") || p.startsWith(root + "\\")) ? p.slice(root.length + 1) || "." : p;
export const isInside = (parent: string, p: string) =>
  p === parent || p.startsWith(parent + "/") || p.startsWith(parent + "\\");

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

/** JSON with comments and trailing commas (the format of VS Code's settings files). */
export function parseJsonc(text: string): any {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  out = out.replace(/,(\s*[}\]])/g, "$1").trim();
  return out ? JSON.parse(out) : undefined;
}

/** Tiny hyperscript helper: h("div.cls", { onclick }, child, "text"). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}` | `${K}#${string}`,
  props: Record<string, any> | null = null,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split(".");
  const [tagName, id] = name.split("#");
  const el = document.createElement(tagName as K);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && k !== "list") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Subsequence fuzzy match. Returns a score (higher is better) and matched indices, or null. */
export function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const prev = indices[indices.length - 1];
    score += found === prev + 1 ? 5 : 1; // contiguous runs score higher
    if (found === 0 || /[\s\-_./:]/.test(text[found - 1])) score += 3; // word starts
    indices.push(found);
    ti = found + 1;
  }
  return { score: score - text.length * 0.01, indices };
}

export function highlight(text: string, indices: number[]) {
  if (!indices.length) return escapeHtml(text);
  const set = new Set(indices);
  let html = "";
  for (let i = 0; i < text.length; i++) {
    const c = escapeHtml(text[i]);
    html += set.has(i) ? `<b>${c}</b>` : c;
  }
  return html;
}

// Global search & replace across the workspace (ripgrep engine in Rust).
import { api, FileMatches, LineMatch } from "../core/api";
import { fileIcon, icons } from "../core/icons";
import { monaco } from "../core/monaco";
import { settings } from "../core/settings";
import { state } from "../core/state";
import { basename, debounce, dirname, escapeHtml, h, relative } from "../core/util";
import { getDoc, isDirty, reloadFromDisk } from "../workbench/documents";
import { openFile } from "../workbench/groups";
import { confirmDialog, notify } from "../ui/notify";
import { View } from "../ui/sidebar";

let queryInput: HTMLInputElement;
let replaceInput: HTMLInputElement;
let includeInput: HTMLInputElement;
let excludeInput: HTMLInputElement;
let resultsEl: HTMLElement;
let summaryEl: HTMLElement;
let replaceRow: HTMLElement;
let detailsEl: HTMLElement;
const toggles = { caseSensitive: false, wholeWord: false, isRegex: false };
const collapsed = new Set<string>();
let results: FileMatches[] = [];
let seq = 0;

function toggleButton(key: keyof typeof toggles, icon: string, title: string) {
  const btn = h("button", {
    className: `toggle${toggles[key] ? " on" : ""}`,
    html: icon,
    title,
    onclick: () => {
      toggles[key] = !toggles[key];
      btn.classList.toggle("on", toggles[key]);
      void runSearch();
    },
  });
  return btn;
}

export async function runSearch() {
  const query = queryInput?.value ?? "";
  const my = ++seq;
  if (!state.root || !query) {
    results = [];
    summaryEl.textContent = "";
    renderResults();
    if (query === "" && state.root) void api.searchText({ root: state.root, query: "", isRegex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "", maxResults: 1 });
    return;
  }
  summaryEl.textContent = "Searching…";
  results = [];
  renderResults();
  resultsEl.scrollTop = 0;
  const countAll = () => results.reduce((n, f) => n + f.matches.length, 0);
  const label = (total: number) => `${total} result${total === 1 ? "" : "s"} in ${results.length} file${results.length === 1 ? "" : "s"}`;
  // Batches stream in while the search runs; re-render at most once per frame.
  let frame = 0;
  const onBatch = (files: FileMatches[]) => {
    if (my !== seq) return;
    results.push(...files);
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (my !== seq) return;
        summaryEl.textContent = `Searching… ${label(countAll())}`;
        renderResults();
      });
    }
  };
  try {
    const globalExclude = settings.get<string[]>("search.exclude", []).join(",");
    const res = await api.searchText(
      {
        root: state.root,
        query,
        ...toggles,
        include: includeInput.value,
        exclude: [excludeInput.value, globalExclude].filter(Boolean).join(","),
        maxResults: 20000,
        maxFileSizeKb: settings.get<number>("search.max_file_size_kb", 2048),
      },
      onBatch,
    );
    if (my !== seq || res.cancelled) return;
    cancelAnimationFrame(frame);
    frame = 0;
    results.sort((x, y) => x.path.localeCompare(y.path));
    const total = countAll();
    summaryEl.textContent = total ? `${label(total)}${res.truncated ? " (limit reached, refine your search)" : ""}` : "No results found.";
    renderResults();
  } catch (e) {
    if (my !== seq) return;
    summaryEl.textContent = String(e);
    results = [];
    renderResults();
  }
}

// Results are virtualized: the list is a flat array of rows, and only the rows in view
// (plus a small margin) exist in the DOM. 20,000 matches render as fast as 20.
type Row = { kind: "file"; file: FileMatches } | { kind: "match"; file: FileMatches; m: LineMatch };
const ROW_HEIGHT = 22;
let rows: Row[] = [];
let spacer: HTMLElement | null = null;
let windowStart = -1;
let windowEnd = -1;

function renderResults() {
  rows = [];
  for (const file of results) {
    rows.push({ kind: "file", file });
    if (!collapsed.has(file.path)) for (const m of file.matches) rows.push({ kind: "match", file, m });
  }
  spacer ??= h("div.search-spacer");
  spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
  if (spacer.parentElement !== resultsEl) resultsEl.replaceChildren(spacer);
  windowStart = windowEnd = -1;
  renderWindow();
}

function renderWindow() {
  if (!spacer) return;
  const top = resultsEl.scrollTop;
  const height = resultsEl.clientHeight || 600;
  const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - 15);
  const end = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + 15);
  if (start === windowStart && end === windowEnd) return;
  windowStart = start;
  windowEnd = end;
  const replacing = !replaceRow.hidden && !!replaceInput.value;
  const els: HTMLElement[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    let el: HTMLElement;
    if (row.kind === "file") {
      const isCollapsed = collapsed.has(row.file.path);
      el = h(
        "div.search-file",
        { title: row.file.path },
        h("span.twist", { html: isCollapsed ? icons.chevronRight : icons.chevronDown }),
        h("span.row-icon", { html: fileIcon(row.file.path) }),
        h("span.row-label", null, basename(row.file.path)),
        h("span.row-desc", null, relative(state.root, dirname(row.file.path))),
        h("span.count", null, String(row.file.matches.length)),
      );
    } else {
      const { m } = row;
      el = h("div.search-match", {
        title: `${m.line}: ${m.pre}${m.text}${m.post}`.trim(),
        html:
          escapeHtml(m.pre) +
          (replacing ? `<del>${escapeHtml(m.text)}</del><ins>${escapeHtml(previewReplace(m.text))}</ins>` : `<mark>${escapeHtml(m.text)}</mark>`) +
          escapeHtml(m.post),
      });
    }
    el.dataset.row = String(i);
    el.style.top = `${i * ROW_HEIGHT}px`;
    els.push(el);
  }
  spacer.replaceChildren(...els);
}

function onResultClick(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
  const row = el ? rows[Number(el.dataset.row)] : undefined;
  if (!row) return;
  if (row.kind === "file") {
    collapsed.has(row.file.path) ? collapsed.delete(row.file.path) : collapsed.add(row.file.path);
    renderResults();
  } else {
    openMatch(row.file.path, row.m.line, row.m.col, row.m.len, e.detail > 1);
  }
}

function buildRegex(global = true) {
  let src = toggles.isRegex ? queryInput.value : queryInput.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (toggles.wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, `${global ? "g" : ""}${toggles.caseSensitive ? "" : "i"}m`);
}

function previewReplace(match: string) {
  try {
    return match.replace(buildRegex(false), replaceInput.value);
  } catch {
    return replaceInput.value;
  }
}

function openMatch(path: string, line: number, col: number, len: number, pin: boolean) {
  const selection = new monaco.Range(line, col, line, col + len);
  void openFile(path, { preview: !pin, selection, focus: pin });
}

async function replaceAll() {
  if (!results.length || !state.root) return;
  const total = results.reduce((n, f) => n + f.matches.length, 0);
  const ok = await confirmDialog(`Replace ${total} occurrence${total === 1 ? "" : "s"} across ${results.length} file${results.length === 1 ? "" : "s"} with '${replaceInput.value}'?`);
  if (!ok) return;
  let re: RegExp;
  try {
    re = buildRegex();
  } catch (e) {
    return notify(String(e), "error");
  }
  let changed = 0;
  for (const file of results) {
    const doc = getDoc(file.path);
    try {
      if (doc && isDirty(doc)) {
        // Unsaved buffer: replace in the editor (undoable) and leave it for the user to save.
        const model = doc.model;
        const next = model.getValue().replace(re, replaceInput.value);
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
      } else {
        const content = (await api.readFile(file.path)).content;
        await api.writeFile(file.path, content.replace(re, replaceInput.value));
        if (doc) await reloadFromDisk(file.path);
      }
      changed++;
    } catch (e) {
      notify(`${basename(file.path)}: ${e}`, "error");
    }
  }
  notify(`Replaced in ${changed} file${changed === 1 ? "" : "s"}.`);
  void runSearch();
}

const debounced = debounce(() => void runSearch(), 300);

/** Opens the view with an optional initial query/folder, like VS Code's Find in Files. */
export function focusSearch(opts: { query?: string; replace?: boolean; folder?: string } = {}) {
  if (opts.query) queryInput.value = opts.query;
  if (opts.replace) replaceRow.hidden = false;
  if (opts.folder && state.root) {
    includeInput.value = relative(state.root, opts.folder) + "/**";
    detailsEl.hidden = false;
  }
  queryInput.focus();
  queryInput.select();
  if (opts.query || opts.folder) void runSearch();
}

export const searchView: View = {
  id: "search",
  title: "Search",
  icon: icons.search,
  order: 2,
  actions: [
    { icon: icons.refresh, title: "Refresh", run: () => runSearch() },
    {
      icon: icons.collapse,
      title: "Collapse All / Expand All",
      run: () => {
        // Toggle: collapse every file group, or expand them all if they already are.
        const allCollapsed = results.length > 0 && results.every((f) => collapsed.has(f.path));
        if (allCollapsed) collapsed.clear();
        else results.forEach((f) => collapsed.add(f.path));
        renderResults();
      },
    },
  ],
  render(container) {
    queryInput = h("input.input", { placeholder: "Search", spellcheck: false });
    replaceInput = h("input.input", { placeholder: "Replace", spellcheck: false });
    includeInput = h("input.input", { placeholder: "e.g. *.ts, src/**/include", spellcheck: false });
    excludeInput = h("input.input", { placeholder: "e.g. *.test.ts, vendor", spellcheck: false });
    summaryEl = h("div.search-summary");
    resultsEl = h("div.search-results");
    let scheduled = false;
    resultsEl.addEventListener("scroll", () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        renderWindow();
      });
    });
    resultsEl.addEventListener("click", onResultClick);
    new ResizeObserver(() => renderWindow()).observe(resultsEl);
    const expand = h("button.icon-btn.expand-replace", {
      html: icons.chevronRight,
      title: "Toggle Replace",
      onclick: () => {
        replaceRow.hidden = !replaceRow.hidden;
        expand.innerHTML = replaceRow.hidden ? icons.chevronRight : icons.chevronDown;
        renderResults();
      },
    });
    replaceRow = h(
      "div.search-row",
      { hidden: true },
      replaceInput,
      h("button.icon-btn", { html: icons.replaceAll, title: "Replace All", onclick: () => void replaceAll() }),
    );
    detailsEl = h(
      "div.search-details",
      { hidden: true },
      h("label", null, "files to include"),
      includeInput,
      h("label", null, "files to exclude"),
      excludeInput,
    );
    container.append(
      h(
        "div.search-form",
        null,
        h(
          "div.search-main",
          null,
          expand,
          h(
            "div.search-inputs",
            null,
            h(
              "div.search-row",
              null,
              queryInput,
              h(
                "div.search-toggles",
                null,
                toggleButton("caseSensitive", icons.caseSensitive, "Match Case"),
                toggleButton("wholeWord", icons.wholeWord, "Match Whole Word"),
                toggleButton("isRegex", icons.regex, "Use Regular Expression"),
              ),
            ),
            replaceRow,
          ),
        ),
        h("button.icon-btn.details-toggle", {
          html: icons.more,
          title: "Toggle Search Details",
          onclick: () => (detailsEl.hidden = !detailsEl.hidden),
        }),
        detailsEl,
      ),
      summaryEl,
      resultsEl,
    );
    for (const input of [queryInput, includeInput, excludeInput]) {
      input.addEventListener("input", debounced);
      input.addEventListener("keydown", (e) => e.key === "Enter" && void runSearch());
    }
    replaceInput.addEventListener("input", () => renderResults());
  },
};

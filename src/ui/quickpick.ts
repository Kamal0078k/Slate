// The VS Code style quick input used by Quick Open, the Command Palette, Go to Line,
// prompts (new file, rename) and plugin pickers.
import { escapeHtml, fuzzyMatch, h, highlight } from "../core/util";

export interface QuickPickItem {
  label: string;
  description?: string;
  /** Right-aligned hint, e.g. a key binding. */
  detail?: string;
  iconHtml?: string;
  /** Precomputed highlight indices for the label (from a server-side matcher). */
  highlights?: number[];
  [key: string]: any;
}

export interface QuickPickOptions<T extends QuickPickItem> {
  placeholder?: string;
  value?: string;
  /** Static list (fuzzy-filtered here) or a provider called on each keystroke. */
  items: T[] | ((query: string) => T[] | Promise<T[]>);
  /** Fires as the selection moves (e.g. live theme preview). */
  onActive?: (item: T | undefined) => void;
  /** Return a different value to re-route the query (e.g. ">" switches to commands). */
  matchOnDescription?: boolean;
}

let host: HTMLElement | null = null;
let cancelCurrent: (() => void) | null = null;

export const isQuickPickOpen = () => cancelCurrent !== null;

function mount() {
  host ??= document.getElementById("overlay-root")!.appendChild(h("div.quickpick", { hidden: true }));
  return host;
}

export function showQuickPick<T extends QuickPickItem>(opts: QuickPickOptions<T>): Promise<T | undefined> {
  cancelCurrent?.();
  const el = mount();
  el.replaceChildren();
  el.hidden = false;
  const input = h("input.qp-input", { placeholder: opts.placeholder ?? "", spellcheck: false, value: opts.value ?? "" });
  const list = h("ul.qp-list");
  el.append(input, list);

  let items: T[] = [];
  let shown: { item: T; indices: number[] }[] = [];
  let selected = 0;
  let seq = 0;

  return new Promise<T | undefined>((resolve) => {
    let done = false;
    const finish = (value: T | undefined) => {
      if (done) return;
      done = true;
      cancelCurrent = null;
      el.hidden = true;
      el.replaceChildren();
      resolve(value);
    };
    cancelCurrent = () => finish(undefined);

    const render = () => {
      list.replaceChildren(
        ...shown.slice(0, 300).map(({ item, indices }, i) =>
          h(
            "li",
            {
              className: i === selected ? "selected" : "",
              onmousedown: (e: MouseEvent) => e.preventDefault(),
              onclick: () => finish(item),
              onmousemove: () => {
                if (selected !== i) {
                  selected = i;
                  updateSelection();
                }
              },
            },
            item.iconHtml ? h("span.qp-icon", { html: item.iconHtml }) : null,
            h("span.qp-label", { html: highlight(item.label, indices) }),
            item.description ? h("span.qp-desc", { html: escapeHtml(item.description) }) : null,
            item.detail ? h("span.qp-detail", null, item.detail) : null,
          ),
        ),
      );
      if (!shown.length) list.append(h("li.qp-empty", null, "No matching results"));
      opts.onActive?.(shown[selected]?.item);
    };

    const updateSelection = () => {
      [...list.children].forEach((li, i) => li.classList.toggle("selected", i === selected));
      list.children[selected]?.scrollIntoView({ block: "nearest" });
      opts.onActive?.(shown[selected]?.item);
    };

    const filter = (query: string) => {
      if (typeof opts.items === "function") {
        shown = items.map((item) => ({ item, indices: item.highlights ?? fuzzyMatch(query, item.label)?.indices ?? [] }));
        return;
      }
      if (!query) {
        shown = items.map((item) => ({ item, indices: [] }));
        return;
      }
      const scored: { item: T; indices: number[]; score: number }[] = [];
      for (const item of items) {
        const m = fuzzyMatch(query, item.label);
        if (m) scored.push({ item, indices: m.indices, score: m.score });
        else if (opts.matchOnDescription && item.description) {
          const d = fuzzyMatch(query, item.description);
          if (d) scored.push({ item, indices: [], score: d.score - 10 });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      shown = scored;
    };

    const update = async () => {
      const query = input.value;
      const my = ++seq;
      if (typeof opts.items === "function") {
        const result = await opts.items(query);
        if (my !== seq || done) return;
        items = result;
      }
      filter(typeof opts.items === "function" ? "" : query);
      selected = 0;
      render();
    };

    if (Array.isArray(opts.items)) items = opts.items;
    input.addEventListener("input", () => void update());
    input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && finish(undefined), 0));
    input.addEventListener("keydown", (e) => {
      const move = (d: number) => {
        e.preventDefault();
        if (!shown.length) return;
        selected = (selected + d + shown.length) % shown.length;
        updateSelection();
      };
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(1);
      else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(-1);
      else if (e.key === "PageDown") move(10);
      else if (e.key === "PageUp") move(-10);
      else if (e.key === "Enter") {
        e.preventDefault();
        finish(shown[selected]?.item);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(undefined);
      }
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    void update();
  });
}

export interface InputOptions {
  prompt: string;
  value?: string;
  placeholder?: string;
  /** Selects part of the value initially, e.g. the file name without extension. */
  selection?: [number, number];
  validate?: (value: string) => string | null;
}

export function showInput(opts: InputOptions): Promise<string | undefined> {
  cancelCurrent?.();
  const el = mount();
  el.replaceChildren();
  el.hidden = false;
  const input = h("input.qp-input", { placeholder: opts.placeholder ?? "", spellcheck: false, value: opts.value ?? "" });
  const msg = h("div.qp-message", null, opts.prompt);
  el.append(input, msg);

  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      cancelCurrent = null;
      el.hidden = true;
      el.replaceChildren();
      resolve(v);
    };
    cancelCurrent = () => finish(undefined);
    const check = () => {
      const err = opts.validate?.(input.value) ?? null;
      msg.textContent = err ?? opts.prompt;
      msg.classList.toggle("error", !!err);
      return !err;
    };
    input.addEventListener("input", check);
    input.addEventListener("blur", () => finish(undefined));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (check()) finish(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(undefined);
      }
    });
    input.focus();
    const [s, end] = opts.selection ?? [0, input.value.length];
    input.setSelectionRange(s, end);
  });
}

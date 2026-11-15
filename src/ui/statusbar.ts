// Status bar with core items (branch, cursor, indentation, language) and plugin items.
import { executeCommand } from "../core/commands";
import { icons } from "../core/icons";
import { state } from "../core/state";
import { basename, bus, escapeHtml, h } from "../core/util";
import { activeCodeEditor, getActiveGroup } from "../workbench/groups";
import { repoOf } from "../views/scm";
import { monaco } from "../core/monaco";

export interface StatusBarItemOptions {
  align?: "left" | "right";
  /** Higher priority items sit further left. */
  priority?: number;
  command?: string;
  tooltip?: string;
  text?: string;
}

export interface StatusBarItem {
  el: HTMLElement;
  show(text?: string): void;
  hide(): void;
  text: string;
  tooltip: string;
  dispose(): void;
}

const items: { el: HTMLElement; align: "left" | "right"; priority: number }[] = [];

function layout() {
  const bar = document.getElementById("statusbar")!;
  for (const side of ["left", "right"] as const) {
    const els = items
      .filter((i) => i.align === side)
      .sort((a, b) => b.priority - a.priority)
      .map((i) => i.el);
    bar.querySelector(`.${side}`)!.replaceChildren(...els);
  }
}

export function createStatusBarItem(opts: StatusBarItemOptions = {}): StatusBarItem {
  const el = h("div.sb-item", { hidden: !opts.text, title: opts.tooltip ?? "" });
  if (opts.command) {
    el.classList.add("clickable");
    el.addEventListener("click", () => executeCommand(opts.command!));
  }
  el.innerHTML = opts.text ?? "";
  const entry = { el, align: opts.align ?? "left", priority: opts.priority ?? 0 };
  items.push(entry);
  layout();
  return {
    el,
    show(text?: string) {
      if (text !== undefined) el.textContent = text;
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
    get text() {
      return el.textContent ?? "";
    },
    set text(v: string) {
      el.textContent = v;
    },
    get tooltip() {
      return el.title;
    },
    set tooltip(v: string) {
      el.title = v;
    },
    dispose() {
      items.splice(items.indexOf(entry), 1);
      el.remove();
    },
  };
}

export function initStatusBar() {
  const branch = createStatusBarItem({ align: "left", priority: 100, command: "workbench.view.scm", tooltip: "Source Control" });
  const changes = createStatusBarItem({ align: "left", priority: 90, command: "workbench.view.scm" });
  const cursor = createStatusBarItem({ align: "right", priority: 100, command: "workbench.action.gotoLine", tooltip: "Go to Line" });
  const indent = createStatusBarItem({ align: "right", priority: 90, command: "editor.action.changeIndentation", tooltip: "Select Indentation" });
  const eol = createStatusBarItem({ align: "right", priority: 70, command: "editor.action.changeEOL", tooltip: "Select End of Line Sequence" });
  const lang = createStatusBarItem({ align: "right", priority: 60, command: "editor.action.changeLanguageMode", tooltip: "Select Language Mode" });

  // With several repositories, show the one holding the active file.
  const updateGit = () => {
    if (!state.git) {
      branch.hide();
      changes.hide();
      return;
    }
    const repos = state.gitRepos;
    const path = getActiveGroup()?.activeDoc()?.path ?? "";
    const repo = repos.length === 1 ? repos[0] : repoOf(path);
    const label = repo ? (repos.length > 1 ? `${basename(repo.root)}: ${repo.branch}` : repo.branch) : `${repos.length} repositories`;
    branch.el.innerHTML = `${icons.branch}<span>${escapeHtml(label)}</span>`;
    branch.show();
    const n = repo ? repo.files.length : state.git.files.length;
    n ? changes.show(`${n} change${n === 1 ? "" : "s"}`) : changes.hide();
  };
  bus.on("git", updateGit);
  bus.on("active-editor", updateGit);

  const updateEditor = () => {
    const ed = activeCodeEditor();
    const model = ed?.getModel();
    if (!ed || !model) {
      for (const i of [cursor, indent, eol, lang]) i.hide();
      return;
    }
    const pos = ed.getPosition();
    const sel = ed.getSelection();
    let text = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : "";
    if (sel && !sel.isEmpty()) text += ` (${model.getValueLengthInRange(sel)} selected)`;
    cursor.show(text);
    const o = model.getOptions();
    indent.show(o.insertSpaces ? `Spaces: ${o.indentSize}` : `Tab Size: ${o.tabSize}`);
    eol.show(model.getEOL() === "\n" ? "LF" : "CRLF");
    lang.show(languageName(model.getLanguageId()));
  };
  bus.on("active-editor", updateEditor);
  bus.on("cursor", updateEditor);
  bus.on("settings", updateEditor);
  bus.on("language-changed", updateEditor);
}

export function languageName(id: string) {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  return lang?.aliases?.[0] ?? id;
}

// ---- [ui] status_right items (herdr's tab_bar_right) ------------------------------------

import { api } from "../core/api";
import { settings } from "../core/settings";

interface StatusSpec {
  type: "text" | "datetime" | "command";
  text?: string;
  format?: string;
  command?: string;
  interval_seconds?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function strftime(format: string, d = new Date()) {
  return format.replace(/%([HMSYmdabIp%])/g, (_, c: string) => {
    switch (c) {
      case "H": return pad(d.getHours());
      case "M": return pad(d.getMinutes());
      case "S": return pad(d.getSeconds());
      case "Y": return String(d.getFullYear());
      case "m": return pad(d.getMonth() + 1);
      case "d": return pad(d.getDate());
      case "a": return DAYS[d.getDay()];
      case "b": return MONTHS[d.getMonth()];
      case "I": return pad(d.getHours() % 12 || 12);
      case "p": return d.getHours() < 12 ? "AM" : "PM";
      default: return "%";
    }
  });
}

let statusItems: StatusBarItem[] = [];
let statusTimers: number[] = [];
let lastSpec = "";

function applyStatusRight() {
  const specs = settings.get<StatusSpec[]>("ui.status_right", []) ?? [];
  const key = JSON.stringify(specs);
  if (key === lastSpec) return;
  lastSpec = key;
  statusItems.forEach((i) => i.dispose());
  statusTimers.forEach((t) => clearInterval(t));
  statusItems = [];
  statusTimers = [];
  specs.forEach((spec, i) => {
    const item = createStatusBarItem({ align: "right", priority: 150 - i, tooltip: spec.command ?? "" });
    statusItems.push(item);
    if (spec.type === "text") item.show(spec.text ?? "");
    else if (spec.type === "datetime") {
      const format = spec.format ?? "%H:%M";
      const tick = () => item.show(strftime(format));
      tick();
      statusTimers.push(window.setInterval(tick, format.includes("%S") ? 1000 : 10000));
    } else if (spec.type === "command" && spec.command) {
      const shell = navigator.userAgent.includes("Windows") ? ["cmd.exe", "/d", "/c", spec.command] : ["/bin/sh", "-c", spec.command];
      let running = false;
      const run = async () => {
        if (running) return;
        running = true;
        try {
          const r = await api.exec(shell, state.root ?? undefined);
          const line = (r.stdout.trim().split("\n")[0] ?? "").slice(0, 80);
          line ? item.show(line) : item.hide();
        } catch {
          item.hide();
        } finally {
          running = false;
        }
      };
      void run();
      statusTimers.push(window.setInterval(run, Math.max(1, spec.interval_seconds ?? 10) * 1000));
    }
  });
}

bus.on("settings", applyStatusRight);
bus.on("workspace", () => {
  lastSpec = ""; // command items depend on the folder
  applyStatusRight();
});

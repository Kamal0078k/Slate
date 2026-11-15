// Dev-only smoke test, run with SLATE_SELFTEST=1. Exercises the main features against the
// open folder and logs PASS/FAIL lines to the terminal.
import { api, FileMatches } from "./core/api";
import { allCommands, executeCommand } from "./core/commands";
import { normalizeKey } from "./core/keybindings";
import { settings } from "./core/settings";
import { state } from "./core/state";
import { join } from "./core/util";
import { refreshGit } from "./views/scm";
import { allGroups, getActiveGroup, openFile } from "./workbench/groups";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a streaming search and collects every batch. */
async function searchAll(opts: Parameters<typeof api.searchText>[0]) {
  const files: FileMatches[] = [];
  await api.searchText(opts, (batch) => files.push(...batch));
  return { files };
}

export async function runSelfTest() {
  const results: string[] = [];
  const check = async (name: string, fn: () => Promise<boolean | string> | boolean | string) => {
    try {
      const r = await fn();
      results.push(r === true ? `PASS ${name}` : `FAIL ${name}${typeof r === "string" ? `: ${r}` : ""}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  const root = state.root!;
  const main = join(root, "src/main.rs");

  await check("quick open finds src/main.rs", async () => (await api.findFiles(root, "mainrs")).includes("src/main.rs"));
  await check("open file", async () => {
    await openFile(main);
    return getActiveGroup().activeDoc()?.model.getValue().includes("slate") ?? "no doc";
  });
  await check("git gutter markers", async () => {
    await wait(600);
    const n = document.querySelectorAll(".dd-added, .dd-modified, .dd-deleted").length;
    return n > 0 || `found ${n}`;
  });
  await check("global search", async () => {
    const r = await searchAll({ root, query: "let", isRegex: false, caseSensitive: false, wholeWord: true, include: "", exclude: "", maxResults: 100 });
    const m = r.files.find((f) => f.path === main)?.matches.length;
    return m === 3 || `got ${m}`;
  });
  await check("regex search + include glob", async () => {
    const r = await searchAll({ root, query: "ad+", isRegex: true, caseSensitive: true, wholeWord: false, include: "*.js", exclude: "", maxResults: 100 });
    return (r.files.length === 1 && r.files[0].path.endsWith("util.js")) || JSON.stringify(r.files.map((f) => f.path));
  });
  await check("search view UI", async () => {
    await executeCommand("workbench.action.findInFiles");
    const input = document.querySelector<HTMLInputElement>(".search-row .input")!;
    input.value = "println";
    input.dispatchEvent(new Event("input"));
    await wait(700);
    return document.querySelectorAll(".search-match").length === 1 || `rows ${document.querySelectorAll(".search-match").length}`;
  });
  await check("diff editor (working tree)", async () => {
    await getActiveGroup().openDiff(main, false);
    await wait(800);
    const changes = getActiveGroup().diff?.getLineChanges()?.length ?? 0;
    return changes > 0 || `changes ${changes}`;
  });
  // Relative counts: the folder may restore a saved layout with several panes.
  const panesBefore = allGroups().length;
  await check("split editor", async () => {
    await executeCommand("workbench.action.splitEditor");
    return allGroups().length === panesBefore + 1 || `groups ${allGroups().length} (was ${panesBefore})`;
  });
  await check("close group via close editor", async () => {
    await executeCommand("workbench.action.closeActiveEditor");
    return allGroups().length === panesBefore || `groups ${allGroups().length} (was ${panesBefore})`;
  });
  await check("stage + unstage", async () => {
    await executeCommand("workbench.view.scm");
    await api.gitStage(state.git!.root, [main]);
    await refreshGit();
    const staged = state.git!.files.some((f) => f.path === main && f.staged);
    const rows = document.querySelectorAll(".scm-row").length;
    await api.gitUnstage(state.git!.root, [main]);
    await refreshGit();
    const unstaged = state.git!.files.some((f) => f.path === main && !f.staged && !state.git!.files.some((g) => g.path === main && g.staged));
    return (staged && unstaged && rows >= 2) || `staged=${staged} unstaged=${unstaged} rows=${rows}`;
  });
  await check("edit + save writes to disk", async () => {
    const util = join(root, "src/util.js");
    await openFile(util);
    const model = getActiveGroup().activeDoc()!.model;
    model.setValue(model.getValue() + "export const sub = (a, b) => a - b;\n");
    const dirty = document.querySelector(".tab.active.dirty") !== null;
    await executeCommand("workbench.action.files.save");
    const disk = (await api.readFile(util)).content;
    const clean = document.querySelector(".tab.active.dirty") === null;
    return (dirty && clean && disk.includes("sub")) || `dirty=${dirty} clean=${clean}`;
  });
  await check("external change reloads open file", async () => {
    const util = join(root, "src/util.js");
    await api.writeFile(util, "// changed outside\n");
    await wait(1500);
    return getActiveGroup().activeDoc()?.model.getValue() === "// changed outside\n" || "not reloaded";
  });
  await check("command palette has commands", () => allCommands().length > 50 || `only ${allCommands().length}`);
  await check("config defaults loaded", () => settings.get("keys.quick_open") === "mod+p" && settings.get("theme.name") !== undefined);
  await check("keybinding normalization", () => normalizeKey("Cmd+Shift+P") === "shift+meta+p");

  for (const r of results) console.log(`selftest ${r}`);
  console.log(`selftest done: ${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
}

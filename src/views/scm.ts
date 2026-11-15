// Source Control view: staged/unstaged changes, diff on click, stage/unstage/discard, commit.
// When the open folder is not a repository itself (a folder of projects), every repository
// inside it gets its own section with its own commit box, like VS Code's multi-repo view.
import { api, GitFile, GitStatus } from "../core/api";
import { settings } from "../core/settings";
import { fileIcon, icons } from "../core/icons";
import { state } from "../core/state";
import { basename, bus, dirname, h, isMac, relative } from "../core/util";
import { getActiveGroup, openFile } from "../workbench/groups";
import { reloadFromDisk } from "../workbench/documents";
import { confirmDialog, contextMenu, notify } from "../ui/notify";
import { updateBadges, View } from "../ui/sidebar";

let listEl: HTMLElement;
let messageEl: HTMLTextAreaElement;
let commitBtn: HTMLButtonElement;
let formEl: HTMLElement;
/** Per-repo commit boxes (kept across re-renders so typing isn't lost). */
const repoInputs = new Map<string, HTMLTextAreaElement>();
const collapsed = new Set<string>();
const expandedByUser = new Set<string>();
/** Collapsed "Staged Changes" / "Changes" lists, keyed by repo root + title. */
const collapsedLists = new Set<string>();
let refreshing: Promise<void> | null = null;
let again = false;

/** Re-reads git status (coalesces bursts of calls from the file watcher). */
export async function refreshGit() {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      try {
        const exclude = settings.get<string[]>("search.exclude", []).filter((e) => !e.includes("*"));
        state.gitRepos = state.root ? await api.gitRepositories(state.root, exclude) : [];
      } catch {
        state.gitRepos = [];
      }
      // One combined view for the rest of the app (explorer colors, gutter markers, badges).
      const repos = state.gitRepos;
      state.git = !repos.length
        ? null
        : repos.length === 1
          ? repos[0]
          : { branch: `${repos.length} repositories`, root: state.root!, files: repos.flatMap((r) => r.files) };
    } while (again);
    bus.emit("git", state.git);
  })().finally(() => (refreshing = null));
  return refreshing;
}

const STATUS_TITLES: Record<string, string> = {
  M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Untracked", C: "Conflict",
};

async function run(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (e) {
    notify(String(e), "error");
  }
  await refreshGit();
}

const gitRoot = () => state.git?.root ?? state.root!;

/** The repository that contains `path` (deepest match). */
export function repoOf(path: string): GitStatus | undefined {
  return state.gitRepos
    .filter((r) => path === r.root || path.startsWith(r.root + "/") || path.startsWith(r.root + "\\"))
    .sort((a, b) => b.root.length - a.root.length)[0];
}

export const stage = (paths: string[]) => run(() => api.gitStage(gitRoot(), paths));
export const unstage = (paths: string[]) => run(() => api.gitUnstage(gitRoot(), paths));

export async function discard(files: GitFile[]) {
  if (!files.length) return;
  const untracked = files.filter((f) => f.status === "U").length;
  const what = files.length === 1 ? `'${basename(files[0].path)}'` : `${files.length} files`;
  const ok = await confirmDialog(
    `Are you sure you want to discard changes in ${what}?\n\n${untracked ? "Untracked files will be moved to the Trash. " : ""}This cannot be undone.`,
  );
  if (!ok) return;
  await run(() => api.gitDiscard(gitRoot(), files.map((f) => f.path)));
  for (const f of files) await reloadFromDisk(f.path);
}

/**
 * Commits one repository. Without `repo`: the only one, or the one holding the active file.
 */
export async function commit(repo?: GitStatus) {
  const repos = state.gitRepos;
  repo ??= repos.length === 1 ? repos[0] : repoOf(getActiveGroup()?.activeDoc()?.path ?? "");
  if (!repo) {
    notify("Several repositories here: use the commit box in the repository's section.", "warning");
    return;
  }
  const input = repos.length === 1 ? messageEl : repoInputs.get(repo.root);
  const message = input?.value.trim();
  if (!message) {
    notify("Type a commit message first.", "warning");
    input?.focus();
    return;
  }
  const name = basename(repo.root);
  if (!repo.files.some((f) => f.staged)) {
    // VS Code's "smart commit": nothing staged means commit all changes.
    const ok = await confirmDialog(`There are no staged changes to commit in ${name}.\n\nWould you like to stage all your changes and commit them directly?`);
    if (!ok) return;
    await api.gitStage(repo.root, repo.files.map((f) => f.path));
  }
  try {
    const oid = await api.gitCommit(repo.root, message);
    if (input) input.value = "";
    notify(`Committed ${oid.slice(0, 7)} in ${name}`);
  } catch (e) {
    notify(String(e), "error");
  }
  await refreshGit();
}

function openChange(f: GitFile, pin: boolean) {
  // Untracked files: VS Code shows the file itself, not a diff against nothing.
  if (f.status === "U") return void openFile(f.path, { preview: !pin });
  void getActiveGroup().openDiff(f.path, f.staged, { preview: !pin });
}

function fileRow(f: GitFile) {
  const actions = f.staged
    ? [{ icon: icons.minus, title: "Unstage Changes", run: () => unstage([f.path]) }]
    : [
        { icon: icons.discard, title: "Discard Changes", run: () => discard([f]) },
        { icon: icons.plus, title: "Stage Changes", run: () => stage([f.path]) },
      ];
  return h(
    "div",
    {
      className: `row scm-row git-${f.status}`,
      title: `${relative(state.root, f.path)} • ${STATUS_TITLES[f.status] ?? f.status}`,
      onclick: (e: MouseEvent) => openChange(f, e.detail > 1),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: "Open Changes", action: () => openChange(f, true) },
          { label: "Open File", disabled: f.status === "D", action: () => openFile(f.path) },
          { separator: true },
          f.staged
            ? { label: "Unstage Changes", action: () => unstage([f.path]) }
            : { label: "Stage Changes", action: () => stage([f.path]) },
          ...(f.staged ? [] : [{ label: "Discard Changes", action: () => discard([f]) }]),
          { separator: true },
          { label: "Reveal in Explorer", action: () => bus.emit("reveal", f.path) },
        ]);
      },
    },
    h("span.row-icon", { html: fileIcon(f.path) }),
    h("span.row-label", { style: f.status === "D" ? { textDecoration: "line-through" } : null }, basename(f.path)),
    h("span.row-desc", null, relative(repoOf(f.path)?.root ?? state.root, dirname(f.path)).replace(/^\.$/, "")),
    h(
      "span.row-actions",
      null,
      h("button.icon-btn", {
        html: icons.openFile,
        title: "Open File",
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          void openFile(f.path);
        },
      }),
      ...actions.map((a) =>
        h("button.icon-btn", {
          html: a.icon,
          title: a.title,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            void a.run();
          },
        }),
      ),
    ),
    h("span.git-badge", null, f.status),
  );
}

function section(title: string, files: GitFile[], actions: { icon: string; title: string; run: () => unknown }[], repoRoot = "") {
  const key = `${repoRoot}|${title}`;
  const isCollapsed = collapsedLists.has(key);
  return [
    h(
      "div.scm-section",
      {
        onclick: () => {
          isCollapsed ? collapsedLists.delete(key) : collapsedLists.add(key);
          render();
        },
      },
      h("span.twist", { html: isCollapsed ? icons.chevronRight : icons.chevronDown }),
      h("span.scm-section-title", null, title),
      h(
        "span.row-actions",
        null,
        ...actions.map((a) =>
          h("button.icon-btn", {
            html: a.icon,
            title: a.title,
            onclick: (e: MouseEvent) => {
              e.stopPropagation(); // the button, not the collapse toggle
              void a.run();
            },
          }),
        ),
      ),
      h("span.count", null, String(files.length)),
    ),
    ...(isCollapsed ? [] : files.map(fileRow)),
  ];
}

/** Collapses every repository and list, or expands them all if everything is collapsed. */
function toggleCollapseAll() {
  const repos = state.gitRepos;
  const keys = repos.flatMap((r) => [`${repos.length === 1 ? "" : r.root}|Staged Changes`, `${repos.length === 1 ? "" : r.root}|Changes`]);
  const everythingCollapsed =
    repos.length > 1 ? repos.every((r) => collapsed.has(r.root) || (!r.files.length && !expandedByUser.has(r.root))) : keys.every((k) => collapsedLists.has(k));
  if (everythingCollapsed) {
    collapsed.clear();
    collapsedLists.clear();
    for (const r of repos) expandedByUser.add(r.root);
  } else if (repos.length > 1) {
    for (const r of repos) {
      collapsed.add(r.root);
      expandedByUser.delete(r.root);
    }
  } else {
    keys.forEach((k) => collapsedLists.add(k));
  }
  render();
}

function changeSections(files: GitFile[], repoRoot = "") {
  const staged = files.filter((f) => f.staged);
  const changes = files.filter((f) => !f.staged);
  return [
    ...(staged.length
      ? section("Staged Changes", staged, [{ icon: icons.minus, title: "Unstage All Changes", run: () => unstage(staged.map((f) => f.path)) }], repoRoot)
      : []),
    ...section(
      "Changes",
      changes,
      [
        { icon: icons.discard, title: "Discard All Changes", run: () => discard(changes) },
        { icon: icons.plus, title: "Stage All Changes", run: () => stage(changes.map((f) => f.path)) },
      ],
      repoRoot,
    ),
  ];
}

function commitBox(repo: GitStatus) {
  let input = repoInputs.get(repo.root);
  if (!input) {
    input = h("textarea.input.commit-input", { rows: 1, spellcheck: true });
    const el = input;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void commit(state.gitRepos.find((r) => r.root === repo.root));
      }
    });
    el.addEventListener("input", () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
    repoInputs.set(repo.root, el);
  }
  input.placeholder = `Message (${isMac ? "⌘" : "Ctrl+"}Enter to commit on "${repo.branch}")`;
  return h(
    "div.scm-form.scm-repo-form",
    null,
    input,
    h("button.btn.commit-btn", { onclick: () => commit(state.gitRepos.find((r) => r.root === repo.root)) }, h("span", { html: icons.check }), " Commit"),
  );
}

function repoSection(repo: GitStatus) {
  // Repositories without changes start collapsed, like VS Code.
  const isCollapsed = collapsed.has(repo.root) || (!repo.files.length && !expandedByUser.has(repo.root));
  const header = h(
    "div.scm-repo",
    {
      title: repo.root,
      onclick: () => {
        if (isCollapsed) {
          collapsed.delete(repo.root);
          expandedByUser.add(repo.root);
        } else {
          collapsed.add(repo.root);
          expandedByUser.delete(repo.root);
        }
        render();
      },
    },
    h("span.twist", { html: isCollapsed ? icons.chevronRight : icons.chevronDown }),
    h("span.scm-repo-name", null, relative(state.root, repo.root)),
    h("span.scm-repo-branch", { html: `${icons.branch}${repo.branch}` }),
    repo.files.length ? h("span.count", null, String(repo.files.length)) : null,
  );
  return isCollapsed ? [header] : [header, commitBox(repo), ...changeSections(repo.files, repo.root)];
}

function render() {
  if (!listEl) return;
  const repos = state.gitRepos;
  const single = repos.length === 1;
  formEl.hidden = !single;
  commitBtn.disabled = !single;
  messageEl.disabled = !single;
  if (!state.root || !repos.length) {
    listEl.replaceChildren(
      h(
        "div.empty-view",
        null,
        h("p", null, state.root ? "No git repositories in this folder or the folders inside it." : "Open a folder to see source control."),
      ),
    );
    return;
  }
  if (single) {
    messageEl.placeholder = `Message (${isMac ? "⌘" : "Ctrl+"}Enter to commit on "${repos[0].branch}")`;
    listEl.replaceChildren(...changeSections(repos[0].files));
    return;
  }
  // Several repositories: changed ones first, then the rest, each with its own commit box.
  const ordered = [...repos.filter((r) => r.files.length), ...repos.filter((r) => !r.files.length)];
  listEl.replaceChildren(...ordered.flatMap(repoSection));
}

export const scmView: View = {
  id: "scm",
  title: "Source Control",
  icon: icons.git,
  order: 3,
  actions: [
    { icon: icons.check, title: "Commit", run: () => commit() },
    { icon: icons.refresh, title: "Refresh", run: () => refreshGit() },
    { icon: icons.collapse, title: "Collapse All / Expand All", run: toggleCollapseAll },
  ],
  render(container) {
    messageEl = h("textarea.input.commit-input", { rows: 1, placeholder: "Message", spellcheck: true });
    messageEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void commit();
      }
    });
    messageEl.addEventListener("input", () => {
      messageEl.style.height = "auto";
      messageEl.style.height = `${Math.min(messageEl.scrollHeight, 200)}px`;
    });
    commitBtn = h("button.btn.commit-btn", { onclick: () => commit() }, h("span", { html: icons.check }), " Commit");
    listEl = h("div.scm-list");
    formEl = h("div.scm-form", null, messageEl, commitBtn);
    container.append(formEl, listEl);
    render();
  },
  onShow: () => void refreshGit(),
  badge: () => (state.git?.files.length ? String(state.git.files.length) : ""),
};

bus.on("git", () => {
  render();
  updateBadges();
});

// Typed wrappers around the Rust commands (src-tauri/src/*.rs).
import { Channel, invoke } from "@tauri-apps/api/core";

export interface DirEntry { name: string; path: string; isDir: boolean }
export interface FileContent { content: string; binary: boolean; tooLarge: boolean }
export interface ExecResult { code: number | null; stdout: string; stderr: string }
export interface GitFile { path: string; status: string; staged: boolean }
export interface GitStatus { branch: string; root: string; files: GitFile[] }
export interface LineMatch { line: number; col: number; len: number; pre: string; text: string; post: string }
export interface FileMatches { path: string; matches: LineMatch[] }
export interface SearchOptions {
  root: string;
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  maxResults: number;
  maxFileSizeKb?: number;
}
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  dir: string;
  dataDir: string;
  source: string;
}
export interface LoadedConfig {
  dir: string;
  path: string;
  exists: boolean;
  config: Record<string, any>;
  diagnostics: string[];
  style: string | null;
  plugins: PluginInfo[];
  themes: Record<string, import("./themes").ThemeFile>;
  layouts: string[];
  tree: import("../ui/sidebar").LayoutNode | null;
  widgets: string[];
}

export const api = {
  openWorkspace: (path: string) => invoke<string>("open_workspace", { path }),
  initialFolder: () => invoke<string | null>("initial_folder"),
  readDir: (path: string) => invoke<DirEntry[]>("read_dir", { path }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  createFile: (path: string) => invoke<void>("create_file", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  deletePath: (path: string) => invoke<void>("delete_path", { path }),
  exec: (argv: string[], cwd?: string, env?: Record<string, string>) =>
    invoke<ExecResult>("exec", { argv, cwd: cwd ?? null, env: env ?? null }),

  findFiles: (root: string, query: string, limit = 80, exclude = "") =>
    invoke<string[]>("find_files", { root, query, limit, exclude }),
  invalidateIndex: () => invoke<void>("invalidate_index"),
  /** Results arrive in batches through `onBatch` while the search runs. */
  searchText: (options: SearchOptions, onBatch: (files: FileMatches[]) => void = () => {}) => {
    const channel = new Channel<FileMatches[]>();
    channel.onmessage = onBatch;
    return invoke<{ truncated: boolean; cancelled: boolean }>("search_text", { options, onBatch: channel });
  },

  gitStatus: (root: string) => invoke<GitStatus | null>("git_status", { root }),
  gitRepositories: (root: string, exclude: string[]) => invoke<GitStatus[]>("git_repositories", { root, exclude }),
  gitFileContent: (root: string, path: string, source: "HEAD" | "INDEX") =>
    invoke<string>("git_file_content", { root, path, source }),
  gitStage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  gitDiscard: (root: string, paths: string[]) => invoke<void>("git_discard", { root, paths }),
  gitCommit: (root: string, message: string) => invoke<string>("git_commit", { root, message }),

  loadConfig: (withPlugins: boolean) => invoke<LoadedConfig>("load_config", { withPlugins }),
  defaultConfig: () => invoke<string>("default_config"),
  ensureConfigFile: () => invoke<string>("ensure_config_file"),
  configSet: (key: string[], value: string | number | boolean) => invoke<void>("config_set", { key, value }),
  watchConfig: () => invoke<void>("watch_config"),
  listImages: (source: string) => invoke<string[]>("list_images", { source }),
  watchWorkspace: (root: string) => invoke<void>("watch_workspace", { root }),
};

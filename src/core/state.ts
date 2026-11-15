// Global mutable app state shared by the workbench modules.
import type { GitStatus } from "./api";

export const state = {
  /** Absolute path of the open folder, or null. */
  root: null as string | null,
  /** Folder that holds settings.json, keybindings.json, plugins/. */
  configDir: "",
  /** Combined status of every repository shown (see gitRepos). */
  git: null as GitStatus | null,
  /** Each repository: the folder's own, or every repository inside a folder of projects. */
  gitRepos: [] as GitStatus[],
  /** A background image is showing, so editor surfaces are see-through. */
  backdrop: false,
  /** The layout puts the editor over an image (a node background). */
  layoutBackdrop: false,
};

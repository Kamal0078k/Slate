// Window background image, modeled on the WezTerm "backdrops" setup: an image from a folder,
// the theme color laid over it at `overlay_opacity`, and commands to go random / next /
// previous / pick one / toggle focus mode (no image). Configured in [ui.background].
import { invoke } from "@tauri-apps/api/core";
import { api } from "../core/api";
import { registerCommand } from "../core/commands";
import { applySettings, settings } from "../core/settings";
import { state } from "../core/state";
import { basename, bus } from "../core/util";
import { notify } from "./notify";
import { showQuickPick } from "./quickpick";

interface BackgroundConfig {
  source: string;
  pick: "random" | "first" | "last";
  overlay_opacity: number;
  size: "cover" | "contain";
  area: "window" | "editor";
  focus_mode: boolean;
}

let images: string[] = [];
let index = -1;
let focus = false;
let loadedSource: string | null = null;
let currentUrl: string | null = null;
let layer: HTMLElement;
let overlay: HTMLElement;

const cfg = () => settings.get<BackgroundConfig>("ui.background", {} as BackgroundConfig) ?? ({} as BackgroundConfig);
const LAST_KEY = "sumi.background.last";

async function show(i: number) {
  if (!images.length) return clear();
  index = ((i % images.length) + images.length) % images.length;
  const path = images[index];
  try {
    const bytes = await invoke<ArrayBuffer>("read_image", { path });
    if (images[index] !== path) return; // a newer pick won
    // SVGs only render from a blob with the right type.
    const type = path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "";
    const url = URL.createObjectURL(new Blob([bytes], type ? { type } : undefined));
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = url;
    layer.style.backgroundImage = `url("${url}")`;
    try {
      localStorage.setItem(LAST_KEY, path);
    } catch {
      /* ignore */
    }
  } catch (e) {
    notify(`Background ${basename(path)}: ${e}`, "error");
  }
  update();
}

function clear() {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  layer.style.backgroundImage = "";
  update();
}

/** Applies overlay/size and tells the theme whether surfaces should be see-through. */
function update() {
  const c = cfg();
  const active = !!currentUrl && !focus;
  const editorOnly = c.area === "editor";
  const host = editorOnly ? document.getElementById("editor-area")! : document.body;
  if (layer.parentElement !== host) host.prepend(layer, overlay);
  document.documentElement.classList.toggle("backdrop-window", active && !editorOnly);
  document.documentElement.classList.toggle("backdrop-editor", active && editorOnly);
  document.documentElement.style.setProperty("--backdrop-overlay", String(Math.min(1, Math.max(0, c.overlay_opacity ?? 0.96))));
  layer.hidden = overlay.hidden = !active;
  layer.style.backgroundSize = c.size === "contain" ? "contain" : "cover";
  overlay.style.opacity = String(Math.min(1, Math.max(0, c.overlay_opacity ?? 0.96)));
  document.documentElement.classList.toggle("has-backdrop", active);
  if (state.backdrop !== active) {
    state.backdrop = active;
    applySettings(); // switch the editor theme to its transparent variant
  }
}

async function loadSource() {
  const c = cfg();
  const source = (c.source ?? "").trim();
  if (source === loadedSource) return update();
  loadedSource = source;
  focus = !!c.focus_mode;
  if (!source) {
    images = [];
    return clear();
  }
  try {
    images = await api.listImages(source);
  } catch (e) {
    images = [];
    notify(`[ui.background] source: ${e}`, "warning");
    return clear();
  }
  if (!images.length) {
    notify(`[ui.background] no images found in ${source}`, "warning");
    return clear();
  }
  let start = 0;
  if (c.pick === "random") start = Math.floor(Math.random() * images.length);
  else if (c.pick === "last") {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_KEY);
    } catch {
      /* ignore */
    }
    start = Math.max(0, images.indexOf(last ?? ""));
  }
  await show(start);
}

function requireImages() {
  if (images.length) return true;
  notify('Set [ui.background] source = "~/path/to/images" in config.toml first.', "warning");
  return false;
}

export function initBackdrop() {
  layer = document.getElementById("backdrop")!;
  overlay = document.getElementById("backdrop-overlay")!;
  registerCommand("background.random", "Background: Random Image", () => {
    if (!requireImages()) return;
    let next = Math.floor(Math.random() * images.length);
    if (images.length > 1 && next === index) next = (next + 1) % images.length;
    focus = false;
    return show(next);
  });
  registerCommand("background.next", "Background: Next Image", () => {
    if (!requireImages()) return;
    focus = false;
    return show(index + 1);
  });
  registerCommand("background.previous", "Background: Previous Image", () => {
    if (!requireImages()) return;
    focus = false;
    return show(index - 1);
  });
  registerCommand("background.select", "Background: Select Image...", async () => {
    if (!requireImages()) return;
    const before = index;
    const pick = await showQuickPick({
      placeholder: "Select Background (Up/Down to preview)",
      items: images.map((path, i) => ({ label: basename(path), description: i === index ? "current" : "", i })),
      onActive: (item) => item && item.i !== index && void show(item.i),
    });
    focus = false;
    await show(pick ? pick.i : before);
  });
  registerCommand("background.toggleFocus", "Background: Toggle Focus Mode (hide image)", () => {
    focus = !focus;
    update();
  });
  bus.on("settings", () => void loadSource());
  void loadSource();
}

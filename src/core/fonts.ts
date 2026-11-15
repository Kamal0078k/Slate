// Fonts. Like the herdr app, Sumi ships JetBrains Mono, Geist and Geist Mono (all OFL), so
// layouts and settings can use them on any machine. Fonts in ~/.config/sumi/fonts/ (and a
// widget's own fonts/ folder) load too; the file name is the family name:
// "Pixel Operator.ttf", or "Pixel Operator-Bold.ttf" for extra weights.
import { invoke } from "@tauri-apps/api/core";
import geist from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import geistItalic from "@fontsource-variable/geist/files/geist-latin-wght-italic.woff2?url";
import geistMono from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url";
import geistMonoItalic from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-italic.woff2?url";
import jetbrains from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import jetbrainsItalic from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-italic.woff2?url";
import { monaco } from "./monaco";

/** Fallbacks appended to any configured font, so a missing font never turns into serif. */
export const UI_FALLBACK = `"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
export const MONO_FALLBACK = `"JetBrains Mono", Menlo, Consolas, monospace`;

export function withFallback(family: string | undefined, fallback: string) {
  const f = (family ?? "").trim().replace(/,\s*$/, "");
  if (!f) return fallback;
  return /\b(monospace|sans-serif|serif)\s*$/.test(f) ? f : `${f}, ${fallback}`;
}

const BUNDLED: [string, string, string][] = [
  ["Geist", geist, "normal"],
  ["Geist", geistItalic, "italic"],
  ["Geist Mono", geistMono, "normal"],
  ["Geist Mono", geistMonoItalic, "italic"],
  ["JetBrains Mono", jetbrains, "normal"],
  ["JetBrains Mono", jetbrainsItalic, "italic"],
];

const loaded = new Set<string>();

async function add(family: string, source: string | ArrayBuffer, style = "normal", weight = "100 900") {
  const key = `${family}|${style}|${weight}|${typeof source === "string" ? source : source.byteLength}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  const face = new FontFace(family, typeof source === "string" ? `url(${source})` : source, { style, weight });
  document.fonts.add(await face.load());
}

const WEIGHTS: Record<string, string> = {
  thin: "100", extralight: "200", light: "300", regular: "400", medium: "500",
  semibold: "600", bold: "700", extrabold: "800", black: "900",
};

/** Loads bundled fonts, then the user's fonts; re-measures Monaco when done. */
export async function loadFonts() {
  await Promise.all(BUNDLED.map(([f, url, style]) => add(f, url, style).catch(() => undefined)));
  try {
    const files = await invoke<string[]>("list_fonts");
    await Promise.all(
      files.map(async (path) => {
        const stem = path.split(/[\\/]/).pop()!.replace(/\.(ttf|otf|woff2?)$/i, "");
        // "Family-BoldItalic" -> family "Family", weight 700, italic. No known suffix: whole name.
        const dash = stem.lastIndexOf("-");
        const suffix = dash > 0 ? stem.slice(dash + 1).toLowerCase() : "";
        const italic = suffix.endsWith("italic");
        const weightWord = suffix.replace("italic", "") || (italic ? "regular" : "");
        const known = !!suffix && (italic || weightWord in WEIGHTS);
        const family = known ? stem.slice(0, dash) : stem;
        const weight = known ? (WEIGHTS[weightWord] ?? "400") : "100 900";
        const bytes = await invoke<ArrayBuffer>("read_image", { path });
        await add(family, bytes, italic ? "italic" : "normal", weight);
      }),
    );
  } catch (e) {
    console.warn("user fonts", e);
  }
  monaco.editor.remeasureFonts();
}

const BUNDLED_FAMILIES = new Set(["geist", "geist mono", "jetbrains mono"]);
const GENERIC = new Set(["monospace", "sans-serif", "serif", "system-ui", "-apple-system", "blinkmacsystemfont", "cursive", "fantasy"]);
const requested = new Set<string>();

/**
 * Makes installed fonts named in config usable: the webview only sees system fonts, so the
 * font files are found on disk and loaded under the name the config uses.
 */
export async function ensureFamilies(...families: (string | undefined)[]) {
  const names = families
    .flatMap((f) => (f ?? "").split(","))
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter((f) => f && !GENERIC.has(f.toLowerCase()) && !BUNDLED_FAMILIES.has(f.toLowerCase()));
  let added = false;
  for (const family of names) {
    if (requested.has(family)) continue;
    requested.add(family);
    try {
      const files = await invoke<string[]>("find_font_files", { family });
      for (const path of files) {
        const stem = path.split(/[\\/]/).pop()!.replace(/\.(ttf|otf)$/i, "");
        const suffix = stem.includes("-") ? stem.slice(stem.lastIndexOf("-") + 1).toLowerCase() : "";
        const italic = suffix.endsWith("italic");
        const weight = WEIGHTS[suffix.replace("italic", "")] ?? (suffix ? "400" : "100 900");
        await add(family, await invoke<ArrayBuffer>("read_image", { path }), italic ? "italic" : "normal", weight);
        added = true;
      }
    } catch (e) {
      console.warn(`font ${family}`, e);
    }
  }
  if (added) monaco.editor.remeasureFonts();
}

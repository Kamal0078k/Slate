// Monaco (the editor component from VS Code) with its language workers.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { basename } from "./util";

(self as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// Files are opened one at a time without a project, so semantic checks ("cannot find
// module ...") would be noise. Syntax errors are still reported.
const tsApi = (monaco as any).typescript ?? (monaco.languages as any).typescript;
for (const defaults of [tsApi?.typescriptDefaults, tsApi?.javascriptDefaults]) {
  defaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults?.setCompilerOptions?.({
    target: 99, // ESNext
    allowJs: true,
    allowNonTsExtensions: true,
    jsx: 4, // react-jsx
    moduleResolution: 2,
  });
}

// Extensions Monaco doesn't know but that map well to a built-in language.
const EXTRA: Record<string, string> = {
  ".toml": "ini",
  ".jsonc": "json",
  ".json5": "json",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".zsh": "shell",
  ".bash": "shell",
  ".env": "ini",
  ".gitignore": "ini",
  ".svelte": "html",
  ".vue": "html",
};

const cache = new Map<string, string>();

export function languageForPath(path: string): string {
  const name = basename(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : name.startsWith(".") ? name : "";
  const key = `${name}|${ext}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let id = "plaintext";
  const langs = monaco.languages.getLanguages();
  const byName = langs.find((l) => l.filenames?.some((f) => f.toLowerCase() === name));
  if (byName) id = byName.id;
  else if (EXTRA[ext] || EXTRA[name]) id = EXTRA[ext] ?? EXTRA[name];
  else {
    const byExt = langs.find((l) => l.extensions?.some((e) => e.toLowerCase() === ext));
    if (byExt) id = byExt.id;
  }
  cache.set(key, id);
  return id;
}

export { monaco };

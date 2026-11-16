# Sumi 墨

**A fast, hackable desktop code editor.** Rust core, VS Code's editor (Monaco) inside, and every
pixel of the look — layout, theme, fonts, panels, widgets — defined by files you own.

*Sumi* (墨) is the ink of Japanese calligraphy: the editor is the brush, your code is the ink.

## Why Sumi

- **Your editor, your look.** The whole window is a layout file: where the file tree, search,
  source control and editor sit, how big they are, what's drawn behind your code. Themes, fonts
  and small UI widgets are plain files next to it. Edit any of them and the window updates as
  you save.
- **Named configs you can switch.** Keep several complete setups — say a calm minimal one, a
  dark one with a wallpaper behind the editor, a presentation one with big fonts — and switch
  between them with one command. Shared settings (search excludes, key bindings) live in one
  place; each config only sets what makes it different.
- **Widgets in a few lines of JS.** Drop a `main.js` into a folder and place it in your layout:
  a clock, a git summary, a quote that changes when you save, an animated header. They
  hot-reload on save and follow the theme's colors automatically.
- **Fast where it matters.** File search, fuzzy file finding, git and file watching run in Rust;
  scrolling is tuned for trackpads and high-refresh (120 Hz) displays.
- **Everything you expect from VS Code's editor.** Multi-cursor, find/replace, folding, symbols,
  the familiar shortcuts — plus a real integrated terminal, git, and split panes.

## Quick start

You need [Node.js](https://nodejs.org) and [Rust](https://rustup.rs) (Tauri 2's
[prerequisites](https://v2.tauri.app/start/prerequisites/)). Developed and tested on macOS.

```bash
git clone https://github.com/Kamal0078k/Slate.git sumi && cd sumi
npm install
npm run tauri dev              # run with hot reload
npm run tauri build            # build the app → src-tauri/target/release/bundle/
```

Open a folder from the app (⌘O) or from the command line:
`src-tauri/target/release/sumi ~/code/project`.

## Features

**Editing**
- VS Code's editor and shortcuts: multi-cursor, ⌘D, ⌥↑/↓, find/replace, folding, minimap
- Quick Open ⌘P (fuzzy; `file:42` jumps to a line), Command Palette ⇧⌘P, Go to Line ⌃G,
  symbols ⇧⌘O
- Split editors ⌘\ (right or down; drag tabs between groups), preview tabs, ⌘1/2/3 to focus a group
- Session restore per folder, auto save, trim whitespace and final newline on save

**Files and search**
- Explorer with git colors; create, rename, delete (to Trash), reveal in Finder
- Search in files ⇧⌘F and replace ⇧⌘H: regex, case, whole word, include/exclude globs,
  respects `.gitignore`
- Watches the folder: files changed by other tools reload automatically when you haven't edited them

**Git**
- Staged and unstaged changes, side-by-side diff (the working-tree side is editable),
  stage / unstage / discard, commit (⌘↩)
- Gutter markers for added, modified and deleted lines

**Terminal**
- A real terminal (xterm.js + PTY) that lives in editor panes, tmux style: split with ⌘\ or ⇧⌘\,
  then ⌃\` turns a pane into a terminal (or switches it back to its file); ⌃⇧\` adds another
  terminal tab
- ⌘ shortcuts go to Sumi; everything else (Ctrl+C, Ctrl+R, Esc, Option…) goes to the shell.
  ⌘K clears, ⌘W closes. `path:line` in the output opens the file there.

## Make it yours

Sumi ships an engine and one plain theme. Everything else lives in `~/.config/sumi/`
(`$XDG_CONFIG_HOME/sumi`, `%APPDATA%\sumi` on Windows):

```
config.toml            shared settings + which layout is active
layouts/<name>.json    a named config: the whole window + its look + any setting
layouts/<name>.toml    or just a settings preset
themes/<name>.toml     every color of a theme ("Config: Create Theme" writes a template)
widgets/<name>/main.js your own UI blocks, placed by layouts
backgrounds/           images to show behind the editor (any path works)
plugins/<id>/          new behavior: commands, keys, views, widgets
style.css              optional raw CSS
```

Switch configs with **Config: Layout**, themes with **Config: Color Theme**. Everything reloads
live when saved (plugins need F5; the title bar needs a restart). Mistakes never stop the app:
invalid values fall back to the default with a hint ("unknown config key …; did you mean …?").

```bash
sumi --default-config   # every setting with its default and an explanation
sumi config check       # validate config.toml, the active layout, themes and plugins
sumi config path        # where the config lives
```

### How settings combine

Sumi defaults < `config.toml` < the active layout < `[layouts.<name>]` in `config.toml`.

Keep what every setup shares in `config.toml`, and put the look in each layout. Any setting can
ride along in a layout's `"config"` object:

```json
"config": { "editor": { "font_size": 15, "minimap": { "enabled": false } } }
```

Small per-layout tweaks can also go in `config.toml` (this is where "Config: Color Theme" saves
your pick, so it sticks to the current layout):

```toml
layout = "night"

[layouts.night.theme]
name = "my-dark-theme"
```

### Layouts

A layout is a tree of `row` / `column` / `stack` / `block` nodes. The root also carries the look:

```json
{ "id": "root", "type": "row", "titlebar": "none", "traffic_lights": [14, 14],
  "theme": "my-theme", "font": "JetBrains Mono", "font_size": 14, "ui_font": "Geist Mono",
  "editor_opacity": 0.75,
  "divider": { "width": 1, "color": "border" },
  "children": [
    { "id": "sidebar", "type": "column", "size": { "px": 260 }, "background": "chrome", "children": [
      { "id": "drag", "type": "block", "size": { "px": 36 }, "window_drag": true, "content": { "spacer": true } },
      { "id": "clock", "type": "block", "size": { "px": 120 }, "content": { "widget": "clock", "props": {} } },
      { "id": "files", "type": "stack", "header": "title", "children": [
        { "id": "explorer", "type": "block", "content": { "view": "explorer" } },
        { "id": "search", "type": "block", "content": { "view": "search" } } ] },
      { "id": "changes", "type": "block", "header": "title", "content": { "view": "scm" } } ] },
    { "id": "work", "type": "column", "padding": 8,
      "background": { "image": "backgrounds/night.jpg", "fit": "cover" }, "children": [
      { "id": "main", "type": "block", "content": { "editor": true },
        "panes": { "gap": 8, "radius": 2, "border": { "width": 1, "color": "border" },
                   "focus": { "width": 1, "color": "accent" }, "header": { "height": 30 } } } ] } ] }
```

- **Block content:** `view` (explorer, search, scm, or a plugin view), `editor`, `statusbar`,
  `activitybar`, `widget` (+ `props`), `spacer`.
- **Any node:** `size` (`px` or `weight`), `min`, `max`, `hidden`, `background` (theme color name,
  `#hex`, `{gradient, angle}`, `{image, fit}`), `border`, `radius`, `padding`, `gap`, `divider`,
  `resizable`, `window_drag`. Stacks: `active`, `header` (`"title"` or `"tabs"`).
- **Editor panes:** `gap`, `radius`, `border`, `focus`, and a tab `header` with `"style"`:
  `"classic"` or `"pills"`.
- **Color names:** background/canvas, chrome/panel/sidebar, surface/popover, hover, selected,
  border, foreground, muted/dim, accent, statusbar, activitybar.
- The node with id `sidebar` is what ⌘B toggles. Sizes you drag are remembered per layout.
- Without a layout, Sumi builds a plain window from the `[ui]` settings.

### Themes

```toml
name = "My Theme"
appearance = "dark"

[colors]   # background, foreground and accent are enough; the rest is derived
background = "#0f1317"
foreground = "#d2d9df"
accent = "#8db7cf"

[syntax]   # keyword, string, number, type, function, comment, ...
[terminal] # the 16 ANSI colors, background, foreground, cursor, selection
[editor]   # any Monaco color id
[ui]       # any CSS variable, e.g. "--tab-border-top" = "#8db7cf"
```

### Widgets

```js
// widgets/clock/main.js — placed with { "widget": "clock", "props": {} }
export function mount(el, sumi) {
  const tick = () => (el.textContent = new Date().toLocaleTimeString());
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer); // cleanup when the block goes away or the file is saved
}
```

`sumi` is the plugin API (below) plus `sumi.widget` (`name`, `props`, `dir`) and `sumi.theme()`.
Use the theme's CSS variables (`var(--accent)`, `var(--fg)`, `var(--fg-dim)`, `var(--border)`, …)
so a widget fits every theme. `sumi.editor.onDidSave(...)` and friends let it react to what you do.

## Plugins

`~/.config/sumi/plugins/<id>/sumi-plugin.toml` + `index.js` (or a single `<id>.js` file):

```toml
id = "my-plugin"
name = "My Plugin"
version = "0.1.0"
min_sumi_version = "0.1.0"
main = "index.js"
```

The module exports `activate(sumi)`. The API: `commands`, `keybindings`, `workspace`, `editor`
(the live Monaco editor and its events), `ui` (status bar, quick pick, input, notifications,
sidebar views, widgets, themes, CSS), `settings`, `monaco`, `exec(argv, { cwd, env })` to run
any program, and `plugin` (`id`, `dir`, `dataDir`, `config()` = `[plugins.<id>]` from config.toml).

**Plugins: Create New Plugin** scaffolds one. Example: [`examples/plugins/word-count.js`](examples/plugins/word-count.js).

## Built with

Sumi is a new editor, not a fork. The text editing itself (typing, multi-cursor, syntax
highlighting, find/replace, folding, the diff view) is
[Monaco](https://github.com/microsoft/monaco-editor), the editor component inside VS Code, used as
a library the way many apps embed it. Only Monaco is used, not the rest of VS Code.

| Part | Built on |
| --- | --- |
| Text editor | [Monaco Editor](https://github.com/microsoft/monaco-editor) (Microsoft, MIT) |
| Desktop app shell | [Tauri 2](https://v2.tauri.app), using the system WebView instead of a bundled browser |
| Terminal | [xterm.js](https://xtermjs.org) + [portable-pty](https://github.com/wezterm/wezterm/tree/main/pty) (from WezTerm) |
| Search in files | [`ignore` and `grep`](https://github.com/BurntSushi/ripgrep), the libraries behind ripgrep |
| Fuzzy file finder | [nucleo-matcher](https://github.com/helix-editor/nucleo) (from the Helix editor) |
| Git | [libgit2](https://libgit2.org) via [`git2`](https://github.com/rust-lang/git2-rs) |
| Files, config | [`notify`](https://github.com/notify-rs/notify), [`trash`](https://github.com/Byron/trash-rs), [`toml` / `toml_edit`](https://github.com/toml-rs/toml) |
| Bundled fonts | [JetBrains Mono](https://www.jetbrains.com/lp/mono/), [Geist and Geist Mono](https://vercel.com/font) (OFL) |

Everything around the editor is Sumi's own code: the workbench (tabs, split groups, drag and
drop, session restore), the explorer, search and source control views, terminals that live in
editor panes, the layout engine (layout files, floating cards, background images, widgets,
accordion sections), themes, the config system and its validation, named configs, the plugin and
widget API, the CLI, and the scrolling tuned for trackpads and 120 Hz displays. The config model
is inspired by the herdr app.

## Project structure

```
src-tauri/src/                   Rust: files and exec, search (fuzzy + ripgrep's engine), git (libgit2),
                                 file watching, terminal (PTY), config (TOML, validation, CLI), layouts
src-tauri/defaults/config.toml   the default config, which is also the schema
src/core/                        commands, keybindings, settings, themes, Monaco setup
src/workbench/                   editor groups, tabs and splits, documents, diff gutter, terminal,
                                 built-in commands, workspace
src/ui/                          layout renderer, widgets, status bar, notifications
src/views/                       explorer, search, source control
src/plugins/                     plugin host and API
```

```bash
npm run typecheck                         # TypeScript
cd src-tauri && cargo test                # Rust
SUMI_SELFTEST=1 src-tauri/target/debug/sumi <git repo>   # dev smoke test (with `npm run dev` running)
```

Sumi was called Slate before; old config folders (`~/.config/slate`), `SLATE_CONFIG_DIR` and
`slate-plugin.toml` manifests still work.

## License

[MIT](LICENSE)

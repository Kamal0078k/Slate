# Slate

A fast, hackable desktop text editor: **Rust core + Monaco (VS Code's editor) + JS customization**.

## Run

```bash
npm install
npm run tauri dev              # dev mode with hot reload
npm run tauri build            # release app → src-tauri/target/release/bundle/
```

Open a folder from the app (⌘O) or pass it on the command line:
`src-tauri/target/release/slate ~/code/project`.

## Features

- Editing with VS Code's editor and shortcuts (multi-cursor, ⌘D, ⌥↑/↓, find/replace, folding, minimap)
- Explorer with git colors, create/rename/delete (to Trash), reveal in Finder
- Quick Open ⌘P (fuzzy, `file:42` jumps to a line), Command Palette ⇧⌘P, Go to Line ⌃G, symbols ⇧⌘O
- Search in files ⇧⌘F / replace ⇧⌘H: regex, case, whole word, include/exclude globs, respects .gitignore
- Source Control: staged/unstaged changes, side-by-side diff (editable working tree), stage/unstage/discard, commit (⌘↩)
- Git gutter markers (added / modified / deleted lines)
- Split editors ⌘\ (right/down, drag tabs between groups, resizable), preview tabs, ⌘1/2/3 to focus groups
- Integrated terminal (xterm.js + a real PTY), tmux/herdr style: make panes with ⌘\ / ⇧⌘\,
  then ⌃` in a pane turns it into a terminal (or switches the pane between its terminal and its
  file); ⌃⇧` adds another terminal tab to the pane. ⌘W closes a terminal (and stops what runs
  in it), ⌘K clears. `path:line` in output opens the file there.
  ⌘ shortcuts go to Slate, everything else (Ctrl+C, Ctrl+R, Esc, Option…) to the shell.
- Watches the folder: files changed by terminal tools reload automatically when not edited
- Session restore per folder; auto save; trim whitespace / final newline on save

## Configuration (herdr app model)

Slate ships an engine and one plain theme (`default`). Every look lives in
`~/.config/slate/` (`$XDG_CONFIG_HOME/slate`, `%APPDATA%\slate` on Windows):

```
config.toml            personal settings + which layout/theme to use
layouts/<name>.json    a whole window: node tree + look (titlebar, theme, fonts, colors)
layouts/<name>.toml    or just a settings preset (any config.toml keys)
themes/<name>.toml     every color of a theme ("Config: Create Theme" writes a template)
widgets/<name>/main.js your own UI blocks, placed by layouts (hot-reloaded on save)
plugins/<id>/          behavior: commands, keys, views, widgets (slate-plugin.toml + index.js)
style.css              optional raw CSS
```

```bash
slate --default-config   # every setting with its default
slate config check       # validate config.toml, the layout, themes, plugins
slate config path
```

Settings apply as: Slate defaults < the layout < config.toml. Invalid values are ignored with
a warning ("unknown config key …; did you mean …?") and never stop the app. Everything reloads
live on save (plugins need F5; the title bar needs a restart).

### Layouts

A layout is a tree of `row` / `column` / `stack` / `block` nodes, like the herdr app's:

```json
{ "id": "root", "type": "row", "titlebar": "none", "traffic_lights": [12, 12],
  "theme": "my-theme", "ui_font": "Geist Mono", "editor_opacity": 0.55,
  "divider": { "width": 1, "color": "border" },
  "children": [
    { "id": "sidebar", "type": "column", "size": { "px": 268 }, "background": "chrome", "children": [
      { "id": "drag", "type": "block", "size": { "px": 32 }, "window_drag": true, "content": { "spacer": true } },
      { "id": "lab", "type": "block", "size": { "px": 174 }, "content": { "widget": "steins-lab", "props": {} } },
      { "id": "files", "type": "stack", "header": "title", "children": [
        { "id": "explorer", "type": "block", "content": { "view": "explorer" } },
        { "id": "search", "type": "block", "content": { "view": "search" } } ] },
      { "id": "changes", "type": "block", "header": "title", "content": { "view": "scm" } } ] },
    { "id": "work", "type": "column", "padding": 8,
      "background": { "image": "~/Pictures/wall.svg", "fit": "contain" }, "children": [
      { "id": "main", "type": "block", "content": { "editor": true },
        "panes": { "gap": 8, "radius": 3, "border": { "width": 1, "color": "border" },
                   "focus": { "width": 1, "color": "accent" }, "header": { "height": 30 } } } ] } ] }
```

- Block content: `view` (explorer, search, scm, or a plugin view), `editor`, `statusbar`,
  `activitybar`, `widget` (+ `props`), `spacer`.
- Any node: `size` (`px` or `weight`), `min`, `max`, `hidden`, `background` (theme color name,
  `#hex`, `{gradient, angle}`, `{image, fit}`), `border`, `radius`, `padding`, `gap`, `divider`,
  `resizable`, `window_drag`. Stacks: `active`, `header` (`"title"` or `"tabs"`).
- Color names: background/canvas, chrome/panel/sidebar, surface/popover, hover, selected,
  border, foreground, muted/dim, accent, statusbar, activitybar.
- The node with id `sidebar` is what ⌘B toggles. Sizes you drag and stack choices are
  remembered per layout.
- Without a layout, Slate builds a plain window from the `[ui]` settings (sidebar position,
  stacked sections, activity bar, framed panes, title bar).

### Themes

```toml
name = "My Theme"
appearance = "dark"
[colors]   # background, foreground, accent are enough; the rest is derived
background = "#030405"
foreground = "#d8d0c0"
accent = "#bd884f"
[syntax]   # keyword, string, number, type, function, comment, ...
[editor]   # any Monaco color id
[ui]       # any CSS variable
```

### Widgets

```js
// widgets/clock/main.js — placed with { "widget": "clock", "props": { "format": "24h" } }
export function mount(el, slate) {
  el.textContent = new Date().toLocaleTimeString();
  const t = setInterval(() => (el.textContent = new Date().toLocaleTimeString()), 1000);
  return () => clearInterval(t); // cleanup when the block goes away or the file is saved
}
```

`slate` is the plugin API plus `slate.widget` (`name`, `props`, `dir`) and `slate.theme()`.
Use the CSS variables (`var(--accent)`, `var(--fg-dim)`, …) so widgets follow the theme.

## Plugins

`~/.config/slate/plugins/<id>/slate-plugin.toml` + `index.js` (or a single `<id>.js` file):

```toml
id = "my-plugin"
name = "My Plugin"
version = "0.1.0"
min_slate_version = "0.1.0"
main = "index.js"
```

The module exports `activate(slate)`. API: `commands`, `keybindings`, `workspace`, `editor` (live Monaco
editor + events), `ui` (status bar, quick pick, input, notifications, sidebar views, themes, CSS),
`settings`, `monaco`, `exec(argv, { cwd, env })` to run any program, and `plugin`
(`id`, `dir`, `dataDir` in `$XDG_STATE_HOME/slate/plugins/<id>`, `config()` = `[plugins.<id>]`).
"Plugins: Create New Plugin" scaffolds one. Example: `examples/plugins/word-count.js`.

## Layout

```
src-tauri/src/   Rust: fsops (files, exec), search (fuzzy + ripgrep), git (libgit2), watcher (notify), config (TOML, validation, CLI)
src-tauri/defaults/config.toml   default config = the schema
src/core/        commands, keybindings, settings, themes, Monaco setup
src/workbench/   editor groups/tabs/splits, documents, diff gutter, built-in commands, workspace
src/views/       explorer, search, source control
src/plugins/     plugin host and API
```

Dev self-test: `SLATE_SELFTEST=1 src-tauri/target/debug/slate <git repo>` (with `npm run dev` running).

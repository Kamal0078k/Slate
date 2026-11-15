//! Configuration, modeled on herdr:
//!
//! * one TOML file, `~/.config/slate/config.toml` ($XDG_CONFIG_HOME, %APPDATA% on Windows);
//!   Slate works without it, and `slate --default-config` prints every default
//! * the bundled default config doubles as the schema: unknown keys and wrongly typed values
//!   are ignored with a diagnostic ("unknown config key ...; did you mean ...?") and fall back
//!   to the default, they never stop the app
//! * `slate config check` validates from the command line
//! * state (plugin data) lives apart from config, in $XDG_STATE_HOME/slate
//! * plugins are folders with a `slate-plugin.toml` manifest (or single .js files)

use crate::err;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use toml::{Table, Value};

pub const DEFAULT_CONFIG: &str = include_str!("../defaults/config.toml");
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// ---- locations ---------------------------------------------------------------------------

pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SLATE_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("slate");
    }
    #[cfg(windows)]
    if let Ok(dir) = std::env::var("APPDATA") {
        return PathBuf::from(dir).join("slate");
    }
    home().join(".config").join("slate")
}

pub fn state_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_STATE_HOME") {
        return PathBuf::from(dir).join("slate");
    }
    #[cfg(windows)]
    if let Ok(dir) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(dir).join("slate");
    }
    home().join(".local").join("state").join("slate")
}

fn home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

// ---- validation --------------------------------------------------------------------------

/// Allowed values for string settings that are enums.
const ENUMS: &[(&str, &[&str])] = &[
    ("ui.sidebar_position", &["left", "right"]),
    ("ui.background.pick", &["random", "first", "last"]),
    ("ui.background.size", &["cover", "contain"]),
    ("ui.background.area", &["window", "editor"]),
    ("ui.pane_style", &["flush", "framed"]),
    ("ui.titlebar", &["native", "hidden"]),
    ("ui.mouse_wheel", &["chromium", "system"]),
    ("ui.editor_wheel", &["slate", "monaco"]),
    ("terminal.cursor_style", &["block", "underline", "bar"]),
    ("files.auto_save", &["off", "after_delay"]),
    ("editor.word_wrap", &["off", "on", "wordWrapColumn", "bounded"]),
    ("editor.line_numbers", &["on", "off", "relative", "interval"]),
    ("editor.render_whitespace", &["none", "boundary", "selection", "trailing", "all"]),
    ("editor.cursor_blinking", &["blink", "smooth", "phase", "expand", "solid"]),
];

/// Sections whose keys are not fixed by the default config.
fn is_open_section(path: &str) -> bool {
    path == "editor" || path.starts_with("editor.") || path == "theme.custom" || path.starts_with("plugins.")
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::String(_) => "a string",
        Value::Integer(_) => "an integer",
        Value::Float(_) => "a number",
        Value::Boolean(_) => "true or false",
        Value::Datetime(_) => "a date",
        Value::Array(_) => "a list",
        Value::Table(_) => "a table",
    }
}

fn same_type(default: &Value, user: &Value) -> bool {
    matches!(
        (default, user),
        (Value::String(_), Value::String(_))
            | (Value::Integer(_), Value::Integer(_))
            | (Value::Float(_), Value::Float(_) | Value::Integer(_))
            | (Value::Boolean(_), Value::Boolean(_))
            | (Value::Array(_), Value::Array(_))
            | (Value::Table(_), Value::Table(_))
    )
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push((prev[j] + usize::from(ca != *cb)).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

fn suggestion(key: &str, candidates: &Table) -> String {
    candidates
        .keys()
        .map(|c| (levenshtein(key, c), c))
        .filter(|(d, c)| *d <= 2.max(c.len() / 4))
        .min()
        .map(|(_, c)| format!("; did you mean {c}?"))
        .unwrap_or_default()
}

/// Copies valid user values over `out` (which starts as the defaults), recording diagnostics.
fn merge(out: &mut Table, defaults: &Table, user: &Table, prefix: &str, diags: &mut Vec<String>) {
    for (key, value) in user {
        let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        match defaults.get(key) {
            Some(Value::Table(dt)) => match value {
                Value::Table(ut) => {
                    let Some(Value::Table(ot)) = out.get_mut(key) else { continue };
                    merge(ot, dt, ut, &path, diags);
                }
                _ => diags.push(format!("invalid value for [{path}]: expected a table; using default")),
            },
            Some(default) => {
                // Key bindings accept a single key or a list of keys.
                let key_like = prefix == "keys" && (value.is_str() || value.is_array());
                if !key_like && !same_type(default, value) {
                    diags.push(format!(
                        "invalid value for {path}: expected {}, got {}; using default",
                        type_name(default),
                        type_name(value)
                    ));
                    continue;
                }
                if let (Some((_, allowed)), Value::String(s)) = (ENUMS.iter().find(|(p, _)| *p == path), value) {
                    if !allowed.contains(&s.as_str()) {
                        diags.push(format!("invalid value for {path}: \"{s}\" is not one of {}; using default", allowed.join(", ")));
                        continue;
                    }
                }
                if let Some(problem) = validate_list(&path, value) {
                    diags.push(problem);
                    continue;
                }
                out.insert(key.clone(), value.clone());
            }
            None if path == "keys.bind" || path == "keys.command" => match validate_key_tables(&path, value) {
                Ok(()) => {
                    out.insert(key.clone(), value.clone());
                }
                Err(problem) => diags.push(problem),
            },
            None if is_open_section(prefix) => {
                if prefix == "theme.custom" && !value.is_str() {
                    diags.push(format!("invalid value for {path}: expected a color string; ignoring key"));
                    continue;
                }
                out.insert(key.clone(), value.clone());
            }
            None if prefix == "plugins" && value.is_table() => {
                out.insert(key.clone(), value.clone());
            }
            None => diags.push(format!("unknown config key {path}; ignoring key{}", suggestion(key, defaults))),
        }
    }
}

fn validate_list(path: &str, value: &Value) -> Option<String> {
    let Value::Array(items) = value else {
        // Key bindings may be a string or a list of strings.
        return None;
    };
    let all_strings = items.iter().all(Value::is_str);
    match path {
        "ui.sidebar_sections" | "search.exclude" | "plugins.disabled" if !all_strings => {
            Some(format!("invalid value for {path}: expected a list of strings; using default"))
        }
        "editor.rulers" if !items.iter().all(Value::is_integer) => {
            Some(format!("invalid value for {path}: expected a list of column numbers; using default"))
        }
        "ui.status_right" => items.iter().enumerate().find_map(|(i, item)| {
            let t = item.as_table()?;
            let kind = t.get("type").and_then(Value::as_str).unwrap_or("");
            let ok = match kind {
                "text" => t.get("text").is_some_and(Value::is_str),
                "datetime" => true,
                "command" => t.get("command").is_some_and(Value::is_str),
                _ => false,
            };
            (!ok).then(|| format!("invalid ui.status_right[{i}]: needs type = \"text\" (with text), \"datetime\" or \"command\" (with command); using default"))
        }),
        p if p.starts_with("keys.") && !all_strings => Some(format!("invalid value for {path}: expected a key string or a list of key strings; using default")),
        _ => None,
    }
}

fn validate_key_tables(path: &str, value: &Value) -> Result<(), String> {
    let Value::Array(items) = value else {
        return Err(format!("invalid value for {path}: use [[{path}]] tables; ignoring"));
    };
    for (i, item) in items.iter().enumerate() {
        let t = item.as_table().ok_or_else(|| format!("invalid {path}[{i}]: expected a table; ignoring {path}"))?;
        for field in ["key", "command"] {
            if !t.get(field).is_some_and(Value::is_str) {
                return Err(format!("invalid {path}[{i}]: missing {field} = \"...\"; ignoring {path}"));
            }
        }
        if path == "keys.command" {
            let kind = t.get("type").and_then(Value::as_str).unwrap_or("shell");
            if !["shell", "command", "plugin_action"].contains(&kind) {
                return Err(format!("invalid {path}[{i}]: type \"{kind}\" is not one of shell, command, plugin_action; ignoring {path}"));
            }
        }
    }
    Ok(())
}

pub struct Parsed {
    pub exists: bool,
    pub effective: Table,
    pub diagnostics: Vec<String>,
    /// Node tree from a layouts/<name>.json, if the active layout is one.
    pub tree: Option<serde_json::Value>,
    pub traffic_lights: Option<(f64, f64)>,
}

fn read_table(path: &Path, label: &str, diags: &mut Vec<String>) -> Option<Table> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            diags.push(format!("{label}: cannot read: {e}"));
            return None;
        }
    };
    match text.trim_start_matches('\u{feff}').parse::<Table>() {
        Ok(t) => Some(t),
        Err(e) => {
            diags.push(format!("{label}: parse error, ignoring file: {}", e.to_string().trim()));
            None
        }
    }
}

/// Defaults, then config.toml (shared settings), then the layout named by `layout`, then
/// config.toml's `[layouts.<name>]` overrides for that layout. A layout is a named config:
/// switching layouts switches everything it sets. Never fails: problems become diagnostics
/// and the affected values fall back.
pub fn parse_config() -> Parsed {
    let defaults: Table = DEFAULT_CONFIG.parse().expect("bundled default config is valid TOML");
    let mut effective = defaults.clone();
    let mut diagnostics = Vec::new();
    let path = config_path();
    let exists = path.exists();
    let mut user = if exists { read_table(&path, "config.toml", &mut diagnostics) } else { None };
    let mut overrides = match user.as_mut().and_then(|u| u.remove("layouts")) {
        Some(Value::Table(t)) => t,
        Some(_) => {
            diagnostics.push("invalid value for [layouts]: expected tables like [layouts.<name>]; ignoring".into());
            Table::new()
        }
        None => Table::new(),
    };
    if let Some(user) = &user {
        merge(&mut effective, &defaults, user, "", &mut diagnostics);
    }

    let layout = user.as_ref().and_then(|u| u.get("layout")).and_then(Value::as_str).unwrap_or("").to_string();
    let mut tree = None;
    let mut traffic_lights = None;
    if !layout.is_empty() {
        let dir = config_dir().join("layouts");
        let json_path = dir.join(format!("{layout}.json"));
        let label = format!("layouts/{layout}.toml");
        let layout_path = dir.join(format!("{layout}.toml"));
        if json_path.exists() {
            // A whole-window layout (herdr style): node tree + look on its root.
            let json_label = format!("layouts/{layout}.json");
            match fs::read_to_string(&json_path) {
                Ok(text) => {
                    if let Some(mut file) = crate::layout::parse(&text, &json_label, &mut diagnostics) {
                        file.config.remove("layout"); // a layout can't pull in another layout
                        let mut layout_diags = Vec::new();
                        merge(&mut effective, &defaults, &file.config, "", &mut layout_diags);
                        diagnostics.extend(layout_diags.into_iter().map(|d| format!("{json_label}: {d}")));
                        tree = Some(file.tree);
                        traffic_lights = file.traffic_lights;
                    }
                }
                Err(e) => diagnostics.push(format!("{json_label}: cannot read: {e}")),
            }
        } else if !layout_path.exists() {
            diagnostics.push(format!("layout \"{layout}\" not found in {} (.json or .toml); using defaults", dir.display()));
        } else if let Some(mut table) = read_table(&layout_path, &label, &mut diagnostics) {
            table.remove("layout"); // a layout can't pull in another layout
            let mut layout_diags = Vec::new();
            merge(&mut effective, &defaults, &table, "", &mut layout_diags);
            diagnostics.extend(layout_diags.into_iter().map(|d| format!("{label}: {d}")));
        }
    }
    match overrides.remove(&layout) {
        Some(Value::Table(mut t)) if !layout.is_empty() => {
            t.remove("layout");
            let label = format!("config.toml [layouts.{layout}]");
            let mut layout_diags = Vec::new();
            merge(&mut effective, &defaults, &t, "", &mut layout_diags);
            diagnostics.extend(layout_diags.into_iter().map(|d| format!("{label}: {d}")));
        }
        Some(_) if !layout.is_empty() => diagnostics.push(format!("config.toml [layouts.{layout}]: expected a table; ignoring")),
        _ => {}
    }
    Parsed { exists, effective, diagnostics, tree, traffic_lights }
}

// ---- themes and layouts --------------------------------------------------------------------

/// Tables a theme file may contain; every value in them must be a color string.
const THEME_TABLES: &[&str] = &["colors", "syntax", "editor", "ui", "terminal"];
const THEME_TERMINAL: &[&str] = &[
    "background", "foreground", "cursor", "selection", "black", "red", "green", "yellow", "blue",
    "magenta", "cyan", "white", "bright_black", "bright_red", "bright_green", "bright_yellow",
    "bright_blue", "bright_magenta", "bright_cyan", "bright_white",
];
const THEME_COLORS: &[&str] = &[
    "background", "foreground", "panel", "dim", "border", "accent", "accent_foreground", "selection",
    "hover", "selected", "red", "green", "yellow", "blue", "magenta", "cyan", "orange",
    "sidebar_background", "statusbar_background", "widget_background", "input_background",
    "tab_active_foreground", "cursor",
];
const THEME_SYNTAX: &[&str] = &[
    "keyword", "string", "number", "type", "function", "comment", "variable", "operator", "tag",
    "attribute", "constant", "regexp", "delimiter", "heading",
];

fn validate_theme(name: &str, t: &Table, diags: &mut Vec<String>) -> Table {
    let label = format!("themes/{name}.toml");
    let mut out = Table::new();
    for (key, value) in t {
        match (key.as_str(), value) {
            ("name", Value::String(_)) => {
                out.insert(key.clone(), value.clone());
            }
            ("appearance", Value::String(s)) if s == "dark" || s == "light" => {
                out.insert(key.clone(), value.clone());
            }
            ("appearance", _) => diags.push(format!("{label}: appearance must be \"dark\" or \"light\"; using dark")),
            ("glow", Value::Boolean(_)) => {
                out.insert(key.clone(), value.clone());
            }
            (table, Value::Table(entries)) if THEME_TABLES.contains(&table) => {
                let known: Option<&[&str]> = match table {
                    "colors" => Some(THEME_COLORS),
                    "syntax" => Some(THEME_SYNTAX),
                    "terminal" => Some(THEME_TERMINAL),
                    _ => None, // editor: Monaco color ids, ui: CSS variables
                };
                let mut clean = Table::new();
                for (k, v) in entries {
                    if !v.is_str() {
                        diags.push(format!("{label}: {table}.{k} must be a color string; ignoring"));
                    } else if known.is_some_and(|list| !list.contains(&k.as_str())) {
                        let candidates: Table = known.unwrap().iter().map(|c| (c.to_string(), Value::Boolean(true))).collect();
                        diags.push(format!("{label}: unknown key {table}.{k}; ignoring{}", suggestion(k, &candidates)));
                    } else if table == "ui" && !k.starts_with("--") {
                        diags.push(format!("{label}: ui.{k} must be a CSS variable name starting with --; ignoring"));
                    } else {
                        clean.insert(k.clone(), v.clone());
                    }
                }
                out.insert(table.to_string(), Value::Table(clean));
            }
            _ => diags.push(format!("{label}: unknown key {key}; ignoring (expected name, appearance, glow, [colors], [syntax], [editor], [ui], [terminal])")),
        }
    }
    out
}

/// All theme files, validated. Name = file name without .toml.
pub fn load_themes(diags: &mut Vec<String>) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    let Ok(entries) = fs::read_dir(config_dir().join("themes")) else { return out };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "toml")).collect();
    paths.sort();
    for path in paths {
        let name = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        if let Some(t) = read_table(&path, &format!("themes/{name}.toml"), diags) {
            let clean = validate_theme(&name, &t, diags);
            if let Ok(v) = serde_json::to_value(clean) {
                out.insert(name, v);
            }
        }
    }
    out
}

pub fn list_layouts() -> Vec<String> {
    let Ok(entries) = fs::read_dir(config_dir().join("layouts")) else { return vec![] };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "toml" || e == "json"))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    names.sort();
    names.dedup();
    names
}

// ---- plugins -----------------------------------------------------------------------------

#[derive(Deserialize)]
struct Manifest {
    id: String,
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    min_slate_version: Option<String>,
    main: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    id: String,
    name: String,
    version: String,
    description: String,
    dir: String,
    data_dir: String,
    source: String,
}

fn version_tuple(v: &str) -> Vec<u64> {
    v.split('.').map(|p| p.trim().parse().unwrap_or(0)).collect()
}

fn load_plugins(disabled: &[String], diags: &mut Vec<String>) -> Vec<PluginInfo> {
    let plugin_dir = config_dir().join("plugins");
    let Ok(entries) = fs::read_dir(&plugin_dir) else { return vec![] };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with('_') || file_name.starts_with('.') {
            continue;
        }
        let (manifest, main) = if path.is_dir() {
            let manifest_path = path.join("slate-plugin.toml");
            let Ok(text) = fs::read_to_string(&manifest_path) else { continue };
            match toml::from_str::<Manifest>(&text) {
                Ok(m) => {
                    let main = path.join(m.main.clone().unwrap_or_else(|| "index.js".into()));
                    (m, main)
                }
                Err(e) => {
                    diags.push(format!("plugin {file_name}: invalid slate-plugin.toml: {}", e.message()));
                    continue;
                }
            }
        } else if matches!(path.extension().and_then(|e| e.to_str()), Some("js" | "mjs")) {
            let id = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            let m = Manifest { id, name: None, version: None, description: None, min_slate_version: None, main: None };
            (m, path.clone())
        } else {
            continue;
        };
        if disabled.contains(&manifest.id) {
            continue;
        }
        if let Some(min) = &manifest.min_slate_version {
            if version_tuple(min) > version_tuple(VERSION) {
                diags.push(format!("plugin {} needs Slate {min} or newer (this is {VERSION}); not loaded", manifest.id));
                continue;
            }
        }
        let source = match fs::read_to_string(&main) {
            Ok(s) => s,
            Err(e) => {
                diags.push(format!("plugin {}: cannot read {}: {e}", manifest.id, main.display()));
                continue;
            }
        };
        let data_dir = state_dir().join("plugins").join(&manifest.id);
        out.push(PluginInfo {
            name: manifest.name.unwrap_or_else(|| manifest.id.clone()),
            version: manifest.version.unwrap_or_else(|| "0.0.0".into()),
            description: manifest.description.unwrap_or_default(),
            dir: if path.is_dir() { path } else { plugin_dir.clone() }.to_string_lossy().into_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            id: manifest.id,
            source,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---- commands ----------------------------------------------------------------------------

#[derive(Serialize)]
pub struct LoadedConfig {
    dir: String,
    path: String,
    exists: bool,
    config: serde_json::Value,
    diagnostics: Vec<String>,
    style: Option<String>,
    plugins: Vec<PluginInfo>,
    themes: serde_json::Map<String, serde_json::Value>,
    layouts: Vec<String>,
    /// The active layout's node tree (null = Slate builds one from [ui]).
    tree: Option<serde_json::Value>,
    widgets: Vec<String>,
}

/// `with_plugins` is false on live reloads: plugins load once per window.
#[tauri::command]
pub fn load_config(with_plugins: bool) -> Result<LoadedConfig, String> {
    let Parsed { exists, effective, mut diagnostics, tree, .. } = parse_config();
    let disabled: Vec<String> = effective
        .get("plugins")
        .and_then(|p| p.get("disabled"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let plugins = if with_plugins { load_plugins(&disabled, &mut diagnostics) } else { vec![] };
    let style = fs::read_to_string(config_dir().join("style.css")).ok();
    let themes = load_themes(&mut diagnostics);
    Ok(LoadedConfig {
        themes,
        layouts: list_layouts(),
        tree,
        widgets: crate::layout::list_widgets(&config_dir().join("widgets")),
        dir: config_dir().to_string_lossy().into_owned(),
        path: config_path().to_string_lossy().into_owned(),
        exists,
        config: serde_json::to_value(&effective).map_err(err)?,
        diagnostics,
        style,
        plugins,
    })
}

/// "chromium" (default) or "system": how mouse-wheel clicks are turned into scrolling (macOS).
pub fn mouse_wheel_mode() -> String {
    parse_config()
        .effective
        .get("ui")
        .and_then(|ui| ui.get("mouse_wheel"))
        .and_then(Value::as_str)
        .unwrap_or("chromium")
        .to_string()
}

/// Whether the window was created without a title bar ([ui] titlebar = "hidden").
pub fn titlebar_hidden() -> bool {
    window_style().0
}

/// (title bar hidden, traffic light position) for the window, from config + layout.
pub fn window_style() -> (bool, Option<(f64, f64)>) {
    let parsed = parse_config();
    let hidden = cfg!(target_os = "macos")
        && parsed.effective.get("ui").and_then(|ui| ui.get("titlebar")).and_then(Value::as_str) == Some("hidden");
    (hidden, parsed.traffic_lights)
}

static TITLEBAR_HIDDEN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub fn record_titlebar() -> bool {
    *TITLEBAR_HIDDEN.get_or_init(titlebar_hidden)
}

/// How the window was actually created (title bar changes need a restart).
#[tauri::command]
pub fn window_info() -> serde_json::Value {
    serde_json::json!({ "titlebarHidden": *TITLEBAR_HIDDEN.get_or_init(titlebar_hidden) })
}

#[derive(Serialize)]
pub struct WidgetSource {
    source: String,
    dir: String,
}

/// The code of widgets/<name>/main.js, loaded when a layout shows the widget.
#[tauri::command]
pub fn load_widget(name: String) -> Result<WidgetSource, String> {
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(format!("invalid widget name {name}"));
    }
    let dir = config_dir().join("widgets").join(&name);
    let source = fs::read_to_string(dir.join("main.js")).map_err(|e| format!("widget {name}: {e}"))?;
    Ok(WidgetSource { source, dir: dir.to_string_lossy().into_owned() })
}

#[tauri::command]
pub fn default_config() -> String {
    DEFAULT_CONFIG.to_string()
}

/// Creates config.toml from the defaults if it doesn't exist yet. Returns its path.
#[tauri::command]
pub fn ensure_config_file() -> Result<String, String> {
    let path = config_path();
    if !path.exists() {
        fs::create_dir_all(config_dir()).map_err(err)?;
        fs::write(&path, DEFAULT_CONFIG).map_err(err)?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Sets one value (e.g. ["theme", "name"]) in config.toml, keeping comments and layout.
#[tauri::command]
pub fn config_set(key: Vec<String>, value: serde_json::Value) -> Result<(), String> {
    let path = PathBuf::from(ensure_config_file()?);
    let text = fs::read_to_string(&path).map_err(err)?;
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(err)?;
    let (last, tables) = key.split_last().ok_or("empty key")?;
    let mut table = doc.as_table_mut();
    for name in tables {
        if !table.contains_key(name) {
            // Implicit: no empty headers for intermediate tables like [layouts].
            let mut t = toml_edit::Table::new();
            t.set_implicit(true);
            table.insert(name, toml_edit::Item::Table(t));
        }
        table = table[name.as_str()].as_table_mut().ok_or_else(|| format!("{name} is not a table"))?;
    }
    let item = match value {
        serde_json::Value::Bool(b) => toml_edit::value(b),
        serde_json::Value::Number(n) if n.is_i64() => toml_edit::value(n.as_i64().unwrap()),
        serde_json::Value::Number(n) => toml_edit::value(n.as_f64().unwrap_or_default()),
        serde_json::Value::String(s) => toml_edit::value(s),
        other => return Err(format!("unsupported value {other}")),
    };
    table.insert(last, item);
    fs::write(&path, doc.to_string()).map_err(err)
}

#[derive(Default)]
pub struct ConfigWatcher(Mutex<Option<RecommendedWatcher>>);

/// Emits "config-changed" (with the changed paths) when config.toml, style.css, plugins,
/// themes, layouts, widgets or background images change on disk.
#[tauri::command]
pub fn watch_config(app: AppHandle, state: State<'_, ConfigWatcher>) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(err)?;
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let relevant = event.paths.iter().any(|p| {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                name == "config.toml"
                    || name == "style.css"
                    || p.components().any(|c| ["plugins", "themes", "layouts", "widgets", "backgrounds"].contains(&c.as_os_str().to_str().unwrap_or("")))
            });
            if relevant && !matches!(event.kind, notify::EventKind::Access(_)) {
                let paths: Vec<String> = event.paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                let _ = app.emit("config-changed", paths);
            }
        }
    })
    .map_err(err)?;
    watcher.watch(Path::new(&dir), RecursiveMode::Recursive).map_err(err)?;
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

// ---- CLI ---------------------------------------------------------------------------------

/// Handles `slate --default-config`, `slate config check|path`, `--version`, `--help`.
/// Returns Some(exit code) when the app should not start.
pub fn run_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let first = args.first().map(String::as_str);
    match (first, args.get(1).map(String::as_str)) {
        (Some("--default-config"), _) => {
            print!("{DEFAULT_CONFIG}");
            Some(0)
        }
        (Some("config"), Some("check")) => {
            let parsed = parse_config();
            let path = config_path();
            if !parsed.exists {
                println!("no config file at {} (using defaults)", path.display());
            }
            let mut diags = parsed.diagnostics;
            let disabled: Vec<String> = vec![];
            let _ = load_plugins(&disabled, &mut diags);
            let themes = load_themes(&mut diags);
            let theme = parsed.effective.get("theme").and_then(|t| t.get("name")).and_then(Value::as_str).unwrap_or("default");
            if theme != "default" && !themes.contains_key(theme) {
                diags.push(format!("theme \"{theme}\" not found in {} (plugins may still define it)", config_dir().join("themes").display()));
            }
            if diags.is_empty() {
                println!("config ok: {}", path.display());
                Some(0)
            } else {
                for d in &diags {
                    println!("{d}");
                }
                Some(1)
            }
        }
        (Some("config"), Some("path")) => {
            println!("{}", config_path().display());
            Some(0)
        }
        (Some("config"), _) => {
            eprintln!("usage: slate config check | slate config path");
            Some(2)
        }
        (Some("--version" | "-V"), _) => {
            println!("slate {VERSION}");
            Some(0)
        }
        (Some("--help" | "-h"), _) => {
            println!(
                "slate {VERSION}\n\nUsage:\n  slate [FOLDER]           open a folder\n  slate --default-config   print the default config.toml\n  slate config check       validate config.toml and print diagnostics\n  slate config path        print the config file location\n\nConfig: {}\nState:  {}",
                config_path().display(),
                state_dir().display()
            );
            Some(0)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(t: &'a Table, path: &[&str]) -> &'a Value {
        let (last, rest) = path.split_last().unwrap();
        let mut cur = t;
        for k in rest {
            cur = cur[*k].as_table().unwrap();
        }
        &cur[*last]
    }

    /// defaults < config.toml < layout < [layouts.<name>]: a layout is a named config.
    #[test]
    fn layout_overrides_config_and_layouts_table_overrides_layout() {
        let dir = std::env::temp_dir().join(format!("slate-config-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("layouts")).unwrap();
        fs::write(
            dir.join("config.toml"),
            r#"layout = "pretty"
[editor]
font_size = 11
font_family = "Shared Mono"
[search]
max_file_size_kb = 77
[layouts.pretty.theme]
name = "tweaked"
[layouts.other.editor]
font_size = 50
"#,
        )
        .unwrap();
        fs::write(
            dir.join("layouts/pretty.json"),
            r#"{ "id": "root", "type": "row", "theme": "pretty-theme", "font_size": 15,
                 "config": { "layout": "loop", "editor": { "minimap": { "enabled": false } } },
                 "children": [ { "type": "block", "content": { "editor": true } } ] }"#,
        )
        .unwrap();
        std::env::set_var("SLATE_CONFIG_DIR", &dir);
        let p = parse_config();
        std::env::remove_var("SLATE_CONFIG_DIR");
        let _ = fs::remove_dir_all(&dir);

        assert!(p.diagnostics.is_empty(), "{:?}", p.diagnostics);
        let e = &p.effective;
        assert_eq!(get(e, &["editor", "font_size"]).as_integer(), Some(15), "layout beats config.toml");
        assert_eq!(get(e, &["editor", "font_family"]).as_str(), Some("Shared Mono"), "config.toml fills what the layout leaves");
        assert_eq!(get(e, &["search", "max_file_size_kb"]).as_integer(), Some(77));
        assert_eq!(get(e, &["editor", "minimap", "enabled"]).as_bool(), Some(false), "layout \"config\" applies");
        assert_eq!(get(e, &["theme", "name"]).as_str(), Some("tweaked"), "[layouts.<name>] beats the layout");
        assert_eq!(get(e, &["layout"]).as_str(), Some("pretty"), "a layout can't switch layouts");
        assert!(e.get("layouts").is_none());
    }
}

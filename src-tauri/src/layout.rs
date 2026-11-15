//! Layout files, modeled on the herdr app's `layouts/<name>.json`: a tree of nodes
//! (row / column / stack / block) describing the whole window. Blocks show Slate's own
//! pieces (explorer, search, scm, editor, statusbar, activitybar) or a widget from
//! `widgets/<name>/main.js`. The root also carries the look (theme, colors, fonts, title bar),
//! which is turned into ordinary config values here so the rest of the app sees one config.

use serde_json::{Map, Value as Json};
use std::collections::HashSet;

const NODE_KEYS: &[&str] = &[
    "id", "type", "children", "content", "size", "min", "max", "hidden", "background", "border", "radius",
    "padding", "gap", "divider", "resizable", "window_drag", "active", "header", "panes", "title",
];
const ROOT_KEYS: &[&str] = &[
    "name", "preview", "titlebar", "traffic_lights", "theme", "colors", "font", "font_size", "ui_font",
    "ui_font_size", "editor_opacity", "config",
];
const BUILTIN_VIEWS: &[&str] = &["explorer", "search", "scm"];

pub struct LayoutFile {
    /// The node tree, cleaned of invalid keys.
    pub tree: Json,
    /// Look and settings from the root, as a partial config.toml.
    pub config: toml::Table,
    /// macOS window button position, from `traffic_lights`.
    pub traffic_lights: Option<(f64, f64)>,
}

fn validate_node(node: &mut Json, path: &str, is_root: bool, ids: &mut HashSet<String>, editors: &mut usize, diags: &mut Vec<String>) {
    let Some(obj) = node.as_object_mut() else {
        diags.push(format!("{path}: a node must be an object"));
        *node = Json::Null;
        return;
    };
    let keys: Vec<String> = obj.keys().cloned().collect();
    for key in keys {
        let allowed = NODE_KEYS.contains(&key.as_str()) || (is_root && ROOT_KEYS.contains(&key.as_str()));
        if !allowed {
            let hint = if ROOT_KEYS.contains(&key.as_str()) { " (only allowed on the root node)" } else { "" };
            diags.push(format!("{path}: unknown key \"{key}\"{hint}; ignoring"));
            obj.remove(&key);
        }
    }
    if let Some(id) = obj.get("id").and_then(Json::as_str) {
        if !ids.insert(id.to_string()) {
            diags.push(format!("{path}: duplicate id \"{id}\""));
        }
    }
    let kind = obj.get("type").and_then(Json::as_str).unwrap_or("block").to_string();
    if !["row", "column", "stack", "block"].contains(&kind.as_str()) {
        diags.push(format!("{path}: type \"{kind}\" is not one of row, column, stack, block; treating as block"));
        obj.insert("type".into(), Json::String("block".into()));
    }
    if let Some(size) = obj.get("size") {
        let ok = size.as_object().is_some_and(|s| s.len() == 1 && (s.get("px").is_some_and(Json::is_number) || s.get("weight").is_some_and(Json::is_number)));
        if !ok {
            diags.push(format!("{path}: size must be {{\"px\": n}} or {{\"weight\": n}}; ignoring"));
            obj.remove("size");
        }
    }
    if kind == "block" {
        match obj.get("content").and_then(Json::as_object) {
            None => diags.push(format!("{path}: a block needs \"content\" (view, editor, statusbar, activitybar, widget or spacer)")),
            Some(c) => {
                if c.get("editor").is_some() {
                    *editors += 1;
                } else if let Some(v) = c.get("view").and_then(Json::as_str) {
                    if !BUILTIN_VIEWS.contains(&v) {
                        // Plugin views register at runtime; only note it.
                        diags.push(format!("{path}: view \"{v}\" is not built in (explorer, search, scm); it must come from a plugin"));
                    }
                } else if ["widget", "statusbar", "activitybar", "spacer"].iter().all(|k| c.get(*k).is_none()) {
                    diags.push(format!("{path}: content must have one of view, editor, statusbar, activitybar, widget, spacer"));
                }
            }
        }
    }
    if let Some(children) = obj.get_mut("children").and_then(Json::as_array_mut) {
        for (i, child) in children.iter_mut().enumerate() {
            let id = child.get("id").and_then(Json::as_str).map(String::from).unwrap_or_else(|| i.to_string());
            validate_node(child, &format!("{path}/{id}"), false, ids, editors, diags);
        }
        children.retain(|c| !c.is_null());
    }
}

fn json_to_toml(v: &Json) -> Option<toml::Value> {
    Some(match v {
        Json::Bool(b) => toml::Value::Boolean(*b),
        Json::Number(n) => n.as_i64().map(toml::Value::Integer).or_else(|| n.as_f64().map(toml::Value::Float))?,
        Json::String(s) => toml::Value::String(s.clone()),
        Json::Array(a) => toml::Value::Array(a.iter().filter_map(json_to_toml).collect()),
        Json::Object(o) => toml::Value::Table(o.iter().filter_map(|(k, v)| Some((k.clone(), json_to_toml(v)?))).collect()),
        Json::Null => return None,
    })
}

fn set(table: &mut toml::Table, section: &str, key: &str, value: toml::Value) {
    let sec = table.entry(section).or_insert_with(|| toml::Value::Table(toml::Table::new()));
    if let Some(t) = sec.as_table_mut() {
        t.insert(key.into(), value);
    }
}

/// Parses and validates a layout file. Problems become diagnostics; the layout still loads.
pub fn parse(text: &str, label: &str, diags: &mut Vec<String>) -> Option<LayoutFile> {
    let mut root: Json = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(e) => {
            diags.push(format!("{label}: invalid JSON, ignoring file: {e}"));
            return None;
        }
    };
    let mut local = Vec::new();
    let mut ids = HashSet::new();
    let mut editors = 0;
    validate_node(&mut root, "root", true, &mut ids, &mut editors, &mut local);
    if editors == 0 {
        local.push("no block with \"content\": {\"editor\": true}; the editor is added at the end".into());
    } else if editors > 1 {
        local.push("more than one editor block; only the first is used".into());
    }
    diags.extend(local.into_iter().map(|d| format!("{label}: {d}")));

    let obj = root.as_object_mut()?;
    let mut config = toml::Table::new();
    // The root's look, mapped onto config keys (same names as config.toml where possible).
    match obj.get("theme") {
        Some(Json::String(name)) => set(&mut config, "theme", "name", toml::Value::String(name.clone())),
        Some(Json::Object(pair)) => {
            set(&mut config, "theme", "auto_switch", toml::Value::Boolean(true));
            if let Some(l) = pair.get("light").and_then(Json::as_str) {
                set(&mut config, "theme", "light_name", toml::Value::String(l.into()));
            }
            if let Some(d) = pair.get("dark").and_then(Json::as_str) {
                set(&mut config, "theme", "dark_name", toml::Value::String(d.into()));
            }
        }
        _ => {}
    }
    if let Some(Json::Object(colors)) = obj.get("colors") {
        if let Some(t) = json_to_toml(&Json::Object(colors.clone())) {
            set(&mut config, "theme", "custom", t);
        }
    }
    for (key, section, target) in [
        ("ui_font", "ui", "font_family"),
        ("ui_font_size", "ui", "font_size"),
        ("font", "editor", "font_family"),
        ("font_size", "editor", "font_size"),
    ] {
        if let Some(v) = obj.get(key).and_then(json_to_toml) {
            set(&mut config, section, target, v);
        }
    }
    if let Some(t) = obj.get("titlebar").and_then(Json::as_str) {
        let value = if t == "none" { "hidden" } else { "native" };
        set(&mut config, "ui", "titlebar", toml::Value::String(value.into()));
    }
    // Anything else from config.toml can ride along under "config".
    if let Some(Json::Object(extra)) = obj.get("config") {
        if let Some(toml::Value::Table(t)) = json_to_toml(&Json::Object(extra.clone())) {
            for (k, v) in t {
                match (config.get_mut(&k), v) {
                    (Some(toml::Value::Table(existing)), toml::Value::Table(more)) => existing.extend(more),
                    (_, v) => {
                        config.insert(k, v);
                    }
                }
            }
        }
    }
    let traffic_lights = obj.get("traffic_lights").and_then(Json::as_array).and_then(|a| Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?)));
    obj.remove("config");
    Some(LayoutFile { tree: root, config, traffic_lights })
}

/// Names of widgets in `widgets/` (folders with a main.js).
pub fn list_widgets(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().join("main.js").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[allow(dead_code)]
pub fn empty_object() -> Json {
    Json::Object(Map::new())
}

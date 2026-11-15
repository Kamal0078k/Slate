//! File-system commands used by the explorer, editor tabs and plugins.

use crate::err;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    content: String,
    binary: bool,
    too_large: bool,
}

#[derive(Serialize)]
pub struct ExecResult {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Canonicalizes a folder so every other path the frontend builds is absolute and stable.
#[tauri::command]
pub fn open_workspace(path: String) -> Result<String, String> {
    let p = fs::canonicalize(&path).map_err(err)?;
    if !p.is_dir() {
        return Err(format!("{} is not a folder", p.display()));
    }
    Ok(p.to_string_lossy().into_owned())
}

/// A folder passed on the command line, e.g. `sumi ~/code/project`.
#[tauri::command]
pub fn initial_folder() -> Option<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .find_map(|a| fs::canonicalize(a).ok().filter(|p| p.is_dir()))
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&path).map_err(err)? {
        let entry = entry.map_err(err)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        let p = entry.path();
        out.push(DirEntry {
            name,
            is_dir: p.is_dir(),
            path: p.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<FileContent, String> {
    let mut file = fs::File::open(&path).map_err(err)?;
    let len = file.metadata().map_err(err)?.len();
    if len > MAX_FILE_BYTES {
        return Ok(FileContent { content: String::new(), binary: false, too_large: true });
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.read_to_end(&mut bytes).map_err(err)?;
    let head = &bytes[..bytes.len().min(8000)];
    if head.contains(&0) {
        return Ok(FileContent { content: String::new(), binary: true, too_large: false });
    }
    let content = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    Ok(FileContent { content, binary: false, too_large: false })
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(&path, content).map_err(err)
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::File::create_new(&path).map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("{to} already exists"));
    }
    fs::rename(&from, &to).map_err(err)
}

/// Moves to the OS trash rather than deleting permanently, like VS Code.
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(err)
}

/// Runs any program (argv, no shell). This is the herdr-style escape hatch for plugins:
/// a plugin can shell out to git, formatters, linters, scripts in any language, etc.
#[tauri::command]
pub async fn exec(
    argv: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<ExecResult, String> {
    let (program, args) = argv.split_first().ok_or("exec: empty argv")?;
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    cmd.envs(env.unwrap_or_default());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let out = tauri::async_runtime::spawn_blocking(move || cmd.output())
        .await
        .map_err(err)?
        .map_err(err)?;
    Ok(ExecResult {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Dev builds forward frontend errors and logs to the terminal running the app.
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    eprintln!("[frontend:{level}] {message}");
}

#[tauri::command]
pub fn dev_selftest() -> bool {
    cfg!(debug_assertions) && std::env::var("SUMI_SELFTEST").is_ok()
}

fn expand_home(path: &str) -> std::path::PathBuf {
    match path.strip_prefix("~/").or_else(|| (path == "~").then_some("")) {
        Some(rest) => std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map(|h| Path::new(&h).join(rest))
            .unwrap_or_else(|_| Path::new(path).to_path_buf()),
        None => Path::new(path).to_path_buf(),
    }
}

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"];

/// Images for the window background: a single image file, or every image in a folder
/// (like WezTerm's backdrops folder). `~` is expanded.
#[tauri::command]
pub fn list_images(source: String) -> Result<Vec<String>, String> {
    let path = expand_home(source.trim());
    let is_image = |p: &Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
    };
    if path.is_file() {
        return Ok(if is_image(&path) { vec![path.to_string_lossy().into_owned()] } else { vec![] });
    }
    let mut images: Vec<String> = fs::read_dir(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_image(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    images.sort();
    Ok(images)
}

/// Raw image bytes (sent as binary, not JSON).
#[tauri::command]
pub async fn read_image(path: String) -> Result<tauri::ipc::Response, String> {
    let path = expand_home(&path);
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(path))
        .await
        .map_err(err)?
        .map_err(err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Font files in ~/.config/sumi/fonts and widgets/*/fonts (like herdr's home and mod fonts/).
#[tauri::command]
pub fn list_fonts() -> Vec<String> {
    let base = crate::config::config_dir();
    let mut dirs = vec![base.join("fonts")];
    if let Ok(widgets) = fs::read_dir(base.join("widgets")) {
        dirs.extend(widgets.flatten().map(|w| w.path().join("fonts")));
    }
    let mut out = Vec::new();
    for dir in dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
                if ["ttf", "otf", "woff", "woff2"].contains(&ext.as_str()) {
                    out.push(p.to_string_lossy().into_owned());
                }
            }
        }
    }
    out.sort();
    out
}

/// Installed font files for a family name, so fonts named in config work even though the
/// webview only exposes system fonts. Matches "<Family>.ttf" and "<Family>-<Style>.ttf".
#[tauri::command]
pub fn find_font_files(family: String) -> Vec<String> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let mut dirs = vec![
        Path::new(&home).join("Library/Fonts"),
        Path::new("/Library/Fonts").to_path_buf(),
        Path::new(&home).join(".local/share/fonts"),
        Path::new(&home).join(".fonts"),
        Path::new("/usr/share/fonts").to_path_buf(),
        Path::new("/usr/local/share/fonts").to_path_buf(),
    ];
    if let Ok(win) = std::env::var("WINDIR") {
        dirs.push(Path::new(&win).join("Fonts"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(Path::new(&local).join("Microsoft/Windows/Fonts"));
    }
    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let want = norm(&family);
    if want.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut stack = dirs;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p); // Linux font dirs are nested
                continue;
            }
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if !["ttf", "otf"].contains(&ext.as_str()) {
                continue;
            }
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let base = stem.rsplit_once('-').map(|(b, _)| b).unwrap_or(stem);
            if norm(stem) == want || norm(base) == want {
                out.push(p.to_string_lossy().into_owned());
            }
        }
    }
    out.sort();
    out
}

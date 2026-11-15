//! Watches the open folder so the explorer, git view and open files stay in sync with
//! changes made outside the editor (e.g. by agents or tools running in your terminal).

use crate::err;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatcherState(Mutex<Option<RecommendedWatcher>>);

fn interesting(path: &Path) -> bool {
    let s = path.to_string_lossy();
    if s.contains("/node_modules/") || s.contains("\\node_modules\\") {
        return false;
    }
    match s.find("/.git/").or_else(|| s.find("\\.git\\")) {
        // Inside .git only HEAD, index and refs matter (branch switches, staging, commits).
        Some(i) => {
            let rest = &s[i + 6..];
            rest == "HEAD" || rest == "index" || rest.starts_with("refs")
        }
        None => true,
    }
}

#[tauri::command]
pub fn watch_workspace(app: AppHandle, state: State<'_, WatcherState>, root: String) -> Result<(), String> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| interesting(p))
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                let _ = app.emit("fs-changed", paths);
            }
        }
    })
    .map_err(err)?;
    watcher.watch(Path::new(&root), RecursiveMode::Recursive).map_err(err)?;
    // Replacing the old watcher drops it, which stops watching the previous folder.
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

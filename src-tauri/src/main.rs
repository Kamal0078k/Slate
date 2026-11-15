// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod fsops;
mod git;
mod layout;
mod search;
mod watcher;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn main() {
    if let Some(code) = config::run_cli() {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(search::FileIndex::default())
        .manage(watcher::WatcherState::default())
        .manage(config::ConfigWatcher::default())
        // A minimal native menu. There is deliberately no "Close Window" item so
        // Cmd+W reaches the editor (close tab) instead of closing the window.
        .menu(|app| {
            Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        "Slate",
                        true,
                        &[
                            &PredefinedMenuItem::about(app, None, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::hide(app, None)?,
                            &PredefinedMenuItem::hide_others(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::quit(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Edit",
                        true,
                        &[
                            &PredefinedMenuItem::undo(app, None)?,
                            &PredefinedMenuItem::redo(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::cut(app, None)?,
                            &PredefinedMenuItem::copy(app, None)?,
                            &PredefinedMenuItem::paste(app, None)?,
                            &PredefinedMenuItem::select_all(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Window",
                        true,
                        &[
                            &PredefinedMenuItem::minimize(app, None)?,
                            &PredefinedMenuItem::fullscreen(app, None)?,
                        ],
                    )?,
                ],
            )
        })
        // The window is built here (not in tauri.conf.json) so config.toml can choose the
        // title bar style, which macOS only allows at creation time.
        .setup(|app| {
            let hidden = config::record_titlebar();
            let traffic = config::window_style().1.unwrap_or((14.0, 18.0));
            #[allow(unused_mut)]
            let mut builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("Slate")
                .inner_size(1400.0, 900.0)
                .min_inner_size(600.0, 400.0)
                .disable_drag_drop_handler();
            #[cfg(target_os = "macos")]
            if hidden {
                // Like herdr's "titlebar": "none": traffic lights float over the sidebar.
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(traffic.0, traffic.1));
            }
            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fsops::open_workspace,
            fsops::initial_folder,
            fsops::read_dir,
            fsops::read_file,
            fsops::write_file,
            fsops::create_file,
            fsops::create_dir,
            fsops::rename_path,
            fsops::delete_path,
            fsops::exec,
            fsops::frontend_log,
            fsops::dev_selftest,
            fsops::list_images,
            fsops::read_image,
            fsops::list_fonts,
            fsops::find_font_files,
            search::find_files,
            search::invalidate_index,
            search::search_text,
            git::git_status,
            git::git_repositories,
            git::git_file_content,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            config::load_config,
            config::window_info,
            config::load_widget,
            config::default_config,
            config::ensure_config_file,
            config::config_set,
            config::watch_config,
            watcher::watch_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Slate");
}

// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod fsops;
mod git;
mod layout;
mod pty;
#[cfg(target_os = "macos")]
mod wheel;
mod search;
mod watcher;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// WebKit caps page animation at 60 fps by default (Safari's "prefer page rendering updates
/// near 60fps"), so the editor, which scrolls by redrawing every frame, ran at half the rate of
/// a 120 Hz ProMotion screen while native scrolling (file tree) and VS Code ran at 120 Hz.
/// The setting is read when the view is created, so it goes on a configuration handed to Tauri
/// up front. Skipped silently when this WebKit doesn't have it.
#[cfg(target_os = "macos")]
fn high_refresh_configuration() -> Option<objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration>> {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel, MainThreadMarker};
    use std::ffi::CStr;
    let mtm = MainThreadMarker::new()?;
    let config = unsafe { objc2_web_kit::WKWebViewConfiguration::new(mtm) };
    unsafe {
        let prefs = config.preferences();
        let prefs_obj: &AnyObject = &prefs;
        // WebKit's feature flags (what Safari's Develop > Feature Flags menu shows).
        let cls = AnyClass::get(c"WKPreferences")?;
        let has_list: bool = msg_send![cls, respondsToSelector: sel!(_features)];
        let has_setter: bool = msg_send![prefs_obj, respondsToSelector: sel!(_setEnabled:forFeature:)];
        if !has_list || !has_setter {
            eprintln!("slate: this WebKit has no feature flags; staying at 60 fps");
            return None;
        }
        let features: *mut AnyObject = msg_send![cls, _features];
        if features.is_null() {
            return None;
        }
        let count: usize = msg_send![features, count];
        for i in 0..count {
            let feature: *mut AnyObject = msg_send![features, objectAtIndex: i];
            let key: *mut AnyObject = msg_send![feature, key];
            if key.is_null() {
                continue;
            }
            let utf8: *const std::ffi::c_char = msg_send![key, UTF8String];
            if !utf8.is_null() && CStr::from_ptr(utf8).to_bytes() == b"PreferPageRenderingUpdatesNear60FPSEnabled" {
                let _: () = msg_send![prefs_obj, _setEnabled: false, forFeature: feature];
                eprintln!("slate: disabled WebKit's near-60-fps rendering preference (measure with Developer: Measure Scroll FPS)");
                return Some(config);
            }
        }
        eprintln!("slate: no 60 fps feature flag in this WebKit; staying at 60 fps");
        None
    }
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
        .manage(pty::Terminals::default())
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
            #[cfg(target_os = "macos")]
            if let Some(config) = high_refresh_configuration() {
                builder = builder.with_webview_configuration(config);
            }
            builder.build()?;
            #[cfg(target_os = "macos")]
            if config::mouse_wheel_mode() == "chromium" {
                wheel::install_chromium_wheel();
            }
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
            pty::term_spawn,
            pty::term_write,
            pty::term_resize,
            pty::term_kill,
            config::load_config,
            config::window_info,
            config::load_widget,
            config::default_config,
            config::ensure_config_file,
            config::config_set,
            config::watch_config,
            watcher::watch_workspace,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Slate")
        .run(|app, event| {
            // Quitting kills every terminal's shell, so nothing keeps running in the background.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<pty::Terminals>().kill_all();
            }
        });
}

//! The app stays in the notification area while its window is closed, because the Core Daemon
//! keeps working behind it (schedules, long agent runs). The tray icon is where the person
//! sees that and where they quit.
//!
//! Quitting is driven by the UI (src/app/quit.ts): it says what would stop and asks only then,
//! calls `set_quitting(true)` so `get_connection` no longer restarts the daemon, sends
//! `system.shutdown`, and finally calls `exit_app`.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_notification::NotificationExt;

/// Emitted to the main window when the person picks 終了 in the tray menu.
pub const QUIT_EVENT: &str = "acc://quit-requested";

static QUITTING: AtomicBool = AtomicBool::new(false);

/// True from the moment the UI starts quitting: the daemon going away is then expected.
pub fn quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("AI Agent Command Center")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "quit" => {
                // The confirmation (if any) is a dialog in the window.
                show_main(app);
                if app.emit_to("main", QUIT_EVENT, ()).is_err() {
                    app.exit(0);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Closing the window (title bar ✕, Alt+F4) hides it; only `exit_app` ends the process.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if quitting() {
            return;
        }
        api.prevent_close();
        let _ = window.hide();
        first_close_hint(window.app_handle());
    }
}

/// Said once, the first time the window disappears while the app keeps running (Windows puts
/// new tray icons in the overflow, so the icon alone is easy to miss).
fn first_close_hint<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let marker = dir.join("tray-hint-shown");
    if marker.exists() {
        return;
    }
    let shown = app
        .notification()
        .builder()
        .title("バックグラウンドで動いています")
        .body("終了はタスクトレイのアイコンから")
        .show()
        .is_ok();
    if shown {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&marker, b"");
    }
}

#[tauri::command]
pub fn set_quitting(on: bool) {
    QUITTING.store(on, Ordering::SeqCst);
}

#[tauri::command]
pub fn exit_app<R: Runtime>(app: AppHandle<R>) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_follows_set_quitting() {
        set_quitting(true);
        assert!(quitting());
        set_quitting(false);
        assert!(!quitting());
    }
}

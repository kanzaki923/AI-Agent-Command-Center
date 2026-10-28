mod daemon;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_window_state::StateFlags;

/// Serializes ensure() inside this process (StrictMode double invoke, pre-warm vs first call).
static ENSURE_LOCK: Mutex<()> = Mutex::new(());
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

/// Resolve how to start the daemon.
/// 1. ACC_DAEMON_ENTRY=<file>  : `node <file>` (`--import tsx` for .ts). Escape hatch for dev/tests.
/// 2. `tauri dev`              : node + tsx on the repo source (packages/daemon/src/main.ts).
/// 3. built app                : bundled node (externalBin "acc-node") + resources/daemon/main.mjs.
fn launch_spec(app: &AppHandle) -> Result<daemon::LaunchSpec, String> {
    let node_from_path = || PathBuf::from(std::env::var_os("ACC_NODE").unwrap_or_else(|| "node".into()));

    if let Some(entry) = std::env::var_os("ACC_DAEMON_ENTRY").filter(|v| !v.is_empty()) {
        let entry = PathBuf::from(entry);
        let mut args = node_flags();
        if entry.extension().is_some_and(|e| e == "ts") {
            args.push("--import".into());
            args.push("tsx".into());
        }
        args.push(entry.clone().into_os_string());
        return Ok(daemon::LaunchSpec { program: node_from_path(), args, cwd: entry.parent().map(Into::into) });
    }

    if tauri::is_dev() {
        // apps/desktop/src-tauri -> repo root. Compile-time path, only used under `tauri dev`.
        let pkg = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/daemon");
        return Ok(daemon::LaunchSpec {
            program: node_from_path(),
            // cwd = packages/daemon so `--import tsx` resolves from its node_modules
            args: [node_flags(), vec!["--import".into(), "tsx".into(), "src/main.ts".into()]].concat(),
            cwd: Some(pkg),
        });
    }

    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("no exe dir")?
        .to_path_buf();
    let node = exe_dir.join(if cfg!(windows) { "acc-node.exe" } else { "acc-node" });
    // resource_dir() is `\\?\C:\...` on Windows; Node 22.23 cannot start a main script given as
    // a verbatim path (EISDIR on lstat 'C:'), so hand it a plain one.
    let entry = dunce::simplified(&app.path().resource_dir().map_err(|e| e.to_string())?)
        .join("daemon")
        .join("main.mjs");
    if !entry.exists() || !node.exists() {
        return Err(format!(
            "Core Daemon のファイルが見つかりません（{} / {}）。アプリを再インストールしてください",
            node.display(),
            entry.display()
        ));
    }
    let mut args = node_flags();
    args.push(entry.into_os_string());
    Ok(daemon::LaunchSpec { program: node, args, cwd: None })
}

/// node:sqlite still prints an ExperimentalWarning on load (it would land in the launch log),
/// and the bundle ships a source map so stack traces in that log point at the TS sources.
fn node_flags() -> Vec<std::ffi::OsString> {
    vec!["--disable-warning=ExperimentalWarning".into(), "--enable-source-maps".into()]
}

fn ensure_blocking(app: &AppHandle) -> Result<daemon::Connection, String> {
    let _g = ENSURE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    daemon::ensure(&daemon::acc_home(), || launch_spec(app), STARTUP_TIMEOUT)
}

/// Frontend entry point. Idempotent and cheap when the daemon is already up, so the UI
/// can call it again whenever the WebSocket drops (daemon restart = new token).
/// `async` + spawn_blocking: a sync command would run on the main thread and freeze the window.
#[tauri::command]
async fn get_connection(app: AppHandle) -> Result<daemon::Connection, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // must be the first plugin: a second launch focuses the existing window and exits
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // window starts hidden (no white flash); we decide when to show it
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // OS notifications (src/lib/notify.ts calls plugin:notification|notify etc.)
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_connection])
        .setup(|app| {
            // Pre-warm: start the daemon while the WebView boots, so the first
            // get_connection() usually returns immediately.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = ensure_blocking(&handle) {
                    eprintln!("[acc] daemon pre-warm failed: {e}");
                }
            });
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // Show once the first document has loaded (backgroundColor + visible:false
            // in tauri.conf.json avoid the white WebView2 flash).
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.window().show();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

//! Core Daemon discovery / launch. Pure std (no Tauri types) so it can be unit tested.
//!
//! Contract (docs/persistent/architecture.md §2.1):
//!   <ACC_HOME>/daemon.json = { port, token, pid }, GET http://127.0.0.1:<port>/health
//!   -> { ok: true, service?: "acc-daemon", pid?, ... }
//! The shell never owns the daemon: it is spawned detached and outlives the UI.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
pub struct DaemonInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// e.g. http://127.0.0.1:47821
    pub url: String,
    /// e.g. ws://127.0.0.1:47821/ws (token is passed separately; the client appends ?token=)
    pub ws_url: String,
    pub token: String,
    pub pid: u32,
    /// true when this call had to start the daemon
    pub spawned: bool,
}

/// How to start the daemon. Built by the Tauri side (dev vs bundled).
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
}

pub fn acc_home() -> PathBuf {
    if let Some(h) = std::env::var_os("ACC_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(h);
    }
    #[allow(deprecated)] // un-deprecated in Rust 1.86+, kept for older toolchains
    let home = std::env::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".acc")
}

pub fn read_info(home: &Path) -> Option<DaemonInfo> {
    let raw = fs::read(home.join("daemon.json")).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Whether a /health body identifies our daemon. `service` and `pid` are checked when the
/// daemon reports them (they reject a stale daemon.json pointing at a reused port); a body
/// without them is accepted as long as it says `ok: true`.
pub fn health_body_matches(body: &serde_json::Value, expected_pid: u32) -> bool {
    if body["ok"] != serde_json::Value::Bool(true) {
        return false;
    }
    if let Some(service) = body.get("service") {
        if service != "acc-daemon" {
            return false;
        }
    }
    if let Some(pid) = body.get("pid") {
        if pid.as_u64() != Some(expected_pid as u64) {
            return false;
        }
    }
    true
}

/// Minimal HTTP GET /health over std TcpStream (avoids an HTTP client crate).
pub fn health(port: u16, expected_pid: u32) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(300)));
    // HTTP/1.0: Node answers 1.0 requests without chunked transfer-encoding
    let req = format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(512);
    let _ = s.take(16 * 1024).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    if !text.starts_with("HTTP/1.1 200") && !text.starts_with("HTTP/1.0 200") {
        return false;
    }
    // tolerate chunked framing anyway: parse the outermost JSON object of the body
    let Some((_, body)) = text.split_once("\r\n\r\n") else { return false };
    let (Some(a), Some(b)) = (body.find('{'), body.rfind('}')) else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body[a..=b]) else { return false };
    health_body_matches(&v, expected_pid)
}

/// Connection to an already-running daemon, if any.
pub fn probe(home: &Path) -> Option<Connection> {
    let info = read_info(home)?;
    health(info.port, info.pid).then(|| to_conn(info, false))
}

fn to_conn(info: DaemonInfo, spawned: bool) -> Connection {
    Connection {
        url: format!("http://127.0.0.1:{}", info.port),
        ws_url: format!("ws://127.0.0.1:{}/ws", info.port),
        token: info.token,
        pid: info.pid,
        spawned,
    }
}

/// Return a live connection, starting the daemon if needed.
/// Callers must serialize calls (see the Mutex in lib.rs) so a double invoke
/// (React StrictMode, pre-warm + first render) does not spawn twice. Cross-process
/// races (UI vs CLI) are resolved by the daemon itself: the loser fails to bind and exits.
pub fn ensure(
    home: &Path,
    spec: impl FnOnce() -> Result<LaunchSpec, String>,
    timeout: Duration,
) -> Result<Connection, String> {
    if let Some(c) = probe(home) {
        return Ok(c);
    }
    let spec = spec()?;
    fs::create_dir_all(home.join("logs")).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
    let log_path = home.join("logs").join("daemon-launch.log");
    let mut child = spawn_detached(&spec, home, &log_path)?;

    let deadline = Instant::now() + timeout;
    let mut child_exited_ok = false;
    loop {
        if let Some(info) = read_info(home) {
            if health(info.port, info.pid) {
                return Ok(to_conn(info, true));
            }
        }
        if !child_exited_ok {
            match child.try_wait() {
                // exit 0 = lost the race to another daemon; keep polling for the winner
                Ok(Some(st)) if st.success() => child_exited_ok = true,
                Ok(Some(st)) => {
                    return Err(format!(
                        "Core Daemon exited during startup ({st}).\n{}",
                        tail(&log_path, 2000)
                    ))
                }
                _ => {}
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Core Daemon did not become healthy within {timeout:?}.\n{}",
                tail(&log_path, 2000)
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // NOTE: dropping `child` does NOT kill the process on any platform.
}

fn spawn_detached(spec: &LaunchSpec, home: &Path, log_path: &Path) -> Result<Child, String> {
    let open_log = || OpenOptions::new().create(true).append(true).open(log_path);
    let mut cmd = Command::new(&spec.program);
    // the daemon must use the same home the shell resolved (and will read daemon.json from)
    cmd.env("ACC_HOME", home);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(open_log().map_err(|e| e.to_string())?)
        .stderr(open_log().map_err(|e| e.to_string())?);
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the daemon gets a *hidden* console. Children it spawns
        //   (git, claude, shells) inherit it, so no console windows flash.
        // CREATE_NEW_PROCESS_GROUP: Ctrl+C in the `tauri dev` terminal does not reach it.
        // CREATE_BREAKAWAY_FROM_JOB: escape a kill-on-close job (some terminals / IDE
        //   runners / CI put children in one). Fails with ERROR_ACCESS_DENIED if the job
        //   forbids breakaway, so retry without it.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        // std::process spawns with bInheritHandles=TRUE, so the daemon would also inherit
        // OUR std handles when they are inheritable (e.g. the pipe `tauri dev`/a terminal
        // gave us) and keep that pipe open forever.
        clear_std_handle_inheritance();
        cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
        match cmd.spawn() {
            Ok(c) => return Ok(c),
            Err(e) if e.raw_os_error() == Some(5) => {
                eprintln!("[acc] CREATE_BREAKAWAY_FROM_JOB denied; spawning inside the current job");
                cmd.creation_flags(base);
                cmd.stdout(open_log().map_err(|e| e.to_string())?)
                    .stderr(open_log().map_err(|e| e.to_string())?);
            }
            Err(e) => return Err(format!("failed to start {}: {e}", spec.program.display())),
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // detach from the terminal's process group (no SIGINT/SIGHUP fan-out)
    }
    cmd.spawn().map_err(|e| format!("failed to start {}: {e}", spec.program.display()))
}

#[cfg(windows)]
fn clear_std_handle_inheritance() {
    type Handle = *mut core::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n: u32) -> Handle;
        fn SetHandleInformation(h: Handle, mask: u32, flags: u32) -> i32;
    }
    const STD_HANDLES: [u32; 3] = [-10i32 as u32, -11i32 as u32, -12i32 as u32];
    const HANDLE_FLAG_INHERIT: u32 = 0x1;
    for n in STD_HANDLES {
        // SAFETY: plain Win32 calls on our own std handles; null/INVALID are skipped.
        unsafe {
            let h = GetStdHandle(n);
            if !h.is_null() && h as isize != -1 {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

fn tail(path: &Path, max: usize) -> String {
    let s = fs::read_to_string(path).unwrap_or_default();
    let start = s.len().saturating_sub(max);
    let start = (start..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
    s[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("acc-shell-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn health_body_accepts_current_and_future_daemons() {
        let v = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        // today's daemon: { ok, version, protocolVersion }
        assert!(health_body_matches(&v(r#"{"ok":true,"version":"0.1.0","protocolVersion":1}"#), 42));
        // with identity fields
        assert!(health_body_matches(&v(r#"{"ok":true,"service":"acc-daemon","pid":42}"#), 42));
        assert!(!health_body_matches(&v(r#"{"ok":true,"service":"acc-daemon","pid":7}"#), 42));
        assert!(!health_body_matches(&v(r#"{"ok":true,"service":"other"}"#), 42));
        assert!(!health_body_matches(&v(r#"{"ok":false}"#), 42));
    }

    #[test]
    fn probe_rejects_missing_and_stale_info() {
        let home = tmp_home("stale");
        assert!(probe(&home).is_none());
        // stale file pointing to a port nobody listens on
        fs::write(home.join("daemon.json"), r#"{"port":1,"token":"x","pid":42}"#).unwrap();
        assert!(probe(&home).is_none());
    }

    /// Uses the fake daemon fixture on a test-only port.
    #[test]
    fn ensure_spawns_once_then_reuses_and_survives_race() {
        let home = tmp_home("spawn");
        let entry = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-daemon.mjs");
        std::env::set_var("ACC_PORT", "47897"); // inherited by the child; only this test sets it
        let spec = || Ok(LaunchSpec { program: "node".into(), args: vec![entry.clone().into()], cwd: None });
        let first = ensure(&home, spec, Duration::from_secs(10)).unwrap();
        assert!(first.spawned);
        let second = ensure(&home, spec, Duration::from_secs(10)).unwrap();
        assert!(!second.spawned);
        assert_eq!(first.pid, second.pid);
        // a racing second daemon must exit 0 and must not clobber daemon.json
        let st = Command::new("node").arg(&entry).env("ACC_HOME", &home).status().unwrap();
        assert!(st.success());
        assert_eq!(read_info(&home).unwrap().pid, first.pid);
        #[cfg(windows)]
        let _ = Command::new("taskkill").args(["/F", "/PID", &first.pid.to_string()]).status();
        #[cfg(unix)]
        let _ = Command::new("kill").args(["-9", &first.pid.to_string()]).status();
    }

    #[test]
    fn ensure_reports_startup_crash_with_log_tail() {
        let home = tmp_home("crash");
        let spec = || {
            Ok(LaunchSpec {
                program: PathBuf::from("node"),
                args: vec!["-e".into(), "console.error('boom-from-daemon'); process.exit(3)".into()],
                cwd: None,
            })
        };
        let err = ensure(&home, spec, Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("boom-from-daemon"), "{err}");
    }
}

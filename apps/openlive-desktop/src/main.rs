// OpenLive 26.7.16 — desktop shell (Windows + macOS)
//
// Wraps the openlive-gateway web surface in a Tauri webview. The gateway
// server is spawned as a child process on startup, kept alive for the
// lifetime of the app, and killed on exit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// Port the gateway listens on (kept in sync with tauri.conf.json devUrl).
const GATEWAY_PORT: u16 = 12345;

static GATEWAY_CHILD: Mutex<Option<Child>> = Mutex::new(None);

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Resolve the gateway binary and web assets, then spawn the gateway.
            // We do this inside setup() so we can use app.path().resource_dir()
            // for bundled resources and fall back to the source tree in dev mode.
            let (gateway_exe, web_dir) = resolve_gateway_and_web(app.handle());
            spawn_gateway(&gateway_exe, web_dir.as_deref());
            wait_for_gateway_ready();

            // Create the main window only after the gateway is ready so the
            // webview never sees an ERR_CONNECTION_REFUSED page.
            let url = format!("http://127.0.0.1:{GATEWAY_PORT}");
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().unwrap()),
            )
            .title("OpenLive")
            .inner_size(1280.0, 820.0)
            .min_inner_size(900.0, 640.0)
            .center()
            .build()?;

            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. } = event
            {
                kill_gateway();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    kill_gateway();
}

/// Resolve the gateway executable and the web assets directory.
///
/// In a bundled app, both live in Tauri's resource directory (placed there by
/// `bundle.resources` in tauri.conf.json). In dev mode, we search upward from
/// the current executable for the project root and use the root workspace's
/// target directory and the source tree's web assets.
fn resolve_gateway_and_web(handle: &tauri::AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    // In a bundled app the gateway binary is staged as openlive-gateway-bundled.exe
    // (even on macOS/Linux) so the runtime lookup is platform-agnostic.
    let bundled_name = "openlive-gateway-bundled.exe";
    let gateway_name = if cfg!(windows) {
        "openlive-gateway.exe"
    } else {
        "openlive-gateway"
    };

    // 1. Bundled mode: use Tauri's resource directory.
    if let Ok(resource_dir) = handle.path().resource_dir() {
        let bundled_gateway = resource_dir.join(bundled_name);
        let bundled_web = resource_dir.join("web");
        if bundled_gateway.exists() {
            return (Some(bundled_gateway), Some(bundled_web));
        }
    }

    // 2. Dev mode: find the project root by walking up from the executable.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));

    if let Some(project_root) = find_project_root(&exe_dir) {
        let debug = project_root.join("target/debug").join(gateway_name);
        let release = project_root.join("target/release").join(gateway_name);
        let gateway = if release.exists() { release } else { debug };
        let web_dir = project_root.join("apps/openlive-gateway/web");
        return (
            gateway.exists().then_some(gateway),
            web_dir.exists().then_some(web_dir),
        );
    }

    (None, None)
}

/// Walk upward from `start` looking for a directory that contains the root
/// workspace marker (Cargo.toml mentioning openlive-gateway).
fn find_project_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let cargo_toml = current.join("Cargo.toml");
        if cargo_toml.exists() {
            if let Ok(contents) = std::fs::read_to_string(&cargo_toml) {
                if contents.contains("openlive-gateway") {
                    return Some(current);
                }
            }
        }
        if !current.pop() {
            break;
        }
    }
    None
}

/// Spawn the gateway child process if a binary was resolved.
fn spawn_gateway(gateway_exe: &Option<PathBuf>, web_dir: Option<&Path>) {
    let Some(exe) = gateway_exe else {
        eprintln!("[openlive-desktop] Gateway binary not found. Please run `cargo build -p openlive-gateway` first.");
        return;
    };

    let mut cmd = Command::new(exe);
    cmd.arg("--listen").arg(format!("127.0.0.1:{GATEWAY_PORT}"));
    if let Some(dir) = web_dir {
        cmd.arg("--web-dir").arg(dir);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    match cmd.spawn() {
        Ok(child) => {
            eprintln!("[openlive-desktop] Gateway spawned (pid {})", child.id());
            *GATEWAY_CHILD.lock().unwrap() = Some(child);
        }
        Err(e) => {
            eprintln!("[openlive-desktop] Failed to spawn gateway: {e}");
        }
    }
}

/// Poll the health endpoint until the gateway responds or we time out.
fn wait_for_gateway_ready() {
    let start = Instant::now();
    let timeout = Duration::from_secs(15);
    // Simple TCP connect check — avoids pulling in an HTTP client dependency.
    let addr = format!("127.0.0.1:{GATEWAY_PORT}");
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect(&addr).is_ok() {
            eprintln!("[openlive-desktop] Gateway is ready on :{GATEWAY_PORT}");
            // Small grace period so axum finishes route setup.
            std::thread::sleep(Duration::from_millis(300));
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    eprintln!(
        "[openlive-desktop] Gateway did not become ready within {}s. \
         The UI will still load — the gateway may start shortly after.",
        timeout.as_secs()
    );
}

/// Kill the gateway child process if it's still running.
fn kill_gateway() {
    if let Ok(mut guard) = GATEWAY_CHILD.lock() {
        if let Some(mut child) = guard.take() {
            // Try graceful kill first, then force.
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("[openlive-desktop] Gateway process stopped.");
        }
    }
}

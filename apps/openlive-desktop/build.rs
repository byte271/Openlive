// OpenLive 26.7.16 — desktop build script
//
// Stages the openlive-gateway binary next to the desktop crate so Tauri can
// bundle it as a resource. This runs before tauri_build::build() validates
// bundle.resources.
//
// The gateway must already be built (e.g. by beforeBuildCommand or manually
// with `cargo build -p openlive-gateway --release`). Set
// OPENLIVE_SKIP_GATEWAY_BUILD=1 to skip staging entirely (clippy/check).
// tauri_build still requires the resource path to exist, so the skip path
// writes a tiny placeholder file.

use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=OPENLIVE_SKIP_GATEWAY_BUILD");

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .expect("CARGO_MANIFEST_DIR not set");

    if std::env::var("OPENLIVE_SKIP_GATEWAY_BUILD").is_ok() {
        eprintln!(
            "[openlive-desktop/build] OPENLIVE_SKIP_GATEWAY_BUILD is set; skipping gateway staging."
        );
        write_placeholder_gateway(&manifest_dir);
        tauri_build::build();
        return;
    }

    // apps/openlive-desktop -> project root
    let project_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .expect("desktop crate must be two levels below project root");

    let gateway_name = if cfg!(windows) {
        "openlive-gateway.exe"
    } else {
        "openlive-gateway"
    };

    // Try release first, then debug. The beforeBuildCommand builds release;
    // debug is a convenience for local `cargo check` / `cargo tauri dev`.
    let src = [
        project_root.join("target/release").join(gateway_name),
        project_root.join("target/debug").join(gateway_name),
    ]
    .into_iter()
    .find(|p| p.exists())
    .unwrap_or_else(|| {
        panic!(
            "openlive-gateway binary not found. Build it first with:\n  cargo build -p openlive-gateway --release\nOr set OPENLIVE_SKIP_GATEWAY_BUILD=1 to skip staging."
        )
    });

    // Use a single cross-platform bundled name. Windows requires the .exe
    // extension for std::process::Command to find it; on macOS/Linux the
    // extension is harmless and keeps the config simple.
    let dst = gateway_resource_path(&manifest_dir);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).expect("failed to create target/release");
    }
    std::fs::copy(&src, &dst).expect("failed to stage gateway binary for bundling");

    eprintln!(
        "[openlive-desktop/build] Staged gateway for bundling: {}",
        dst.display()
    );

    tauri_build::build();
}

fn gateway_resource_path(manifest_dir: &Path) -> PathBuf {
    manifest_dir
        .join("target/release")
        .join("openlive-gateway-bundled.exe")
}

/// `tauri_build` validates `bundle.resources` even during clippy. A
/// placeholder keeps lint from requiring a real gateway binary.
fn write_placeholder_gateway(manifest_dir: &Path) {
    let dst = gateway_resource_path(manifest_dir);
    if dst.exists() {
        return;
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).expect("failed to create target/release");
    }
    std::fs::write(&dst, b"OPENLIVE_SKIP_GATEWAY_BUILD placeholder\n")
        .expect("failed to write placeholder gateway resource");
}

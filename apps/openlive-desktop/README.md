# OpenLive Desktop

Native desktop shells for OpenLive, built with [Tauri](https://tauri.app/) v2.

## Supported platforms

- Windows 10/11 (MSI installer)
- macOS 10.13+ (DMG / App bundle)

## Prerequisites

- [Rust](https://rustup.rs/) 1.83+
- Tauri CLI: `cargo install tauri-cli --version "^2.0"`

## Build

The desktop app is intentionally **not** part of the root Cargo workspace to
avoid dependency conflicts with the pinned `reqwest`/`url` versions used by the
gateway. Build the gateway first, then build the desktop app from this
directory:

```bash
# From the project root
cargo build -p openlive-gateway --release

# Then build the desktop app
cd apps/openlive-desktop
cargo tauri build
```

## Development

1. Start the gateway server:
   ```bash
   cargo run -p openlive-gateway
   ```
2. Run the desktop app in dev mode:
   ```bash
   cd apps/openlive-desktop
   cargo tauri dev
   ```

## Structure

- `src/main.rs` — minimal Tauri entry point
- `tauri.conf.json` — window, bundle, and security configuration
- `icons/` — Windows `.ico` and macOS `.icns` placeholder icons
- `Cargo.toml` — standalone workspace for the desktop app

## Notes

- The desktop shell loads the same web UI as the browser version.
- The gateway server must be running locally for the voice surface to work.
- Replace `icons/icon.ico` and `icons/icon.icns` with branded assets before
  publishing.

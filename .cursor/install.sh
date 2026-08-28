#!/usr/bin/env bash
# Cloud Agent install: pin Rust 1.98 (lockfile needs edition 2024 / rustc >= 1.85),
# then fetch and compile the workspace including test binaries.
set -euo pipefail

rustup toolchain install 1.98.0 --component rustfmt --component clippy --no-self-update
rustup default 1.98.0
cargo fetch --locked
cargo build --workspace --locked --all-targets

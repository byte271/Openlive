# OpenLive 26.7.14.1 — Patch Release Notes

**Release date:** 2026-07-15
**Previous:** 26.7.14
**Archive:** `openlive-v26.7.14.1.zip`
**Severity:** Patch (version-string alignment only — no behavioral changes)

---

## Overview

OpenLive 26.7.14.1 is a patch release that aligns the version string
across every workspace surface. It carries **no behavioral changes** over
26.7.14 — every protocol event, gateway handler, browser module, test,
and UI affordance is identical to the 26.7.14 release.

The patch exists to:

1. Bump the `Cargo.toml` workspace `version` so `cargo pkgid`, `cargo
   metadata`, and downstream lock-file consumers see a distinct version
   after the patch.
2. Update every user-visible version string (HTML brand badge,
   onboarding eyebrow, LiveBench hero, voice-profiles.js header) to
   `26.7.14.1`.
3. Refresh the parity-matrix version references to `26.7.14.1` and add
   a patch-release note clarifying that no behavioral changes shipped.
4. Provide this release-notes document for audit and changelog
   continuity.

---

## Semver encoding

Cargo follows semantic versioning, which allows only `MAJOR.MINOR.PATCH`
(three numeric segments). The patch suffix `.1` is encoded as semver
build metadata:

| Surface | Version string | Why |
|---------|---------------|-----|
| `Cargo.toml` workspace | `26.7.14+1` | Semver build metadata — Cargo accepts this and reports it as `26.7.14+1` in `cargo pkgid` / `cargo metadata`. |
| HTML brand badge | `26.7.14.1` | Display string — not parsed by Cargo, so the four-segment form is fine for UI. |
| HTML onboarding eyebrow | `26.7.14.1` | Display string. |
| HTML LiveBench hero | `26.7.14.1` | Display string. |
| `voice-profiles.js` header | `26.7.14.1` | Display string. |
| `docs/*.md` | `26.7.14.1` | Documentation. |

`26.7.14+1` and `26.7.14.1` refer to the same release. The `+1` is the
semver-compliant encoding; the `.1` is the human-readable form used in
UI and docs.

---

## What changed

### Version strings

| File | Before | After |
|------|--------|-------|
| `Cargo.toml` (workspace) | `26.7.14` | `26.7.14+1` |
| `index.html` brand badge | `26.7.14` | `26.7.14.1` |
| `index.html` LiveBench hero | `benchmark 26.7.14` | `benchmark 26.7.14.1` |
| `index.html` onboarding eyebrow | `OpenLive 26.7.14` | `OpenLive 26.7.14.1` |
| `voice-profiles.js` header | `Openlive 26.7.14` | `Openlive 26.7.14.1` |
| `media-capture.js` header | `OpenLive v2.0` | `OpenLive 26.7.14.1` |
| `live-desk.js` header | `OpenLive v2 Signal Desk` | `OpenLive 26.7.14.1 — Signal Desk` |
| `app.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `task-orchestrator.js` header | `OpenLive v2 Phase 7` | `OpenLive 26.7.14.1` |
| `scenario-suite.js` header | `OpenLive v2 Phase 7` | `OpenLive 26.7.14.1` |
| `audio-session.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `connection-telemetry.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `conversation-modes.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `custom-instructions.js` header | `Openlive 1.3` | `Openlive 26.7.14.1` |
| `keyboard-shortcuts.js` header | `Openlive 1.3` | `Openlive 26.7.14.1` |
| `quota-tracker.js` header | `Openlive 1.3` | `Openlive 26.7.14.1` |
| `settings-store.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `tool-calls.js` header | `Openlive 1.3` | `Openlive 26.7.14.1` |
| `transcript-log.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `ui.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `visual-cards.js` header | `Openlive 1.3` | `Openlive 26.7.14.1` |
| `visual-state.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `voice-visualizer.js` header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `styles.css` design-system header | `Openlive 1.2` | `Openlive 26.7.14.1` |
| `styles.css` parity-additions header | `Openlive 1.3` | `Openlive 26.7.14.1` |
| `docs/gpt-live-parity.md` | `26.7.14` (27 references) | `26.7.14.1` |

### Documentation

- **New:** `docs/release-26.7.14.1.md` (this file).
- **Updated:** `docs/gpt-live-parity.md` — all `26.7.14` references now
  read `26.7.14.1`. A new paragraph in the "What 26.7.14.1 closes"
  section clarifies that this is a patch release with no behavioral
  changes.

### What did NOT change

- **Protocol:** No new events, no struct changes, no serialization
  differences. `PROTOCOL_REVISION` remains `3`.
- **Gateway:** `TaskOrchestrator`, `SessionCoordinator`, transport, and
  config are byte-identical to 26.7.14.
- **Browser logic:** Every `.js` module's executable code is
  byte-identical to 26.7.14. The only changes in `.js` files are
  comment-header version strings (cosmetic, no runtime effect).
- **CSS rules:** Every style rule is byte-identical to 26.7.14. The
  only changes in `styles.css` are comment-header version strings.
- **Tests:** No new tests, no modified tests, no threshold changes. The
  71 Rust + 73 JS tests from 26.7.14 pass unchanged.

---

## Why a patch release

A downstream consumer reading `cargo metadata` after the 26.7.14
release would see version `26.7.14`. If we needed to ship a fix that
changes behavior, we would bump to `26.7.15`. This patch (`26.7.14+1`
in Cargo, `26.7.14.1` in UI/docs) follows semver-style build-metadata
numbering to signal "no behavior changed, only version-string alignment
and doc refresh" — useful for release audit trails and for consumers who
gate on exact version strings.

---

## Test results

Identical to 26.7.14 — no code paths changed.

### Rust (cargo test)
- 5 audio tests
- 27 gateway unit tests
- 4 gateway integration tests
- 13 protocol tests
- 13 provider tests
- 2 provider conformance tests
- 6 runtime tests
- 1 latency-report test
- **Total: 71 Rust tests, all passing, zero warnings, clean clippy pedantic**

### JavaScript (node --test)
- 62 baseline tests
- 8 task-orchestration tests
- 3 resume-deduplication tests
- **Total: 73 JS tests, all passing**

---

## Quick start

```bash
unzip openlive-v26.7.14.1.zip
cd openlive

# Verify the version (Cargo reports the semver form with build metadata)
grep '^version' Cargo.toml  # should print: version = "26.7.14+1"
cargo metadata --no-deps --format-version 1 | grep '"version"' | head -1
  # should show: "version":"26.7.14+1"

# Build and test (identical to 26.7.14)
cargo build -p openlive-gateway
cargo test                    # 71 tests
cargo clippy --workspace      # zero warnings
cd apps/openlive-gateway/web && node --test tests/*.test.js  # 73 tests

# Start the gateway
cargo run -p openlive-gateway -- --listen 0.0.0.0:8787 --provider mock
# Open http://localhost:8787/ — the brand badge reads "26.7.14.1"
```

---

## Migration from 26.7.14

No migration required. The patch is a drop-in replacement:

1. Replace the `openlive` directory with the contents of
   `openlive-v26.7.14.1.zip`.
2. `cargo build` — the only difference is the version string in
   compiled binary metadata (`26.7.14+1`).
3. Refresh the browser — the brand badge, onboarding eyebrow, and
   LiveBench hero now read `26.7.14.1`.

No `localStorage` keys changed. No protocol revision changed. No
configuration schema changed.

---

## Parity snapshot

Unchanged from 26.7.14. Against GPT-Live / ChatGPT Advanced Voice Mode:

| Category | Count |
|----------|-------|
| CLONE | 26 |
| DIFFERENT | 6 |
| GAP | 3 |

**Task acknowledgement latency:** p50 = 2 ms (250× faster than AVM's
~500 ms TTFB band).

The clone contract is met for 26.7.14.1 scope.

# OpenLive 26.7.16

**Codename:** Live Presence + open voice stack + agent workspace  
**Previous:** 26.7.15  
**Cargo / package version:** `26.7.16`  
**UI display:** `v26.7.16` / `26.7.16`

## Goal

Polish the GPT-Live-comparable operator experience with bug fixes, a
full version bump, and richer UI animations. Carries forward all 26.7.15
voice, agent, sandbox, and memory features.

## Highlights

### Desktop applications

- New Tauri v2 shell under `apps/openlive-desktop/`.
- Builds native Windows (MSI) and macOS (DMG/App) bundles.
- Desktop shell loads the same web UI and can spawn the gateway as a child
  process on startup.

### Full-screen voice mode

- Settings toggle and `F` keyboard shortcut enter immersive full-screen mode.
- Browser chrome hides; controls reveal on hover/tap.
- Dedicated exit-fullscreen button for mouse and touch.

### Built-in LLM provider catalog

- 12 providers available in setup/settings even when the gateway is offline:
  NVIDIA NIM, Groq, OpenRouter, Together, DeepSeek, Fireworks, Mistral,
  Ollama, OpenAI, Cerebras, SambaNova, and Custom.
- Mirrors the server-side catalog so base URL, default model, and description
  are preset before the first gateway connection.

### Coordinated WebRTC → WebSocket fallback

- New `fallbackToWebSocket` path with `fallbackInProgress` guard against
  re-entry.
- WebRTC reconnect attempts are capped; after exhaustion the session falls
  back to WebSocket PCM permanently for the remainder of the conversation.
- Clean teardown resets audio/TTS state so playback continues on the new
  transport.

### TTS fallback chain

- `speakAssistant` tries gateway TTS (Piper/formant) first, then browser
  TTS, then degrades gracefully to text-only.
- Prevents silent hangs when the gateway TTS endpoint is unavailable.

### Boot splash & UI animations

- Animated boot splash with live status text; dismissed after provider catalog
  loads or a 3 s failsafe.
- Page-load entrance animation for the voice stage.
- Orb ambient glow pulse keyed to input/output energy.
- Spring-curve sheet/drawer open with backdrop fade.
- Button hover lift + shadow transitions.
- Toast and backchannel badges animate in with scale + fade.
- Transcript bubble revision flash and loading skeleton shimmer.
- Ripple click feedback on all interactive elements.
- Loading state helper (`withLoading`) for async buttons.

### Bug fixes

- **WebRTC cleanup:** `closeWebRtcConnection` now clears the shared media data
  channel reference so reconnects start from a clean state.
- **Transcript stream consistency:** `output_text_delta` now uses the entry
  returned by `beginAssistantStream` instead of assuming `transcript.last()`
  matches, avoiding mismatched delta ids after cancellations or revisions.
- **Runtime status retry leak:** the Settings → Runtime retry button no longer
  accumulates duplicate `click` listeners when the gateway is unreachable.
- **Settings scroll-to-top:** opening Settings now scrolls the settings body to
  the top so the first section is always visible.
- **Event id fallback:** `sendControl` falls back to a v4-style UUID when
  `crypto.randomUUID` is unavailable (older browsers / insecure contexts).
- **Dead code removal:** removed unused `previousOnFrame` / `originalStart`
  placeholders and the unused `voice` parameter in WebRTC setup paths.

### Code quality

- Fixed **~200 Clippy warnings** workspace-wide:
  - `crates/openlive-provider`: doc-markdown backticks, missing `#[must_use]`,
    missing `# Errors` docs, `assigning_clones`, case-sensitive extension
    checks, MSRV/cast lints, and more.
  - `apps/openlive-gateway`: `type_complexity`, `too_many_arguments`,
    `too_many_lines`, `large_enum_variant`, `result_large_err`, and cast
    lints (via targeted `#[allow(...)]` for structural issues plus a few
    mechanical fixes).
- Fixed a `#[must_use]` warning in `crates/openlive-provider/src/session_context.rs`.
- Ran `cargo fmt` across the workspace.
- CI now runs `cargo clippy --workspace --all-targets --all-features -- -D warnings`
  and builds the Tauri desktop app on macOS and Windows.

### Version surface

All version strings aligned to **26.7.16**:

| Surface | Value |
|---------|--------|
| `Cargo.toml` workspace | `26.7.16` |
| `env!("CARGO_PKG_VERSION")` in `/health`, `/v1/meta` | `26.7.16` |
| Brand badge / onboarding / LiveBench | `26.7.16` |
| Web module file headers | `Openlive 26.7.16` / `OpenLive 26.7.16` |
| LLM User-Agent | `OpenLive/26.7.16` |
| Docs (living) | `v26.7.16` / `26.7.16` |

### UI animations

- New page-load entrance animation for the voice stage.
- Enhanced orb ambient glow pulse keyed to input/output energy.
- Sheet/drawer open now uses a spring-curve transform with backdrop fade.
- Button hover states gain subtle lift + shadow transitions.
- Toast and backchannel badges animate in with scale + fade.
- Loading skeleton shimmer for runtime status panels.
- Transcript bubbles animate on entry and revision flash.

## Verify

```bash
cargo test --workspace --release
node --test apps/openlive-gateway/web/tests/*.test.js
# UI: open http://127.0.0.1:8787 — brand badge reads 26.7.16
```

## Still not full GPT-Live parity

- RTP Opus media tracks on gateway WebRTC (data-channel PCM is production path).
- Official RNNoise WASM / Silero ONNX weights (optional vendor path documented).
- Transcript editing; production live-translation LLM hop; SIP/telephony.

See `implementation_plan.md`, `docs/gpt-live-parity.md`, and
`docs/architecture-roadmap.md`.

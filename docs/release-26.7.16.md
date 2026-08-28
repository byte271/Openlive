# OpenLive 26.7.16

**Codename:** Live Presence + call-first surface + open voice stack + agent workspace  
**Previous:** 26.7.15  
**Cargo / package version:** `26.7.16`  
**UI display:** `v26.7.16` / `26.7.16`

## Goal

Ship a GPT-Live-comparable **call** as the default experience: listening immediately, real neural voice (or silence), instant interrupt, minimal chrome. Architecture may stay rich; the default surface must feel light.

## Highlights

### Call-first UI

- First paint is the live call: **Bloub** face + **Mute / End / Settings** (Morphicons + Lucide data).
- Session **auto-joins**. Gesture-gated mic failures stay idle (**Tap to talk**) instead of dumping a lab error.
- No branded boot splash delay; the call surface is ready immediately.
- Sandbox, multi-agent, camera, screen share, presence playground, and diagnostics live in **Settings → Advanced** (collapsed by default).
- Optional setup wizard remains under Settings; it is not forced on launch.
- Desktop shell shows a local listening-orb splash, then navigates to the gateway once healthy — gateway spawn must not block first paint.

### Demo TTS policy: neural or silence

- Auto engine uses **Piper only**. If Piper is not ready, the path stays silent (no formant pad).
- Formant / browser TTS only when the user explicitly selects those engines.
- Avoids the audible fake→real switch that makes demos feel cheap.

### Interruption

- Local-first barge-in chain: `local duck → soft_duck → hard_yield → cancel generation`.
- VAD duck happens before waiting on full server RTT.

### Desktop applications

- Tauri v2 shell under `apps/openlive-desktop/`.
- Native Windows (MSI) and macOS (DMG/App) bundles.
- Clippy/check can set `OPENLIVE_SKIP_GATEWAY_BUILD=1`; a placeholder resource keeps `tauri_build` happy.

### Full-screen voice mode

- Settings toggle and `F` enter immersive full-screen mode.
- Dedicated exit-fullscreen control.

### Built-in LLM provider catalog

- Providers available in Settings even when the gateway is offline:
  NVIDIA NIM, Groq, OpenRouter, Together, DeepSeek, Fireworks, Mistral,
  Ollama, OpenAI, Cerebras, SambaNova, and Custom.

### Coordinated WebRTC → WebSocket fallback

- Guarded re-entry, retry cap, clean audio/TTS reset when falling back to WebSocket PCM.

### UI motion (without a forced splash)

- Orb / Bloub state mapping for listen / speak / barge-in / mute.
- Sheet spring entrance, toast/backchannel motion, transcript revision flash.
- Ripple click feedback on interactive controls.
- System UI fonts (no Google Fonts CDN on the default path).

### Agent, tools, sandbox, profile

- Internal agent tools: search, deep research pool, calculator, time, sandbox I/O, browse/shot/PDF, profile memory.
- Multi-agent pool (≤50), SSE progress, agent classes, destructive-action confirms.
- Durable profile facts + session memory export.

### Code quality & CI

- Workspace Clippy with `-D warnings`; desktop builds on macOS and Windows.
- Tauri CLI install uses `cargo install … --force` so cached runners stay healthy.

### Version surface

All version strings aligned to **26.7.16**:

| Surface | Value |
|---------|--------|
| `Cargo.toml` workspace | `26.7.16` |
| `/health`, `/v1/meta` | `26.7.16` |
| UI / LiveBench | `26.7.16` |
| LLM User-Agent | `OpenLive/26.7.16` |
| Living docs | `v26.7.16` / `26.7.16` |

## Verify

```bash
cargo test --workspace --release
node --test apps/openlive-gateway/web/tests/*.test.js
# UI: open http://127.0.0.1:8787 — call surface listens immediately
```

## Still not full GPT-Live parity

- RTP Opus media tracks on gateway WebRTC (data-channel PCM is the production path).
- Official RNNoise WASM / Silero ONNX weights (optional vendor path documented).
- Transcript editing; production live-translation LLM hop; SIP/telephony.

See `docs/gpt-live-parity.md`, `docs/architecture-roadmap.md`, and `implementation_plan.md`.

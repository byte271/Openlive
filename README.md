# OpenLive

OpenLive is an open, model-neutral runtime for continuous voice agents. It separates deadline-sensitive interaction continuity from slower model cognition and preserves native duplex provider capabilities instead of forcing every model through a text-chat abstraction.

## Current status

**Version 26.7.15** (`v26.7.15`) targets a **GPT-Live-comparable** experience: polished live voice UI, open neural speech (Piper), client-side audio intelligence, WebRTC session path, semantic endpointing, **real tools + multi-agent sandbox**, and durable profile/memory — with original visuals and model neutrality intact.

Full parity matrix: [`docs/gpt-live-parity.md`](docs/gpt-live-parity.md) · Architecture roadmap: [`docs/architecture-roadmap.md`](docs/architecture-roadmap.md) · Open stack guide: [`docs/open-source-stack.md`](docs/open-source-stack.md) · Credits: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) · Release notes: [`docs/release-26.7.15.md`](docs/release-26.7.15.md)

### What 26.7.15 ships

**Voice surface**

- Minimal black live surface + setup wizard; Live Presence theme tokens.
- Full-screen voice presence with 11 named modes and multi-layer procedural orb.
- Inline layout toggle, live dual transcript, conversation modes, speaking-style axes.
- Push-to-talk, barge-in with local duck, camera/screen share affordances, visual cards.
- **Piper-first voice roster** (Lessac, Amy, Ryan, …) plus API-compatible fallbacks.
- Brand chrome and package version: **26.7.15**.

**Open AI voice**

- Production path: cascade → OpenAI-compatible **Piper** TTS (via LocalAI, openedai-speech, or gateway-local Piper).
- Gateway: `GET /v1/tts/status`, `POST /v1/tts/speak`; formant fallback for demos.
- Licenses and attribution in `THIRD_PARTY_NOTICES.md`.

**Client audio intelligence**

- RNNoise-style noise suppression worklet (10 ms frames).
- Silero-style VAD worklet + energy blend.
- NLMS adaptive echo cancellation + windowed-sinc resampler.

**Agent, tools & sandbox**

- Internal agent (no OpenCode): search, deep research pool, calculator, time, identity, profile.
- Path-safe sandbox file I/O + optional Chrome/Edge headless browse / screenshot / PDF.
- Multi-agent pool (≤50) with SSE progress, agent classes, and destructive-action confirms.
- Durable user profile (facts editor, drag-and-drop reorder) + session memory export.
- See `sandbox/README.md` and `docs/architecture-roadmap.md`.

**Transport, providers & tasks**

- Binary WebSocket PCM + **gateway-native WebRTC** (DTLS data channels for events/PCM).
- Provider-edge WebRTC (OpenAI Realtime SDP) when secrets are available.
- `POST /v1/webrtc/offer` answers browser offers; `POST /v1/realtime/session` for edge secrets.
- **Moshi** native duplex: `--provider moshi --moshi-url ws://127.0.0.1:8998/api/chat`.
- Semantic endpointing (transcript-aware early end ~200 ms).
- Visual cards + live translation demo (mock) / language-mode instructions.
- Task lifecycle, evidence links, resume with dedup.
- Configurable `--task-deadline-ms`.
- Developer API: `GET /health`, `/v1/meta`, `/v1/sessions`, `/v1/agent/*`, `/v1/sandbox/*`, `/v1/profile`, MCP tools (+ optional API key).
- Session persistence (JSONL under `data/openlive-sessions`), streaming safety holdback, MCP HTTP client.

### Still missing (vs full GPT-Live)

- Full RTP Opus media plane with packet FEC (data-channel PCM works today).
- Official RNNoise WASM / Silero ONNX vendor weights (interfaces ready).
- Transcript editing; production live-translation LLM hop.

## Requirements

- Rust 1.83 or newer.
- A modern Chromium, Firefox, or Safari browser.
- Microphone permission.

## Run the offline mock

```bash
cargo run -p openlive-gateway --release
```

Open `http://127.0.0.1:8787` and select **Start** (or press `Space` in push-to-talk mode). The mock speaks with a lightweight formant voice so you can exercise barge-in, transcript, and tasks without external services.

## Run open-source neural voice (recommended)

Use any OpenAI-compatible stack that exposes:

- `POST /v1/audio/transcriptions`
- `POST /v1/chat/completions`
- `POST /v1/audio/speech` with `response_format: "pcm"` (24 kHz mono PCM16 preferred)

Example with Piper-style voice ids:

```bash
# API keys: set in the environment only — never commit keys into this repo.
# omit or leave empty for local unauthenticated servers
export OPENLIVE_MODEL_API_KEY

cargo run -p openlive-gateway --release -- \
  --provider openai-compatible \
  --model-base-url http://127.0.0.1:8000/v1 \
  --asr-model whisper-1 \
  --llm-model your-chat-model \
  --tts-model tts-1 \
  --voice en_US-lessac-medium
```

See [`docs/open-source-stack.md`](docs/open-source-stack.md) for LocalAI / openedai-speech / Piper wiring.

## Run a native realtime speech endpoint

```bash
# Read the key from your shell environment (do not put keys in project files)
export OPENLIVE_MODEL_API_KEY

cargo run -p openlive-gateway --release -- \
  --provider openai-realtime \
  --realtime-url wss://api.openai.com/v1/realtime \
  --realtime-model your-realtime-model \
  --voice alloy
```

## Deterministic replay

```bash
cargo run -p openlive-runtime --bin openlive-replay -- \
  --input fixtures/turn-completion.jsonl
```

## Persistence, safety & MCP

```bash
# Default: write session events/tasks under data/openlive-sessions
cargo run -p openlive-gateway --release

# Disable durability or safety:
cargo run -p openlive-gateway --release -- --no-persist --safety false

# Attach a remote MCP tool host:
cargo run -p openlive-gateway --release -- --mcp-url http://127.0.0.1:3100/mcp

# Deep model + local knowledge notes for complex turns:
cargo run -p openlive-gateway --release -- \
  --provider openai-compatible \
  --model-base-url http://127.0.0.1:8000/v1 \
  --llm-model llama3.2 \
  --deep-llm-model qwen2.5-32b \
  --knowledge-dir ./knowledge

# Hybrid: fast local duplex + deep cascade for hard turns
cargo run -p openlive-gateway --release -- \
  --provider hybrid \
  --model-base-url http://127.0.0.1:8000/v1

# Local Chronos full-duplex latency gate
cargo run -p openlive-runtime --release --bin openlive-full-duplex-bench -- --turns 50
```

## Tests

```bash
cargo test --workspace --release
# Integration tests need a debug binary:
cargo build -p openlive-gateway && cargo test -p openlive-gateway --test task_lifecycle
node --test apps/openlive-gateway/web/tests/*.test.js
```

## License

Apache-2.0 for OpenLive source. Third-party speech stacks (Piper, etc.) have their own licenses — see `THIRD_PARTY_NOTICES.md`. Prefer running GPL TTS servers **out-of-process** over HTTP.

# OpenLive

OpenLive is an open, model-neutral runtime for continuous voice agents. It separates deadline-sensitive interaction continuity from slower model cognition and preserves native duplex provider capabilities instead of forcing every model through a text-chat abstraction.

> [!IMPORTANT]
> **Disclaimer:** This is an independent open-source project. It is **not an official OpenAI project** and has no affiliation with OpenAI or xAI.

## Current status

**Version 26.7.16** targets a **GPT-Live-comparable** experience: a call-first live surface, open neural speech (Piper), client-side audio intelligence, WebRTC session path, semantic endpointing, **real tools + multi-agent sandbox**, and durable profile/memory — with original visuals and model neutrality intact.

Full parity matrix: [`docs/gpt-live-parity.md`](docs/gpt-live-parity.md) · Architecture roadmap: [`docs/architecture-roadmap.md`](docs/architecture-roadmap.md) · Open stack guide: [`docs/open-source-stack.md`](docs/open-source-stack.md) · Credits: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) · Release notes: [`docs/release-26.7.16.md`](docs/release-26.7.16.md)

### What 26.7.16 ships

**Call-first voice surface**

- First paint is a live call: **Bloub** face on a black stage + **Mute / End / Settings** (Morphicons).
- Session **auto-joins**. If the browser needs a gesture for the mic, the surface says **Tap to talk**.
- Lab chrome (camera, screen share, sandbox, multi-agent, diagnostics) lives in **Settings → Advanced**.
- Optional setup wizard remains available from Settings; it is not forced on launch.
- Full-screen mode, live transcript, conversation modes, and speaking-style axes stay available behind Settings / shortcuts.
- **Demo TTS policy: neural or silence.** Auto never pads with formant/mock. Formant only when you explicitly pick it.
- Package version: **26.7.16**.

**Open AI voice**

- Production path: cascade → OpenAI-compatible **Piper** TTS (via LocalAI, openedai-speech, or gateway-local Piper).
- Gateway: `GET /v1/tts/status`, `POST /v1/tts/speak`.
- Auto engine = Piper or silence until ready; browser / formant only when selected in Settings.
- Licenses and attribution in `THIRD_PARTY_NOTICES.md`.

**Client audio intelligence**

- RNNoise-style noise suppression worklet (10 ms frames).
- Silero-style VAD worklet + energy blend.
- NLMS adaptive echo cancellation + windowed-sinc resampler.
- Local-first barge-in: `local duck → soft_duck → hard_yield → cancel`.

**Agent, tools & sandbox**

- Internal agent (no OpenCode): search, deep research pool, calculator, time, identity, profile.
- Path-safe sandbox file I/O + optional Chrome/Edge headless browse / screenshot / PDF.
- Multi-agent pool (≤50) with SSE progress, agent classes, and destructive-action confirms.
- Durable user profile (facts editor) + session memory export.
- See `sandbox/README.md` and `docs/architecture-roadmap.md`.

**Transport, providers & tasks**

- Binary WebSocket PCM + **gateway-native WebRTC** (DTLS data channels for events/PCM).
- Provider-edge WebRTC (OpenAI Realtime SDP) when secrets are available.
- **Coordinated WebRTC → WebSocket fallback** with clean audio/TTS state reset.
- `POST /v1/webrtc/offer` answers browser offers; `POST /v1/realtime/session` for edge secrets.
- **Moshi** native duplex: `--provider moshi --moshi-url ws://127.0.0.1:8998/api/chat`.
- Built-in LLM provider catalog (NVIDIA NIM, Groq, OpenRouter, Ollama, …) in Settings.
- Semantic endpointing (transcript-aware early end ~200 ms).
- Task lifecycle, evidence links, resume with dedup.
- Developer API: `GET /health`, `/v1/meta`, `/v1/sessions`, `/v1/agent/*`, `/v1/sandbox/*`, `/v1/profile`, MCP tools.

**Desktop**

- **Tauri** shells for Windows (MSI) and macOS (DMG/App) in `apps/openlive-desktop/`.
- Local listening-orb splash first; gateway spawn must not block first paint.

### Still missing (vs full GPT-Live)

- Full RTP Opus media plane with packet FEC (data-channel PCM works today).
- Official RNNoise WASM / Silero ONNX vendor weights (interfaces ready).
- Transcript editing; production live-translation LLM hop.

## Requirements

- Rust 1.83 or newer (CI / lockfile may require newer for builds; prefer a recent stable).
- A modern Chromium, Firefox, or Safari browser.
- Microphone permission.

## Run the offline mock

```bash
cargo run -p openlive-gateway --release
```

Open `http://127.0.0.1:8787`. You should land on the listening call surface immediately. Talk (or tap the orb / Mute if the browser gated the mic). Prefer installing Piper for real voice; without it the demo path stays silent rather than faking a formant pad.

## Run open-source neural voice (recommended)

Use any OpenAI-compatible stack that exposes:

- `POST /v1/audio/transcriptions`
- `POST /v1/chat/completions`
- `POST /v1/audio/speech` with `response_format: "pcm"` (24 kHz mono PCM16 preferred)

```bash
# API keys: set in the environment only — never commit keys into this repo.
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
export OPENLIVE_MODEL_API_KEY

cargo run -p openlive-gateway --release -- \
  --provider openai-realtime \
  --realtime-url wss://api.openai.com/v1/realtime \
  --realtime-model your-realtime-model \
  --voice alloy
```

## Desktop app (Windows / macOS)

```bash
cargo build -p openlive-gateway --release
cd apps/openlive-desktop
cargo tauri build
```

See [`apps/openlive-desktop/README.md`](apps/openlive-desktop/README.md).

## Deterministic replay

```bash
cargo run -p openlive-runtime --bin openlive-replay -- \
  --input fixtures/turn-completion.jsonl
```

## Persistence, safety & MCP

```bash
cargo run -p openlive-gateway --release

cargo run -p openlive-gateway --release -- --no-persist --safety false

cargo run -p openlive-gateway --release -- --mcp-url http://127.0.0.1:3100/mcp

cargo run -p openlive-gateway --release -- \
  --provider openai-compatible \
  --model-base-url http://127.0.0.1:8000/v1 \
  --llm-model llama3.2 \
  --deep-llm-model qwen2.5-32b \
  --knowledge-dir ./knowledge

cargo run -p openlive-gateway --release -- \
  --provider hybrid \
  --model-base-url http://127.0.0.1:8000/v1

cargo run -p openlive-runtime --release --bin openlive-full-duplex-bench -- --turns 50
```

## Tests

```bash
cargo test --workspace --release
cargo build -p openlive-gateway && cargo test -p openlive-gateway --test task_lifecycle
node --test apps/openlive-gateway/web/tests/*.test.js
```

## License

Apache-2.0 for OpenLive source. Third-party speech stacks (Piper, etc.) have their own licenses — see `THIRD_PARTY_NOTICES.md`. Prefer running GPL TTS servers **out-of-process** over HTTP.

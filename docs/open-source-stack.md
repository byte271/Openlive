# OpenLive open-source stack (v26.7.15)

OpenLive is model-neutral. For a **GPT-Live-comparable experience without
proprietary voice APIs**, run the cascade against well-maintained open projects
and keep credits/licenses intact (see [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)).

Release notes: [`release-26.7.15.md`](release-26.7.15.md) · Sandbox: [`../sandbox/README.md`](../sandbox/README.md)

## Recommended production voice path

| Role | Open project | Why |
|------|----------------|-----|
| **TTS (AI voice)** | [Piper](https://github.com/OHF-Voice/piper1-gpl) (GPL-3.0) via [openedai-speech](https://github.com/matatonic/openedai-speech) or [LocalAI](https://localai.io/) | Fast neural CPU TTS; OpenAI `/v1/audio/speech` compatible |
| **ASR** | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) / Whisper.cpp / LocalAI | OpenAI `/v1/audio/transcriptions` compatible |
| **LLM** | Any OpenAI-compatible chat API (Ollama, vLLM, LocalAI, llama.cpp server) | Cascaded cognition |
| **Noise suppression** | RNNoise algorithm family (browser worklet; optional WASM later) | Classic 10 ms frames |
| **VAD** | Silero-style spectral VAD worklet (optional ONNX later) | Client endpointing prior |

### Example: Piper + Local stack

```bash
# 1) Start an OpenAI-compatible speech stack that serves Piper (openedai-speech, LocalAI, etc.)
#    Example base URL only — follow that project's README for exact Docker/run commands.

# 2) Point OpenLive cascade at it:
# optional if local and unauthenticated — set in the shell only, never in repo files
export OPENLIVE_MODEL_API_KEY

cargo run -p openlive-gateway --release -- \
  --provider openai-compatible \
  --model-base-url http://127.0.0.1:8000/v1 \
  --asr-model whisper-1 \
  --llm-model llama3.2 \
  --tts-model tts-1 \
  --voice en_US-lessac-medium
```

Piper voice IDs commonly used with compatible servers:

- `en_US-lessac-medium` — clear US English (default recommendation)
- `en_US-amy-medium` — warm conversational
- `en_US-ryan-high` — lower, direct
- `en_GB-alba-medium` — British

Pick voices that your TTS server actually installs; OpenLive forwards the
`voice` field to `/v1/audio/speech`.

## Offline mock (no external services)

```bash
cargo run -p openlive-gateway --release
```

The mock provider uses an **original formant synthesizer** so the desk is
demoable without GPU or network. It is **not** production TTS — switch to
Piper for a real AI voice.

## Browser audio intelligence

Client pipeline (Phase 1):

`mic → RNNoise-style worklet → Silero-style VAD worklet → NLMS AEC → FIR resample`

Algorithms are implemented in-tree for zero-npm install and offline use.
Design lineage and licenses are listed in `THIRD_PARTY_NOTICES.md`. When
vendoring official WASM/ONNX weights later, drop them under
`apps/openlive-gateway/web/vendor/` and keep notices updated.

## Native duplex (Moshi)

[Kyutai Moshi](https://github.com/kyutai-labs/moshi) (Apache-2.0) is a full-duplex
speech model. OpenLive includes a **Moshi-compatible WebSocket adapter**:

```bash
# Start your Moshi (or compatible) server, then:
cargo run -p openlive-gateway --release -- \
  --provider moshi \
  --moshi-url ws://127.0.0.1:8998/api/chat \
  --voice default
```

Wire dialect (binary PCM16 LE + JSON text control) is documented in
`crates/openlive-provider/src/moshi.rs`. Use a thin shim if your Moshi server
uses a different message layout.

## Developer REST API

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness + uptime + active sessions |
| `GET /v1/meta` | Version, protocol revision, feature flags |
| `GET /v1/providers` | Active provider manifest + features |
| `GET /v1/sessions` | Active realtime sessions |
| `POST /v1/realtime/session` | Ephemeral WebRTC client secret |
| `POST /v1/tasks` | Task payload validation hint (live tasks still use WS) |
| `GET /v1/sessions/{id}/tasks` | Persisted task snapshots |
| `GET /v1/webrtc/ice` | STUN ICE servers for browser WebRTC |
| `GET /v1/mcp/tools` | List remote MCP tools (`--mcp-url`) |
| `POST /v1/mcp/call` | Invoke MCP tool |

Optional auth: set `--api-key` / `OPENLIVE_API_KEY` and send
`Authorization: Bearer …` or `X-OpenLive-Key`.

Session durability defaults to `data/openlive-sessions/` (JSONL). Disable with
`--no-persist`. Streaming safety holdback is on by default (`--safety false` to
disable).

### Deep cognition + knowledge notes

```bash
# Fast model + optional deeper model for complex turns:
cargo run -p openlive-gateway --release -- \
  --provider openai-compatible \
  --model-base-url http://127.0.0.1:8000/v1 \
  --llm-model llama3.2 \
  --deep-llm-model qwen2.5-32b \
  --knowledge-dir ./knowledge

# Drop operator notes as knowledge/*.md for pause-time retrieval inject.
```

## WebRTC

Browser WebRTC to OpenAI-compatible Realtime SDP is supported when the
provider mints ephemeral client secrets. Fully self-hosted ICE/DTLS/SRTP
on the Rust gateway remains a follow-on (tracked in `implementation_plan.md`).

## UI

Default theme is **Live Presence** (`chatgpt` token) — an original OpenLive
visual inspired by modern voice-mode UX, not a proprietary asset clone.

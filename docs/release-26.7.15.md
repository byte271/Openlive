# OpenLive 26.7.15

**Codename:** Live Presence + open voice stack + agent workspace  
**Previous:** 26.7.14.1  
**Cargo / package version:** `26.7.15`  
**UI display:** `v26.7.15` / `26.7.15`

## Goal

Ship a **GPT-Live-comparable** operator experience: polished live voice UI,
open-source neural voice path (Piper), client audio intelligence, real tools
with sandbox + multi-agent pool, durable profile/memory, and clear third-party
credits — without cloning proprietary assets.

## Highlights

### Open AI voice (Piper-first)

- Default CLI voice id: `en_US-lessac-medium` (Piper).
- Offline voice picker lists **Piper voices first**, then API-compatible ids.
- Gateway TTS: `GET /v1/tts/status`, `POST /v1/tts/speak` with Piper install
  helpers and **formant synthesizer** fallback for demos without GPU/network.
- Documented cascade against LocalAI / openedai-speech / any OpenAI-compatible
  ASR + chat + PCM TTS stack (`docs/open-source-stack.md`).
- Mock provider upgraded from pure tones to an original formant synthesizer
  (not a substitute for Piper).

### Internal agent + tools (no OpenCode)

- Built-in agent client (`openlive-provider` → `AgentClient`) with tool loop:
  `web_search`, `deep_search`, `research_pool`, `calculator`, `get_time`,
  `identity`, sandbox `list_file` / `read_file` / `write_file` / `delete_file`,
  `browse_url` / `browse_site`, optional headless `screenshot_url` / `print_pdf`,
  `save_note`, `get_profile` / `remember_fact`.
- Typo correction for ASR/search (`POST /v1/typo/correct`).
- Thought depth: voice / balanced / deep (drives reply length + research pool).
- Model HTTP status plumbing on `/v1/agent/run` and `/v1/llm/*` errors.
- Confirm gate for destructive sandbox writes/deletes (`needs_confirm`,
  `POST /v1/agent/confirm`, voice yes/no + UI modal).

### Multi-agent pool (≤50)

- `POST /v1/agent/pool` — sync pool run (default 4 search workers).
- `POST /v1/agent/pool/start` + `GET /v1/agent/pool/status` +
  `GET /v1/agent/pool/events` (SSE) for live deep research progress.
- Agent classes: `general` | `researcher` | `coder` | `safe` with tool allow-lists
  (`GET /v1/agent/classes`).
- Live UI research strip + Settings **Demo deep pool**.

### Sandbox workspace

- Path-safe workspace under `%LOCALAPPDATA%\openlive\sandbox` (Windows) /
  platform data dir elsewhere.
- REST: status, list, read, write, delete, browse, screenshot, PDF, media list/read,
  browser status, lab status, self-test runner.
- Optional Chrome/Edge headless: dump-dom, screenshots → `workspace/lab/screenshots`,
  PDF → `workspace/lab/pdfs`, media gallery in Settings.
- Never unrestricted host FS — all paths confined to sandbox root.

### Durable profile + session memory

- Profile: `GET|POST /v1/profile`, export/clear, fact remove/update/move/reorder/clear.
- Settings profile editor (name, timezone, notes, facts) with drag-and-drop reorder.
- Session memory JSON store + export/clear; inject into LLM context.
- Multi-turn session ring on server + client transcript prior.
- `GET /v1/agent/session/stats` for ring stats.

### Client audio intelligence (Phase 1)

- Capture graph: **RNNoise-style worklet → Silero-style VAD → NLMS AEC →
  windowed-sinc resample**.
- Algorithms implemented in-tree; lineage credited in `THIRD_PARTY_NOTICES.md`.

### Web UI quality

- Minimal black live surface + setup wizard; **Live Presence** theme tokens.
- Latency pill; Settings credits for Piper / Silero / RNNoise.
- Onboarding and version chrome: **26.7.15**.
- Setup store key: `openlive.v26.7.15.setup`.

### Transport & playout

- WebRTC ephemeral session route (`POST /v1/realtime/session`) + silent renegotiation.
- **Statistics-based jitter controller** and **pitch-period PLC** on WebSocket PCM.
- Transport ribbon updates to `WebRTC · Opus` when the peer path is live.
- `POST /v1/webrtc/offer` — gateway-native SDP answer (webrtc-rs) with
  `openlive-events` + `openlive-media` data channels.

### Transcript & cascade

- In-place **ASR revision** model (`reviseText`) with UI flash animation.
- Cascade ASR uses a **~400 ms overlapping prior** window across turns.

### Emotion-aware VAD

- Client `emotion-detector.js` modulates local barge-in and unduck timing.

### Runtime & developer API

- `--task-deadline-ms`, semantic endpointing path, enriched `GET /v1/providers`.
- `--provider moshi`, hybrid, openai-compatible, openai-realtime, mock.
- `GET /health`, `GET /v1/meta`, `GET /v1/sessions`, `POST /v1/tasks` hint.
- Optional `OPENLIVE_API_KEY` / `--api-key` for mutating routes.
- Protocol revision **4**: `VisualCard` events; language chip translate mode.
- JSONL session store (`--data-dir`, `--no-persist`); streaming safety (`--safety`).
- MCP HTTP JSON-RPC: `--mcp-url`, `GET /v1/mcp/tools`, `POST /v1/mcp/call`.
- Cascade `--deep-llm-model`, `--knowledge-dir`, transcript export.

### Credits & licensing

- `THIRD_PARTY_NOTICES.md` with Piper, Moshi, openedai-speech, LocalAI, RNNoise,
  Silero VAD, and font attributions.
- Preferred deployment keeps GPL speech servers **out-of-process**.

## Version surface

| Surface | Value |
|---------|--------|
| `Cargo.toml` workspace | `26.7.15` |
| `env!("CARGO_PKG_VERSION")` in `/health`, `/v1/meta` | `26.7.15` |
| Brand badge / onboarding / LiveBench | `26.7.15` |
| Web module file headers | `Openlive 26.7.15` / `OpenLive 26.7.15` |
| LLM User-Agent | `OpenLive/26.7.15` |
| Docs (living) | `v26.7.15` / `26.7.15` |

Historical notes `docs/release-26.7.14.md` and `docs/release-26.7.14.1.md`
remain as release history and are **not** rewritten to this version.

## Verify

```bash
cargo test --workspace --release
node --test apps/openlive-gateway/web/tests/*.test.js
# UI: open http://127.0.0.1:8787 — brand badge reads 26.7.15
```

## Still not full GPT-Live parity

- RTP Opus media tracks on gateway WebRTC (data-channel PCM is production path).
- Official RNNoise WASM / Silero ONNX weights (optional vendor path documented).
- Transcript editing; production live-translation LLM hop; SIP/telephony.

See `implementation_plan.md`, `docs/gpt-live-parity.md`, and
`docs/architecture-roadmap.md`.

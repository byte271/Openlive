# OpenLive

OpenLive is an open, model-neutral runtime for continuous voice agents. It separates deadline-sensitive interaction continuity from slower model cognition and preserves native duplex provider capabilities instead of forcing every model through a text-chat abstraction.

## Current status

**Version 26.7.14.1 is the current release.** It folds the v2.0.0 Phase 7/8 task orchestration work into the mainline version line, making OpenLive a credible open-source clone of the GPT-Live / ChatGPT Advanced Voice Mode (AVM) voice surface — original visual identity preserved, proprietary assets avoided, and the model-neutral runtime intact. It is not a GPT-Live-equivalent model. The full parity matrix lives in [`docs/gpt-live-parity.md`](docs/gpt-live-parity.md); the underlying research is in [`docs/gpt-live-benchmark.md`](docs/gpt-live-benchmark.md).

### What 26.7.14.1 ships

**Voice surface (CLONE parity with AVM):**

- Original full-screen voice presence with 11 named modes (idle, starting, listening, thinking, speaking, yielding, interrupted, muted, reconnecting, connection_error, error), each with its own palette.
- Multi-layer procedural orb: outer aura, energy ribbons, procedural body with barge-in jitter, inner core glow, and a barge-in ripple that radiates when the local duck fires.
- Inline layout toggle — focused (orb-centered) vs inline (orb shrinks to header-indicator scale, transcript beside orb), mirroring AVM's late-2025 redesign.
- Live dual transcript (user + assistant) with role-differentiated bubbles and a system channel.
- In-app voice picker sourced from the provider manifest, with an offline roster fallback. Voices shown in the AVM pattern: name + one-line personality descriptor.
- Five conversation mode presets — Open, Brainstorm, Interview, Language tutor, Stand-up.
- Per-call instruction overrides (Pace, Detail, Complexity, Tone) via an inline Speaking Style panel.
- Optional push-to-talk entry mode (hold space or hold the primary button).
- Backchannel badge ("mhmm" cue) near the orb.
- Camera & screen-share affordances with truthful media lifecycle (local preview until explicit snapshot).
- Rich visual cards (weather, stock, sports, maps, web_search, code, translation) + tool-call cards in transcript.
- Three themes (Aurora, Graphite, Signal) + motion-intensity slider.
- Live latency pill, diagnostics drawer, first-run onboarding, settings persistence.

**Task & evidence orchestration (DIFFERENT — OpenLive original, exceeds AVM):**

- `task_requested` → `task_acknowledged` → `task_outcome` lifecycle with deadline enforcement, cancel, and generation-scoped completion. Measured p50 = 2 ms, p95 = 2 ms over 50 samples (250× faster than AVM's ~500 ms TTFB band).
- Bidirectional `evidence_link` events with `TaskProof` / `TaskContext` / `TaskFailure` link types and confidence scores.
- `session_resume` with gateway-side `event_id` dedup and 30 s buffered-outcomes TTL. Resume replay is O(log n) via `BTreeMap` range queries.
- LiveBench scenario suite: 3 deterministic scenarios (acknowledgement latency, evidence linkage completeness, resume without duplication).

**Runtime & protocol:**

- Protocol 1.0 (revision 3) with JSON control events and compact binary PCM media packets. Additive v2 events: `capability_offer` / `capability_selected`, `visual_input` / `visual_input_accepted` / `visual_input_rejected`, `task_requested` / `task_acknowledged` / `task_cancel` / `task_outcome`, `evidence_link`, `session_resume`.
- Strict monotonic client/server sequence and media-time validation.
- Chronos pause, overlap, reversible duck, hard-yield, and cancellation policy.
- Browser-local speech confidence and gain ducking before a network round trip.
- Adaptive 30–120 ms playback target with underflow-driven jitter recovery.
- Sample-aligned browser output-reference correlation over a bounded 500 ms ring.
- Long-lived bidirectional provider sessions that accept audio during output.
- Deterministic answer leases, conversation versions, and stale-event suppression.
- Generation-scoped monotonic latency telemetry and percentile reports.
- Deterministic JSONL replay (`openlive-replay`) and latency reporting (`openlive-latency-report`).

**Workspace quality:**

- Rust workspace with `unsafe_code = "forbid"` and strict Clippy pedantic (zero warnings).
- 71 Rust tests + 73 JS tests, all passing.
- 4 integration tests that spawn the real gateway binary and exercise the full task lifecycle over a WebSocket.

### Still missing

- WebRTC/Opus transport with packet-level FEC and loss concealment (largest remaining gap).
- SIP / telephony transport.
- Adaptive acoustic echo cancellation and target-speaker attribution.
- Streaming ASR revisions and semantic endpointing.
- Live translation (UI ready, needs translation LLM hop).
- Transcript editing (read-only today).
- A production-tested open-source native speech-to-speech worker.

## Requirements

- Rust 1.83 or newer.
- A modern Chromium, Firefox, or Safari browser.
- Microphone permission.

## Run the offline mock

```bash
cargo run -p openlive-gateway
```

Open `http://127.0.0.1:8787` and select **Start** (or press `Space` in push-to-talk mode). Speak, pause, then speak over the generated tone. The browser should duck output immediately; Chronos then resumes after brief overlap or cancels after confirmed barge-in. Toggle the transcript with `T`, diagnostics with `D`, voice picker with `V`, conversation mode with `M`, custom instructions with `I`, layout with `L`, camera with `C`, and screen share with `Shift+C`.

To issue a task, click **+ New** in the Tasks rail (right sidebar) and type an intent. The gateway acknowledges it within milliseconds and emits a `task_outcome` when the next generation completes.

## Run an OpenAI-compatible speech cascade

The endpoint must implement:

- `POST /v1/audio/transcriptions` with WAV input;
- `POST /v1/chat/completions`;
- `POST /v1/audio/speech` with `response_format: "pcm"` returning 24 kHz mono signed 16-bit little-endian PCM.

```bash
export OPENLIVE_MODEL_API_KEY="replace-if-required"

cargo run -p openlive-gateway -- \
  --provider openai-compatible \
  --model-base-url https://example.invalid/v1 \
  --asr-model whisper-1 \
  --llm-model your-chat-model \
  --tts-model your-tts-model \
  --voice alloy
```

For a local endpoint without authentication, omit the environment variable. The key is read only by the gateway and is never included in events or logs.

## Run a native realtime speech endpoint

The endpoint must implement the OpenAI Realtime WebSocket event shape. Audio is 24 kHz mono PCM16 in both directions.

```bash
export OPENLIVE_MODEL_API_KEY="replace-if-required"

cargo run -p openlive-gateway -- \
  --provider openai-realtime \
  --realtime-url wss://api.openai.com/v1/realtime \
  --realtime-model your-realtime-model \
  --voice alloy
```

The URL is configurable, so a self-hosted compatible server can be used without authentication.

## Deterministic replay

```bash
cargo run -p openlive-runtime --bin openlive-replay -- \
  fixtures/turn-completion.jsonl
```

The same fixture produces the same interaction event IDs and decisions.

## Latency report

Capture gateway events as JSONL, then summarize generation phases:

```bash
cargo run -p openlive-runtime --bin openlive-latency-report -- \
  fixtures/latency-sample.jsonl
```

The included fixture validates report parsing only; its values are not performance claims. See [`docs/evaluation.md`](docs/evaluation.md).

## Quality commands

```bash
cargo fmt --all --check
cargo check --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
node --test apps/openlive-gateway/web/tests/*.test.js
```

## Workspace

```text
apps/openlive-gateway/       Gateway, WebSocket transport, and immersive browser voice client
  web/                       Voice surface: orb, transcript, voice picker, mode picker,
                             settings sheet, diagnostics, onboarding, keyboard shortcuts
                             task rail, LiveBench scenario suite
  tests/                     Integration tests: full task lifecycle over real WebSocket
crates/openlive-audio/       Acoustic analysis and endpointing
crates/openlive-protocol/    Control events, binary media codec, provider manifests,
                             task/evidence/resume protocol events (revision 3)
crates/openlive-provider/    Bidirectional mock, cascade, and realtime adapters
crates/openlive-runtime/     Chronos, answer leases, and deterministic replay
fixtures/                    Versioned event recordings
docs/                        Architecture, adapter guidance, release notes, gpt-live benchmark
```

## Protocol principles

- Media time is authoritative; wall-clock arrival order is not.
- Output is not complete until the client confirms playout.
- Every response attempt has a generation ID and answer lease.
- A new user turn invalidates older cognition and provider output.
- Cancellation names an exact generation and requested audio cutoff.
- Native duplex capabilities remain visible in the provider manifest.
- Tasks are only completed by the generation they are bound to.
- Evidence is classified from real event types — never fabricated.
- Resume replay deduplicates by `event_id` — the ledger is append-only.

## GPT-Live parity snapshot

Against ChatGPT Advanced Voice Mode / GPT-Live:

| Category | Count | Notes |
|----------|-------|-------|
| CLONE | 26 | Every user-visible affordance AVM exposes |
| DIFFERENT | 6 | Deliberate improvements (push-to-talk, diagnostics, model neutrality, deterministic replay, resume with dedup, task lifecycle) |
| GAP | 3 | WebRTC+Opus, SIP, semantic VAD (all transport-layer) |

**Task acknowledgement latency:** p50 = 2 ms (250× faster than AVM's ~500 ms TTFB band).

See [`docs/gpt-live-parity.md`](docs/gpt-live-parity.md) for the full 43-row feature matrix.

## Release history

- **26.7.14.1** (2026-07-15) — Patch: version-string alignment, all docs refreshed. [`docs/release-26.7.14.1.md`](docs/release-26.7.14.1.md)
- **26.7.14** (2026-07-14) — Mainline: v2.0.0 Phase 7/8 task orchestration folded in. O(log n) resume replay. Latency benchmark. [`docs/release-26.7.14.md`](docs/release-26.7.14.md)
- **1.3** — gpt-live parity release (inline layout, backchannel, camera/screen UI, quota pill, custom instructions, tool-call cards, visual cards). [`docs/release-1.3.md`](docs/release-1.3.md)
- **1.2** — Redesigned voice surface, voice picker, mode presets, push-to-talk, latency pill, multi-layer orb, themes, onboarding. [`docs/release-1.2.md`](docs/release-1.2.md)
- **1.1** — Initial open runtime. [`docs/release-1.1.md`](docs/release-1.1.md)

## Next milestone

1. WebRTC/Opus with FEC, PLC, and congestion-aware media transport.
2. Streaming semantic endpointing and transcript revisions.
3. A Moshi, PersonaPlex, or equivalent native duplex worker.
4. Streaming safety intervention, retrieval, tools, and remote MCP server support.
5. Cancellation-deadline and 30-minute provider certification.
6. Full-Duplex-Bench, VoiceBench, and reproducible network-impairment reports.

See [`docs/production-readiness.md`](docs/production-readiness.md) for the verified feature truth table and mandatory release gates. Additional references: [`docs/gpt-live-parity.md`](docs/gpt-live-parity.md), [`docs/gpt-live-benchmark.md`](docs/gpt-live-benchmark.md), [`docs/architecture.md`](docs/architecture.md), [`docs/provider-adapters.md`](docs/provider-adapters.md), [`docs/protocol-1.0.md`](docs/protocol-1.0.md), and [`docs/evaluation.md`](docs/evaluation.md).

## License

Apache-2.0. Integrated model weights may use different licenses and must be surfaced independently.

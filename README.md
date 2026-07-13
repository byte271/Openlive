# Openlive

Openlive is an open, model-neutral runtime for continuous voice agents. It separates deadline-sensitive interaction continuity from slower model cognition and preserves native duplex provider capabilities instead of forcing every model through a text-chat abstraction.

## Current status

**Version 1.0 is the first stable Openlive protocol/runtime release. It is not a GPT-Live-equivalent model.**

Implemented:

- Rust workspace with unsafe code forbidden and strict Clippy.
- Dedicated audio/DSP crate and separated gateway configuration, session, transport, and state modules.
- Separated cascade streaming primitives and native realtime wire protocol mapping.
- Protocol 1.0 with JSON control events and compact binary PCM media packets.
- Strict monotonic client/server sequence and media-time validation.
- Chronos pause, overlap, reversible duck, hard-yield, and cancellation policy.
- Browser-local speech confidence and gain ducking before a network round trip.
- Browser playout acknowledgments for sent-versus-played audio tracking.
- Adaptive server noise floor and playout-aware echo probability.
- Sample-aligned browser output-reference correlation over a bounded 500 ms ring.
- Long-lived bidirectional provider sessions that accept audio during output.
- Deterministic answer leases, conversation versions, and stale-event suppression.
- Provider commits carry conversation versions instead of relying on gateway patch-up.
- Provider lifecycle conformance tests cover cancellation storms, stale generations, monotonic offsets, and close.
- Asynchronous cognition task and result events.
- Mock duplex provider for offline runtime development.
- Configurable OpenAI-compatible ASR → LLM → PCM TTS provider.
- OpenAI-compatible native realtime WebSocket speech provider.
- Streaming chat SSE, early phrase segmentation, and streamed PCM TTS.
- Generation-scoped monotonic latency telemetry and percentile reports.
- Sample-accurate AudioWorklet playback instead of one browser node per frame.
- Adaptive 30–120 ms playback target with underflow-driven jitter recovery.
- Worklet-side generation cancellation with a short audible fade.
- Endpointing prediction events that fuse speech duration, silence, and energy fall.
- Barge-in repair context so the next answer knows it follows an interruption.
- Browser output correlation and RMS attached to binary microphone packets for echo-aware filtering.
- Backpressure-aware media queues and throttled client telemetry preserve interaction deadlines.
- Browser code split into protocol, audio session, DSP utilities, jitter control, and UI modules.
- Rust and dependency-free Node tests cover media framing, correlation, jitter adaptation, and lifecycle behavior.

Still missing:

- A production-tested open-source native speech-to-speech worker.
- WebRTC/Opus transport with packet-level FEC and loss concealment.
- Adaptive acoustic echo cancellation and target-speaker attribution.
- Streaming ASR revisions and semantic endpointing.
- Retrieval, tools, streaming safety, GPU scheduling, and production control plane.
- Measured parity on Full-Duplex-Bench, VoiceBench, and network impairment suites.

The default mock deliberately emits a tone. The optional real endpoint is a conventional cascade and cannot reproduce a model trained natively for full-duplex speech.

The native realtime adapter preserves a continuous speech session and maps audio deltas, transcript deltas, cancellation, and provider state into Openlive. It requires a compatible external endpoint and has not been certified as GPT-Live-equivalent.

The cascade adapter now consumes chat SSE incrementally, sends completed clauses to a sequential TTS worker, and packetizes streamed PCM into 20 ms frames. This reduces first-audio onset when endpoints support streaming, but multiple phrase-level TTS requests can introduce prosody seams.

Browser playback now runs through a persistent AudioWorklet queue. It starts with a 40 ms target, raises the target after underflow, slowly reduces it during stable playback, reports frame completion from the render thread, and fades an exact generation during cancellation.

Endpointing emits `endpointing_prediction` events before Chronos decisions. The `openlive-audio` crate estimates acoustic turn-completion confidence and prosodic finality from duration, silence, and energy shape instead of using silence alone. It does not claim semantic understanding; learned semantic endpointing requires transcript revisions or a dedicated model.

When a user hard-yields an assistant response, the gateway records a one-shot repair context. The next committed response receives instructions to prioritize the new user turn, avoid repeating the interrupted answer, and acknowledge corrections only when useful. Cascaded and realtime adapters both receive this hint.

The playback worklet publishes sample-timed rendered reference frames. A bounded browser ring searches plausible acoustic delays with normalized cross-correlation, then sends echo confidence and output RMS in each binary microphone packet. The gateway fuses that evidence with its acoustic prior before allowing barge-in. This is not adaptive acoustic echo cancellation, but it is materially stronger than an unaligned output-level heuristic.

## Requirements

- Rust 1.83 or newer.
- A modern Chromium, Firefox, or Safari browser.
- Microphone permission.

## Run the offline mock

```bash
cargo run -p openlive-gateway
```

Open `http://127.0.0.1:8787`, connect, and start the microphone. Speak, pause, then speak over the generated tone. The browser should duck output immediately; Chronos then resumes after brief overlap or cancels after confirmed barge-in.

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
apps/openlive-gateway/       Gateway, WebSocket transport, and modular browser console
crates/openlive-audio/       Acoustic analysis and endpointing
crates/openlive-protocol/    Control events, binary media codec, and provider manifests
crates/openlive-provider/    Bidirectional mock, cascade, and realtime adapters
crates/openlive-runtime/     Chronos, answer leases, and deterministic replay
fixtures/                    Versioned event recordings
docs/                        Architecture and adapter guidance
```

## Protocol principles

- Media time is authoritative; wall-clock arrival order is not.
- Output is not complete until the client confirms playout.
- Every response attempt has a generation ID and answer lease.
- A new user turn invalidates older cognition and provider output.
- Cancellation names an exact generation and requested audio cutoff.
- Native duplex capabilities remain visible in the provider manifest.

## Next milestone

1. WebRTC/Opus with FEC, PLC, and congestion-aware media transport.
2. Streaming semantic endpointing and transcript revisions.
3. A Moshi, PersonaPlex, or equivalent native duplex worker.
4. Streaming safety intervention, retrieval, and tools.
5. Cancellation-deadline and 30-minute provider certification.
6. Full-Duplex-Bench, VoiceBench, and reproducible network-impairment reports.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/provider-adapters.md`](docs/provider-adapters.md).

## License

Apache-2.0. Integrated model weights may use different licenses and must be surfaced independently.

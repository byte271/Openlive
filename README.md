# Openlive

Openlive is an open, model-neutral runtime for continuous voice agents. It separates deadline-sensitive interaction continuity from slower model cognition and preserves native duplex provider capabilities instead of forcing every model through a text-chat abstraction.

## Current status

**Version 0.2 is an experimental runtime—not a GPT-Live equivalent.**

Implemented:

- Rust workspace with unsafe code forbidden and strict Clippy.
- Versioned, timestamped JSON realtime protocol and deterministic replay.
- Chronos pause, overlap, reversible duck, hard-yield, and cancellation policy.
- Browser-local speech confidence and gain ducking before a network round trip.
- Browser playout acknowledgments for sent-versus-played audio tracking.
- Adaptive server noise floor and playout-aware echo probability.
- Long-lived bidirectional provider sessions that accept audio during output.
- Deterministic answer leases, conversation versions, and stale-event suppression.
- Asynchronous cognition task and result events.
- Mock duplex provider for offline runtime development.
- Configurable OpenAI-compatible ASR → LLM → PCM TTS provider.
- Bounded WebSocket messages, provider queues, and captured audio.

Still missing:

- A production native speech-to-speech model adapter.
- WebRTC/Opus transport, jitter buffering, FEC, and packet-loss concealment.
- True aligned acoustic echo-reference correlation and speaker attribution.
- Streaming ASR revisions, streaming LLM-to-TTS, and semantic endpointing.
- Retrieval, tools, streaming safety, GPU scheduling, and production control plane.
- Measured parity on Full-Duplex-Bench, VoiceBench, and network impairment suites.

The default mock deliberately emits a tone. The optional real endpoint is a conventional cascade and cannot reproduce a model trained natively for full-duplex speech.

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

## Deterministic replay

```bash
cargo run -p openlive-runtime --bin openlive-replay -- \
  fixtures/turn-completion.jsonl
```

The same fixture produces the same interaction event IDs and decisions.

## Quality commands

```bash
cargo fmt --all --check
cargo check --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

## Workspace

```text
apps/openlive-gateway/       Gateway, acoustic frontend, and browser console
crates/openlive-protocol/    Events, profiles, and provider manifests
crates/openlive-provider/    Bidirectional sessions, mock, and cascade adapter
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

1. WebRTC/Opus with aligned playout reference.
2. Streaming semantic endpointing and transcript revisions.
3. A Moshi, PersonaPlex, or equivalent native duplex worker.
4. Incremental LLM-to-TTS for the cascade adapter.
5. Provider conformance and cancellation-deadline tests.
6. Network impairment, echo, false-interruption, and long-session suites.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/provider-adapters.md`](docs/provider-adapters.md).

## License

Apache-2.0. Integrated model weights may use different licenses and must be surfaced independently.

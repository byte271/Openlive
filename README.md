# Openlive

Openlive is an open, model-neutral runtime for continuous full-duplex voice agents. This initial build establishes the correctness-critical foundation: typed timestamped events, deterministic interaction replay, capability-aware providers, reversible barge-in, cancelable streaming output, and a runnable browser console.

## Current status

**Version 0.1 is a Phase 0/alpha runtime—not a GPT-Live clone yet.**

Implemented:

- Rust workspace with no unsafe code.
- Versioned JSON realtime event protocol.
- Capability and license manifests for providers.
- Deterministic Chronos interaction controller.
- Multi-signal speech confidence input.
- Pause preservation and turn commitment.
- Reversible `soft_duck -> resume` path for false interruptions.
- `soft_duck -> hard_yield -> cancel` path for sustained barge-in.
- Async, cancelable provider stream contract.
- Local mock duplex provider with PCM output.
- WebSocket gateway and browser microphone/playback console.
- Audio-clock replay CLI.
- Unit tests for protocol, interruption, replay, provider cancellation, and audio analysis.

Not implemented:

- Production ASR, LLM, TTS, or native duplex model adapters.
- WebRTC media transport. The alpha uses WebSocket PCM for inspection; WebRTC is the production target.
- Acoustic echo-reference transport and speaker attribution.
- Retrieval/tools/safety services.
- GPU scheduler or production deployment control plane.

The mock provider deliberately emits a tone rather than pretending to be a language model.

## Requirements

- Rust 1.83 or newer.
- A modern Chromium, Firefox, or Safari browser.
- Microphone permission.

## Run

```bash
cargo run -p openlive-gateway
```

Open `http://127.0.0.1:8787`, connect, and start the microphone.

Speak for at least a second, then pause. After the configured 650 ms pause tolerance, the mock provider emits text and a short speech-like tone. Speak over the tone:

1. Openlive emits `soft_duck` immediately and lowers playback.
2. A brief sound emits `resume`.
3. Sustained speech emits `hard_yield` and `output_audio_cancel`.

Use headphones for the cleanest barge-in demonstration.

## Deterministic replay

```bash
cargo run -p openlive-runtime --bin openlive-replay -- \
  fixtures/turn-completion.jsonl
```

The same fixture produces the same interaction event IDs and state decisions on every run.

## Quality commands

```bash
cargo fmt --all --check
cargo check --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

## Workspace

```text
apps/openlive-gateway/       WebSocket server and browser console
crates/openlive-protocol/    Events, profiles, and provider manifests
crates/openlive-provider/    Provider trait and mock duplex implementation
crates/openlive-runtime/     Chronos controller and deterministic replay
fixtures/                    Versioned event recordings
docs/                        Architecture and adapter guidance
```

## Protocol principles

- Media time is authoritative; wall-clock arrival order is not.
- Output is not complete until the client confirms playout.
- Every response attempt has a generation ID.
- Cancellation names an exact generation and requested audio cutoff.
- Native duplex capabilities are preserved instead of reduced to chat completions.
- Unknown safety or cancellation events will eventually fail closed.

## Next implementation milestone

The next milestone should add:

1. WebRTC/Opus transport with playout-reference events.
2. A Moshi/PersonaPlex native duplex worker adapter.
3. A streaming ASR + Qwen3-TTS hybrid adapter.
4. Provider conformance tests.
5. Network impairment and long-session harnesses.
6. Asynchronous cognition tasks with answer leases.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/provider-adapters.md`](docs/provider-adapters.md).

## License

Apache-2.0. Model weights integrated later may use different licenses and must be surfaced independently.

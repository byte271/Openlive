# Provider adapter guide

## Bidirectional session contract

Providers allocate a long-lived session:

```rust
#[async_trait]
pub trait RealtimeProvider: Send + Sync {
    fn manifest(&self) -> ProviderManifest;

    async fn open_session(
        &self,
        request: ProviderSessionRequest,
    ) -> Result<ProviderSession, ProviderError>;
}
```

`ProviderSession::into_parts()` returns a bounded input sender and output receiver. Inputs include:

- continuous timestamped `AudioFrame` messages;
- `CommitResponse` with an exact generation ID;
- `CancelGeneration`;
- `Close`.

Outputs are typed control events or raw PCM frames with a generation ID and media offset. This avoids internal base64 conversion while letting native duplex adapters consume new user audio during output.

## Contract requirements

### Cancellation

- Match cancellation to the exact generation ID.
- Abort network/model work promptly.
- Emit no new accepted audio after cancellation.
- Never reuse a generation ID.
- Let the gateway suppress output whose answer lease is no longer active.

### Audio

- Declare exact sample rates, channels, and frame duration.
- Use mono signed 16-bit little-endian PCM for protocol 1.0.
- Preserve monotonically increasing media offsets per generation.
- Bound captured input and provider queues.
- Do not emit empty frames to improve a latency score.

### Capabilities

Advertise only measured behavior:

- `continuous_input_while_output`: the adapter accepts audio while output runs;
- `native_turn_policy`: endpointing belongs to the model;
- `native_barge_in`: model state itself reacts to overlap;
- `state_tokens`: provider exposes meaningful interaction state;
- license class describes model weights separately from adapter code.

## Included adapters

### Mock duplex

The mock accepts continuous audio, supports generation cancellation, and emits text plus a generated tone. It exists for runtime development and is not a speech model.

### OpenAI-compatible cascade

The cascade buffers bounded 16 kHz PCM, sends WAV to transcription, calls chat completions, requests raw 24 kHz PCM speech, and emits:

- `transcribing`, `reasoning`, `synthesizing`, and `complete` states;
- `task_created` and `task_result`;
- text and audio output.

It accepts continuous input during output and supports cancellation, but its manifest correctly declares that barge-in and turn policy are not model-native. Chat completions are consumed as SSE, clauses are queued early, and PCM TTS bodies are packetized while they arrive. ASR remains final-only.

### OpenAI-compatible realtime

The native realtime adapter opens one persistent WebSocket per Openlive session. It:

- forwards 24 kHz PCM continuously with `input_audio_buffer.append`;
- commits externally-endpointed turns;
- requests audio and text responses;
- streams audio and transcript deltas without a cascade boundary;
- maps exact-generation cancellation to `response.cancel`;
- supports hosted or self-hosted compatible URLs.

The adapter disables remote turn detection so Chronos remains authoritative. A future negotiation mode may delegate turn policy to providers whose native behavior has been measured.

## Native duplex adapter design

A Moshi/PersonaPlex-style worker should:

- consume user audio continuously;
- preserve model session and codec state;
- expose model audio, text, and state channels;
- map model wait/respond/yield states into Openlive events;
- accept context injections only when supported;
- report observed cancellation and audio cutoffs;
- avoid unnecessary decode/re-encode boundaries.

## Hybrid adapter design

A DuplexCascade-style adapter should expose:

- incremental transcript deltas and revisions;
- wait/respond/backchannel control tokens;
- speculative and committed LLM text separately;
- cancelable incremental TTS frames;
- stage-specific latency traces.

Do not flatten transcript revisions into final-only text.

## Conformance suite

Every provider should pass:

- manifest schema validation;
- format negotiation;
- cancellation deadline;
- stale-generation isolation;
- monotonic media offset;
- bounded backpressure;
- 30-minute session stability;
- declared duplex behavior;
- malformed endpoint response handling;
- license metadata validation.

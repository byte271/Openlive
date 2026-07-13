# Provider adapter guide

## Trait

Implement `RealtimeProvider`:

```rust
#[async_trait]
pub trait RealtimeProvider: Send + Sync {
    fn manifest(&self) -> ProviderManifest;

    async fn start_response(
        &self,
        request: ResponseRequest,
    ) -> Result<ProviderStream, ProviderError>;
}
```

`ProviderStream` emits typed `RealtimeEvent` values with offsets relative to the response request's media time.

## Contract requirements

### Cancellation

- Observe `ResponseRequest.cancellation`.
- Stop expensive work promptly.
- Emit no new audio after cancellation is observed.
- Never reuse a generation ID.

### Audio

- Declare exact sample rates and frame size.
- Use mono PCM in the current alpha.
- Preserve monotonically increasing media offsets.
- Do not emit empty first frames to improve a latency score.

### Capabilities

Advertise only verified behavior:

- `continuous_input_while_output` means the model consumes live audio while generating.
- `native_turn_policy` means turn behavior belongs to the model rather than only an external VAD.
- `native_barge_in` means model state can react to overlapping input.
- License class describes weights independently of adapter code.

## Native duplex adapter design

A Moshi/PersonaPlex worker should:

- receive user audio continuously, not per response request;
- preserve model session state;
- expose model state/text/audio channels;
- map model start/end/yield states into Openlive events;
- accept context or knowledge injections if supported;
- make cancellation cutoff observable.

The trait will evolve from the alpha response-stream shape to a bidirectional allocated session before the first model adapter lands.

## Hybrid adapter design

A DuplexCascade-style adapter should expose:

- incremental transcript deltas and revisions;
- wait/respond/backchannel control tokens;
- incremental LLM text;
- cancelable TTS frames;
- stage-specific latency traces.

Do not flatten transcript revisions into a final-only message.

## Conformance suite

Every provider will need to pass:

- manifest schema validation;
- format negotiation;
- cancellation deadline;
- generation isolation;
- monotonic offset;
- bounded backpressure;
- 30-minute session stability;
- declared duplex behavior;
- license metadata.

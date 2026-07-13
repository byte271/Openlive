# Runtime architecture

## Two-plane model

The continuity plane handles bounded, deadline-sensitive work:

```text
browser microphone
  -> local adaptive speech confidence
  -> local reversible duck
  -> 20 ms PCM over WebSocket
  -> adaptive server acoustic features
  -> Chronos interaction controller
  -> generation cancellation / resume
  -> browser playback and playout acknowledgment
```

The cognition plane handles variable-latency work:

```text
captured turn
  -> transcription or native speech state
  -> asynchronous cognition task
  -> answer lease validation
  -> synthesis or native speech output
```

Continuity does not wait for cognition to decide whether output should duck or stop.

## Runtime module boundaries

- `openlive-audio` owns PCM validation, adaptive acoustics, echo probability, target-speech confidence, and endpointing.
- Gateway `session` owns one connection's lifecycle and is independent of CLI/provider construction.
- Gateway `session_state` owns latency, playout, and interruption-repair state.
- Provider streaming helpers own SSE parsing, phrase segmentation, and PCM framing.
- Native realtime wire helpers own request construction and provider event payloads.
- `AnswerLeaseManager` is isolated from the Chronos interaction controller.

## Local-first interruption

While output is active, the browser estimates speech confidence in the audio callback. A likely overlap ramps gain to 18% locally before a WebSocket round trip. This is reversible:

```text
assistant output
  -> local duck
  -> server soft_duck
  -> resume          brief overlap or false alarm
  -> hard_yield      sustained target speech
  -> cancel exact generation
```

The local detector is intentionally advisory. Chronos remains authoritative for hard cancellation.

## Adaptive acoustic observations

Protocol 0.3 carries optional client speech confidence and output-reference level. The audio crate independently computes PCM RMS, maintains an adaptive noise floor, fuses client/server confidence, and uses actual playout acknowledgments as an echo prior.

This is an improvement over a fixed RMS threshold, but it is not full acoustic echo cancellation. Production requires aligned rendered-audio reference, cross-correlation or a learned echo detector, and target-speaker embeddings.

## Chronos state machine

States:

- `listening`
- `user_speaking`
- `user_pause`
- `response_pending`
- `assistant_speaking`
- `soft_ducked`
- `yielded`

`soft_ducked` separates fast perceived reaction from the slower, higher-confidence decision to cancel generation.

## Answer leases

Each response receives:

- a generation ID;
- a conversation version;
- a deterministic answer lease ID.

Starting a new user turn invalidates the active lease. Provider emissions, cognition results, and late audio are accepted only if their generation still owns the active lease. This protects the audible channel even when cancellation races with remote work.

## Provider boundary

Providers allocate bidirectional sessions with bounded input and output queues. They can receive audio continuously, commit a response, cancel an exact generation, and close cleanly.

Provider manifests describe:

- native duplex, hybrid, cascade, or mock class;
- input/output modalities and audio formats;
- native turn and barge-in behavior;
- context and voice controls;
- hardware limits;
- model-weight license class.

The included cascade provider demonstrates configurable ASR, cognition, TTS, and answer-lease cancellation. The native realtime provider keeps a persistent speech session and streams PCM/transcript deltas without forcing an ASR → text → TTS boundary inside Openlive.

The cascade cognition path streams chat deltas into an early phrase segmenter. A sequential speech worker begins TTS at the first complete clause while later text is still arriving, then packetizes response-body PCM into 20 ms frames. This improves onset without allowing overlapping phrase audio.

## Endpointing sidecar

The gateway emits `endpointing_prediction` events from a lightweight sidecar before constructing Chronos observations. The sidecar tracks:

- accumulated speech duration;
- current silence duration;
- adaptive speech probability;
- falling RMS energy over recent frames.

It derives separate acoustic turn-completion confidence and prosodic-finality scores. Chronos consumes these scores instead of a single silence-only completion number. This reduces premature responses on short hesitations and keeps turn completion explainable in traces. It does not claim semantic understanding; learned endpointing with transcript revisions is a later stage.

## Determinism

`SessionEngine`:

- rejects decreasing media timestamps;
- consumes versioned envelopes;
- has no system-clock dependency;
- creates decision IDs with UUID v5;
- replays JSONL recordings exactly.

`AnswerLeaseManager` also derives lease IDs deterministically from the session, conversation version, and lease sequence.

## Transport limitations

WebSocket PCM is transparent and easy to inspect, but has:

- base64 overhead;
- TCP head-of-line blocking;
- no jitter/FEC/PLC;
- no standard NAT/media negotiation;
- browser-dependent capture buffering.

The production path should use WebRTC with Opus, DTLS-SRTP, ICE/TURN, jitter buffering, and aligned playout reference.

## Cancellation and playout

The browser queues resampled PCM in a persistent playback AudioWorklet and acknowledges frames from the render thread with `output_audio_played`. The queue begins at a 40 ms target, expands by 10 ms after underflow up to 120 ms, and contracts during stable playback to a 30 ms floor. The gateway tracks the latest sent and played media times and only applies its echo prior while audio remains unacknowledged.

On `hard_yield`:

1. the decision identifies the active generation;
2. the playback worklet drops queued frames and fades the active generation;
3. the provider receives `CancelGeneration`;
4. the answer lease is revoked;
5. `output_audio_cancel` records the requested cutoff.

The worklet reports complete rendered frames; exact partial-frame cutoff telemetry remains future work.

The playback worklet also reports rendered-output RMS. The browser attaches this output-reference level to subsequent microphone frames, allowing the gateway to raise echo probability and suppress interruption confidence when input resembles assistant leakage. Full aligned echo cancellation still requires sample-synchronous reference audio and correlation.

## Barge-in repair

Hard-yield no longer only stops audio. The gateway records the interrupted generation and media timestamp as one-shot repair context. The next provider commit includes a prompt hint that the user interrupted the previous answer and that the new turn has priority.

For cascaded providers, the hint is merged with the transcribed user turn. For realtime providers, it is sent as per-response instructions when the endpoint supports that field. This prevents stale answer continuation and reduces repeated pre-interruption content after a user correction.

## Safety trajectory

Before production:

- authenticate event streams;
- validate protocol versions;
- add streaming input/output policy checks;
- fail closed for unknown policy and cancellation events;
- isolate tools, model workers, and credentials;
- require consent metadata for cloned voices;
- provide zero-retention and encrypted-trace modes.

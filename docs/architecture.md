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

Protocol 0.2 carries optional client speech confidence. The gateway independently computes PCM RMS, maintains an adaptive noise floor, fuses client/server confidence, and uses actual playout acknowledgments as an echo prior.

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

The browser acknowledges completed frames with `output_audio_played`. The gateway tracks the latest sent and played media times and only applies its echo prior while audio remains unacknowledged.

On `hard_yield`:

1. the decision identifies the active generation;
2. the browser stops queued sources immediately;
3. the provider receives `CancelGeneration`;
4. the answer lease is revoked;
5. `output_audio_cancel` records the requested cutoff.

Exact partial-frame audible cutoff still requires a richer playout report.

## Safety trajectory

Before production:

- authenticate event streams;
- validate protocol versions;
- add streaming input/output policy checks;
- fail closed for unknown policy and cancellation events;
- isolate tools, model workers, and credentials;
- require consent metadata for cloned voices;
- provide zero-retention and encrypted-trace modes.

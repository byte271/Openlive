# Runtime architecture

## Event path

```text
Browser microphone
  -> 20 ms PCM frames
  -> WebSocket gateway (alpha transport)
  -> acoustic observation
  -> SessionEngine
  -> Chronos state machine
  -> interaction decisions
  -> provider generation stream
  -> timestamped text/audio events
  -> browser playback queue
```

The browser sends 16 kHz mono PCM frames with a monotonic media timestamp. The gateway derives an energy-based speech probability for this alpha and creates an `Observation`. Production deployments will replace that feature with WebRTC audio processing, echo reference, VAD, prosody, semantic completion, and speaker confidence.

## Chronos state machine

States:

- `listening`
- `user_speaking`
- `user_pause`
- `response_pending`
- `assistant_speaking`
- `soft_ducked`
- `yielded`

Important transitions:

```text
listening -> user_speaking
user_speaking -> user_pause
user_pause -> user_speaking      user resumes during a thinking pause
user_pause -> response_pending   pause + semantic completion
assistant_speaking -> soft_ducked
soft_ducked -> assistant_speaking  overlap was brief
soft_ducked -> yielded             sustained target speech
yielded -> user_speaking
```

`soft_ducked` is deliberately reversible. It separates fast perceived reaction from the slower, more confident decision to cancel generation.

## Determinism

`SessionEngine`:

- rejects decreasing media timestamps;
- consumes only versioned envelopes;
- has no system-clock dependency;
- creates response decision IDs with UUID v5 from session, sequence, and parent event;
- can replay JSONL recordings exactly.

Production event storage should encrypt raw audio and default to timing/features only.

## Provider boundary

Provider workers are asynchronous and cancelable. A provider advertises:

- class: native duplex, hybrid, cascade, or mock;
- input/output modalities;
- audio formats;
- native duplex and barge-in support;
- context and voice controls;
- hardware limits;
- license class.

The runtime must eventually isolate workers in restricted processes/containers. Shared memory can optimize audio transfer without becoming a trust boundary.

## Alpha transport limitations

WebSocket PCM is intentionally transparent and easy to inspect, but it has:

- base64 overhead;
- TCP head-of-line blocking;
- no jitter/FEC/PLC;
- no standard NAT/media negotiation;
- browser-dependent capture buffering.

The production client path will use WebRTC with Opus, DTLS-SRTP, ICE/TURN, jitter buffers, and explicit playout reference.

## Cancellation

The gateway keeps one active generation. On `hard_yield`:

1. The provider cancellation token is triggered.
2. An `output_audio_cancel` event identifies the generation.
3. The browser stops queued and active sources for that generation.
4. The interaction engine yields and listens to the user.

Future versions will report last accepted, last sent, and last played media timestamps for exact audible-stop measurement.

## Safety trajectory

Before production:

- bound and authenticate every event stream;
- enforce maximum frame and queue sizes;
- validate protocol versions;
- fail closed for unknown policy/cancellation events;
- stream moderation decisions;
- isolate tools and credentials;
- require consent metadata for cloned voices;
- provide zero-retention mode.

# Openlive 1.0

Openlive 1.0 is the first stable protocol/runtime source release. Stability refers to the Openlive control and media boundary, not parity with any proprietary model.

## Release gates

- Raw binary PCM replaces base64 JSON audio in the browser, gateway, and provider SDK.
- Client and server control/media share strict ordered sequence spaces.
- Sample-aligned rendered output is correlated against capture across plausible acoustic delays.
- Local ducking discounts likely echo before attenuating assistant output.
- The server fuses client correlation, output RMS, playout state, and adaptive acoustic evidence.
- Provider input and client output queues avoid blocking the interaction loop under saturation.
- Routine UI telemetry is rate-limited while endpoint commits remain immediate.
- Browser code is split into audio session, DSP utilities, jitter controller, protocol, and UI modules.
- Provider cancellation-storm conformance ensures stale generations do not leak after the latest starts.
- Binary codec corruption, echo correlation, jitter adaptation, timeline ordering, playout, endpointing, and provider lifecycle have automated coverage.

## Capability classes

- `mock`: offline runtime verification only.
- `cascade`: functional OpenAI-compatible streaming ASR → LLM → PCM TTS; not native duplex speech.
- `native_duplex`: persistent compatible realtime speech endpoint; quality and license depend on that endpoint.
- Openlive runtime: experimental for production deployment until security, safety, load, and long-session certification are completed.

## Known limits

- WebSocket/TCP still has head-of-line blocking.
- PCM has higher bandwidth than Opus.
- Correlation is not adaptive acoustic echo cancellation.
- The runtime does not attribute a target speaker.
- Endpointing has no learned transcript semantics.
- Included code does not ship a production-certified native speech-to-speech model.
- Hosted endpoint behavior is not an Openlive performance claim.

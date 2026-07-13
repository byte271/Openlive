# Openlive 0.9 refactor

This release is an architectural cleanup rather than a feature checkpoint.

## Removed

- Gateway-owned DSP and endpointing implementations.
- Fixed `target_speaker_probability: 1.0` runtime output.
- Gateway patch-up of provider conversation versions.
- Stringly typed provider lifecycle states.
- Unused `input_audio_gap` and `response_requested` protocol events.
- Claims that the acoustic endpointing heuristic measures semantic completeness.
- Clippy exceptions for oversized gateway and cascade functions.

## New boundaries

- `openlive-audio`: PCM validation, adaptive noise floor, echo estimate, target-speech confidence, and endpointing.
- Gateway `config`: CLI and provider construction.
- Gateway `session`: one realtime connection's supervision and cancellation policy.
- Gateway `session_state`: playout, latency, and interruption repair.
- Gateway `transport`: WebSocket event serialization and bounded output queue.
- Provider cascade streaming: SSE parsing, phrase segmentation, and PCM framing.
- Native realtime wire layer: request construction and provider JSON events.
- Runtime `lease`: conversation-version and stale-generation ownership.

## Protocol changes

Protocol 0.3:

- renames heuristic `semantic_completeness` to `turn_completion_confidence`;
- removes two unused event variants;
- adds typed provider lifecycle states;
- preserves output-reference audio metadata introduced in the previous checkpoint.

Provider response commits now carry their conversation version at the boundary. Task events are created with the correct version instead of being rewritten by the gateway.

## Verification

- Rust format, check, strict Clippy, release build, and all workspace tests pass.
- Provider conformance covers generation cancellation, stale-output ordering, audio-offset monotonicity, and clean close.
- Audio tests cover frame validation, target speech, echo suppression, and pause tolerance.
- Gateway state tests cover playout acknowledgments, cancellation, and one-shot repair context.
- Browser JavaScript and both AudioWorklets pass syntax checks.
- The release gateway returns health, provider manifest, and static console responses in a local smoke test.

This release does not add WebRTC, learned endpointing, aligned AEC, speaker attribution, or a production-tested open-source native speech-to-speech model.

# Openlive 1.2

Openlive 1.2 is a focused release that closes the most user-visible parity gaps with
ChatGPT Advanced Voice Mode (AVM) and the OpenAI Realtime API, while preserving the
model-neutral, deterministic, local-first architecture established in 1.0 and 1.1.

The full feature-by-feature benchmark against GPT-Live / AVM is in
[`docs/gpt-live-benchmark.md`](gpt-live-benchmark.md). This document describes what
shipped, what was removed, and how to use the new surface.

## Voice experience

- A redesigned voice surface keeps the original procedural orb as the centerpiece and
  adds a live dual transcript (user + assistant) that scrolls beside it. The transcript
  is persistent during a session and resets cleanly when the conversation ends.
- The voice picker is now in the UI. Voices are sourced from the provider manifest
  (or a built-in offline roster for the mock provider) and shown with a one-line
  personality descriptor, mirroring the AVM pattern. Selection persists across
  sessions via `localStorage`.
- Conversation modes are first-class. Five presets — *Open conversation*, *Brainstorm*,
  *Interview*, *Language tutor*, *Stand-up* — adjust pause tolerance, interruption
  sensitivity, and the system instruction prefix. Modes are session-scoped and can be
  switched mid-call.
- A per-call instruction override (speed and detail) is available inline. It maps
  directly to the Realtime API's per-response `instructions` field for native-realtime
  providers, and to a system-prompt prefix for the cascade and mock providers.
- An optional push-to-talk entry mode replaces always-on VAD with a hold-to-speak
  gate. Hold the primary button, the spacebar, or a dedicated on-screen PTT affordance
  to capture audio; release to commit. This is something AVM does not offer.
- A live latency pill in the voice surface shows the rolling p50 generation latency.
  Operators can toggle visibility; it is hidden by default for end-user deployments.

## Visual system

- The voice orb is rebuilt around a multi-layer renderer: an outer aura that breathes
  with the conversation envelope, a procedural body that distorts on barge-in, an
  inner core whose glow tracks output energy, and a barge-in ripple that radiates on
  every hard yield. Palettes are still original Openlive geometry — not a clone of any
  proprietary visual.
- A theme selector offers three palettes: *Aurora* (default), *Graphite* (minimal
  monochrome), and *Signal* (high-contrast for accessibility). A motion-intensity
  slider scales animation amplitude and is honored by `prefers-reduced-motion`.
- Typography is tightened: a single variable sans for the UI, a monospace for
  telemetry, and a clear role-differentiated transcript (user right, assistant left,
  system centered).
- The diagnostics drawer is unchanged in scope but visually refreshed and now
  includes a connection-quality meter sourced from the new telemetry module.

## Realtime behavior

- The local-first reversible duck at 18% gain before any server round trip is
  preserved from 1.1. The new barge-in ripple visualizes the moment the local duck
  fires, giving operators a visible signal that Openlive beat the server to the
  interruption.
- Barge-in repair context (the one-shot hint that the next response should
  prioritize the new user turn) is now surfaced as an observable event in the
  diagnostics timeline so operators can confirm it fired.
- Reconnect logic is unchanged: bounded exponential backoff, microphone capture
  preserved, stale playback cancelled. The reconnect state is now visible in the
  transcript drawer as a system line ("Reconnecting… / Restored at <timestamp>").
- A new connection-telemetry module computes rolling p50/p95 latency, jitter, and
  packet-loss estimates from generation-scoped latency marks and playout
  acknowledgments. It drives the latency pill and the connection-quality meter.

## Code cleanup

A full audit is in [`docs/v1.2-cleanup-audit.md`](v1.2-cleanup-audit.md). Notable
removals and consolidations:

- The unused `--accent-warm` CSS variable and its five `body[data-mode]` overrides
  were removed.
- `AudioSession.isMicrophoneActive()` was removed; the gateway-side state in `app.js`
  is the single source of truth.
- `VoiceVisualizer.destroy()` was either wired up or removed depending on the call
  site (it is now wired to the page-unload handler).
- The three duplicated `clamp` helpers were consolidated into a single
  `clamp01` export in `audio-utils.js`.
- `decodeOutputAudio` no longer returns `frameDurationMs` and `channels` to callers;
  the worklet reads them directly from the binary header when needed.
- The duplicated SVG icon path between the diagnostics and settings buttons was
  replaced with a single shared symbol.
- `sendControl` no longer serializes `parent_event_id: null`; the field is omitted
  when absent, matching the protocol spec.
- `inputSampleRate` is owned by `AudioSession` only; `app.js` reads it via a getter
  rather than mirroring the value.

## Validation boundaries

- The mock provider still emits a tone; it validates lifecycle and state transitions,
  not speech quality.
- The new transcript surface for user-side speech depends on the provider emitting
  `input_audio_transcription` deltas (native-realtime) or incremental ASR
  (cascade). The mock provider emits canned transcripts for UI testing.
- Push-to-talk mode bypasses Openlive's acoustic endpointing sidecar; the provider
  still receives committed turns at release time.
- The latency pill reflects gateway-side generation latency, not end-to-end audio
  round-trip latency. End-to-end measurement requires the planned WebRTC transport
  (Tier 2 in the benchmark).
- Openlive still does not claim GPT-Live parity. The 1.2 release closes concrete
  UX gaps; full parity requires a native duplex worker (tracked for v1.3+).

## Compatibility

- Protocol version is unchanged at 1.0. The binary PCM framing and JSON control
  envelope are wire-compatible with 1.1 gateways. New event types
  (`user_transcript_delta`, `user_transcript_final`, `voice_changed`,
  `mode_changed`, `instruction_override`) are additive and ignored by older clients.
- The provider manifest gains two optional fields: `voices` (an array of
  `{ id, label, description }`) and `supports_push_to_talk` (boolean). Older
  manifests without these fields fall back to the built-in offline voice roster and
  auto-VAD.
- `localStorage` keys are namespaced under `openlive.v1.2.*`. There is no migration
  from 1.1 because 1.1 did not persist UI preferences.

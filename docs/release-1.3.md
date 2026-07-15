# Openlive 1.3 — gpt-live parity release

Openlive 1.3 is the gpt-live parity release. It closes the most visible
UX gaps between Openlive 1.2 and ChatGPT Advanced Voice Mode / GPT-Live,
with the explicit goal of making Openlive a credible open-source clone
of the gpt-live voice surface — original visual identity preserved,
proprietary assets avoided, and the model-neutral runtime intact.

This release is UI-layer only. Protocol 1.0 wire compatibility is
preserved. New event types are additive and ignored by older clients.

## What's new in 1.3

### Voice surface

- **Inline layout toggle.** A new layout toggle in the topbar switches
  between *focused* (orb-centered, default) and *inline* (transcript beside
  the orb) layouts. Inline mirrors the late-2025 AVM redesign that moved
  voice inline with the chat thread, with the orb shrinking to a side
  indicator and the transcript taking primary visual real estate.
- **Refined orb palette.** Deeper saturated blues for IDLE/SPEAKING to
  evoke the AVM signature mood while keeping Openlive's original violet
  and cyan accents. All colors are original Openlive values — no
  proprietary assets are reproduced.
- **Backchannel badge.** A subtle "mhmm" cue near the orb flashes when
  the provider emits a backchannel acknowledgement, mirroring GPT-Live's
  native backchanneling behavior. The badge fades in over 1.6 seconds
  and never takes the floor.
- **Camera & screen-share affordances.** Two new dock buttons surface
  the camera and screen-share modalities that AVM exposes. v1.3 ships
  the UI affordances and a "preview" notice; the actual video streams
  will be wired in v1.4 alongside the WebRTC transport.
- **Quota pill.** A daily/session cap indicator in the topbar with
  graceful fallback messaging. Operators configure the cap (5 / 15 / 30 /
  60 minutes, or unlimited) in the settings sheet. At 80% of the cap a
  non-blocking notice appears; at 100% the conversation ends gracefully,
  matching AVM's daily-limit fallback behavior.
- **Custom instructions inline panel.** An AVM-style "Speaking style"
  panel accessible from the dock or the `I` keyboard shortcut. Exposes
  four axes — Pace, Detail, Complexity, Tone — each with four options
  (Auto / Slower / Balanced / Faster, etc.). Changes apply to the next
  turn instantly. A `!` badge on the dock button indicates when any
  axis is non-auto.
- **Tool-call cards in transcript.** Function-calling invocations are
  rendered as cards in the transcript drawer with the tool glyph, name,
  streaming arguments preview, status (pending / running / completed /
  failed), and the result text. Mirrors GPT-Live's rich tool-call
  surface. Builtin tool descriptors cover weather, stock, maps,
  web_search, calculator, calendar, email, and code_interpreter.
- **Rich visual cards.** Structured cards for weather, stock, sports,
  maps, web_search, code, translation, and a generic fallback. Each card
  carries a glyph, title, key/value fields, and optional attribution.
  Cards render inline in the transcript drawer.
- **Conversation mode presets** shipped in v1.2 are now visually
  consistent with the new tool/card surfaces.

### Keyboard shortcuts

New shortcuts: `I` (custom instructions), `L` (layout toggle),
`C` (camera), `Shift+C` (screen share). All existing v1.2 shortcuts
are preserved.

### Persistence

- `localStorage` key bumped from `openlive.v1.2.settings` to
  `openlive.v1.3.settings` to accommodate new fields cleanly.
- New persisted fields: `complexityOverride`, `toneOverride`, `layout`.
  All validators are tested.

## Validation boundaries

- Camera and screen-share buttons surface UI affordances only. The video
  streams require the WebRTC transport planned for v1.4.
- Tool-call cards depend on the provider emitting the new
  `tool_call_begin`, `tool_call_arguments_delta`,
  `tool_call_arguments_final`, and `tool_call_result` events. The mock
  provider does not emit these; native-realtime providers will in a
  follow-up adapter revision.
- Rich visual cards depend on the gateway emitting `visual_card` events.
  These are additive and ignored by older clients.
- Backchanneling depends on the provider emitting `backchannel` events.
  Native duplex workers (Moshi, PersonaPlex) will emit these; the mock
  provider does not.
- Quota tracking is wall-clock based, not media-time based, because
  quota is a product concern, not a media-synchronization concern.

## Compatibility

- Protocol version is unchanged at 1.0. The binary PCM framing and JSON
  control envelope are wire-compatible with 1.2 gateways.
- New event types (`backchannel`, `tool_call_begin`,
  `tool_call_arguments_delta`, `tool_call_arguments_final`,
  `tool_call_result`, `visual_card`) are additive and ignored by older
  clients.
- The provider manifest gains three optional fields: `tools` (an array
  of `{ name, description, glyph }`), `supports_backchanneling` (boolean),
  and `supports_visual_cards` (boolean). Older manifests without these
  fields fall back to the builtin tool roster and disable the
  backchannel/card surfaces.
- `localStorage` keys are namespaced under `openlive.v1.3.*`. There is
  no migration from v1.2 because v1.2 keys live under a different
  namespace; users will see the default settings on first load of v1.3.

## What Openlive still does not claim

- Openlive is not a GPT-Live-equivalent model. Full-duplex native speech
  with backchanneling, live translation, and rich visual cards requires
  a native duplex worker (Moshi, PersonaPlex, or equivalent) — tracked
  for v1.4+.
- WebRTC + Opus transport with FEC, PLC, and congestion control is the
  largest remaining transport gap. Planned for v1.4.
- Live video / camera input streams require WebRTC. Planned for v1.4.
- SIP / telephony transport is out of v1.3 scope.
- Transcript editing is out of v1.3 scope; the transcript drawer is
  read-only.

See [`docs/gpt-live-parity.md`](gpt-live-parity.md) for the explicit
feature-by-feature parity matrix and what's "open-source clone" vs
"deliberately different."

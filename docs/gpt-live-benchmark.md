# GPT-Live Benchmark — ChatGPT Advanced Voice Mode & OpenAI Realtime API vs. Openlive

**Living status:** Parity tracking for the current tree is in
[`gpt-live-parity.md`](gpt-live-parity.md) (**v26.7.15**). This file is the historical
research notebook that drove the v1.1 → v1.2 → … → 26.7.15 roadmap.

**Scope (original):** This document benchmarks Openlive v1.1 against "gpt-live" — interpreted as the full
voice stack OpenAI ships: the consumer ChatGPT Advanced Voice Mode (AVM) and the underlying
GPT-Live-1 / GPT-Realtime models exposed through the OpenAI Realtime API. The goal is to
identify concrete gaps and prioritize the v1.2.0 roadmap.

**Research basis:** OpenAI's "Introducing GPT-Live" announcement (Jul 8, 2026), the GPT-Live
System Card on OpenAI's Deployment Safety Hub, the OpenAI Realtime API developer docs
(Realtime and audio guide, Realtime client events reference, Realtime VAD guide, Realtime
WebRTC guide, Realtime transcription guide, Realtime conversations guide), the
"Introducing gpt-realtime" announcement, OpenAI Help Center "Voice Mode FAQ," the
Latent.Space "Missing Manual" writeup, webrtcHacks latency measurements, Forasoft transport
comparison, and community threads on r/ChatGPT and the OpenAI Developer Community. All
claims below are anchored to those sources.

---

## 1. Feature Inventory — ChatGPT Advanced Voice Mode (AVM) / GPT-Live

### 1.1 Conversation model
- **Full-duplex audio.** GPT-Live-1 and GPT-Live-1 mini are explicitly full-duplex: they
  listen and speak simultaneously, making interaction decisions many times per second
  instead of waiting for a clearly bounded turn (OpenAI System Card, Jul 8, 2026).
- **Natural barge-in.** Users can interrupt the assistant mid-utterance; the model stops
  and yields to the new input (ChatGPT Voice features page; "introducing-gpt-live").
- **Backchanneling.** The model emits short acknowledgments like "mhmm" while the user is
  speaking, and stays quiet when the user pauses briefly without committing a full turn
  ("Engineering Behind OpenAI's GPT-Live," Towards AI).
- **Slow thinking / pause tolerance.** Late-2025 AVM updates gave users "more time to
  think during a conversation without interrupting you" (itdaily.co.il). GPT-Live extends
  this with native pause reasoning.
- **GPT-5.5 delegation.** GPT-Live can hand off complex reasoning to GPT-5.5 mid-call,
  surfacing the result back into the voice channel (Mindstudio blog; "r/MervinPraison"
  writeup).
- **Live translation.** Built-in real-time translation between languages during a single
  voice session (livelingo.io guide; Reddit r/AISEOInsider Jul 9, 2026).
- **Rich visual cards.** Weather forecasts, stock data, sports scores, and maps surface
  inline during voice conversations (VentureBeat, Jul 8, 2026).

### 1.2 User-facing UI
- **Voice orb.** The signature blue animated orb is the primary visual. It pulses,
  distorts, and changes color with conversation state. It was temporarily removed in a
  mid-2026 build and restored after user backlash (r/OpenAI "BLUE ORB IN VOICE MODE IS
  BACK!"), confirming its centrality to the product.
- **Inline-in-chat voice mode.** As of late 2025, voice mode no longer takes over the
  screen with an orb-only view; it lives inside the chat thread with live transcript
  bubbles, message edit, and earlier-message review (r/singularity; PCMag/Facebook).
- **Live transcript.** Streaming text of both user and assistant turns, editable after the
  turn.
- **Voice picker.** Settings menu lists voices with personality descriptors: Breeze
  ("Animated and earnest"), Cove ("Composed and direct"), Ember ("Confident and
  optimistic"), Juniper ("Open and upbeat"), Maple ("Cheerful"), plus Sol, Arbor, Spruce,
  Vale, and the older Shimmer/Sky. New voices were added in batches (Mashable, Sep 2024;
  Help Center FAQ).
- **Live video / camera input.** Camera button during voice session streams live video;
  the model reacts to what the camera sees (Dec 14, 2024 rollout; Help Center FAQ).
- **Screen sharing.** Available alongside live video on supported platforms.
- **Custom voice instructions.** Inline panel to instruct the assistant to talk quicker or
  slower, with more detail or more concise (chatgpt.com/features/voice).
- **Mute, end-call (X),** and **camera toggle** are the persistent in-call controls.
- **Daily usage indicator.** Plus tier historically had 1 hour/day of unlimited AVM with
  fallback to standard voice; free tier saw a 15-minute preview window (OpenAI community
  threads; ainews.com).

### 1.3 Interaction patterns
- **One-tap entry.** Tap the waveform icon next to the text field to start voice.
- **Auto-endpointing (server VAD).** The model detects when the user has stopped speaking.
- **Push-to-talk (legacy / Standard Voice).** Standard Voice (4o-mini-based) historically
  had a push-to-talk button. Users have requested PTT return for Advanced Voice to prevent
  accidental interruptions (community.openai.com "URGENT: Voice Mode Needs Push-to-Talk
  Feature").
- **Quota recovery messaging.** When daily limits are hit, the UI reverts to standard
  voice rather than hard-stopping.

### 1.4 Quality / latency profile
- Reported "time-to-first-byte" of ~500 ms WebSocket, ~300–600 ms steady-state WebRTC,
  500–1200 ms first turn (Latent.Space; Forasoft).
- GPT-Live-1 and mini are "strongly preferred over Advanced Voice Mode in matched 5–10
  minute" head-to-head conversations (openai.com/index/introducing-gpt-live).

---

## 2. Feature Inventory — OpenAI Realtime API

### 2.1 Transports
- **WebSocket** (`wss://api.openai.com/v1/realtime?model=...`) — original, default for
  server-to-server.
- **WebRTC** — recommended for browser voice agents; OpenAI rebuilt its WebRTC stack for
  low-latency, global-scale voice AI ("delivering-low-latency-voice-ai-at-scale").
- **SIP** — telephony inbound/outbound via Session Initiation Protocol, announced with the
  gpt-realtime GA ("introducing-gpt-realtime").

### 2.2 Session configuration (`session.update`)
Documented fields the client may set on a session:
- `modalities`: `["audio", "text"]` or subset.
- `instructions`: system-style prompt applied to the session.
- `voice`: output voice name (alloy, ash, ballad, cedar, coral, echo, sage, verse, plus
  the newer ChatGPT voices when available).
- `input_audio_format` / `output_audio_format`: `pcm16`, `g711_ulaw`, `g711_alaw`.
- `input_audio_transcription`: opt-in user-speech transcription with `model: "whisper-1"`.
- `turn_detection`:
  - `type: "server_vad"` with `threshold`, `prefix_padding_ms`, `silence_duration_ms`,
    `create_response`.
  - `type: "semantic_vad"` (newer, Azure-supported, semantic-aware endpointing).
  - `type: "none"` (manual `input_audio_buffer.commit`).
- `tools`: array of function tool definitions and (since gpt-realtime GA) remote MCP server
  references.
- `tool_choice`: `auto`, `none`, `required`, or specific tool.
- `temperature`, `max_response_output_tokens`.
- `speed`: spoken-response speed factor (where supported).

### 2.3 Client events (client → server)
- `session.update` — apply session config delta; server replies `session.updated`.
- `input_audio_buffer.append` — base64 audio chunk (≈100 ms minimum, else commit errors).
- `input_audio_buffer.commit` — manually commit buffered audio as a user turn.
- `input_audio_buffer.clear` — drop uncommitted audio.
- `conversation.item.create` — inject a message, function call, or function call output
  into conversation history.
- `conversation.item.truncate` — truncate an earlier assistant audio item (used for
  mid-utterance cancellation / barge-in repair).
- `conversation.item.delete` — remove a conversation item.
- `response.create` — explicitly request a response, optionally with per-response
  `instructions`, `modalities`, `voice`, `tools`, `tool_choice`, `temperature`,
  `max_response_output_tokens`, `metadata`.
- `response.cancel` — cancel an in-flight response.

### 2.4 Server events (server → client)
- `session.created`, `session.updated`.
- `input_audio_buffer.speech_started`, `input_audio_buffer.speech_stopped`,
  `input_audio_buffer.committed`.
- `conversation.item.created`.
- `conversation.item.input_audio_transcription.delta`,
  `conversation.item.input_audio_transcription.completed`,
  `conversation.item.input_audio_transcription.failed` (streaming user-speech
  transcript).
- `response.created`, `response.output_item.added`, `response.content_part.added`.
- `response.audio.delta`, `response.audio.done` (assistant PCM chunks + final).
- `response.audio_transcript.delta`, `response.audio_transcript.done` (assistant text
  transcript).
- `response.output_text.delta`, `response.output_text.done`.
- `response.text.delta`, `response.text.done`.
- `response.function_call_arguments.delta`, `response.function_call_arguments.done`.
- `response.done`, `response.cancelled`, `response.incomplete`.
- `rate_limits.updated`, `error`.

### 2.5 Capabilities
- 24 kHz mono PCM16 in both directions (also G.711 µ-law/a-law for telephony).
- Server-managed VAD with configurable thresholds and semantic mode.
- Server-managed conversation history; client can read, append, truncate, delete items.
- Streaming bidirectional transcription (both user and assistant sides).
- Function calling / tool use, with streamed argument deltas.
- Remote MCP server integration (gpt-realtime GA).
- Image input into the realtime session (gpt-realtime GA).
- Code Interpreter (gpt-realtime GA).
- SIP inbound/outbound for telephony agents.
- WebRTC peer connection for browser clients (lower-latency than WebSocket).
- Conversation state survives `response.cancel` and barge-in; `conversation.item.truncate`
  is the official barge-in repair mechanism.

---

## 3. Benchmark Matrix

Legend: ✅ shipped in v1.1 · 🟡 partial / behind a flag · ❌ missing · 🎯 v1.2 target

| # | Feature | GPT-Live / AVM capability | Openlive v1.1 status | Openlive v1.2 target |
|---|---------|---------------------------|----------------------|----------------------|
| 1 | Full-duplex audio (listen + speak simultaneously) | Native in GPT-Live-1; AVM approximates via fast server VAD + barge-in | 🟡 Mock + native-realtime adapter preserve provider duplex; cascade adapter is half-duplex at the gateway | 🎯 Document duplex-by-provider-class in manifest; expose `duplex` flag to UI |
| 2 | Server-side VAD with configurable silence / threshold | `turn_detection: server_vad` with `threshold`, `prefix_padding_ms`, `silence_duration_ms` | 🟡 Openlive ships its own endpointing sidecar (acoustic + prosodic); not a passthrough of provider VAD config | 🎯 Surface provider VAD knobs in session config; keep Openlive endpointing as an additive layer |
| 3 | Semantic VAD | `turn_detection: semantic_vad` (Azure-supported, GA) | ❌ Openlive endpointing is acoustic-only; no transcript-revision path | 🎯 Optional `semantic_endpointing` flag when provider advertises it |
| 4 | Streaming user-side transcription | `conversation.item.input_audio_transcription.delta/.completed` | ❌ Cascade adapter transcribes once at commit; native-realtime adapter forwards provider transcript deltas but UI does not render them | 🎯 Render live user transcript in a transcript drawer |
| 5 | Streaming assistant transcript | `response.audio_transcript.delta/.done` | 🟡 Assistant text is "temporary" per release-1.1.md; not persisted or scrollable | 🎯 Persistent scrolling transcript with role attribution |
| 6 | Barge-in / interruption | Native; AVM yields immediately | ✅ Local reversible duck → soft_ducked → hard_yield → exact-generation cancel | 🎯 Maintain; add UI affordance showing duck state |
| 7 | Barge-in repair context | `conversation.item.truncate` + new `response.create` | ✅ One-shot repair hint already merged into next provider commit | 🎯 Expose repair hint as observable event in diagnostics |
| 8 | Push-to-talk mode | Legacy Standard Voice had PTT; AVM is auto-VAD only | ❌ Only auto-VAD entry | 🎯 Optional PTT entry mode (hold space / hold button) |
| 9 | Voice picker (named voices + descriptors) | Settings menu: Breeze, Cove, Juniper, Ember, Maple, Sol, Arbor, Vale, Spruce, etc., with personality descriptors | 🟡 CLI `--voice` flag only; no in-app picker | 🎯 In-app voice picker with descriptors, sourced from provider manifest |
| 10 | Per-call voice + instruction overrides | Per-`response.create` `voice`, `instructions`, `modalities` | 🟡 Per-session voice only | 🎯 Per-turn instruction override (speed, detail) like AVM |
| 11 | Live video / camera input | Camera button streams frames into the session | ❌ | 🎯 Out of v1.2 scope; tracked for v1.3 |
| 12 | Rich visual cards (weather, stock, maps) | Inline cards during GPT-Live conversations | ❌ | 🎯 Tool-call result surface in transcript drawer (text only) |
| 13 | Function calling / tools | `tools` array; `response.function_call_arguments.delta` | ❌ | 🎯 Pluggable tool adapter; surface tool calls in UI |
| 14 | Remote MCP server tools | `tools: [{ type: "mcp", server_url: ... }]` (gpt-realtime GA) | ❌ | 🎯 MCP client adapter in cognition plane |
| 15 | Image input | Image input to realtime session (gpt-realtime GA) | ❌ | 🎯 Out of v1.2 scope |
| 16 | WebRTC transport | Native WebRTC peer connection | ❌ Binary WebSocket PCM only; no FEC/PLC, no NAT negotiation | 🎯 WebRTC + Opus transport with FEC, PLC, congestion control |
| 17 | SIP / telephony transport | SIP inbound/outbound | ❌ | 🎯 Out of v1.2 scope |
| 18 | Latency display | Not surfaced in AVM UI; visible only via API latency measurements | 🟡 Generation-scoped latency telemetry exists; buried in diagnostics drawer | 🎯 Optional live latency pill in the main voice surface |
| 19 | Daily/session quota indicator | Plus: 1 hr/day; free: 15 min preview; UI reverts to standard voice | ❌ | 🎯 Optional configurable session cap with graceful fallback |
| 20 | Conversation state recovery after reconnect | Realtime API session resumability is limited; clients rebuild from `conversation.item.create` | 🟡 Openlive bounded reconnect preserves mic capture and cancels stale playback, but does not rebuild server-side conversation history | 🎯 Replay conversation items into provider on reconnect when supported |
| 21 | Customizable voice orb / visual | AVM orb is fixed; community has requested customization | ✅ Openlive uses original procedural geometry (explicitly not a clone) | 🎯 Theme selector (color palette + motion intensity) |
| 22 | Mute, end-call, camera controls | Persistent in-call controls | 🟡 Mute + end-call present; no camera | 🎯 Add configurable secondary action slot |
| 23 | Live translation | Built-in GPT-Live feature | ❌ | 🎯 Out of v1.2 scope; prototype via cascade adapter with translation LLM hop |
| 24 | Backchanneling ("mhmm") | Native GPT-Live behavior | ❌ | 🎯 Out of v1.2 scope; requires native duplex worker |
| 25 | Slow-thinking / GPT-5.5 delegation | GPT-Live delegates complex reasoning | ❌ | 🎯 Cognition plane already async; pluggable "deep" cognition task with deferred commit |
| 26 | Audio format flexibility | pcm16, g711_ulaw, g711_alaw | 🟡 PCM16 24 kHz only | 🎯 Keep PCM16 internal; add Opus on the wire for v1.2 WebRTC |
| 27 | Transcript editing | Editable after turn in AVM | ❌ | 🎯 Out of v1.2 scope |
| 28 | Deterministic replay / recording | Not offered by AVM | ✅ `openlive-replay` JSONL replay | 🎯 Maintain; add redacted export mode |
| 29 | Local-first interruption (duck before server round trip) | AVM does this implicitly via client-side VAD; not exposed | ✅ Local reversible duck at 18% gain before WebSocket RTT | 🎯 Maintain; document in benchmark |
| 30 | Echo probability / AEC prior | Not exposed by Realtime API | ✅ Sample-aligned cross-correlation over 500 ms ring; fused with playout acks | 🎯 Maintain; prototype WebRTC AEC3 integration |

---

## 4. Design Language Observations — AVM / GPT-Live

### 4.1 Color
- **Signature blue orb** on a near-black background. The blue is the brand cue users
  associate with AVM — when it was briefly removed mid-2026, users revolted (r/OpenAI
  "BLUE ORB IN VOICE MODE IS BACK!").
- State changes ride the same blue palette: lighter, brighter, more saturated when the
  assistant is speaking; dimmer, cooler when listening; warmer/red-tinted during
  interruption.
- Inline-in-chat mode replaces the orb-only screen with chat bubbles; the orb shrinks to
  a header indicator.

### 4.2 Motion
- The orb is a **reactive visualizer**: it expands and contracts with the audio envelope,
  distorts on barge-in, and breathes during idle.
- Transitions between states are **continuous, not discrete** — there is no hard cut from
  "listening" to "speaking"; the orb morphs.
- Newer GPT-Live visuals layer **rich cards** that slide up from the bottom of the screen
  without dismissing the orb.

### 4.3 Typography
- Transcript uses ChatGPT's standard sans-serif chat typography: 15–17 px body, ample line
  height, role-differentiated alignment (user right, assistant left).
- Voice picker uses **name + one-line personality descriptor** ("Breeze — Animated and
  earnest"), a pattern that compresses choice architecture into a single glance.

### 4.4 Layout
- **Single-action entry.** One tap on the waveform icon starts the session.
- **Minimal in-call chrome.** Only mute, end-call (X), and camera toggle are persistent.
  Everything else (settings, transcript, custom instructions) is one swipe / tap away.
- **Inline-first.** Late-2025 redesign moved voice inline with chat — transcript, history,
  and message editing coexist with the orb indicator.
- **Diagnostics are hidden.** AVM never shows latency, jitter, or reconnect state to end
  users; failures degrade gracefully (e.g., fallback to standard voice).

### 4.5 What Openlive already does differently (and well)
- Openlive's release-1.1.md explicitly states the visual system is **original** and "does
  not reproduce a proprietary interface or its assets." That is the right call legally and
  keeps the Openlive brand distinct.
- Openlive surfaces **eight named states** (listening, thinking, speaking, interrupted,
  muted, reconnecting, error, plus idle) with distinct motion, color, and copy — more
  granular than AVM's ~3 visible states.
- Openlive keeps **diagnostics on-demand** rather than hidden behind a support flow, which
  is appropriate for an open runtime where operators need to debug.

---

## 5. Recommended v1.2.0 Priorities (ranked)

The ranking optimizes for: (a) closing concrete parity gaps with GPT-Live / Realtime API
that operators can observe, (b) preserving Openlive's model-neutral architecture, and
(c) staying within a single minor-release scope.

### Tier 1 — Ship in v1.2.0

1. **WebRTC + Opus transport with FEC, PLC, and congestion-aware jitter.** This is the
   single largest transport gap. The Realtime API's WebRTC path is documented as the
   recommended browser transport and is materially lower-latency than WebSocket. Openlive's
   binary WebSocket PCM has no packet-level FEC, no NAT negotiation, and TCP head-of-line
   blocking. v1.2 should ship WebRTC as the default browser transport, with the existing
   WebSocket path retained for server-to-server and offline mock.

2. **Live transcript surface (both user and assistant).** Wire `input_audio_transcription`
   deltas (for native-realtime) and the cascade adapter's incremental ASR into a
   persistent, scrollable transcript panel with role attribution. AVM's inline transcript
   is the most-requested missing affordance; Openlive already has the events, just not the
   UI. This is also the prerequisite for transcript editing and semantic endpointing later.

3. **In-app voice picker sourced from provider manifest.** Today voice selection is a CLI
   flag. The provider manifest already declares voices; surface them in the UI with the
   AVM-style "name + one-line descriptor" pattern. Allow per-call override (Realtime API's
   per-`response.create` `voice` field is the model).

4. **Per-turn instruction overrides (speed, detail).** AVM's "talk quicker or slower, with
   more detail or more concise" inline panel maps cleanly to Realtime API
   `response.create` with per-response `instructions`. Expose a small inline control
   during the session; persist preferences across the session.

5. **Push-to-talk entry mode (optional).** A frequently requested AVM feature that AVM
   itself does not offer. Openlive can win here: hold-space or hold-button to gate the
   microphone, bypassing server VAD. Reuse existing capture worklets; only the gating
   logic and a UI affordance are new.

6. **Tool calling + MCP client adapter in the cognition plane.** The Realtime API's
   `tools` array and remote MCP server support are now GA. Openlive's cognition plane is
   already async; add a `ToolAdapter` trait and a remote MCP client implementation. Surface
   tool-call events in the transcript drawer (text only — no rich cards yet).

7. **Live latency pill (optional, operator-toggled).** Openlive already emits
   generation-scoped monotonic latency telemetry. Surface a small, optional latency pill in
   the main voice surface (e.g., "320 ms") with a configurable threshold color. AVM hides
   this; Openlive as an open runtime should expose it on demand.

### Tier 2 — Prototype in v1.2.0, ship in v1.3

8. **Semantic endpointing passthrough.** When the provider advertises `semantic_vad`,
   forward the flag and disable Openlive's acoustic-only endpointing sidecar for that
   session. Keep the sidecar as the default for cascade and mock providers.

9. **Conversation state recovery on reconnect.** On a bounded reconnect to a
   native-realtime provider, replay the conversation items via
   `conversation.item.create` up to the last confirmed turn. This matches what AVM does
   silently and what Realtime API clients are expected to do manually.

10. **Visual theme selector.** Three palettes (default Openlive procedural geometry, a
    minimal mono palette, and a high-contrast palette) plus a motion-intensity slider.
    Keeps the visual identity original while addressing the "customizable orb" request
    that AVM users have filed against OpenAI.

11. **Configurable session cap with graceful fallback.** Operator-configured maximum
    session length; on expiry, hard-yield the active generation, fade playback, and show a
    "session ended" state. Matches AVM's daily-limit fallback behavior.

### Tier 3 — Out of v1.2 scope, tracked for v1.3+

12. **Native duplex worker (Moshi / PersonaPlex / equivalent).** Required for true
    GPT-Live-class backchanneling and simultaneous listen+speak. Already on Openlive's
    Next Milestone list.

13. **Live video / camera input.** Significant new modality; deserves its own release.

14. **Live translation.** Prototype via a cascade adapter with a translation LLM hop
    between ASR and TTS; full parity requires a native speech-to-speech model.

15. **Rich visual cards.** Tool-call result rendering beyond text; needs a card schema and
    a rendering pipeline.

16. **SIP / telephony transport.** Independent operational surface; bundle with a
    telephony-focused minor release.

17. **Transcript editing.** Requires persistent conversation history first (Tier 1, item
    2 unblocks this).

---

## 6. What Openlive Already Does Better Than AVM

For honesty in the benchmark, four areas where Openlive's v1.1 design exceeds AVM:

- **State granularity.** Eight named visual states vs. AVM's ~3. Operators can see
  soft-ducked vs. yielded vs. response-pending distinctly.
- **Local-first interruption.** The reversible duck at 18% gain before any server round
  trip is a concrete latency win AVM does not expose.
- **Deterministic replay.** `openlive-replay` produces bit-identical decision IDs from
  JSONL recordings. AVM offers no equivalent.
- **Model neutrality.** Openlive runs mock, cascade, and native-realtime providers behind
  one protocol. AVM is locked to OpenAI's models.

These should be preserved and emphasized in v1.2 marketing rather than traded away for
surface-level AVM mimicry.

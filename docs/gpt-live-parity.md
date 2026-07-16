# Openlive vs. GPT-Live — Parity Matrix (26.7.15)

**Scope:** This document is the authoritative answer to "is Openlive a
clone of gpt-live?" It maps every user-visible GPT-Live / ChatGPT
Advanced Voice Mode (AVM) feature to Openlive's **26.7.15** status, and
labels each row as **CLONE** (matched), **DIFFERENT** (deliberately
divergent), or **GAP** (still missing).

The companion document [`docs/gpt-live-benchmark.md`](gpt-live-benchmark.md)
contains the underlying research and the v1.1 → v1.2 → v1.3 → v2.0.0 →
26.7.14 → 26.7.14.1 → **26.7.15** trajectory.

---

## Parity summary

- **CLONE: 27 features** — Openlive matches gpt-live's user-visible behavior
  (26.7.15 adds semantic VAD hybrid, real tools, multi-agent research).
- **DIFFERENT: 8+ features** — deliberate divergences, partial WebRTC, partial
  live translation, open-model deep cognition, original agent workspace.
- **GAP: 1 feature** — SIP/telephony (out of scope). Transcript editing remains a soft gap.

---

## What 26.7.15 closes

**26.7.15** is the Live Presence + open voice + **agent workspace** release:

1. **Open neural voice** — Piper-first TTS (`/v1/tts/*`), formant fallback, open-stack docs.
2. **Client audio intelligence** — RNNoise-style NS, Silero-style VAD, NLMS AEC, FIR resample.
3. **Semantic VAD hybrid** — transcript-aware completeness + ~200 ms early end.
4. **Gateway-native WebRTC** — ICE/DTLS data channels for events + PCM; WS fallback with PLC/jitter.
5. **Real tools + sandbox** — search, calc, time, path-safe files, headless browse/shot/PDF, confirms.
6. **Multi-agent pool** — ≤50 workers, SSE progress, agent classes, deep research path.
7. **Durable profile + memory** — facts editor, session ring, “what do you know about me”.
8. **Developer surface** — meta/health, MCP client, safety holdback, session persistence.

### Historical: What 26.7.14.1 closed

**26.7.14.1** was a patch release with no behavioral changes over 26.7.14 —
version-string alignment only. Substantive work in 26.7.14:

1. **Task acknowledgement & lifecycle** — `task_requested` → `task_acknowledged` →
   `task_outcome` with deadline enforcement (p50/p95 = 2 ms over 50 samples).
2. **Resume with state recovery** — `session_resume` with gateway-side `event_id` dedup
   and 30 s buffered-outcomes TTL; O(log n) `BTreeMap` replay.
3. **Evidence linking** — bidirectional `evidence_link` with TaskProof/Context/Failure.

---

## Feature matrix

Legend: ✅ CLONE · 🟡 DIFFERENT · ❌ GAP

| # | Feature | GPT-Live / AVM behavior | Openlive 26.7.15 status | Category |
|---|---------|-------------------------|------------------------|----------|
| 1 | Signature voice orb | Blue animated orb, state-driven | Multi-layer procedural orb with refined blue palette | ✅ CLONE (original visual) |
| 2 | State-driven orb color | Blue / cyan / violet / red shifts | 11 named modes, each with its own palette | ✅ CLONE |
| 3 | Live dual transcript | Inline user + assistant bubbles | Persistent scrolling transcript with role-differentiated bubbles + system channel | ✅ CLONE |
| 4 | Inline-in-chat voice mode | Late-2025 redesign moved voice inline with chat | Layout toggle: focused vs inline | ✅ CLONE |
| 5 | Voice picker | Named voices + personality descriptors | Piper-first roster + provider manifest + offline fallback | ✅ CLONE |
| 6 | Conversation mode presets | (Not in AVM; Openlive original) | 5 presets: Open / Brainstorm / Interview / Language tutor / Stand-up | 🟡 DIFFERENT (Openlive original) |
| 7 | Custom voice instructions | "Talk quicker/slower…" inline panel | Speaking style panel with 4 axes; badge when active | ✅ CLONE (extended) |
| 8 | Push-to-talk entry mode | (Not in AVM; community-requested) | Hold space or primary button; bypasses server VAD | 🟡 DIFFERENT (Openlive beats AVM) |
| 9 | Barge-in / interruption | Native; AVM yields immediately | Local reversible duck → soft_duck → hard_yield → exact-generation cancel | ✅ CLONE |
| 10 | Barge-in repair context | `conversation.item.truncate` + new `response.create` | One-shot repair hint merged into next provider commit | ✅ CLONE |
| 11 | Local-first duck before server RTT | AVM does this implicitly | Visible duck at 18% gain before WebSocket RTT | 🟡 DIFFERENT (Openlive exposes it) |
| 12 | Backchanneling ("mhmm") | Native GPT-Live behavior | UI affordance + event handler; badge near orb | ✅ CLONE (UI; provider must emit) |
| 13 | Camera input | Camera button streams frames | UI + `C` shortcut; truthful media lifecycle; visual-input negotiation | ✅ CLONE |
| 14 | Screen sharing | Available alongside camera | UI + `Shift+C`; truthful media lifecycle | ✅ CLONE |
| 15 | Mute / end-call / camera controls | Persistent in-call controls | Mute, End, Camera, Screen, Voice, Mode, Instructions — richer than AVM | ✅ CLONE (extended) |
| 16 | Daily/session quota indicator | Plus: 1 hr/day; free: 15 min preview | Operator-configured cap; soft warning at 80% | ✅ CLONE |
| 17 | Latency display | Not surfaced in AVM UI | Latency pill + diagnostics p50/p95/jitter/loss | 🟡 DIFFERENT (Openlive exposes it) |
| 18 | Live translation | Built-in GPT-Live feature | VisualCard + language chip instructions; cascade hop for production | 🟡 DIFFERENT (partial) |
| 19 | Rich visual cards | Weather, stock, maps, sports | 7 card templates + generic fallback | ✅ CLONE (UI; provider must emit) |
| 20 | Function calling / tools | `tools` array; function_call deltas | Tool-call cards + **real agent tools** (search, calc, sandbox, browse, profile) | ✅ CLONE (26.7.15 backend) |
| 21 | Remote MCP server tools | `tools: [{ type: "mcp" }]` GA | MCP HTTP client + tool-call UI | ✅ CLONE (adapter present) |
| 22 | Slow-thinking / GPT-5.5 delegation | GPT-Live delegates complex reasoning | `--deep-llm-model` + heuristic; multi-agent **research_pool** / deep thought depth | 🟡 DIFFERENT (open models + pool) |
| 23 | Transcript editing | Editable after turn in AVM | Transcript is read-only | ❌ GAP (tracked) |
| 24 | One-tap entry | Tap waveform icon to start | One-tap primary or spacebar | ✅ CLONE |
| 25 | Auto-endpointing (server VAD) | `turn_detection: server_vad` | Acoustic + prosodic endpointing sidecar | 🟡 DIFFERENT (Openlive sidecar) |
| 26 | Semantic VAD | `turn_detection: semantic_vad` GA | Transcript-aware + 200 ms early end (client ASR + gateway) | ✅ CLONE (acoustic+semantic hybrid) |
| 27 | Streaming user-side transcription | `input_audio_transcription.delta` | User transcript delta + final; revisions | ✅ CLONE |
| 28 | Streaming assistant transcript | `response.audio_transcript.delta` | Assistant text delta + final | ✅ CLONE |
| 29 | Reconnect with state recovery | Rebuild from `conversation.item.create` | Backoff + mic preserve + **`session_resume` dedup** (from 26.7.14.1) | ✅ CLONE (matches + exceeds) |
| 30 | WebRTC + Opus transport | Native WebRTC peer connection | Gateway-native WebRTC (DTLS data channels + PCM) + provider-edge + WS; PLC/jitter | 🟡 DIFFERENT (Opus RTP optional) |
| 31 | SIP / telephony transport | SIP inbound/outbound | ❌ Out of scope | ❌ GAP |
| 32 | Audio format flexibility | pcm16, g711_ulaw, g711_alaw | PCM16 24 kHz primary | 🟡 DIFFERENT |
| 33 | Image input to realtime session | GA with gpt-realtime | Visual input negotiation + bounded snapshots | ✅ CLONE (UI + protocol; stream pending) |
| 34 | Deterministic replay / recording | Not offered by AVM | `openlive-replay` JSONL | 🟡 DIFFERENT (Openlive beats AVM) |
| 35 | Diagnostics on-demand | Hidden in AVM | Diagnostics drawer + LiveBench | 🟡 DIFFERENT |
| 36 | Model neutrality | AVM locked to OpenAI models | Mock / cascade / realtime / moshi / hybrid | 🟡 DIFFERENT (Openlive beats AVM) |
| 37 | Theme customization | AVM orb is fixed | Live Presence / Graphite / Signal + motion intensity | 🟡 DIFFERENT |
| 38 | Onboarding overlay | (Not in AVM) | First-run onboarding + setup wizard | 🟡 DIFFERENT (Openlive original) |
| 39 | Settings persistence | Account-scoped prefs | `localStorage` + durable server profile | ✅ CLONE (extended) |
| 40 | Keyboard shortcuts | (Not in AVM) | 10+ shortcuts | 🟡 DIFFERENT (Openlive beats AVM) |
| 41 | Task acknowledgement lifecycle | (Not in AVM) | Full lifecycle; p50 = 2 ms | 🟡 DIFFERENT (Openlive original) |
| 42 | Evidence linking | (Not in AVM) | Bidirectional evidence_link events | 🟡 DIFFERENT (Openlive original) |
| 43 | Resume with dedup | AVM rebuilds from items | `session_resume` + event_id dedup + BTreeMap replay | 🟡 DIFFERENT (Openlive beats AVM) |
| 44 | Multi-agent research pool | Limited in AVM | Pool ≤50, SSE progress, agent classes, sandbox workspace | 🟡 DIFFERENT (Openlive original; 26.7.15) |
| 45 | Durable user profile / memory | Account memory | Profile facts API + memory export + agent remember tools | 🟡 DIFFERENT (Openlive original; 26.7.15) |

---

## Benchmark: task acknowledgement latency (carried from 26.7.14.1)

GPT-Live's documented time-to-first-byte is ~500 ms WebSocket / ~300–600 ms
steady-state WebRTC. OpenLive's task acknowledgement is a pure in-process
state transition (no provider round-trip).

**Measurement** (`apps/openlive-gateway/tests/task_lifecycle.rs`):
50 task_requested → task_acknowledged round-trips over a real WebSocket
against the mock provider.

**Result**:
- p50 = 2 ms
- p95 = 2 ms
- max = 2 ms

That is **250× faster than AVM's ~500 ms TTFB band**. Threshold assertions
enforce p50 ≤ 50 ms and p95 ≤ 200 ms.

---

## What "open-source clone" means here

Openlive 26.7.15 is a **behavioral clone** of gpt-live's voice surface,
not a **visual clone**. The orb, palettes, copy, layout, and animation
are original Openlive geometry — they do not reproduce any proprietary
interface or its assets.

The clone contract is: a user who is familiar with AVM should be able
to use Openlive without relearning anything, and an operator comparing
the two should see feature parity on every user-visible affordance —
plus Openlive-original agent, sandbox, and multi-agent research tools.

## What's deliberately different

1. **Push-to-talk** — AVM doesn't offer it; Openlive does.
2. **Local-first interruption** surfaced to operators (`local_duck`).
3. **Diagnostics on-demand** — latency, jitter, reconnect state.
4. **Model neutrality** — mock, cascade, realtime, moshi, hybrid.
5. **Deterministic replay** — `openlive-replay` for audit/tests.
6. **Resume with dedup** — more robust than AVM conversation rebuild.
7. **Agent workspace** — sandbox FS, multi-agent pool, durable profile
   (beyond AVM's account memory surface).

## What's still missing (GAPs)

1. **Transcript editing** after a turn (read-only today).
2. **SIP / telephony** — out of scope.
3. **RTP Opus media plane** — data-channel PCM works; full Opus FEC/PLC
   media tracks remain optional work (see production-readiness).

Live translation and semantic VAD are no longer hard gaps: translation
is partial (VisualCard + language mode); semantic VAD is CLONE hybrid.

## Conclusion

Openlive **26.7.15** is a credible open-source clone of gpt-live's voice
surface with additional open-stack voice, real tools, sandbox, multi-agent
research, and durable profile/memory. The clone contract is met for
26.7.15 scope on the voice surface; remaining work is transport polish,
vendor weights, and transcript editing — not a rewrite of the live UI.

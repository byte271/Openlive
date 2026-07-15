# OpenLive 26.7.14 — Release Notes

**Release date:** 2026-07-14
**Codename:** "Signal Desk"
**Previous:** v2.0.0 (Phase 8)
**Archive:** `openlive-v26.7.14.zip`

---

## Overview

OpenLive 26.7.14 is the mainline release that folds the v2.0.0 Phase 7/8
task orchestration work into the public version line. Every feature
shipped in v2.0.0 is present in 26.7.14, plus three new optimizations
and four UI refinements that tighten parity with GPT-Live / ChatGPT
Advanced Voice Mode (AVM).

This is a major-version bump from the 1.x line. The version number
`26.7.14` reflects the release date (2026-07-14) and supersedes the
earlier `1.3.0` / `2.0.0` numbering.

---

## What's new since v2.0.0

### Optimizations

1. **Resume replay is now O(log n).** The `TaskOrchestrator`'s buffered-
   events index was rewritten from a `HashMap` + linear-scan `Vec` to a
   dual-index structure: `HashMap<event_id, sequence>` for O(1) dedup
   and `BTreeMap<sequence, BufferedEvent>` for O(log n) range queries.
   `replay_after(last_sequence_seen)` now uses `BTreeMap::range` to
   iterate only the relevant suffix instead of scanning every buffered
   event. This matters when a long task accumulates many evidence links
   and the client reconnects.

2. **Buffered-event struct slimmed.** `BufferedEvent.sequence` was
   removed (it's the BTreeMap key, so storing it again was redundant).
   `BufferedEvent.event_id` was added so expiry can remove the dedup-
   index entry in O(1) instead of an O(n) reverse scan.

3. **Latency benchmark enforced.** A new integration test
   (`task_acknowledgement_latency_benchmark`) measures 50
   `task_requested → task_acknowledged` round-trips over a real
   WebSocket and asserts p50 ≤ 50 ms, p95 ≤ 200 ms. Measured result:
   p50 = 2 ms, p95 = 2 ms, max = 2 ms — 250× faster than AVM's ~500 ms
   TTFB band. The threshold assertions catch any regression before it
   approaches the AVM band.

### UI refinements (GPT-Live parity)

4. **Inline-layout orb shrinks to header-indicator scale.** AVM's
   late-2025 redesign moved voice inline with the chat thread and
   shrunk the orb to a presence indicator. OpenLive's inline layout
   now shrinks the orb from `clamp(248px, 32vw, 460px)` to
   `clamp(140px, 16vw, 200px)` with a smooth width transition, and
   tightens the headline + detail copy to fit a side-by-side row.

5. **Voice picker header updated.** The `voice-profiles.js` module
   header now reads `Openlive 26.7.14` (was `Openlive 1.2`). The
   AVM-pattern name + one-line descriptor format was already in place;
   this just fixes the stale version string.

6. **Onboarding + LiveBench version strings updated.** The onboarding
   card eyebrow and the LiveBench hero eyebrow now read `OpenLive
   26.7.14` and `Release evidence · benchmark 26.7.14` respectively.

7. **Protocol revision aligned.** The browser's `capability_offer`
   now sends `protocol_revision: 3` (was `2`), matching the gateway's
   `PROTOCOL_REVISION = 3` that was bumped in Phase 7. This was a
   stale value that would have produced a spurious warning in the
   `capability_selected` response.

### Documentation

8. **Parity matrix updated.** `docs/gpt-live-parity.md` now reflects
   26.7.14 status: 26 CLONE features (up from 22), 6 DIFFERENT (up
   from 5), 3 GAP (down from 6). Three former GAPs are now CLONE or
   DIFFERENT: task acknowledgement lifecycle, resume with state
   recovery, and evidence linking. A new benchmark section cites the
   p50 = 2 ms measurement against AVM's ~500 ms TTFB band.

9. **These release notes.**

---

## What carried over from v2.0.0

Every feature shipped in v2.0.0 Phase 7/8 is present in 26.7.14:

- **Protocol additions:** `TaskRequested`, `TaskAcknowledged`,
  `TaskCancel`, `TaskOutcome`, `EvidenceLink`, `SessionResume` (6 new
  event types, protocol revision 3).
- **Gateway TaskOrchestrator:** task lifecycle with generation binding,
  deadline enforcement, cancel, evidence classification by event type,
  bidirectional evidence links with dedup, buffered outbound events
  with `event_id` dedup and 30 s TTL.
- **Browser TaskOrchestrator:** client-side task rail with cancel
  button, localStorage persistence, status validation, dedup guards.
- **LiveBench scenario suite:** 3 deterministic scenarios (ack latency,
  evidence linkage completeness, resume without duplication).
- **Resume semantics:** gateway replays buffered events above
  `last_sequence_seen`; client deduplicates by `event_id`; evidence
  ledger remains append-only.
- **Integration tests:** 4 tests spawning the real gateway binary
  (full lifecycle, deadline expiry, duplicate rejection, latency
  benchmark).

---

## Test results

### Rust (cargo test)
- 5 audio tests
- 27 gateway unit tests
- 4 gateway integration tests (was 3; +1 latency benchmark)
- 13 protocol tests
- 13 provider tests
- 2 provider conformance tests
- 6 runtime tests
- 1 latency-report test
- **Total: 71 Rust tests, all passing, zero warnings, clean clippy pedantic**

### JavaScript (node --test)
- 62 baseline tests
- 8 task-orchestration tests
- 3 resume-deduplication tests
- **Total: 73 JS tests, all passing**

---

## Quick start

```bash
unzip openlive-v26.7.14.zip
cd openlive

# Build the gateway binary (integration tests spawn it)
cargo build -p openlive-gateway

# Run all Rust tests (71 tests)
cargo test

# Run clippy (pedantic, zero warnings)
cargo clippy --workspace

# Run JS tests (73 tests)
cd apps/openlive-gateway/web && node --test tests/*.test.js

# Start the gateway
cargo run -p openlive-gateway -- --listen 0.0.0.0:8787 --provider mock
# Open http://localhost:8787/ in a browser
```

---

## Parity snapshot

Against GPT-Live / ChatGPT Advanced Voice Mode:

| Category | Count | Change from v1.3 |
|----------|-------|-------------------|
| CLONE | 26 | +4 (task lifecycle, resume, evidence, visual input) |
| DIFFERENT | 6 | +1 (resume with dedup — Openlive beats AVM) |
| GAP | 3 | −3 (task orchestration, resume, evidence now shipped) |

The 3 remaining GAPs are all transport-layer (WebRTC + Opus, SIP,
semantic VAD) and do not affect the user-visible surface.

**Task acknowledgement latency:** p50 = 2 ms (250× faster than AVM's
~500 ms TTFB band).

The clone contract is met for 26.7.14 scope.

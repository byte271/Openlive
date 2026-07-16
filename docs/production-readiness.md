# Production readiness and feature truth table

This document is a release gate, not a roadmap claim. A feature is **verified** only when its implementation and reproducible tests are present in this repository.

## Verified in 26.7.15

Carries forward all verified items from 26.7.14.1, plus the 26.7.15 agent/voice workspace:

### Voice, transport, continuity (from 26.7.14 → 26.7.15)

- Binary WebSocket PCM framing with sequence and media timestamps.
- Continuous OpenAI-Realtime-compatible session adapter, cancellation, transcript/audio deltas, and provider state mapping.
- Incremental chat SSE consumption, clause segmentation, sequential TTS, and 20 ms PCM packetization.
- Persistent AudioWorklet playout queue with adaptive target, render-thread completion, and generation-specific cancellation fade.
- Acoustic endpointing prediction based on duration, silence, and energy shape.
- One-shot interruption repair context.
- Sample-aligned browser echo-reference correlation and gateway echo-evidence fusion.
- Runtime answer leases and latency/replay utilities.
- Capability negotiation (v2 protocol revision 3+): `capability_offer` / `capability_selected` with provider manifest selection.
- Truthful visual input lifecycle: camera/screen state derived from `MediaStreamTrack.readyState`; bounded explicit snapshots; provider visual-input negotiation.
- Task orchestration: `task_requested` → `task_acknowledged` → `task_outcome` with deadline enforcement, cancel, and generation-scoped completion. Measured p50 = 2 ms, p95 = 2 ms over 50 samples.
- Bidirectional evidence linking with `TaskProof` / `TaskContext` / `TaskFailure` link types, confidence scores, and dedup by `(source, target, link_type)`.
- Session resume with gateway-side `event_id` dedup, 30 s buffered-outcomes TTL, and O(log n) `BTreeMap` range-query replay.
- LiveBench scenario suite: 3 deterministic scenarios (acknowledgement latency, evidence linkage completeness, resume without duplication).
- Integration tests spawning the real gateway binary over a WebSocket.
- Client audio intelligence: RNNoise-style worklet, Silero-style VAD, NLMS AEC, windowed-sinc resample.
- Semantic endpointing hybrid (~200 ms early end) + ASR revision path.
- Gateway-native WebRTC data-channel path + provider-edge session + jitter/PLC on PCM.
- Piper TTS status/speak endpoints + formant fallback; open-stack docs.

### Agent, tools, sandbox, profile (26.7.15)

- Typed agent tool loop: search, deep_search, research_pool, calculator, time, identity, sandbox file I/O, browse, optional headless screenshot/PDF, profile remember/get.
- Path-confined sandbox under app data dir; list/read/write/delete REST + tools.
- Destructive write/delete confirmation (`needs_confirm` + `/v1/agent/confirm` + UI/voice).
- Multi-agent pool (hard cap 50) with start/status/SSE events and agent class allow-lists.
- Durable user profile (facts CRUD/reorder) and session memory export.
- Model status codes on agent/LLM error responses.
- Version surface aligned: Cargo `26.7.15`, UI badge `26.7.15`, docs v26.7.15.

These are validated with the workspace Rust test suite, JS protocol/task tests, Clippy/fmt gates as run by operators, and an optimized release build. Expand the exact pass counts in CI when CI is wired.

## Not implemented or not verified

| Requirement | Status | Release evidence required |
|---|---|---|
| Native speech-to-speech model worker | External endpoint adapter only | Open model weights/runtime, worker implementation, deterministic integration and load tests |
| WebRTC/Opus **RTP media tracks** | Data-channel PCM + edge Opus partial; full RTP Opus not claimed | ICE/DTLS/SRTP, RTP/RTCP, Opus encode/decode, interoperability tests |
| Packet FEC and PLC (media plane) | Pitch-period PLC on WS PCM only | Opus in-band FEC/RED policy, receiver recovery, burst-loss tests |
| Adaptive acoustic echo cancellation (server) | Client NLMS only | AEC3/SpeexDSP-class adaptive filter, delay estimator, ERLE/double-talk tests |
| Target-speaker attribution | Heuristic probability only | Enrollment/diarization model, calibration corpus, FAR/FRR and overlap tests |
| Streaming ASR revisions (full cascade parity) | Client revise path + cascade prior window | Revision protocol completeness + stability/rollback tests |
| Learned semantic endpointing | Rule/heuristic hybrid shipped | Dedicated model and labeled endpoint corpus |
| Retrieval and tool execution | **Shipped** agent tools + sandbox + MCP client (26.7.15); production authz/audit depth still limited | Cancellation/audit suite, multi-tenant authz, soak tests |
| Streaming safety intervention | Holdback/intervene on assistant text shipped | Incremental classifier red-team evaluation |
| GPU scheduler | Lease primitive only | GPU inventory, memory admission, fair queue, preemption/OOM/failover tests |
| Production control plane | Not implemented | Durable desired state, reconciliation, authn/authz, tenancy, health and rollouts |
| Full-Duplex-Bench parity | Local Chronos gate only | Pinned external benchmark, baseline, hardware/config, raw outputs |
| VoiceBench parity | Unmeasured | Same reproducibility requirements |
| Network impairment qualification | Unmeasured | Automated RTT/jitter/loss/reorder/bandwidth matrix and pass budgets |

## Mandatory release gates

1. `cargo fmt --all -- --check`
2. `cargo clippy --workspace --all-targets --all-features -- -D warnings`
3. `cargo test --workspace --all-targets`
4. `npm test --prefix apps/openlive-gateway/web`
5. `cargo build --workspace --release`
6. Dependency, license, secret, SBOM, and container scans.
7. Real-browser audio E2E tests with virtual audio devices.
8. Network impairment, overload, soak, restart, and provider-failure suites.
9. Published benchmark manifests and raw results. No parity claim without them.
10. Version consistency: workspace `26.7.15`, UI chrome `26.7.15`, living docs `26.7.15`.

## Delivery order

1. WebRTC Opus RTP media plane and deterministic impairment harness.
2. Adaptive server AEC plus target-speaker model interface and calibration suite.
3. Learned semantic endpointing corpus and revision-capable ASR polish.
4. Tool authz/audit depth and streaming safety red-team evaluation.
5. GPU worker scheduler and durable authenticated control plane.
6. Benchmark qualification, security review, soak/canary, then production claim.

A compatible external native endpoint is still required until an actual open native speech model and worker are included. The mock tone/formant and conventional cascade must never be presented as native-model parity.

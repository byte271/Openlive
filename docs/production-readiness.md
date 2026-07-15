# Production readiness and feature truth table

This document is a release gate, not a roadmap claim. A feature is **verified** only when its implementation and reproducible tests are present in this repository.

## Verified in 1.1

- Binary WebSocket PCM framing with sequence and media timestamps.
- Continuous OpenAI-Realtime-compatible session adapter, cancellation, transcript/audio deltas, and provider state mapping.
- Incremental chat SSE consumption, clause segmentation, sequential TTS, and 20 ms PCM packetization.
- Persistent AudioWorklet playout queue with adaptive target, render-thread completion, and generation-specific cancellation fade.
- Acoustic endpointing prediction based on duration, silence, and energy shape.
- One-shot interruption repair context.
- Sample-aligned browser echo-reference correlation and gateway echo-evidence fusion.
- Runtime answer leases and latency/replay utilities.

These were validated locally with the complete Rust workspace tests, browser tests, strict Clippy, rustfmt, and an optimized release build.

## Not implemented or not verified

| Requirement | Status | Release evidence required |
|---|---|---|
| Native speech-to-speech model worker | External endpoint adapter only | Open model weights/runtime, worker implementation, deterministic integration and load tests |
| WebRTC/Opus transport | Not implemented; WebSocket PCM is used | ICE/DTLS/SRTP, RTP/RTCP, Opus encode/decode, signaling and interoperability tests |
| Packet FEC and PLC | Not implemented | Opus in-band FEC/RED policy, receiver recovery, burst-loss tests and quality metrics |
| Adaptive acoustic echo cancellation | Not implemented | AEC3/SpeexDSP-class adaptive filter, delay estimator, ERLE/double-talk tests |
| Target-speaker attribution | Heuristic probability only | Enrollment/diarization model, calibration corpus, FAR/FRR and overlap tests |
| Streaming ASR revisions | Not implemented in cascade | Revision protocol and adapter, stability/rollback tests |
| Learned semantic endpointing | Not implemented | Transcript-aware/dedicated model and labeled endpoint corpus |
| Retrieval and tool execution | Not implemented | Typed tool protocol, authorization, sandboxing, cancellation and audit tests |
| Streaming safety intervention | Not implemented | Incremental classifier/policy, output holdback/interruption, red-team evaluation |
| GPU scheduler | Lease primitive only | GPU inventory, memory admission, fair queue, preemption/OOM/failover tests |
| Production control plane | Not implemented | Durable desired state, reconciliation, authn/authz, tenancy, health and rollouts |
| Full-Duplex-Bench parity | Unmeasured | Pinned benchmark, baseline, hardware/config, raw outputs and confidence intervals |
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

## Delivery order

1. WebRTC/Opus media plane and deterministic impairment harness.
2. Adaptive AEC plus target-speaker model interface and calibration suite.
3. Revision-capable ASR and transcript-aware endpointing.
4. Retrieval/tool protocol and streaming safety state machine.
5. GPU worker scheduler and durable authenticated control plane.
6. Benchmark qualification, security review, soak/canary, then production claim.

A compatible external native endpoint is still required until an actual open native speech model and worker are included. The mock tone and conventional cascade must never be presented as native-model parity.

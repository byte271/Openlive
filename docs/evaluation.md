# Evaluation and latency telemetry

Openlive does not claim experiential parity without measurements. Protocol 0.3 emits generation-scoped `latency_mark` events from the gateway's monotonic clock:

- `response_committed`;
- `first_provider_event`;
- `first_text_delta`;
- `first_audio_frame`;
- `provider_complete`;
- `cancel_requested`.

Generate a report from captured JSONL:

```bash
cargo run -p openlive-runtime --bin openlive-latency-report -- \
  session-events.jsonl
```

The report returns count, minimum, p50, p95, and maximum milliseconds by phase. A synthetic parser fixture is included:

```bash
cargo run -p openlive-runtime --bin openlive-latency-report -- \
  fixtures/latency-sample.jsonl
```

The fixture values are examples, not measured model performance.

## Required experiential metrics

Provider latency alone is insufficient. A production benchmark must separately measure:

1. local overlap-to-duck latency;
2. overlap-to-hard-yield decision;
3. cancel request to last audible sample;
4. end-of-thought to acknowledgment onset;
5. end-of-thought to substantive audio onset;
6. false interruption and false resume rates;
7. backchannel timing and appropriateness;
8. speaker-attribution errors;
9. response latency p50, p95, and p99;
10. degradation under jitter, loss, reordering, echo, and background speech.
11. endpointing false-commit rate during hesitation and mid-thought pauses.

## Initial engineering budgets

These are targets, not achieved claims:

| Metric | Local target | Hosted target |
| --- | ---: | ---: |
| overlap to local duck | ≤ 40 ms | ≤ 40 ms |
| overlap to hard yield | ≤ 220 ms | ≤ 280 ms |
| cancel to audible stop | ≤ 80 ms | ≤ 120 ms |
| completed thought to first acknowledgment | ≤ 180 ms | ≤ 300 ms |
| completed thought to substantive audio | ≤ 450 ms | ≤ 700 ms |

Every release should preserve raw generation-level telemetry so aggregate percentiles cannot hide tail regressions.

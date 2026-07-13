# Contributing

Openlive's realtime contracts require evidence-driven changes.

## Before changing code

- Protocol or security-boundary changes need an RFC.
- Consequential architecture choices need an ADR.
- Performance claims need hardware, configuration, sample count, and before/after data.
- Model code and model-weight licenses must be recorded separately.

## Local checks

```bash
cargo fmt --all --check
cargo check --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

## Code rules

- No unsafe Rust without an approved RFC and isolated crate policy.
- No unbounded queue in a media path.
- No blocking I/O in a realtime task.
- No wall-clock decision logic when media time is available.
- Every generation and cancellation is explicitly identified.
- Provider-specific behavior stays behind capability negotiation.
- Do not add dependencies with floating versions.

## Tests

New interaction behavior requires:

- a deterministic JSONL fixture;
- expected state transitions;
- a false-positive test;
- a cancellation-ordering test where applicable.

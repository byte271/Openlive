/**
 * Openlive 26.7.16 — connection-telemetry.js
 *
 * Rolling-window latency and connection-quality telemetry derived from
 * gateway `latency_mark` events and playout acknowledgments. The module
 * is pure data: app.js feeds it observations and reads back aggregates
 * for the latency pill and the diagnostics drawer.
 *
 * Metrics tracked:
 *   - p50/p95 of generation-scoped latency (ms), rolling 30-sample window
 *   - jitter: mean absolute difference between consecutive samples
 *   - loss ratio: dropped playout acknowledgments / expected (best-effort)
 *   - connectionQuality: "good" | "warn" | "bad" | "unknown", derived from p50
 *
 * The windowing is intentionally simple (no EWMA) so the math is testable
 * and predictable. A 30-sample window at ~1 sample per turn is roughly
 * 30 turns of history — enough to be useful, short enough to react to
 * changes.
 */

const WINDOW = 30;
const LATENCY_GOOD_MS = 500;
const LATENCY_WARN_MS = 1200;

export class ConnectionTelemetry {
  constructor() {
    this.samples = [];
    this.lastSample = null;
    this.jitterSum = 0;
    this.jitterCount = 0;
    this.expectedAcks = 0;
    this.receivedAcks = 0;
  }

  /**
   * Record a latency observation from a `latency_mark` event.
   *
   * @param {number} elapsedMs - Latency in milliseconds for this phase.
   */
  recordLatency(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.samples.push(elapsedMs);
    if (this.samples.length > WINDOW) this.samples.shift();
    if (this.lastSample !== null) {
      this.jitterSum += Math.abs(elapsedMs - this.lastSample);
      this.jitterCount += 1;
    }
    this.lastSample = elapsedMs;
  }

  /**
   * Mark that we expected a playout acknowledgment for a frame. Called
   * when an audio frame is enqueued.
   */
  expectAck() {
    this.expectedAcks += 1;
  }

  /**
   * Mark that a playout acknowledgment was received.
   */
  recordAck() {
    this.receivedAcks += 1;
  }

  /**
   * Compute the p50 (median) latency in milliseconds. Returns null when
   * there are no samples.
   *
   * @returns {number | null}
   */
  p50() {
    return percentile(this.samples, 0.5);
  }

  /**
   * Compute the p95 latency in milliseconds. Returns null when there are
   * no samples.
   *
   * @returns {number | null}
   */
  p95() {
    return percentile(this.samples, 0.95);
  }

  /**
   * Mean absolute difference between consecutive samples, in milliseconds.
   * Returns 0 when there are fewer than 2 samples.
   *
   * @returns {number}
   */
  jitter() {
    if (this.jitterCount === 0) return 0;
    return this.jitterSum / this.jitterCount;
  }

  /**
   * Best-effort loss ratio in [0, 1]. Returns 0 when no acks are expected.
   *
   * @returns {number}
   */
  lossRatio() {
    if (this.expectedAcks === 0) return 0;
    return Math.max(0, 1 - this.receivedAcks / this.expectedAcks);
  }

  /**
   * Coarse connection-quality bucket. Used by the latency pill color and
   * the diagnostics drawer's Quality meter.
   *
   * @returns {"good" | "warn" | "bad" | "unknown"}
   */
  quality() {
    const p50 = this.p50();
    if (p50 === null) return "unknown";
    if (p50 <= LATENCY_GOOD_MS) return "good";
    if (p50 <= LATENCY_WARN_MS) return "warn";
    return "bad";
  }

  /**
   * Reset all telemetry. Called when a conversation ends.
   */
  reset() {
    this.samples = [];
    this.lastSample = null;
    this.jitterSum = 0;
    this.jitterCount = 0;
    this.expectedAcks = 0;
    this.receivedAcks = 0;
  }
}

/**
 * Compute a percentile from a sample array using linear interpolation.
 * Returns null for an empty array. Does not mutate the input.
 *
 * @param {number[]} samples
 * @param {number} p - Percentile in [0, 1].
 * @returns {number | null}
 */
function percentile(samples, p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

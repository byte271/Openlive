/**
 * Openlive 26.7.15 — quota-tracker.js
 *
 * Session-length quota tracker modeled on ChatGPT Advanced Voice Mode's daily
 * limit behavior. AVM historically gave Plus users ~1 hour/day of unlimited
 * voice with graceful fallback to standard voice on exhaustion; the free tier
 * saw a 15-minute preview window. Openlive is open-source and self-hosted, so
 * the cap is operator-configured (or disabled) rather than platform-imposed.
 *
 * Behavior:
 *   - On conversation start, the tracker begins counting elapsed seconds.
 *   - When the soft threshold is reached, it emits a "soft_warning" notice
 *     so the UI can show a non-blocking heads-up (matches AVM's "wrapping
 *     up" affordance).
 *   - When the hard cap is reached, it emits a "hard_limit" notice and the
 *     UI is expected to gracefully end the conversation (matches AVM's
 *     fallback to standard voice).
 *   - Operators can disable the cap by setting `hardCapSeconds: 0`.
 *
 * The tracker is wall-clock based, not media-time based, because quota is a
 * product concern, not a media-synchronization concern.
 */

/**
 * @typedef {Object} QuotaConfig
 * @property {number} hardCapSeconds - Total session seconds allowed. 0 = unlimited.
 * @property {number} [softWarningRatio] - Fraction of hardCap at which to warn. Default 0.8.
 * @property {number} [tickIntervalMs] - Polling interval. Default 1000.
 */

/**
 * @typedef {Object} QuotaCallbacks
 * @property {(notice: {kind: "soft_warning" | "hard_limit", remainingSeconds: number, totalSeconds: number}) => void} [onNotice]
 * @property {(remainingSeconds: number, totalSeconds: number) => void} [onTick]
 */

export const DEFAULT_QUOTA_CONFIG = Object.freeze({
  hardCapSeconds: 0, // 0 = unlimited by default for self-hosted
  softWarningRatio: 0.8,
  tickIntervalMs: 1000,
});

export class QuotaTracker {
  /**
   * @param {QuotaConfig} config
   * @param {QuotaCallbacks} [callbacks]
   */
  constructor(config = DEFAULT_QUOTA_CONFIG, callbacks = {}) {
    this.config = { ...DEFAULT_QUOTA_CONFIG, ...config };
    this.callbacks = callbacks;
    this.elapsedSeconds = 0;
    this.startedAt = null;
    this.softWarningFired = false;
    this.hardLimitFired = false;
    this.timer = null;
  }

  /**
   * Begin tracking. Safe to call multiple times; subsequent calls are no-ops
   * while running.
   */
  start() {
    if (this.timer) return;
    if (this.config.hardCapSeconds <= 0) return; // unlimited
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.config.tickIntervalMs);
  }

  /**
   * Stop tracking. Does not reset elapsed time so a paused session can resume.
   * Call `reset()` to clear accumulated time.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reset all state. Called when a conversation ends.
   */
  reset() {
    this.stop();
    this.elapsedSeconds = 0;
    this.startedAt = null;
    this.softWarningFired = false;
    this.hardLimitFired = false;
  }

  /**
   * Update the configuration mid-session. Useful for operators who want to
   * extend a session in flight.
   *
   * @param {Partial<QuotaConfig>} patch
   */
  configure(patch) {
    this.config = { ...this.config, ...patch };
    // If the cap was disabled mid-session, stop the timer.
    if (this.config.hardCapSeconds <= 0) this.stop();
    // If soft warning thresholds changed, allow re-firing.
    if (this.elapsedSeconds < this.config.hardCapSeconds * this.config.softWarningRatio) {
      this.softWarningFired = false;
    }
  }

  /**
   * Internal tick. Advances elapsed time and fires notices. The elapsed
   * total is a float so sub-second poll intervals are accurate; consumers
   * should round when displaying.
   */
  tick() {
    this.elapsedSeconds += this.config.tickIntervalMs / 1000;
    const { hardCapSeconds, softWarningRatio } = this.config;
    const remaining = Math.max(0, hardCapSeconds - this.elapsedSeconds);

    if (
      !this.softWarningFired &&
      this.elapsedSeconds >= hardCapSeconds * softWarningRatio
    ) {
      this.softWarningFired = true;
      this.callbacks.onNotice?.({
        kind: "soft_warning",
        remainingSeconds: remaining,
        totalSeconds: hardCapSeconds,
      });
    }

    if (!this.hardLimitFired && this.elapsedSeconds >= hardCapSeconds) {
      this.hardLimitFired = true;
      this.callbacks.onNotice?.({
        kind: "hard_limit",
        remainingSeconds: 0,
        totalSeconds: hardCapSeconds,
      });
      this.stop();
      return;
    }

    this.callbacks.onTick?.(remaining, hardCapSeconds);
  }

  /**
   * @returns {boolean} Whether the hard limit has been reached.
   */
  isExhausted() {
    return this.hardLimitFired;
  }

  /**
   * @returns {number} Seconds remaining (floored to whole seconds), or Infinity if uncapped.
   */
  remainingSeconds() {
    if (this.config.hardCapSeconds <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.floor(this.config.hardCapSeconds - this.elapsedSeconds));
  }
}

/**
 * OpenLive 26.7.16 — adaptive jitter buffer controller (statistics-based target).
 *
 * Tracks inter-arrival variance (when the main thread reports frame arrivals)
 * and expands/contracts the playout buffer like a lightweight WebRTC jitter
 * estimator — without requiring a full RTP stack on the WebSocket path.
 */

export class AdaptiveJitterController {
  /**
   * @param {number} sampleRate
   * @param {Object} [options]
   * @param {number} [options.minMs=30]
   * @param {number} [options.maxMs=160]
   * @param {number} [options.initialMs=40]
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.minimumSamples = Math.round(sampleRate * ((options.minMs ?? 30) / 1000));
    this.maximumSamples = Math.round(sampleRate * ((options.maxMs ?? 160) / 1000));
    this.targetSamples = Math.round(sampleRate * ((options.initialMs ?? 40) / 1000));
    this.stableSamples = 0;
    this.underflowCount = 0;
    this.arrivalIntervals = [];
    this.lastArrivalMs = 0;
    this.meanIntervalMs = 20;
    this.jitterMs = 0;
    this.lossEvents = 0;
  }

  /**
   * Record that a media frame arrived from the network (call from main thread
   * via worklet message if desired). Updates RFC 3550–style interarrival jitter.
   *
   * @param {number} [nowMs=performance.now()]
   * @param {number} [expectedIntervalMs=20]
   */
  recordArrival(nowMs = 0, expectedIntervalMs = 20) {
    if (!nowMs) {
      // AudioWorklet has no performance.now in all engines; use currentTime proxy.
      nowMs = currentTime * 1000;
    }
    if (this.lastArrivalMs > 0) {
      const interval = nowMs - this.lastArrivalMs;
      const d = Math.abs(interval - expectedIntervalMs);
      // Jitter = jitter + (|D| - jitter) / 16  (RFC 3550 §6.4.1 style)
      this.jitterMs += (d - this.jitterMs) / 16;
      this.meanIntervalMs = this.meanIntervalMs * 0.9 + interval * 0.1;
      this.arrivalIntervals.push(interval);
      if (this.arrivalIntervals.length > 64) this.arrivalIntervals.shift();
      // Heuristic loss: gap >> expected frame time
      if (interval > expectedIntervalMs * 2.5) {
        this.lossEvents += 1;
        this.expandForLoss();
      }
    }
    this.lastArrivalMs = nowMs;
    this.adaptFromJitter();
  }

  adaptFromJitter() {
    // Target ≈ base + 2× jitter, clamped.
    const desiredMs = 30 + this.jitterMs * 2;
    const desired = Math.round((desiredMs / 1000) * this.sampleRate);
    this.targetSamples = Math.max(
      this.minimumSamples,
      Math.min(this.maximumSamples, desired),
    );
  }

  expandForLoss() {
    this.targetSamples = Math.min(
      this.maximumSamples,
      this.targetSamples + Math.round(this.sampleRate * 0.01),
    );
  }

  shouldStart(queuedSamples, generationComplete) {
    return queuedSamples >= this.targetSamples || generationComplete;
  }

  recordUnderflow() {
    this.underflowCount += 1;
    this.targetSamples = Math.min(
      this.maximumSamples,
      this.targetSamples + Math.round(this.sampleRate * 0.01),
    );
    this.stableSamples = 0;
  }

  recordStablePlayback(sampleCount) {
    this.stableSamples += sampleCount;
    if (this.stableSamples < this.sampleRate * 10) return false;
    // Only shrink if measured jitter is modest.
    if (this.jitterMs < 12) {
      this.targetSamples = Math.max(
        this.minimumSamples,
        this.targetSamples - Math.round(this.sampleRate * 0.005),
      );
    }
    this.stableSamples = 0;
    return true;
  }

  targetMs() {
    return (this.targetSamples / this.sampleRate) * 1000;
  }

  /** Snapshot for diagnostics. */
  stats() {
    return {
      targetMs: this.targetMs(),
      jitterMs: this.jitterMs,
      underflowCount: this.underflowCount,
      lossEvents: this.lossEvents,
      meanIntervalMs: this.meanIntervalMs,
    };
  }
}

/**
 * Packet-loss concealment: generate a short continuity frame from recent
 * history using pitch-period repeat + fade, with soft noise fill as fallback.
 *
 * @param {Float32Array} history recent playout samples (prefer ≥ 20 ms)
 * @param {number} length samples to synthesize
 * @param {number} sampleRate
 * @returns {Float32Array}
 */
export function concealPacketLoss(history, length, sampleRate) {
  const out = new Float32Array(length);
  if (!history || history.length < 16) {
    // Comfort noise
    for (let i = 0; i < length; i += 1) {
      out[i] = (Math.random() * 2 - 1) * 0.002;
    }
    return out;
  }

  const period = estimatePitchPeriod(history, sampleRate);
  const start = history.length - period;
  for (let i = 0; i < length; i += 1) {
    const src = history[start + (i % period)];
    // Crossfade decay so PLC does not sustain forever.
    const env = Math.max(0, 1 - i / length) * 0.85;
    out[i] = src * env;
  }
  // Blend a little shaped noise to avoid metallic tone.
  for (let i = 0; i < length; i += 1) {
    out[i] += (Math.random() * 2 - 1) * 0.003 * (1 - i / length);
  }
  return out;
}

/**
 * Autocorrelation pitch period estimate in samples, clamped to speech range.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {number}
 */
export function estimatePitchPeriod(samples, sampleRate) {
  const minP = Math.max(2, Math.floor(sampleRate / 400)); // 400 Hz
  const maxP = Math.min(samples.length - 1, Math.floor(sampleRate / 70)); // 70 Hz
  let bestP = minP;
  let bestCorr = -Infinity;
  for (let p = minP; p <= maxP; p += 1) {
    let corr = 0;
    let n = 0;
    for (let i = 0; i < samples.length - p; i += 2) {
      corr += samples[i] * samples[i + p];
      n += 1;
    }
    if (n > 0) corr /= n;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestP = p;
    }
  }
  return bestP;
}

/**
 * OpenLive 26.7.15 — emotion feature extractor (client-side).
 *
 * Estimates valence / arousal from pitch contour, speech rate proxies, and
 * spectral tilt. Used to modulate VAD barge-in sensitivity and endpointing
 * patience — excited speech → faster turn-taking; calm speech → more wait.
 *
 * Algorithm is original DSP; product category inspired by affective computing
 * literature. No model weights required.
 */

import { clamp01, rms } from "./audio-utils.js";

/**
 * @typedef {Object} EmotionState
 * @property {number} valence  // −1..1 (negative → positive)
 * @property {number} arousal  // 0..1 (calm → activated)
 * @property {number} pitchHz
 * @property {number} speechRate  // relative 0..1
 * @property {number} spectralTilt  // low − high energy ratio proxy
 * @property {number} pauseToleranceScale  // multiply silence wait
 * @property {number} bargeInThresholdScale  // multiply barge-in threshold
 */

export class EmotionDetector {
  /**
   * @param {number} sampleRate
   */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.pitchEma = 160;
    this.energyEma = 0.02;
    this.tiltEma = 0;
    this.onsetCount = 0;
    this.frames = 0;
    this.prevRms = 0;
    this.windowSec = 0;
    /** @type {EmotionState} */
    this.state = {
      valence: 0,
      arousal: 0.35,
      pitchHz: 160,
      speechRate: 0.4,
      spectralTilt: 0,
      pauseToleranceScale: 1,
      bargeInThresholdScale: 1,
    };
  }

  /**
   * Ingest one capture frame (float mono).
   * @param {Float32Array} samples
   * @returns {EmotionState}
   */
  observe(samples) {
    this.frames += 1;
    this.windowSec += samples.length / this.sampleRate;
    const level = rms(samples);
    this.energyEma = this.energyEma * 0.92 + level * 0.08;

    if (level > this.prevRms * 1.35 && level > 0.01) {
      this.onsetCount += 1;
    }
    this.prevRms = level;

    const pitch = estimateF0(samples, this.sampleRate);
    if (pitch > 60 && pitch < 450) {
      this.pitchEma = this.pitchEma * 0.85 + pitch * 0.15;
    }

    const tilt = spectralTiltProxy(samples);
    this.tiltEma = this.tiltEma * 0.9 + tilt * 0.1;

    // Refresh derived state every ~200 ms of audio.
    if (this.windowSec >= 0.2) {
      this.recompute();
      this.windowSec = 0;
      this.onsetCount = 0;
    }
    return this.state;
  }

  recompute() {
    const pitchNorm = clamp01((this.pitchEma - 100) / 180);
    const energyNorm = clamp01((this.energyEma - 0.005) / 0.08);
    const rateNorm = clamp01(this.onsetCount / 8);
    // Brighter spectrum (higher tilt) often correlates with positive valence.
    const tiltNorm = clamp01((this.tiltEma + 1) / 2);

    const arousal = clamp01(energyNorm * 0.45 + pitchNorm * 0.25 + rateNorm * 0.3);
    const valence = clamp01(tiltNorm * 0.55 + (1 - Math.abs(pitchNorm - 0.45)) * 0.45) * 2 - 1;

    // High arousal → shorter pauses, easier barge-in.
    // Low valence + high arousal (stress) → slightly more patient endpointing.
    const pauseToleranceScale = clamp01(1.15 - arousal * 0.45 + (valence < -0.3 ? 0.1 : 0));
    const bargeInThresholdScale = clamp01(1.05 - arousal * 0.35);

    this.state = {
      valence,
      arousal,
      pitchHz: this.pitchEma,
      speechRate: rateNorm,
      spectralTilt: this.tiltEma,
      pauseToleranceScale: Math.max(0.55, Math.min(1.35, pauseToleranceScale)),
      bargeInThresholdScale: Math.max(0.6, Math.min(1.25, bargeInThresholdScale)),
    };
  }

  reset() {
    this.pitchEma = 160;
    this.energyEma = 0.02;
    this.tiltEma = 0;
    this.onsetCount = 0;
    this.frames = 0;
    this.prevRms = 0;
    this.windowSec = 0;
    this.recompute();
  }
}

/**
 * Simple autocorrelation F0 estimate.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {number} Hz or 0
 */
export function estimateF0(samples, sampleRate) {
  const minP = Math.max(2, Math.floor(sampleRate / 400));
  const maxP = Math.min(samples.length >> 1, Math.floor(sampleRate / 70));
  if (maxP <= minP) return 0;
  let best = 0;
  let bestCorr = 0;
  for (let p = minP; p <= maxP; p += 1) {
    let corr = 0;
    let n = 0;
    for (let i = 0; i < samples.length - p; i += 3) {
      corr += samples[i] * samples[i + p];
      n += 1;
    }
    if (n) corr /= n;
    if (corr > bestCorr) {
      bestCorr = corr;
      best = p;
    }
  }
  if (bestCorr < 0.01 || !best) return 0;
  return sampleRate / best;
}

/**
 * Spectral tilt proxy: high-band vs low-band energy difference in [−1, 1].
 * @param {Float32Array} samples
 * @returns {number}
 */
export function spectralTiltProxy(samples) {
  let low = 0;
  let high = 0;
  // Cheap: alternate sample products as crude high-pass residual.
  for (let i = 1; i < samples.length; i += 1) {
    const diff = samples[i] - samples[i - 1];
    high += diff * diff;
    low += samples[i] * samples[i];
  }
  low = Math.sqrt(low / samples.length) + 1e-9;
  high = Math.sqrt(high / samples.length) + 1e-9;
  const ratio = Math.log(high / low);
  return Math.max(-1, Math.min(1, ratio));
}

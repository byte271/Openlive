/**
 * OpenLive 26.7.15 — audio utilities: polyphase FIR resampling, PCM conversion,
 * RMS, echo reference correlation, and NLMS adaptive echo cancellation.
 */

/**
 * Clamp a number to [0, 1]. NaN becomes 0; +Infinity becomes 1;
 * -Infinity becomes 0. All other values are clamped with Math.max/Math.min.
 *
 * @param {number} value
 * @returns {number}
 */
export function clamp01(value) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Normalized sinc. */
function sinc(x) {
  if (Math.abs(x) < 1e-9) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/** Blackman window for FIR design. */
function blackman(n, N) {
  if (N <= 1) return 1;
  const a0 = 0.42;
  const a1 = 0.5;
  const a2 = 0.08;
  const t = (2 * Math.PI * n) / (N - 1);
  return a0 - a1 * Math.cos(t) + a2 * Math.cos(2 * t);
}

/**
 * Design a windowed-sinc lowpass kernel used by the polyphase resampler.
 *
 * @param {number} taps odd number of taps (or rounded up to odd)
 * @param {number} cutoff normalized cutoff in (0, 1], relative to input Nyquist
 * @returns {Float32Array}
 */
export function designLowpassKernel(taps = 49, cutoff = 0.95) {
  const n = Math.max(3, taps | 0);
  const length = n % 2 === 0 ? n + 1 : n;
  const half = (length - 1) / 2;
  const fc = Math.max(0.01, Math.min(1, cutoff));
  const kernel = new Float32Array(length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const x = i - half;
    const w = sinc(x * fc) * fc * blackman(i, length);
    kernel[i] = w;
    sum += w;
  }
  if (sum > 1e-12) {
    for (let i = 0; i < length; i += 1) kernel[i] /= sum;
  }
  return kernel;
}

/**
 * High-quality windowed-sinc (polyphase-style) resampler.
 * Replaces linear interpolation for capture downsample and playback upsample.
 * Anti-aliases when downsampling; lowpass-filters when upsampling.
 *
 * @param {Float32Array} input
 * @param {number} inputRate
 * @param {number} outputRate
 * @param {number} [taps=48] half-width is taps/2 samples on each side of center
 * @returns {Float32Array}
 */
export function resample(input, inputRate, outputRate, taps = 48) {
  if (inputRate === outputRate) return input;
  if (!input.length) return new Float32Array(0);

  const outputLength = Math.max(
    1,
    Math.round((input.length * outputRate) / inputRate),
  );
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  // Anti-alias when downsampling; mild lowpass when upsampling.
  const cutoff = 0.95 * Math.min(1, outputRate / inputRate);
  const halfTaps = Math.max(8, Math.floor(taps / 2));

  for (let i = 0; i < outputLength; i += 1) {
    const center = i * ratio;
    const left = Math.floor(center) - halfTaps;
    const right = Math.ceil(center) + halfTaps;
    const windowLen = right - left + 1;
    let acc = 0;
    let wsum = 0;
    for (let j = left; j <= right; j += 1) {
      if (j < 0 || j >= input.length) continue;
      const x = center - j;
      const w = sinc(x * cutoff) * cutoff * blackman(j - left, windowLen);
      acc += input[j] * w;
      wsum += w;
    }
    output[i] = Math.abs(wsum) > 1e-12 ? acc / wsum : 0;
  }
  return output;
}

/**
 * Fast linear resampler retained for hot paths that need lower CPU
 * (e.g. visualization meters). Prefer {@link resample} for wire audio.
 *
 * @param {Float32Array} input
 * @param {number} inputRate
 * @param {number} outputRate
 * @returns {Float32Array}
 */
export function resampleLinear(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const outputLength = Math.max(
    1,
    Math.round((input.length * outputRate) / inputRate),
  );
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

export function floatToPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = value < 0 ? value * 32768 : value * 32767;
  }
  return pcm;
}

export function pcm16ToFloat(pcm) {
  const decoded = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    decoded[index] = pcm[index] / 32768;
  }
  return decoded;
}

export function rms(samples) {
  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    energy += samples[index] * samples[index];
  }
  return Math.sqrt(energy / Math.max(1, samples.length));
}

/**
 * Sample-aligned far-end echo probability via cross-correlation.
 * Used for barge-in gating; does not subtract echo (see {@link NlmsAec}).
 */
export class EchoReferenceCorrelator {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.capacity = Math.round(sampleRate * 0.5);
    this.samples = new Float32Array(this.capacity);
    this.latestFrame = 0;
    this.hasReference = false;
  }

  write(samples, endFrame) {
    const startFrame = endFrame - samples.length;
    for (let index = 0; index < samples.length; index += 1) {
      this.samples[this.index(startFrame + index)] = samples[index];
    }
    this.latestFrame = Math.max(this.latestFrame, endFrame);
    this.hasReference = true;
  }

  /**
   * Read a block of far-end samples ending at `inputEndFrame`, aligned
   * with a candidate lag of 0 (same timeline as capture endFrame).
   *
   * @param {number} length
   * @param {number} inputEndFrame
   * @param {number} [lagSamples=0]
   * @returns {Float32Array|null}
   */
  readAligned(length, inputEndFrame, lagSamples = 0) {
    if (!this.hasReference) return null;
    const referenceEnd = inputEndFrame - lagSamples;
    const referenceStart = referenceEnd - length;
    if (
      referenceEnd > this.latestFrame ||
      referenceStart < this.latestFrame - this.capacity
    ) {
      return null;
    }
    const out = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      out[index] = this.samples[this.index(referenceStart + index)];
    }
    return out;
  }

  estimate(input, inputEndFrame) {
    if (!this.hasReference || rms(input) < 0.002) return 0;
    const step = Math.max(1, Math.round(this.sampleRate * 0.005));
    const maximumLag = Math.round(this.sampleRate * 0.16);
    let best = 0;
    for (let lag = 0; lag <= maximumLag; lag += step) {
      const referenceEnd = inputEndFrame - lag;
      const referenceStart = referenceEnd - input.length;
      if (
        referenceEnd > this.latestFrame ||
        referenceStart < this.latestFrame - this.capacity
      ) {
        continue;
      }
      let dot = 0;
      let inputEnergy = 0;
      let referenceEnergy = 0;
      for (let index = 0; index < input.length; index += 1) {
        const reference = this.samples[this.index(referenceStart + index)];
        const value = input[index];
        dot += value * reference;
        inputEnergy += value * value;
        referenceEnergy += reference * reference;
      }
      if (referenceEnergy > 1e-6) {
        best = Math.max(
          best,
          Math.abs(dot) / Math.sqrt(inputEnergy * referenceEnergy),
        );
      }
    }
    return Math.max(0, Math.min(1, (best - 0.18) / 0.67));
  }

  index(frame) {
    return ((frame % this.capacity) + this.capacity) % this.capacity;
  }
}

/**
 * Normalized Least Mean Squares adaptive filter for acoustic echo
 * cancellation. Subtracts an estimated far-end echo from the near-end
 * microphone signal.
 *
 * Typical use: feed playback reference as `far` and mic as `near`.
 */
export class NlmsAec {
  /**
   * @param {Object} [options]
   * @param {number} [options.filterLength=256] adaptive filter taps
   * @param {number} [options.mu=0.4] step size (0–1)
   * @param {number} [options.eps=1e-6] power floor for normalization
   * @param {number} [options.leakage=0.9995] weight decay (prevents runaway)
   */
  constructor({
    filterLength = 256,
    mu = 0.4,
    eps = 1e-6,
    leakage = 0.9995,
  } = {}) {
    this.filterLength = Math.max(8, filterLength | 0);
    this.mu = mu;
    this.eps = eps;
    this.leakage = leakage;
    this.weights = new Float32Array(this.filterLength);
    this.delayLine = new Float32Array(this.filterLength);
    this.writeIndex = 0;
  }

  reset() {
    this.weights.fill(0);
    this.delayLine.fill(0);
    this.writeIndex = 0;
  }

  /**
   * Process one sample. Returns residual (near − ŷ).
   * @param {number} near mic sample
   * @param {number} far playback / far-end sample
   * @returns {number}
   */
  processSample(near, far) {
    this.delayLine[this.writeIndex] = far;

    let yHat = 0;
    let power = this.eps;
    let idx = this.writeIndex;
    for (let i = 0; i < this.filterLength; i += 1) {
      const x = this.delayLine[idx];
      yHat += this.weights[i] * x;
      power += x * x;
      idx -= 1;
      if (idx < 0) idx = this.filterLength - 1;
    }

    const error = near - yHat;
    const step = (this.mu * error) / power;
    idx = this.writeIndex;
    for (let i = 0; i < this.filterLength; i += 1) {
      const x = this.delayLine[idx];
      this.weights[i] = this.weights[i] * this.leakage + step * x;
      idx -= 1;
      if (idx < 0) idx = this.filterLength - 1;
    }

    this.writeIndex += 1;
    if (this.writeIndex >= this.filterLength) this.writeIndex = 0;
    return error;
  }

  /**
   * Process a block. When `far` is missing or shorter, missing samples
   * are treated as silence (filter still adapts on zeros).
   *
   * @param {Float32Array} near
   * @param {Float32Array|null} [far]
   * @returns {Float32Array}
   */
  process(near, far = null) {
    const out = new Float32Array(near.length);
    for (let i = 0; i < near.length; i += 1) {
      const farSample = far && i < far.length ? far[i] : 0;
      out[i] = this.processSample(near[i], farSample);
    }
    return out;
  }

  /** L2 norm of adaptive weights — useful for tests / diagnostics. */
  weightEnergy() {
    let e = 0;
    for (let i = 0; i < this.weights.length; i += 1) {
      e += this.weights[i] * this.weights[i];
    }
    return e;
  }
}

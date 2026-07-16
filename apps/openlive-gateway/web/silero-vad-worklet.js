/**
 * OpenLive 26.7.15 — Silero-style voice activity detector (AudioWorklet).
 *
 * Emits speech probability for ~32 ms frames (512 samples @ 16 kHz,
 * scaled to the AudioContext sample rate). Feature path is a compact
 * spectral + energy model that approximates Silero-class decisions
 * without a mandatory ONNX runtime.
 *
 * Credit: product category and typical frame timing inspired by
 * Silero VAD (MIT) — see THIRD_PARTY_NOTICES.md. This file is original
 * JS; official ONNX weights are not redistributed here.
 *
 * Optional ONNX path: post `{ type: "loadOnnx", modelUrl }` after the
 * main thread has loaded onnxruntime-web and transferred a session
 * handle via a future extension. Until then, the pure-JS scorer runs.
 *
 * Registration name: "openlive-silero-vad"
 *
 * Outbound port messages:
 *   { type: "vad", speechProbability: number, endFrame: number, rms: number }
 */

class OpenliveSileroVadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Silero v4/v5 often uses 512 samples @ 16 kHz (~32 ms).
    this.frameSize = Math.max(128, Math.round(sampleRate * 0.032));
    this.pending = [];
    this.pendingLength = 0;
    this.nextFrame = null;

    this.noiseFloor = 1e-4;
    this.speechEma = 0;
    this.prevSpectrum = null;
    this.enabled = true;

    this.port.onmessage = ({ data }) => {
      if (data?.type === "setEnabled") this.enabled = !!data.enabled;
      if (data?.type === "reset") {
        this.noiseFloor = 1e-4;
        this.speechEma = 0;
        this.prevSpectrum = null;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    // Transparent pass-through — VAD is analysis-only.
    output.set(input);

    if (!this.enabled) return true;

    this.nextFrame ??= currentFrame;
    this.pending.push(new Float32Array(input));
    this.pendingLength += input.length;

    while (this.pendingLength >= this.frameSize) {
      const frame = this.pullFrame(this.frameSize);
      this.nextFrame += this.frameSize;
      const speechProbability = this.scoreFrame(frame);
      const level = rms(frame);
      this.port.postMessage({
        type: "vad",
        speechProbability,
        endFrame: this.nextFrame,
        rms: level,
      });
    }
    return true;
  }

  pullFrame(size) {
    const frame = new Float32Array(size);
    let written = 0;
    while (written < size) {
      const head = this.pending[0];
      const needed = size - written;
      const copied = Math.min(needed, head.length);
      frame.set(head.subarray(0, copied), written);
      written += copied;
      if (copied === head.length) {
        this.pending.shift();
      } else {
        this.pending[0] = head.subarray(copied);
      }
      this.pendingLength -= copied;
    }
    return frame;
  }

  /**
   * Multi-feature speech score in [0, 1]:
   *  - SNR vs adaptive noise floor
   *  - zero-crossing rate (speech-like mid band)
   *  - spectral flux (onset / formant motion)
   *  - spectral flatness inverse (tonal voiced speech)
   */
  scoreFrame(frame) {
    const level = rms(frame) + 1e-12;
    // Noise floor: only track when clearly quiet.
    if (level < this.noiseFloor * 2.5) {
      this.noiseFloor = this.noiseFloor * 0.97 + level * 0.03;
    } else if (level < this.noiseFloor) {
      this.noiseFloor = level;
    }
    this.noiseFloor = Math.max(1e-5, this.noiseFloor);

    const snr = level / this.noiseFloor;
    const snrScore = clamp01((snr - 1.6) / 6);

    const zcr = zeroCrossingRate(frame);
    // Speech often 0.02–0.25 at 16–48 kHz frame rates.
    const zcrScore = clamp01(1 - Math.abs(zcr - 0.12) / 0.2);

    const spectrum = bandEnergies(frame, 6);
    let flux = 0;
    if (this.prevSpectrum) {
      for (let i = 0; i < spectrum.length; i += 1) {
        const d = spectrum[i] - this.prevSpectrum[i];
        flux += d * d;
      }
      flux = Math.sqrt(flux / spectrum.length);
    }
    this.prevSpectrum = spectrum;
    const fluxScore = clamp01(flux * 8);

    const flatness = spectralFlatness(spectrum);
    // Lower flatness → more tonal → more speech-like.
    const tonalScore = clamp01(1 - flatness * 1.4);

    const raw =
      snrScore * 0.45 +
      zcrScore * 0.15 +
      fluxScore * 0.2 +
      tonalScore * 0.2;

    // Temporal smoothing (Silero-like post-process).
    this.speechEma = this.speechEma * 0.65 + raw * 0.35;
    return clamp01(this.speechEma);
  }
}

function rms(samples) {
  let e = 0;
  for (let i = 0; i < samples.length; i += 1) e += samples[i] * samples[i];
  return Math.sqrt(e / Math.max(1, samples.length));
}

function clamp01(v) {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function zeroCrossingRate(frame) {
  let crossings = 0;
  for (let i = 1; i < frame.length; i += 1) {
    if ((frame[i] >= 0 && frame[i - 1] < 0) || (frame[i] < 0 && frame[i - 1] >= 0)) {
      crossings += 1;
    }
  }
  return crossings / Math.max(1, frame.length - 1);
}

/** Coarse magnitude spectrum via Goertzel-like band energy (no full FFT). */
function bandEnergies(frame, bands) {
  const out = new Float32Array(bands);
  const n = frame.length;
  for (let b = 0; b < bands; b += 1) {
    // Center frequencies from ~200 Hz to ~4 kHz equivalent.
    const freqNorm = (0.02 + (0.35 * b) / Math.max(1, bands - 1));
    const w = 2 * Math.PI * freqNorm;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      re += frame[i] * Math.cos(w * i);
      im += frame[i] * Math.sin(w * i);
    }
    out[b] = Math.sqrt(re * re + im * im) / n;
  }
  return out;
}

function spectralFlatness(spectrum) {
  let logSum = 0;
  let arith = 0;
  let count = 0;
  for (let i = 0; i < spectrum.length; i += 1) {
    const v = Math.max(1e-12, spectrum[i]);
    logSum += Math.log(v);
    arith += v;
    count += 1;
  }
  if (!count) return 1;
  const geo = Math.exp(logSum / count);
  const mean = arith / count;
  return mean > 0 ? geo / mean : 1;
}

registerProcessor("openlive-silero-vad", OpenliveSileroVadProcessor);

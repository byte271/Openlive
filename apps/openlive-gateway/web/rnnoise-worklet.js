/**
 * OpenLive 26.7.15 — RNNoise-style spectral noise suppressor (AudioWorklet).
 *
 * Processes classic RNNoise frame size: 480 samples (10 ms at 48 kHz).
 * At other sample rates the frame size is scaled to ~10 ms.
 *
 * Pipeline: 1-frame delay line → Hann-windowed FFT → Wiener gain from
 * adaptive noise PSD → IFFT → delayed output. A future build can swap
 * `denoiseFrame` for real RNNoise WASM while keeping this registration.
 *
 * Credit: frame geometry and product category inspired by Xiph RNNoise
 * (BSD-3-Clause) — see THIRD_PARTY_NOTICES.md. This file is original code.
 *
 * Registration name: "openlive-rnnoise"
 */

class OpenliveRnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 10 ms frames; RNNoise canonical is 480 @ 48 kHz.
    this.frameSize = sampleRate === 48000 ? 480 : Math.max(80, Math.round(sampleRate * 0.01));

    this.inputRing = new Float32Array(this.frameSize);
    this.outputRing = new Float32Array(this.frameSize);
    this.ringPos = 0;
    this.filled = 0;

    this.fftSize = nextPow2(this.frameSize);
    this.halfBins = this.fftSize / 2;
    this.noisePsd = new Float32Array(this.halfBins + 1);
    this.noisePsd.fill(1e-8);
    this.noiseFrames = 0;
    this.warmupFrames = 25;
    this.gainFloor = 0.1;
    this.enabled = true;

    // Scratch buffers reused every frame.
    this.re = new Float32Array(this.fftSize);
    this.im = new Float32Array(this.fftSize);
    this.frameScratch = new Float32Array(this.frameSize);

    this.port.onmessage = ({ data }) => {
      if (data?.type === "setEnabled") this.enabled = !!data.enabled;
      if (data?.type === "reset") {
        this.noisePsd.fill(1e-8);
        this.noiseFrames = 0;
        this.outputRing.fill(0);
        this.inputRing.fill(0);
        this.ringPos = 0;
        this.filled = 0;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    if (!this.enabled) {
      output.set(input);
      return true;
    }

    for (let i = 0; i < input.length; i += 1) {
      // Emit previously denoised sample at this ring slot.
      output[i] = this.filled >= this.frameSize ? this.outputRing[this.ringPos] : input[i];

      this.inputRing[this.ringPos] = input[i];
      this.ringPos += 1;

      if (this.ringPos >= this.frameSize) {
        this.ringPos = 0;
        this.filled = this.frameSize;
        // Denoise the completed input frame into outputRing.
        this.frameScratch.set(this.inputRing);
        const cleaned = this.denoiseFrame(this.frameScratch);
        this.outputRing.set(cleaned);
      }
    }
    return true;
  }

  denoiseFrame(frame) {
    const n = this.fftSize;
    const re = this.re;
    const im = this.im;
    re.fill(0);
    im.fill(0);

    for (let i = 0; i < frame.length; i += 1) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, frame.length - 1)));
      re[i] = frame[i] * w;
    }
    fftRadix2(re, im);

    let frameEnergy = 0;
    let noiseEnergy = 0;
    for (let k = 0; k <= this.halfBins; k += 1) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      frameEnergy += mag2;
      noiseEnergy += this.noisePsd[k];
    }
    frameEnergy /= this.halfBins + 1;
    noiseEnergy /= this.halfBins + 1;

    const isNoiseLike =
      this.noiseFrames < this.warmupFrames || frameEnergy < noiseEnergy * 1.8;

    for (let k = 0; k <= this.halfBins; k += 1) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      if (isNoiseLike) {
        this.noisePsd[k] = 0.95 * this.noisePsd[k] + 0.05 * mag2;
      } else if (mag2 < this.noisePsd[k]) {
        this.noisePsd[k] = 0.8 * this.noisePsd[k] + 0.2 * mag2;
      }

      const snr = mag2 / (this.noisePsd[k] + 1e-12);
      const gain = Math.max(this.gainFloor, 1 - 1 / (snr + 1e-6));
      re[k] *= gain;
      im[k] *= gain;
      if (k > 0 && k < this.halfBins) {
        re[n - k] *= gain;
        im[n - k] *= gain;
      }
    }
    if (isNoiseLike) this.noiseFrames += 1;

    ifftRadix2(re, im);

    const out = new Float32Array(frame.length);
    const scale = 2 / n;
    for (let i = 0; i < frame.length; i += 1) {
      out[i] = re[i] * scale;
    }
    return out;
  }
}

function nextPow2(v) {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
}

function fftRadix2(re, im) {
  const n = re.length;
  let j = 0;
  for (let i = 0; i < n - 1; i += 1) {
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const tableStep = (Math.PI * 2) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k += 1) {
        const angle = tableStep * k;
        const wr = Math.cos(angle);
        const wi = -Math.sin(angle);
        const even = i + k;
        const odd = even + half;
        const tr = wr * re[odd] - wi * im[odd];
        const ti = wr * im[odd] + wi * re[odd];
        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] += tr;
        im[even] += ti;
      }
    }
  }
}

function ifftRadix2(re, im) {
  for (let i = 0; i < im.length; i += 1) im[i] = -im[i];
  fftRadix2(re, im);
  for (let i = 0; i < im.length; i += 1) im[i] = -im[i];
}

registerProcessor("openlive-rnnoise", OpenliveRnnoiseProcessor);

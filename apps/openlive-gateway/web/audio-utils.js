export function resample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const outputLength = Math.max(
    1,
    Math.round(input.length * outputRate / inputRate),
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
        const reference =
          this.samples[this.index(referenceStart + index)];
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

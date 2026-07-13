export class AdaptiveJitterController {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.targetSamples = Math.round(sampleRate * 0.04);
    this.minimumSamples = Math.round(sampleRate * 0.03);
    this.maximumSamples = Math.round(sampleRate * 0.12);
    this.stableSamples = 0;
  }

  shouldStart(queuedSamples, generationComplete) {
    return queuedSamples >= this.targetSamples || generationComplete;
  }

  recordUnderflow() {
    this.targetSamples = Math.min(
      this.maximumSamples,
      this.targetSamples + Math.round(this.sampleRate * 0.01),
    );
    this.stableSamples = 0;
  }

  recordStablePlayback(sampleCount) {
    this.stableSamples += sampleCount;
    if (this.stableSamples < this.sampleRate * 10) return false;
    this.targetSamples = Math.max(
      this.minimumSamples,
      this.targetSamples - Math.round(this.sampleRate * 0.005),
    );
    this.stableSamples = 0;
    return true;
  }

  targetMs() {
    return this.targetSamples / this.sampleRate * 1000;
  }
}

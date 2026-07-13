import {
  EchoReferenceCorrelator,
  floatToPcm16,
  pcm16ToFloat,
  resample,
  rms,
} from "./audio-utils.js";

export class AudioSession {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.inputSampleRate = 16000;
    this.playbackFrameCounts = new Map();
    this.canceledGenerations = new Set();
    this.localNoiseFloor = 0.006;
    this.playbackOutputLevel = 0;
    this.locallyDucked = false;
    this.hardYielded = false;
    this.outputGainConnected = false;
  }

  setInputSampleRate(sampleRate) {
    this.inputSampleRate = sampleRate;
  }

  isMicrophoneActive() {
    return Boolean(this.microphoneStream);
  }

  async startMicrophone() {
    await this.ensureContext();
    await this.audioContext.audioWorklet.addModule(
      "/audio-capture-worklet.js",
    );
    this.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    const source = this.audioContext.createMediaStreamSource(
      this.microphoneStream,
    );
    this.captureNode = new AudioWorkletNode(
      this.audioContext,
      "openlive-capture",
    );
    this.captureNode.port.onmessage = ({ data }) =>
      this.handleCaptureFrame(data);
    source.connect(this.captureNode);
    this.captureNode.connect(this.audioContext.destination);
    return this.audioContext.sampleRate;
  }

  stopMicrophone() {
    this.microphoneStream?.getTracks().forEach((track) => track.stop());
    this.captureNode?.disconnect();
    this.microphoneStream = undefined;
    this.captureNode = undefined;
  }

  async enqueue(packet) {
    if (this.canceledGenerations.has(packet.generationId)) return;
    await this.ensurePlayback();
    const decoded = pcm16ToFloat(packet.pcm);
    const samples = resample(
      decoded,
      packet.sampleRate,
      this.audioContext.sampleRate,
    );
    this.playbackFrameCounts.set(
      packet.generationId,
      (this.playbackFrameCounts.get(packet.generationId) ?? 0) + 1,
    );
    this.playbackNode.port.postMessage(
      {
        type: "enqueue",
        generationId: packet.generationId,
        mediaEndUs:
          packet.mediaTimeUs +
          Math.round(packet.pcm.length / packet.sampleRate * 1_000_000),
        samples: samples.buffer,
      },
      [samples.buffer],
    );
  }

  complete(generationId) {
    this.playbackNode?.port.postMessage({
      type: "complete",
      generationId,
    });
  }

  providerGenerating() {
    this.hardYielded = false;
    this.locallyDucked = false;
    this.setOutputGain(1, 0.02);
  }

  cancel(generationId, fadeMs = 35) {
    if (generationId) {
      this.canceledGenerations.add(generationId);
      while (this.canceledGenerations.size > 256) {
        this.canceledGenerations.delete(
          this.canceledGenerations.values().next().value,
        );
      }
      this.playbackFrameCounts.delete(generationId);
      this.playbackNode?.port.postMessage({
        type: "cancel",
        generationId,
        fadeMs,
      });
    }
    this.setOutputGain(1, 0.05);
  }

  applyDecision(action, generationId) {
    if (action === "soft_duck") this.setOutputGain(0.18, 0.04);
    if (action === "resume") {
      this.locallyDucked = false;
      this.setOutputGain(1, 0.08);
    }
    if (action === "hard_yield") {
      this.hardYielded = true;
      this.cancel(generationId);
    }
  }

  async ensureContext() {
    this.audioContext ??= new AudioContext({ latencyHint: "interactive" });
    await this.audioContext.resume();
    this.echoCorrelator ??= new EchoReferenceCorrelator(
      this.audioContext.sampleRate,
    );
  }

  ensureOutputGain() {
    this.outputGain ??= this.audioContext.createGain();
    if (!this.outputGainConnected) {
      this.outputGain.connect(this.audioContext.destination);
      this.outputGainConnected = true;
    }
  }

  async ensurePlayback() {
    await this.ensureContext();
    this.ensureOutputGain();
    if (!this.playbackNode) {
      this.playbackModulePromise ??= this.audioContext.audioWorklet.addModule(
        "/audio-playback-worklet.js",
      );
      await this.playbackModulePromise;
      this.playbackNode = new AudioWorkletNode(
        this.audioContext,
        "openlive-playback",
        { outputChannelCount: [1] },
      );
      this.playbackNode.port.onmessage = ({ data }) =>
        this.handlePlaybackMessage(data);
      this.playbackNode.connect(this.outputGain);
    }
  }

  handleCaptureFrame({ samples: buffer, endFrame }) {
    const samples = new Float32Array(buffer);
    const speechProbability = this.estimateSpeech(samples);
    const echoProbability = this.hasActiveOutput()
      ? this.echoCorrelator.estimate(samples, endFrame)
      : 0;
    const targetSpeechProbability =
      speechProbability * (1 - echoProbability);
    this.applyLocalInterruption(targetSpeechProbability);
    const resampled = resample(
      samples,
      this.audioContext.sampleRate,
      this.inputSampleRate,
    );
    this.callbacks.onInputFrame({
      pcm: floatToPcm16(resampled),
      speechProbability,
      outputLevel: this.playbackOutputLevel,
      echoProbability,
    });
  }

  handlePlaybackMessage(message) {
    if (message.type === "played") {
      const remaining = Math.max(
        0,
        (this.playbackFrameCounts.get(message.generationId) ?? 1) - 1,
      );
      if (remaining === 0) {
        this.playbackFrameCounts.delete(message.generationId);
      } else {
        this.playbackFrameCounts.set(message.generationId, remaining);
      }
      if (!this.canceledGenerations.has(message.generationId)) {
        this.callbacks.onPlayed(message);
      }
      return;
    }
    if (message.type === "reference") {
      this.echoCorrelator.write(
        new Float32Array(message.samples),
        message.endFrame,
      );
      return;
    }
    if (message.type === "canceled" || message.type === "idle") {
      this.playbackFrameCounts.delete(message.generationId);
      return;
    }
    if (message.type === "underflow") {
      this.callbacks.onTimeline(
        "jitter",
        `Playback underflow; target raised to ${message.targetMs.toFixed(0)} ms`,
      );
      return;
    }
    if (message.type === "buffer") {
      this.callbacks.onBuffer(message.queuedMs, message.targetMs);
      return;
    }
    if (message.type === "output_level") {
      this.playbackOutputLevel = message.rms;
    }
  }

  estimateSpeech(samples) {
    const level = rms(samples);
    if (!this.hasActiveOutput() && level < this.localNoiseFloor * 2.2) {
      this.localNoiseFloor = this.localNoiseFloor * 0.98 + level * 0.02;
    }
    const ratio = level / Math.max(0.001, this.localNoiseFloor);
    return Math.max(0, Math.min(1, (ratio - 1.8) / 5.5));
  }

  applyLocalInterruption(probability) {
    if (!this.hasActiveOutput()) return;
    if (probability >= 0.62 && !this.locallyDucked) {
      clearTimeout(this.localResumeTimer);
      this.locallyDucked = true;
      this.setOutputGain(0.18, 0.02);
      this.callbacks.onTimeline(
        "local_duck",
        "Playback attenuated before server confirmation",
      );
      return;
    }
    if (probability <= 0.28 && this.locallyDucked && !this.hardYielded) {
      clearTimeout(this.localResumeTimer);
      this.localResumeTimer = setTimeout(() => {
        if (!this.hardYielded) {
          this.locallyDucked = false;
          this.setOutputGain(1, 0.06);
        }
      }, 120);
    }
  }

  hasActiveOutput() {
    return [...this.playbackFrameCounts.values()].some((count) => count > 0);
  }

  setOutputGain(value, seconds) {
    if (!this.audioContext) return;
    this.ensureOutputGain();
    this.outputGain.gain.cancelScheduledValues(this.audioContext.currentTime);
    this.outputGain.gain.linearRampToValueAtTime(
      value,
      this.audioContext.currentTime + seconds,
    );
    this.callbacks.onGain(value);
  }
}

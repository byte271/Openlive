import {
  EchoReferenceCorrelator,
  NlmsAec,
  floatToPcm16,
  pcm16ToFloat,
  resample,
  rms,
} from "./audio-utils.js";
import { EmotionDetector } from "./emotion-detector.js";

/**
 * Openlive 26.7.15 — AudioSession
 *
 * Owns the AudioContext, the microphone capture worklet, the playback
 * worklet, and the output gain node. Bridges binary PCM frames between
 * the WebSocket and the worklets. Local-first interruption (the reversible
 * duck before any server round trip) lives here.
 *
 * Phase 1 client-side intelligence chain:
 *   mic → RNNoise worklet → Silero VAD worklet → capture worklet
 *   → NLMS AEC (main thread) → polyphase FIR resample → PCM16 wire
 *
 * The class is intentionally framework-agnostic: app.js wires it to the
 * WebSocket via the callbacks passed to the constructor.
 */
export class AudioSession {
  /**
   * @param {Object} callbacks
   * @param {(frame: {pcm: Int16Array, speechProbability: number, outputLevel: number, echoProbability: number}) => void} [callbacks.onInputFrame]
   * @param {(speechProbability: number, echoProbability: number) => void} [callbacks.onInputActivity]
   * @param {(message: {generationId: string, mediaEndUs: number}) => void} [callbacks.onPlayed]
   * @param {(kind: string, detail: string) => void} [callbacks.onTimeline]
   * @param {(queuedMs: number, targetMs: number) => void} [callbacks.onBuffer]
   * @param {(value: number) => void} [callbacks.onGain]
   * @param {(level: number) => void} [callbacks.onOutputLevel]
   * @param {() => void} [callbacks.onInterruption]
   * @param {() => void} [callbacks.onPlaybackIdle]
   */
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
    /** Latest Silero-style speech probability from the VAD worklet. */
    this.sileroSpeechProbability = null;
    /** When true, RNNoise + Silero worklets are inserted in the capture graph. */
    this.clientIntelligenceEnabled = true;
    /** @type {import("./emotion-detector.js").EmotionState|null} */
    this.emotion = null;
  }

  /**
   * @param {number} sampleRate
   */
  setInputSampleRate(sampleRate) {
    this.inputSampleRate = sampleRate;
  }

  /**
   * Start the microphone capture worklet. Resolves with the AudioContext
   * sample rate so the gateway can be told what to expect.
   *
   * @returns {Promise<number>}
   */
  async startMicrophone() {
    await this.ensureContext();
    this.captureModulePromise ??= this.audioContext.audioWorklet.addModule(
      "/audio-capture-worklet.js",
    );
    await this.captureModulePromise;

    if (this.clientIntelligenceEnabled) {
      this.rnnoiseModulePromise ??= this.audioContext.audioWorklet.addModule(
        "/rnnoise-worklet.js",
      );
      this.sileroModulePromise ??= this.audioContext.audioWorklet.addModule(
        "/silero-vad-worklet.js",
      );
      await Promise.all([this.rnnoiseModulePromise, this.sileroModulePromise]);
    }

    this.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Prefer software AEC/NS in our graph; keep browser AEC as a prior.
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    const source = this.audioContext.createMediaStreamSource(
      this.microphoneStream,
    );
    this.captureSource = source;
    this.captureNode = new AudioWorkletNode(
      this.audioContext,
      "openlive-capture",
    );
    this.captureNode.port.onmessage = ({ data }) =>
      this.handleCaptureFrame(data);

    let tail = source;
    if (this.clientIntelligenceEnabled) {
      this.rnnoiseNode = new AudioWorkletNode(
        this.audioContext,
        "openlive-rnnoise",
      );
      this.sileroNode = new AudioWorkletNode(
        this.audioContext,
        "openlive-silero-vad",
      );
      this.sileroNode.port.onmessage = ({ data }) => {
        if (data?.type === "vad") {
          this.sileroSpeechProbability = data.speechProbability;
        }
      };
      source.connect(this.rnnoiseNode);
      this.rnnoiseNode.connect(this.sileroNode);
      tail = this.sileroNode;
      this.callbacks.onTimeline?.(
        "audio",
        "Client intelligence chain active (RNNoise → Silero VAD → NLMS)",
      );
    }

    tail.connect(this.captureNode);
    // Keep the graph running without mic-monitor bleed: zero-gain sink.
    this.silentSink ??= this.audioContext.createGain();
    this.silentSink.gain.value = 0;
    this.captureNode.connect(this.silentSink);
    this.silentSink.connect(this.audioContext.destination);
    return this.audioContext.sampleRate;
  }

  /**
   * Stop microphone capture and disconnect the worklet. The AudioContext
   * itself stays alive so the playback worklet can continue running.
   */
  stopMicrophone() {
    this.microphoneStream?.getTracks().forEach((track) => track.stop());
    this.captureSource?.disconnect();
    this.rnnoiseNode?.disconnect();
    this.sileroNode?.disconnect();
    this.captureNode?.disconnect();
    this.silentSink?.disconnect();
    this.microphoneStream = undefined;
    this.captureSource = undefined;
    this.rnnoiseNode = undefined;
    this.sileroNode = undefined;
    this.captureNode = undefined;
    this.sileroSpeechProbability = null;
    this.nlmsAec?.reset();
    this.emotionDetector?.reset();
    this.emotion = null;
  }

  /**
   * Hard-reset the session: cancel all in-flight generations, restore
   * the output gain, and clear local duck state. Used when the
   * conversation ends or before a reconnect.
   */
  reset() {
    this.cancelAllPlayback(25);
    this.playbackOutputLevel = 0;
    this.locallyDucked = false;
    this.hardYielded = false;
    clearTimeout(this.localResumeTimer);
    this.setOutputGain(1, 0.03);
    this.callbacks.onOutputLevel?.(0);
  }

  /**
   * Cancel every queued playback frame. Centralizes the cancel-message
   * posting that was previously duplicated between reset() and cancel().
   *
   * @param {number} fadeMs
   */
  cancelAllPlayback(fadeMs) {
    for (const generationId of this.playbackFrameCounts.keys()) {
      this.playbackNode?.port.postMessage({
        type: "cancel",
        generationId,
        fadeMs,
      });
    }
    this.playbackFrameCounts.clear();
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
    // ~16 ms filter at 48 kHz covers short acoustic paths; longer rooms
    // still benefit via the delay line memory across frames.
    this.nlmsAec ??= new NlmsAec({
      filterLength: Math.min(
        512,
        Math.max(128, Math.round(this.audioContext.sampleRate * 0.016)),
      ),
      mu: 0.35,
    });
    this.emotionDetector ??= new EmotionDetector(this.audioContext.sampleRate);
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
    let samples = new Float32Array(buffer);

    // NLMS adaptive echo cancellation when far-end playback is active.
    const echoProbability = this.hasActiveOutput()
      ? this.echoCorrelator.estimate(samples, endFrame)
      : 0;
    if (this.hasActiveOutput() && this.nlmsAec) {
      const far = this.echoCorrelator.readAligned(
        samples.length,
        endFrame,
        0,
      );
      if (far) {
        samples = this.nlmsAec.process(samples, far);
      } else {
        // Still adapt toward silence far-end so weights don't freeze wrong.
        samples = this.nlmsAec.process(samples, null);
      }
    }

    this.emotion = this.emotionDetector?.observe(samples) ?? null;
    const energySpeech = this.estimateSpeech(samples);
    // Prefer Silero-style worklet score when available; blend with energy.
    const silero = this.sileroSpeechProbability;
    let speechProbability =
      silero == null
        ? energySpeech
        : clampBlend(silero, energySpeech, 0.7);
    // Mild arousal boost so animated speech is not under-detected.
    if (this.emotion) {
      speechProbability = clampBlend(
        speechProbability,
        Math.min(1, speechProbability + this.emotion.arousal * 0.12),
        0.85,
      );
    }
    const targetSpeechProbability =
      speechProbability * (1 - echoProbability);
    this.callbacks.onInputActivity?.(
      speechProbability,
      echoProbability,
    );
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
      this.playbackOutputLevel = 0;
      this.callbacks.onOutputLevel?.(0);
      if (message.type === "idle") this.callbacks.onPlaybackIdle?.();
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
      this.callbacks.onOutputLevel?.(message.rms);
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
    const bargeScale = this.emotion?.bargeInThresholdScale ?? 1;
    const duckAt = 0.62 * bargeScale;
    const unduckAt = 0.28 * bargeScale;
    const resumeMs = Math.round(120 * (this.emotion?.pauseToleranceScale ?? 1));
    if (probability >= duckAt && !this.locallyDucked) {
      clearTimeout(this.localResumeTimer);
      this.locallyDucked = true;
      this.setOutputGain(0.18, 0.02);
      this.callbacks.onTimeline(
        "local_duck",
        "Playback attenuated before server confirmation",
      );
      this.callbacks.onInterruption?.();
      return;
    }
    if (probability <= unduckAt && this.locallyDucked && !this.hardYielded) {
      clearTimeout(this.localResumeTimer);
      this.localResumeTimer = setTimeout(() => {
        if (!this.hardYielded) {
          this.locallyDucked = false;
          this.setOutputGain(1, 0.06);
        }
      }, resumeMs);
    }
  }

  /** Latest emotion snapshot for diagnostics / telemetry. */
  getEmotion() {
    return this.emotion;
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

  connectWebRtcTrack(track) {
    this.ensureOutputGain();
    const mediaStream = new MediaStream([track]);
    this.webRtcSource = this.audioContext.createMediaStreamSource(mediaStream);
    this.webRtcSource.connect(this.outputGain);

    this.webRtcAnalyser = this.audioContext.createAnalyser();
    this.webRtcAnalyser.fftSize = 256;
    this.webRtcSource.connect(this.webRtcAnalyser);

    this.webRtcLevelInterval = setInterval(() => {
      const dataArray = new Float32Array(this.webRtcAnalyser.frequencyBinCount);
      this.webRtcAnalyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      this.playbackOutputLevel = Math.sqrt(sum / dataArray.length);
      this.callbacks.onOutputLevel?.(this.playbackOutputLevel);
    }, 20);
  }

  disconnectWebRtc() {
    clearInterval(this.webRtcLevelInterval);
    this.webRtcSource?.disconnect();
    this.webRtcAnalyser?.disconnect();
    this.webRtcSource = null;
    this.webRtcAnalyser = null;
  }
}

/** Weighted blend of two probabilities in [0, 1]. */
function clampBlend(primary, secondary, primaryWeight) {
  const w = Math.max(0, Math.min(1, primaryWeight));
  const v = primary * w + secondary * (1 - w);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}


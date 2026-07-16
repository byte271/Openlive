import {
  AdaptiveJitterController,
  concealPacketLoss,
} from "./jitter-controller.js";

/**
 * OpenLive 26.7.15 — playback worklet (adaptive jitter + packet-loss concealment).
 *
 * On underflow while a generation is still streaming, synthesizes a short
 * PLC frame from recent history instead of hard silence — closer to WebRTC
 * Opus PLC behavior on the WebSocket PCM path.
 */
class OpenlivePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.queuedSamples = 0;
    this.jitter = new AdaptiveJitterController(sampleRate);
    this.started = false;
    this.underflowReported = false;
    this.lastGenerationId = null;
    this.completeGenerations = new Set();
    this.fadeGenerationId = null;
    this.fadeRemaining = 0;
    this.fadeTotal = 1;
    this.referenceFrameSize = Math.max(1, Math.round(sampleRate * 0.02));
    this.reference = new Float32Array(this.referenceFrameSize);
    this.referenceOffset = 0;
    this.referenceStartFrame = 0;
    // History for PLC (~40 ms).
    this.history = new Float32Array(Math.round(sampleRate * 0.04));
    this.historyWrite = 0;
    this.historyFilled = 0;
    this.plcRemaining = 0;
    this.plcFrame = null;
    this.plcOffset = 0;
    this.port.onmessage = ({ data }) => this.handleMessage(data);
  }

  handleMessage(message) {
    if (message.type === "enqueue") {
      const samples = new Float32Array(message.samples);
      this.queue.push({
        generationId: message.generationId,
        mediaEndUs: message.mediaEndUs,
        samples,
        offset: 0,
      });
      this.queuedSamples += samples.length;
      this.underflowReported = false;
      this.jitter.recordArrival(currentTime * 1000, 20);
      this.postBufferState();
      return;
    }
    if (message.type === "complete") {
      this.completeGenerations.add(message.generationId);
      const generationQueued = this.queue.some(
        (frame) => frame.generationId === message.generationId,
      );
      if (
        !generationQueued &&
        !this.current &&
        this.lastGenerationId === message.generationId
      ) {
        this.port.postMessage({
          type: "idle",
          generationId: message.generationId,
        });
        this.completeGenerations.delete(message.generationId);
      }
      return;
    }
    if (message.type === "cancel") {
      this.cancelGeneration(message.generationId, message.fadeMs ?? 35);
    }
  }

  cancelGeneration(generationId, fadeMs) {
    const retained = [];
    for (const frame of this.queue) {
      if (frame.generationId === generationId) {
        this.queuedSamples -= frame.samples.length - frame.offset;
      } else {
        retained.push(frame);
      }
    }
    this.queue = retained;
    this.completeGenerations.add(generationId);
    this.plcRemaining = 0;
    this.plcFrame = null;
    if (this.current?.generationId === generationId) {
      this.fadeGenerationId = generationId;
      this.fadeTotal = Math.max(1, Math.round((sampleRate * fadeMs) / 1000));
      this.fadeRemaining = this.fadeTotal;
    } else {
      this.port.postMessage({ type: "canceled", generationId });
      this.completeGenerations.delete(generationId);
    }
    this.postBufferState();
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);

    if (!this.started) {
      const completedQueue = this.queue.some((frame) =>
        this.completeGenerations.has(frame.generationId),
      );
      if (!this.jitter.shouldStart(this.queuedSamples, completedQueue)) {
        return true;
      }
      this.started = true;
    }

    let wroteSamples = false;
    let writtenSamples = 0;
    let sumSquares = 0;
    for (let index = 0; index < output.length; index += 1) {
      let value = this.nextSample();
      if (value === null) {
        this.handleUnderflow();
        break;
      }
      output[index] = value;
      this.pushHistory(value);
      sumSquares += value * value;
      writtenSamples += 1;
      wroteSamples = true;
    }

    if (wroteSamples && this.jitter.recordStablePlayback(writtenSamples)) {
      this.postBufferState();
    }
    if (wroteSamples) {
      this.port.postMessage({
        type: "output_level",
        rms: Math.sqrt(sumSquares / output.length),
      });
    }
    this.captureReference(output);
    return true;
  }

  nextSample() {
    // Drain active PLC tail first.
    if (this.plcFrame && this.plcOffset < this.plcFrame.length) {
      const v = this.plcFrame[this.plcOffset++];
      this.plcRemaining = Math.max(0, this.plcRemaining - 1);
      if (this.plcOffset >= this.plcFrame.length) {
        this.plcFrame = null;
        this.plcOffset = 0;
      }
      return v;
    }

    if (!this.current) {
      this.current = this.queue.shift() ?? null;
      if (!this.current) return null;
      this.lastGenerationId = this.current.generationId;
    }

    let value = this.current.samples[this.current.offset];
    if (this.fadeGenerationId === this.current.generationId) {
      value *= this.fadeRemaining / this.fadeTotal;
      this.fadeRemaining -= 1;
      if (this.fadeRemaining <= 0) {
        this.dropCanceledCurrent();
        return 0;
      }
    }
    this.current.offset += 1;
    this.queuedSamples = Math.max(0, this.queuedSamples - 1);

    if (this.current.offset >= this.current.samples.length) {
      this.port.postMessage({
        type: "played",
        generationId: this.current.generationId,
        mediaEndUs: this.current.mediaEndUs,
      });
      this.current = null;
    }
    return value;
  }

  pushHistory(sample) {
    this.history[this.historyWrite] = sample;
    this.historyWrite = (this.historyWrite + 1) % this.history.length;
    this.historyFilled = Math.min(this.history.length, this.historyFilled + 1);
  }

  historySnapshot() {
    const n = this.historyFilled;
    const out = new Float32Array(n);
    let idx = (this.historyWrite - n + this.history.length) % this.history.length;
    for (let i = 0; i < n; i += 1) {
      out[i] = this.history[idx];
      idx = (idx + 1) % this.history.length;
    }
    return out;
  }

  captureReference(output) {
    let copied = 0;
    while (copied < output.length) {
      if (this.referenceOffset === 0) {
        this.referenceStartFrame = currentFrame + copied;
      }
      const count = Math.min(
        output.length - copied,
        this.reference.length - this.referenceOffset,
      );
      this.reference.set(
        output.subarray(copied, copied + count),
        this.referenceOffset,
      );
      this.referenceOffset += count;
      copied += count;
      if (this.referenceOffset === this.reference.length) {
        const reference = this.reference;
        this.port.postMessage(
          {
            type: "reference",
            samples: reference.buffer,
            endFrame: this.referenceStartFrame + reference.length,
          },
          [reference.buffer],
        );
        this.reference = new Float32Array(this.referenceFrameSize);
        this.referenceOffset = 0;
      }
    }
  }

  dropCanceledCurrent() {
    const generationId = this.current.generationId;
    this.queuedSamples = Math.max(
      0,
      this.queuedSamples - (this.current.samples.length - this.current.offset),
    );
    this.current = null;
    this.fadeGenerationId = null;
    this.fadeRemaining = 0;
    this.port.postMessage({ type: "canceled", generationId });
    this.completeGenerations.delete(generationId);
    this.postBufferState();
  }

  handleUnderflow() {
    // If generation still open, synthesize PLC instead of pure silence.
    const stillStreaming =
      this.lastGenerationId &&
      !this.completeGenerations.has(this.lastGenerationId);

    if (stillStreaming && this.historyFilled > 32 && this.plcRemaining <= 0) {
      const plcLen = Math.round(sampleRate * 0.02); // 20 ms
      this.plcFrame = concealPacketLoss(
        this.historySnapshot(),
        plcLen,
        sampleRate,
      );
      this.plcOffset = 0;
      this.plcRemaining = plcLen * 3; // allow up to ~60 ms of PLC bursts
      this.jitter.recordUnderflow();
      if (!this.underflowReported) {
        this.underflowReported = true;
        this.port.postMessage({
          type: "underflow",
          generationId: this.lastGenerationId,
          targetMs: this.jitter.targetMs(),
          plc: true,
        });
      }
      return;
    }

    this.started = false;
    if (stillStreaming && !this.underflowReported) {
      this.jitter.recordUnderflow();
      this.underflowReported = true;
      this.port.postMessage({
        type: "underflow",
        generationId: this.lastGenerationId,
        targetMs: this.jitter.targetMs(),
        plc: false,
      });
    }
    if (
      this.lastGenerationId &&
      this.completeGenerations.has(this.lastGenerationId)
    ) {
      this.port.postMessage({
        type: "idle",
        generationId: this.lastGenerationId,
      });
      this.completeGenerations.delete(this.lastGenerationId);
    }
    this.postBufferState();
  }

  postBufferState() {
    this.port.postMessage({
      type: "buffer",
      targetMs: this.jitter.targetMs(),
      queuedMs: (this.queuedSamples / sampleRate) * 1000,
      jitterMs: this.jitter.jitterMs,
    });
  }
}

registerProcessor("openlive-playback", OpenlivePlaybackProcessor);

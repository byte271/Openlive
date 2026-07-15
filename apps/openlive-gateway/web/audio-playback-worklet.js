import { AdaptiveJitterController } from "./jitter-controller.js";

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
    if (this.current?.generationId === generationId) {
      this.fadeGenerationId = generationId;
      this.fadeTotal = Math.max(1, Math.round(sampleRate * fadeMs / 1000));
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
      if (!this.current) {
        this.current = this.queue.shift() ?? null;
        if (!this.current) {
          this.handleUnderflow();
          break;
        }
        this.lastGenerationId = this.current.generationId;
      }

      let value = this.current.samples[this.current.offset];
      if (this.fadeGenerationId === this.current.generationId) {
        value *= this.fadeRemaining / this.fadeTotal;
        this.fadeRemaining -= 1;
        if (this.fadeRemaining <= 0) {
          this.dropCanceledCurrent();
          continue;
        }
      }
      output[index] = value;
      sumSquares += value * value;
      this.current.offset += 1;
      this.queuedSamples = Math.max(0, this.queuedSamples - 1);
      writtenSamples += 1;
      wroteSamples = true;

      if (this.current.offset >= this.current.samples.length) {
        this.port.postMessage({
          type: "played",
          generationId: this.current.generationId,
          mediaEndUs: this.current.mediaEndUs,
        });
        this.current = null;
      }
    }

    if (
      wroteSamples &&
      this.jitter.recordStablePlayback(writtenSamples)
    ) {
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
    this.started = false;
    if (
      this.lastGenerationId &&
      !this.completeGenerations.has(this.lastGenerationId) &&
      !this.underflowReported
    ) {
      this.jitter.recordUnderflow();
      this.underflowReported = true;
      this.port.postMessage({
        type: "underflow",
        generationId: this.lastGenerationId,
        targetMs: this.jitter.targetMs(),
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
      queuedMs: this.queuedSamples / sampleRate * 1000,
    });
  }
}

registerProcessor("openlive-playback", OpenlivePlaybackProcessor);

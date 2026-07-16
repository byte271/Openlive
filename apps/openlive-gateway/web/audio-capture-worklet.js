/**
 * OpenLive 26.7.15 — capture worklet (20 ms frames).
 */
class OpenliveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.max(1, Math.round(sampleRate * 0.02));
    this.pending = [];
    this.pendingLength = 0;
    this.nextFrame = null;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    this.nextFrame ??= currentFrame;

    this.pending.push(new Float32Array(channel));
    this.pendingLength += channel.length;

    while (this.pendingLength >= this.frameSize) {
      const frame = new Float32Array(this.frameSize);
      let written = 0;
      while (written < this.frameSize) {
        const head = this.pending[0];
        const needed = this.frameSize - written;
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
      this.nextFrame += this.frameSize;
      this.port.postMessage(
        { samples: frame.buffer, endFrame: this.nextFrame },
        [frame.buffer],
      );
    }
    return true;
  }
}

registerProcessor("openlive-capture", OpenliveCaptureProcessor);

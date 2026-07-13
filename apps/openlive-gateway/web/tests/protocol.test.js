import assert from "node:assert/strict";
import test from "node:test";

import { EchoReferenceCorrelator, resample } from "../audio-utils.js";
import { AdaptiveJitterController } from "../jitter-controller.js";
import { decodeOutputAudio, encodeInputAudio } from "../protocol.js";

test("binary PCM packet preserves timing and samples", () => {
  const pcm = new Int16Array([1, -2, 32767, -32768]);
  const packet = encodeInputAudio({
    sequence: 9,
    mediaTimeUs: 180000,
    pcm,
    sampleRate: 16000,
    frameDurationMs: 20,
    speechProbability: 0.8,
    outputLevel: 0.2,
    echoProbability: 0.1,
  });
  const view = new DataView(packet);
  view.setUint8(5, 2);
  new Uint8Array(packet).set(
    [0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x12, 0xd3, 0xa4, 0x56, 0x42, 0x66, 0x14, 0x17, 0x40, 0x00],
    24,
  );

  const decoded = decodeOutputAudio(packet);
  assert.equal(decoded.sequence, 9);
  assert.equal(decoded.mediaTimeUs, 180000);
  assert.equal(decoded.generationId, "123e4567-e89b-12d3-a456-426614174000");
  assert.deepEqual([...decoded.pcm], [...pcm]);
});

test("resampler produces the requested time-domain length", () => {
  const input = new Float32Array(960);
  assert.equal(resample(input, 48000, 16000).length, 320);
});

test("aligned output reference distinguishes echo from unrelated input", () => {
  const sampleRate = 5000;
  const correlator = new EchoReferenceCorrelator(sampleRate);
  const reference = randomSignal(2000, 17);
  correlator.write(reference, 4000);
  const echoed = reference.slice(1600, 1700);
  const unrelated = randomSignal(100, 31);

  assert.ok(correlator.estimate(echoed, 4500) > 0.8);
  assert.ok(correlator.estimate(unrelated, 4500) < 0.5);
});

test("jitter target expands on loss and recovers after stable playout", () => {
  const jitter = new AdaptiveJitterController(48000);
  assert.equal(jitter.targetMs(), 40);
  for (let index = 0; index < 12; index += 1) jitter.recordUnderflow();
  assert.equal(jitter.targetMs(), 120);
  for (let index = 0; index < 18; index += 1) {
    jitter.recordStablePlayback(48000 * 10);
  }
  assert.equal(jitter.targetMs(), 30);
  assert.ok(jitter.shouldStart(1440, false));
  assert.ok(jitter.shouldStart(0, true));
});

function randomSignal(length, seed) {
  const signal = new Float32Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    signal[index] = (state / 0xffffffff) * 2 - 1;
  }
  return signal;
}

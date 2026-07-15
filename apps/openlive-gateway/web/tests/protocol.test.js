import assert from "node:assert/strict";
import test from "node:test";

import { EchoReferenceCorrelator, resample, clamp01 } from "../audio-utils.js";
import { AdaptiveJitterController } from "../jitter-controller.js";
import {
  reconnectDelay,
  signalEnergy,
  voicePresentation,
  VoiceMode,
  INPUT_MODES,
  OUTPUT_MODES,
} from "../visual-state.js";
import { decodeOutputAudio, encodeInputAudio } from "../protocol.js";
import { TranscriptLog } from "../transcript-log.js";
import { ConnectionTelemetry } from "../connection-telemetry.js";
import {
  DEFAULT_VOICE_ID,
  OFFLINE_VOICES,
  resolveVoices,
  selectVoice,
} from "../voice-profiles.js";
import {
  buildInteractionProfile,
  composeInstruction,
  DEFAULT_MODE_ID,
  MODES,
  selectMode,
} from "../conversation-modes.js";
import {
  clearSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "../settings-store.js";

/* ---------------------------------------------------------------------------
   Protocol 1.0 binary PCM framing
   --------------------------------------------------------------------------- */

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
  // 1.2 cleanup: frameDurationMs and channels are intentionally not surfaced.
  assert.equal("frameDurationMs" in decoded, false);
  assert.equal("channels" in decoded, false);
});

/* ---------------------------------------------------------------------------
   Audio utilities
   --------------------------------------------------------------------------- */

test("resampler produces the requested time-domain length", () => {
  const input = new Float32Array(960);
  assert.equal(resample(input, 48000, 16000).length, 320);
});

test("clamp01 saturates and rejects non-finite input", () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 1);
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

/* ---------------------------------------------------------------------------
   Jitter controller
   --------------------------------------------------------------------------- */

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

/* ---------------------------------------------------------------------------
   Visual state
   --------------------------------------------------------------------------- */

test("voice presentation keeps live states concise and distinct", () => {
  assert.equal(voicePresentation(VoiceMode.LISTENING).label, "Listening");
  assert.equal(voicePresentation(VoiceMode.SPEAKING).label, "Speaking");
  assert.notEqual(
    voicePresentation(VoiceMode.INTERRUPTED).title,
    voicePresentation(VoiceMode.THINKING).title,
  );
  assert.equal(
    voicePresentation(VoiceMode.CONNECTION_ERROR).title,
    "Connection lost",
  );
  assert.ok(
    Math.abs(signalEnergy(0.9, 0.1, VoiceMode.LISTENING) - 0.828) < 1e-9,
  );
  assert.equal(signalEnergy(0.1, 0.9, VoiceMode.SPEAKING), 0.9);
});

test("v1.2 YIELDING mode is distinct from INTERRUPTED and LISTENING", () => {
  assert.notEqual(VoiceMode.YIELDING, VoiceMode.INTERRUPTED);
  assert.notEqual(VoiceMode.YIELDING, VoiceMode.LISTENING);
  assert.equal(voicePresentation(VoiceMode.YIELDING).label, "Yielding");
  // YIELDING gets a slightly higher input weight than LISTENING so the orb
  // visibly reacts to the user's voice even while output is being ducked.
  assert.ok(
    signalEnergy(0.9, 0, VoiceMode.YIELDING) >
      signalEnergy(0.9, 0, VoiceMode.LISTENING),
  );
});

test("INPUT_MODES and OUTPUT_MODES classify modes correctly", () => {
  assert.ok(INPUT_MODES.has(VoiceMode.LISTENING));
  assert.ok(INPUT_MODES.has(VoiceMode.YIELDING));
  assert.ok(INPUT_MODES.has(VoiceMode.INTERRUPTED));
  assert.ok(!INPUT_MODES.has(VoiceMode.SPEAKING));
  assert.ok(OUTPUT_MODES.has(VoiceMode.SPEAKING));
  assert.ok(OUTPUT_MODES.has(VoiceMode.THINKING));
  assert.ok(!OUTPUT_MODES.has(VoiceMode.LISTENING));
});

test("reconnect backoff is immediate enough for a live conversation", () => {
  assert.equal(reconnectDelay(0), 350);
  assert.equal(reconnectDelay(3), 2800);
  assert.equal(reconnectDelay(10), 5000);
});

/* ---------------------------------------------------------------------------
   Transcript log
   --------------------------------------------------------------------------- */

test("TranscriptLog appends and clears entries", () => {
  const log = new TranscriptLog();
  assert.equal(log.entries.length, 0);
  const user = log.append("user", "Hello");
  assert.equal(user.role, "user");
  assert.equal(user.text, "Hello");
  assert.equal(user.pending, false);
  assert.equal(log.entries.length, 1);
  log.clear();
  assert.equal(log.entries.length, 0);
});

test("TranscriptLog streams assistant turns via beginAssistantStream + appendDelta + finalize", () => {
  const log = new TranscriptLog();
  const entry = log.beginAssistantStream("gen-1");
  assert.equal(entry.pending, true);
  assert.equal(entry.role, "assistant");
  assert.equal(entry.text, "");
  log.appendDelta(entry.id, "Hello ");
  log.appendDelta(entry.id, "world");
  assert.equal(log.last().text, "Hello world");
  assert.equal(log.last().pending, true);
  log.finalize(entry.id, "Hello world.");
  assert.equal(log.last().text, "Hello world.");
  assert.equal(log.last().pending, false);
});

test("TranscriptLog streams user turns via beginUserStream", () => {
  const log = new TranscriptLog();
  const entry = log.beginUserStream("gen-2");
  assert.equal(entry.role, "user");
  assert.equal(entry.pending, true);
  log.appendDelta(entry.id, "Hi");
  log.finalize(entry.id, "Hi there");
  assert.equal(log.last().text, "Hi there");
  assert.equal(log.last().pending, false);
});

test("TranscriptLog finalizeByGeneration locates the right entry", () => {
  const log = new TranscriptLog();
  log.beginAssistantStream("gen-a");
  log.beginAssistantStream("gen-b");
  log.appendDelta("t1", "old");
  log.appendDelta("t2", "new");
  const finalized = log.finalizeByGeneration("gen-b", "new final");
  assert.equal(finalized.generationId, "gen-b");
  assert.equal(finalized.text, "new final");
  // The other entry remains pending.
  const other = log.entries.find((e) => e.generationId === "gen-a");
  assert.equal(other.pending, true);
});

test("TranscriptLog trim preserves pending entries", () => {
  const log = new TranscriptLog({ maxEntries: 3 });
  log.append("user", "one");
  log.append("user", "two");
  const pending = log.beginAssistantStream("gen-x");
  log.append("user", "three"); // forces trim
  // The pending assistant entry must survive.
  assert.ok(log.entries.some((e) => e.id === pending.id));
  assert.ok(log.entries.length <= 3);
});

test("TranscriptLog appendDelta on missing id returns null and is a no-op", () => {
  const log = new TranscriptLog();
  log.append("user", "hi");
  const result = log.appendDelta("nonexistent", "delta");
  assert.equal(result, null);
  assert.equal(log.entries[0].text, "hi");
});

/* ---------------------------------------------------------------------------
   Connection telemetry
   --------------------------------------------------------------------------- */

test("ConnectionTelemetry p50/p95 return null with no samples", () => {
  const t = new ConnectionTelemetry();
  assert.equal(t.p50(), null);
  assert.equal(t.p95(), null);
  assert.equal(t.quality(), "unknown");
});

test("ConnectionTelemetry percentiles and quality buckets", () => {
  const t = new ConnectionTelemetry();
  for (const ms of [200, 250, 300, 400, 350]) t.recordLatency(ms);
  assert.equal(t.p50(), 300);
  assert.equal(t.quality(), "good");
  // p50 is robust to a single outlier; quality stays good.
  t.recordLatency(2000);
  assert.equal(t.quality(), "good");
  // p95 should jump though.
  assert.ok(t.p95() >= 350);
  // Many bad samples degrade the bucket.
  for (let i = 0; i < 25; i++) t.recordLatency(2000);
  assert.equal(t.quality(), "bad");
});

test("ConnectionTelemetry jitter and loss ratio", () => {
  const t = new ConnectionTelemetry();
  t.recordLatency(100);
  t.recordLatency(200);
  t.recordLatency(150);
  // |200-100| + |150-200| = 150, divided by 2 = 75
  assert.equal(t.jitter(), 75);
  t.expectAck();
  t.expectAck();
  t.recordAck();
  assert.equal(t.lossRatio(), 0.5);
});

test("ConnectionTelemetry reset clears all state", () => {
  const t = new ConnectionTelemetry();
  t.recordLatency(100);
  t.expectAck();
  t.recordAck();
  t.reset();
  assert.equal(t.p50(), null);
  assert.equal(t.jitter(), 0);
  assert.equal(t.lossRatio(), 0);
});

/* ---------------------------------------------------------------------------
   Voice profiles
   --------------------------------------------------------------------------- */

test("resolveVoices falls back to the offline roster when manifest is empty", () => {
  assert.equal(resolveVoices(null).length, OFFLINE_VOICES.length);
  assert.equal(resolveVoices([]).length, OFFLINE_VOICES.length);
  assert.equal(resolveVoices(undefined).length, OFFLINE_VOICES.length);
});

test("resolveVoices maps manifest entries to VoiceProfile shape", () => {
  const manifest = [
    { id: "nova", label: "Nova", description: "Warm." },
    { id: "echo" },
  ];
  const voices = resolveVoices(manifest);
  assert.equal(voices.length, 2);
  assert.equal(voices[0].name, "Nova");
  assert.equal(voices[0].description, "Warm.");
  assert.equal(voices[1].name, "echo"); // falls back to id when label missing
  assert.equal(voices[1].description, "Provider voice.");
});

test("selectVoice prefers the requested id, then the default, then the first", () => {
  const voices = resolveVoices([
    { id: "alpha" },
    { id: "beta" },
    { id: DEFAULT_VOICE_ID, label: "Default" },
  ]);
  assert.equal(selectVoice(voices, "beta").id, "beta");
  assert.equal(selectVoice(voices, null).id, DEFAULT_VOICE_ID);
  assert.equal(selectVoice(voices, "missing").id, DEFAULT_VOICE_ID);

  const voicesWithoutDefault = resolveVoices([{ id: "alpha" }, { id: "beta" }]);
  assert.equal(selectVoice(voicesWithoutDefault, null).id, "alpha");
});

/* ---------------------------------------------------------------------------
   Conversation modes
   --------------------------------------------------------------------------- */

test("selectMode falls back to the default mode", () => {
  assert.equal(selectMode(DEFAULT_MODE_ID).id, DEFAULT_MODE_ID);
  assert.equal(selectMode("nonexistent").id, DEFAULT_MODE_ID);
});

test("buildInteractionProfile merges mode timing with backchannels preference", () => {
  const profile = buildInteractionProfile("brainstorm", "expressive");
  assert.equal(profile.backchannels, "expressive");
  assert.equal(profile.pause_tolerance_ms, 320);
  assert.equal(profile.interruption_sensitivity, "high");
});

test("composeInstruction emits nothing for the default open mode with no overrides", () => {
  assert.equal(composeInstruction("open", "auto", "auto"), "");
});

test("composeInstruction stacks mode prefix with speed and detail hints", () => {
  const instruction = composeInstruction("tutor", "slower", "concise");
  assert.ok(instruction.includes("language-tutor mode"));
  assert.ok(instruction.includes("Speak more slowly"));
  assert.ok(instruction.includes("Keep answers concise"));
});

test("MODES is non-empty and every mode has a unique id", () => {
  const ids = new Set(MODES.map((m) => m.id));
  assert.equal(ids.size, MODES.length);
  assert.ok(MODES.length >= 5);
});

/* ---------------------------------------------------------------------------
   Settings store
   --------------------------------------------------------------------------- */

test("loadSettings returns defaults when storage is empty", () => {
  // The Node test runner does not have localStorage; the store must
  // degrade gracefully to defaults.
  const settings = loadSettings();
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    assert.deepEqual(settings[key], value);
  }
});

test("saveSettings validates and merges over defaults", () => {
  const next = saveSettings({ theme: "graphite", motionScale: 0.5 });
  assert.equal(next.theme, "graphite");
  assert.equal(next.motionScale, 0.5);
  // Untouched fields keep their defaults.
  assert.equal(next.entryMode, DEFAULT_SETTINGS.entryMode);
});

test("saveSettings rejects invalid values and falls back to defaults", () => {
  const next = saveSettings({ theme: "neon", entryMode: "yell", motionScale: 5 });
  assert.equal(next.theme, DEFAULT_SETTINGS.theme);
  assert.equal(next.entryMode, DEFAULT_SETTINGS.entryMode);
  assert.equal(next.motionScale, 1);
});

test("clearSettings is safe to call even without localStorage", () => {
  clearSettings();
  const settings = loadSettings();
  assert.equal(settings.theme, DEFAULT_SETTINGS.theme);
});

/* ---------------------------------------------------------------------------
   Test helpers
   --------------------------------------------------------------------------- */

function randomSignal(length, seed) {
  const signal = new Float32Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    signal[index] = (state / 0xffffffff) * 2 - 1;
  }
  return signal;
}

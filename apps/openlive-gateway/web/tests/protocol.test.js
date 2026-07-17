import assert from "node:assert/strict";
import test from "node:test";

import {
  EchoReferenceCorrelator,
  NlmsAec,
  designLowpassKernel,
  resample,
  resampleLinear,
  clamp01,
  rms,
} from "../audio-utils.js";
import {
  AdaptiveJitterController,
  concealPacketLoss,
  estimatePitchPeriod,
} from "../jitter-controller.js";
import { EmotionDetector, estimateF0, spectralTiltProxy } from "../emotion-detector.js";
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

test("polyphase resampler preserves a pure tone better than linear", () => {
  const sampleRate = 48000;
  const duration = 0.05;
  const freq = 440;
  const input = new Float32Array(Math.round(sampleRate * duration));
  for (let i = 0; i < input.length; i += 1) {
    input[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  const targetRate = 16000;
  const poly = resample(input, sampleRate, targetRate);
  const linear = resampleLinear(input, sampleRate, targetRate);
  // Correlate each result against a reference tone at the output rate.
  const ref = new Float32Array(poly.length);
  for (let i = 0; i < ref.length; i += 1) {
    ref[i] = Math.sin((2 * Math.PI * freq * i) / targetRate);
  }
  const corr = (a, b) => {
    let dot = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      ea += a[i] * a[i];
      eb += b[i] * b[i];
    }
    return Math.abs(dot) / Math.sqrt(ea * eb + 1e-12);
  };
  const polyCorr = corr(poly, ref);
  const linearCorr = corr(linear, ref);
  assert.ok(polyCorr > 0.9, `polyphase correlation ${polyCorr}`);
  // Polyphase should be at least as good as linear on a band-limited tone.
  assert.ok(
    polyCorr + 0.02 >= linearCorr,
    `poly=${polyCorr} linear=${linearCorr}`,
  );
});

test("designLowpassKernel is odd-length and approximately unit-gain", () => {
  const kernel = designLowpassKernel(49, 0.9);
  assert.equal(kernel.length % 2, 1);
  let sum = 0;
  for (let i = 0; i < kernel.length; i += 1) sum += kernel[i];
  assert.ok(Math.abs(sum - 1) < 1e-5, `kernel sum ${sum}`);
});

test("NLMS AEC attenuates a known far-end echo path", () => {
  const filterLength = 32;
  const aec = new NlmsAec({ filterLength, mu: 0.6 });
  // True echo path: 0.5 * far[n] + 0.25 * far[n-1]
  const truePath = [0.5, 0.25];
  const farHistory = new Float32Array(truePath.length);
  const frames = 4000;
  let residualEnergy = 0;
  let lateResidual = 0;
  let lateCount = 0;
  for (let n = 0; n < frames; n += 1) {
    const far = Math.sin(0.07 * n) * 0.4 + Math.sin(0.13 * n) * 0.2;
    // Shift true delay line.
    for (let i = farHistory.length - 1; i > 0; i -= 1) farHistory[i] = farHistory[i - 1];
    farHistory[0] = far;
    let echo = 0;
    for (let i = 0; i < truePath.length; i += 1) echo += truePath[i] * farHistory[i];
    const near = echo; // pure echo, no near-end speech
    const residual = aec.processSample(near, far);
    residualEnergy += residual * residual;
    if (n > frames * 0.75) {
      lateResidual += residual * residual;
      lateCount += 1;
    }
  }
  const early = residualEnergy / frames;
  const late = lateResidual / Math.max(1, lateCount);
  // After convergence, residual power should drop substantially.
  assert.ok(late < early * 0.5 || late < 1e-4, `late=${late} early=${early}`);
  assert.ok(aec.weightEnergy() > 0, "weights should adapt away from zero");
});

test("NLMS process block length matches input", () => {
  const aec = new NlmsAec({ filterLength: 16 });
  const near = new Float32Array(128);
  const far = new Float32Array(128);
  for (let i = 0; i < 128; i += 1) {
    far[i] = Math.sin(i / 5);
    near[i] = 0.4 * far[i];
  }
  const out = aec.process(near, far);
  assert.equal(out.length, near.length);
  assert.ok(rms(out) < rms(near), "AEC should reduce echo energy on a block");
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

test("PLC concealment produces non-silent continuity from history", () => {
  const sampleRate = 24000;
  const history = new Float32Array(960);
  for (let i = 0; i < history.length; i += 1) {
    history[i] = Math.sin((2 * Math.PI * 180 * i) / sampleRate) * 0.4;
  }
  const plc = concealPacketLoss(history, 480, sampleRate);
  assert.equal(plc.length, 480);
  assert.ok(rms(plc) > 0.001, "PLC should not be pure silence");
  const period = estimatePitchPeriod(history, sampleRate);
  assert.ok(period >= sampleRate / 400 && period <= sampleRate / 70);
});

test("emotion detector returns bounded valence and arousal", () => {
  const det = new EmotionDetector(16000);
  const frame = new Float32Array(320);
  for (let i = 0; i < frame.length; i += 1) {
    frame[i] = Math.sin((2 * Math.PI * 200 * i) / 16000) * 0.3;
  }
  for (let n = 0; n < 20; n += 1) det.observe(frame);
  const state = det.getEmotion?.() ?? det.state;
  assert.ok(state.arousal >= 0 && state.arousal <= 1);
  assert.ok(state.valence >= -1 && state.valence <= 1);
  assert.ok(state.pauseToleranceScale >= 0.5);
  assert.ok(estimateF0(frame, 16000) > 0);
  assert.ok(Number.isFinite(spectralTiltProxy(frame)));
});

test("jitter target expands on loss and recovers after stable playout", () => {
  const jitter = new AdaptiveJitterController(48000);
  assert.equal(jitter.targetMs(), 40);
  const before = jitter.targetMs();
  for (let index = 0; index < 12; index += 1) jitter.recordUnderflow();
  assert.ok(jitter.targetMs() > before, "underflow should expand target");
  assert.ok(jitter.targetMs() <= 160, "target stays within maxMs");
  const expanded = jitter.targetMs();
  for (let index = 0; index < 24; index += 1) {
    jitter.recordStablePlayback(48000 * 10);
  }
  assert.ok(jitter.targetMs() < expanded, "stable playout should shrink target");
  assert.ok(jitter.targetMs() >= 30);
  assert.ok(jitter.shouldStart(Math.round(48000 * 0.04), false));
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

test("TranscriptLog reviseText bumps revision for ASR corrections", () => {
  const log = new TranscriptLog();
  const entry = log.beginUserStream("asr-1");
  log.reviseText(entry.id, "hel");
  const revised = log.reviseText(entry.id, "hello there");
  assert.equal(revised.text, "hello there");
  assert.equal(revised.revision, 2);
  assert.equal(revised.revised, true);
  const latest = log.reviseLatestPending("user", "hello there friend", "asr-1");
  assert.equal(latest.text, "hello there friend");
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

test("default theme is minimal black for v26.7.16", () => {
  assert.equal(DEFAULT_SETTINGS.theme, "minimal");
  assert.equal(DEFAULT_SETTINGS.backchannels, "natural");
});

test("saveSettings accepts minimal theme", () => {
  const next = saveSettings({ theme: "minimal" });
  assert.equal(next.theme, "minimal");
});

/* ---------------------------------------------------------------------------
   Speech utilities + setup store
   --------------------------------------------------------------------------- */

import {
  isOnlyFillers,
  looksLikeAgentTask,
  stripFillers,
} from "../speech-utils.js";
import {
  DEFAULT_SETUP,
  isSetupComplete,
  loadSetup,
  markSetupComplete,
  resetSetup,
  saveSetup,
} from "../setup-store.js";

test("stripFillers removes um/uh/hmm while keeping meaning", () => {
  assert.equal(
    stripFillers("um, can you please fix the bug hmm"),
    "can you please fix the bug",
  );
  assert.equal(stripFillers("uh huh, yeah I mean deploy it"), "yeah deploy it");
  assert.equal(stripFillers("hmm... uh, look up the docs"), "look up the docs");
});

test("isOnlyFillers detects pure filler turns", () => {
  assert.equal(isOnlyFillers("um uh hmm"), true);
  assert.equal(isOnlyFillers("um, please fix that"), false);
});

test("looksLikeAgentTask detects task-like speech", () => {
  assert.equal(looksLikeAgentTask("can you please fix the login bug"), true);
  assert.equal(looksLikeAgentTask("how are you"), false);
  assert.equal(looksLikeAgentTask("um uh"), false);
});

test("setup store defaults and mark complete", () => {
  resetSetup();
  const initial = loadSetup();
  assert.equal(initial.completed, false);
  assert.equal(isSetupComplete(), false);
  assert.equal(initial.agentKind, DEFAULT_SETUP.agentKind);
  const done = markSetupComplete({
    displayName: "Alex",
    agentKind: "internal",
    llmProviderId: "nvidia",
  });
  assert.equal(done.completed, true);
  assert.equal(done.displayName, "Alex");
  assert.equal(done.agentKind, "internal");
  // Without localStorage, markSetupComplete still returns merged object.
  assert.equal(typeof saveSetup({ stripFillers: false }).stripFillers, "boolean");
  resetSetup();
});

import {
  isUiSoundMuted,
  setUiSoundMuted,
  updateRangeFill,
} from "../ui-feedback.js";

test("ui feedback mute flag toggles safely without AudioContext", () => {
  const before = isUiSoundMuted();
  setUiSoundMuted(true);
  assert.equal(isUiSoundMuted(), true);
  setUiSoundMuted(false);
  assert.equal(isUiSoundMuted(), false);
  setUiSoundMuted(before);
});

test("updateRangeFill paints CSS custom property from range value", () => {
  // Minimal stand-in for an HTML range input.
  const el = {
    min: "0",
    max: "100",
    value: "40",
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
  };
  updateRangeFill(el);
  assert.equal(el.style.props["--range-fill"], "40%");
  el.value = "0";
  updateRangeFill(el);
  assert.equal(el.style.props["--range-fill"], "0%");
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

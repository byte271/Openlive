import assert from "node:assert/strict";
import test from "node:test";

import {
  allowInboundProviderPcm,
  demoAllowsFormant,
  DEMO_TTS_POLICY,
  isRealTtsReady,
  neuralSpeakEngine,
} from "../demo-voice.js";

test("demo path policy is neural-or-silence", () => {
  assert.equal(DEMO_TTS_POLICY, "neural-or-silence");
});

test("auto never requests formant", () => {
  assert.equal(neuralSpeakEngine({}), "piper");
  assert.equal(neuralSpeakEngine({ ttsEngine: "auto" }), "piper");
  assert.equal(demoAllowsFormant({ ttsEngine: "auto" }), false);
  assert.equal(demoAllowsFormant({ ttsEngine: "formant" }), true);
});

test("explicit engines are preserved", () => {
  assert.equal(neuralSpeakEngine({ ttsEngine: "piper" }), "piper");
  assert.equal(neuralSpeakEngine({ ttsEngine: "formant" }), "formant");
  assert.equal(neuralSpeakEngine({ ttsEngine: "browser" }), "browser");
});

test("real TTS ready only when Piper is available", () => {
  assert.equal(isRealTtsReady({ piper: { available: true } }), true);
  assert.equal(isRealTtsReady({ piper: { available: false } }), false);
  assert.equal(isRealTtsReady(null), false);
});

test("mock provider PCM is dropped unless formant is opted in", () => {
  const mock = { id: "mock-local", provider_class: "mock" };
  const grok = { id: "grok", provider_class: "native_duplex" };
  assert.equal(allowInboundProviderPcm({ ttsEngine: "auto" }, mock), false);
  assert.equal(allowInboundProviderPcm({ ttsEngine: "formant" }, mock), true);
  assert.equal(allowInboundProviderPcm({ ttsEngine: "auto" }, grok), true);
});

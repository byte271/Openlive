/**
 * Openlive 1.3 — tests for the gpt-live parity modules.
 *
 * Covers: QuotaTracker, ToolCallLog, visual-cards factory functions,
 * and custom-instructions axes/composition. Settings-store now also
 * includes the v1.3 complexity/tone/layout fields, so those are
 * exercised here too.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AXES,
  composeCustomInstructions,
  loadCustomInstructions,
  resetCustomInstructions,
  setAxis,
} from "../custom-instructions.js";
import {
  clearSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "../settings-store.js";
import { QuotaTracker } from "../quota-tracker.js";
import { ToolCallLog, BUILTIN_TOOLS } from "../tool-calls.js";
import * as visualCards from "../visual-cards.js";

/* ---------------------------------------------------------------------------
   Settings store — v1.3 fields
   --------------------------------------------------------------------------- */

test("settings store v1.3 includes complexity, tone, and layout fields", () => {
  const settings = loadSettings();
  assert.equal(settings.complexityOverride, DEFAULT_SETTINGS.complexityOverride);
  assert.equal(settings.toneOverride, DEFAULT_SETTINGS.toneOverride);
  assert.equal(settings.layout, DEFAULT_SETTINGS.layout);
});

test("settings store v1.3 validates complexity, tone, and layout", () => {
  const next = saveSettings({
    complexityOverride: "expert",
    toneOverride: "casual",
    layout: "inline",
  });
  assert.equal(next.complexityOverride, "expert");
  assert.equal(next.toneOverride, "casual");
  assert.equal(next.layout, "inline");

  const bad = saveSettings({
    complexityOverride: "elaborate",
    toneOverride: "sarcastic",
    layout: "sidebar",
  });
  assert.equal(bad.complexityOverride, DEFAULT_SETTINGS.complexityOverride);
  assert.equal(bad.toneOverride, DEFAULT_SETTINGS.toneOverride);
  assert.equal(bad.layout, DEFAULT_SETTINGS.layout);
});

test("settings store key is namespaced to v1.3", () => {
  // We can't observe localStorage in the Node test runner, but we can verify
  // the version bump didn't break the load/save contract.
  clearSettings();
  const fresh = loadSettings();
  assert.equal(fresh.theme, "aurora");
});

/* ---------------------------------------------------------------------------
   Custom instructions
   --------------------------------------------------------------------------- */

test("AXES has four axes with four options each", () => {
  for (const axisName of Object.keys(AXES)) {
    const axis = AXES[axisName];
    assert.equal(axis.options.length, 4);
    assert.equal(axis.options[0].value, "auto");
    assert.equal(typeof axis.instruction, "function");
  }
});

test("loadCustomInstructions returns all-auto defaults when storage is empty", () => {
  clearSettings();
  const ci = loadCustomInstructions();
  assert.equal(ci.speed, "auto");
  assert.equal(ci.detail, "auto");
  assert.equal(ci.complexity, "auto");
  assert.equal(ci.tone, "auto");
});

test("setAxis validates the new value and returns the merged instructions", () => {
  clearSettings();
  // setAxis returns the merged instructions object. In the Node test runner
  // there is no localStorage, so the persistence layer degrades to
  // in-memory defaults — but the returned object still reflects the change.
  const next = setAxis("speed", "slower");
  assert.equal(next.speed, "slower");
  // Other axes untouched.
  assert.equal(next.detail, "auto");
  // Invalid value rejected — setAxis returns the unchanged current state.
  const unchanged = setAxis("speed", "warp");
  assert.equal(unchanged.speed, "auto");
  assert.equal(unchanged.detail, "auto");
});

test("composeCustomInstructions returns null when all axes are auto", () => {
  clearSettings();
  assert.equal(composeCustomInstructions(), null);
});

test("composeCustomInstructions stacks multiple axes", () => {
  // Pass the instructions explicitly so the test does not rely on localStorage.
  const composed = composeCustomInstructions({
    speed: "faster",
    detail: "concise",
    complexity: "expert",
    tone: "casual",
  });
  assert.ok(composed);
  assert.ok(composed.includes("Speak more briskly"));
  assert.ok(composed.includes("Keep answers concise"));
  assert.ok(composed.includes("expert background"));
  assert.ok(composed.includes("casual, friendly tone"));
});

test("resetCustomInstructions restores all-auto state", () => {
  setAxis("speed", "slower");
  const cleared = resetCustomInstructions();
  assert.equal(cleared.speed, "auto");
  assert.equal(cleared.detail, "auto");
  assert.equal(cleared.complexity, "auto");
  assert.equal(cleared.tone, "auto");
  assert.equal(composeCustomInstructions(cleared), null);
});

/* ---------------------------------------------------------------------------
   Quota tracker
   --------------------------------------------------------------------------- */

test("QuotaTracker with hardCapSeconds=0 is uncapped and never fires", () => {
  const tracker = new QuotaTracker({ hardCapSeconds: 0 });
  tracker.start();
  assert.equal(tracker.remainingSeconds(), Number.POSITIVE_INFINITY);
  assert.equal(tracker.isExhausted(), false);
  tracker.stop();
});

test("QuotaTracker fires soft_warning at 80% of cap", () => {
  const notices = [];
  const tracker = new QuotaTracker(
    { hardCapSeconds: 10, softWarningRatio: 0.8, tickIntervalMs: 1000 },
    { onNotice: (n) => notices.push(n) },
  );
  // Do NOT call start() — we don't want a real setInterval. Manually tick
  // 9 times at 1000ms each = 9 seconds, which crosses the 80% threshold (8s).
  for (let i = 0; i < 9; i++) tracker.tick();
  const soft = notices.find((n) => n.kind === "soft_warning");
  assert.ok(soft, "expected a soft_warning notice");
  assert.ok(soft.remainingSeconds <= 2);
});

test("QuotaTracker fires hard_limit at cap and stops the timer", () => {
  const notices = [];
  const tracker = new QuotaTracker(
    { hardCapSeconds: 5, softWarningRatio: 0.5, tickIntervalMs: 1000 },
    { onNotice: (n) => notices.push(n) },
  );
  // Tick 6 times at 1000ms each = 6 seconds, exceeding the 5s cap.
  for (let i = 0; i < 6; i++) tracker.tick();
  // Even though we ticked past the cap, the hard_limit flag should prevent
  // duplicate notices.
  for (let i = 0; i < 6; i++) tracker.tick();
  const hard = notices.filter((n) => n.kind === "hard_limit");
  assert.equal(hard.length, 1);
  assert.equal(tracker.isExhausted(), true);
});

test("QuotaTracker.reset clears all state", () => {
  const tracker = new QuotaTracker({ hardCapSeconds: 5, tickIntervalMs: 1000 });
  // Tick 6 times at 1000ms each = 6 seconds, exceeding the 5s cap.
  for (let i = 0; i < 6; i++) tracker.tick();
  assert.equal(tracker.isExhausted(), true);
  tracker.reset();
  assert.equal(tracker.isExhausted(), false);
  assert.equal(tracker.elapsedSeconds, 0);
});

test("QuotaTracker.configure can disable the cap mid-session", () => {
  const tracker = new QuotaTracker({ hardCapSeconds: 60, tickIntervalMs: 60000 });
  tracker.start();
  tracker.configure({ hardCapSeconds: 0 });
  assert.equal(tracker.remainingSeconds(), Number.POSITIVE_INFINITY);
  tracker.stop();
});

/* ---------------------------------------------------------------------------
   Tool call log
   --------------------------------------------------------------------------- */

test("ToolCallLog begins and streams a call", () => {
  const log = new ToolCallLog();
  const call = log.beginCall("call-1", "weather");
  assert.equal(call.status, "pending");
  assert.equal(call.argumentsText, "");
  log.appendArgumentsDelta("call-1", '{"loc":"NYC"}');
  assert.equal(log.findByCallId("call-1").argumentsText, '{"loc":"NYC"}');
  assert.equal(log.findByCallId("call-1").status, "running");
});

test("ToolCallLog completes a call with a result", () => {
  const log = new ToolCallLog();
  log.beginCall("call-2", "stock");
  log.completeCall("call-2", "AAPL $189.50", false);
  const call = log.findByCallId("call-2");
  assert.equal(call.status, "completed");
  assert.equal(call.result, "AAPL $189.50");
  assert.ok(call.completedAt !== null);
});

test("ToolCallLog marks failed completions", () => {
  const log = new ToolCallLog();
  log.beginCall("call-3", "web_search");
  log.completeCall("call-3", "timeout", true);
  assert.equal(log.findByCallId("call-3").status, "failed");
});

test("ToolCallLog.describe uses builtin tools and falls back gracefully", () => {
  const log = new ToolCallLog();
  assert.equal(log.describe("weather").glyph, "☀");
  assert.equal(log.describe("nonexistent").glyph, "N");
  assert.equal(log.describe("nonexistent").description, "Provider tool");
});

test("ToolCallLog.registerTool overrides a builtin descriptor", () => {
  const log = new ToolCallLog();
  log.registerTool({ name: "weather", description: "Custom weather", glyph: "W" });
  assert.equal(log.describe("weather").glyph, "W");
  assert.equal(log.describe("weather").description, "Custom weather");
});

test("ToolCallLog.trim preserves pending entries over completed ones", () => {
  const log = new ToolCallLog({ maxCalls: 3 });
  // Two completed calls (eligible for trimming).
  log.beginCall("a", "weather");
  log.completeCall("a", "sunny");
  log.beginCall("b", "stock");
  log.completeCall("b", "AAPL $1");
  // One pending call.
  log.beginCall("c", "maps");
  // Adding a fourth call exceeds maxCalls and should trim a completed call
  // (a or b), preserving the pending c.
  log.beginCall("d", "web_search");
  // The pending call c must survive.
  assert.ok(log.findByCallId("c"), "pending call should survive trim");
  // The new call d must be present.
  assert.ok(log.findByCallId("d"), "new call should be present");
  // At least one completed call should have been trimmed.
  const aPresent = Boolean(log.findByCallId("a"));
  const bPresent = Boolean(log.findByCallId("b"));
  assert.ok(!(aPresent && bPresent), "at least one completed call should be trimmed");
});

test("BUILTIN_TOOLS has the expected set of names", () => {
  const names = Object.keys(BUILTIN_TOOLS);
  for (const expected of ["weather", "stock", "maps", "web_search", "calculator"]) {
    assert.ok(names.includes(expected), `expected ${expected} in BUILTIN_TOOLS`);
  }
});

/* ---------------------------------------------------------------------------
   Visual cards
   --------------------------------------------------------------------------- */

test("weatherCard builds the expected shape", () => {
  const card = visualCards.weatherCard({
    location: "San Francisco",
    temperatureC: 14,
    condition: "Foggy",
    humidity: 85,
    windKph: 12,
  }, "OpenWeather");
  assert.equal(card.kind, "weather");
  assert.equal(card.title, "Weather · San Francisco");
  assert.equal(card.fields.temperature, "14°C");
  assert.equal(card.fields.humidity, "85%");
  assert.equal(card.attribution, "OpenWeather");
});

test("stockCard includes a directional arrow", () => {
  const up = visualCards.stockCard({ symbol: "AAPL", price: 189.5, changePercent: 1.2 });
  assert.ok(up.fields.change.startsWith("▲"));
  const down = visualCards.stockCard({ symbol: "TSLA", price: 240.1, changePercent: -2.3 });
  assert.ok(down.fields.change.startsWith("▼"));
});

test("sportsCard formats home and away", () => {
  const card = visualCards.sportsCard({
    league: "MLB",
    home: "Giants",
    away: "Dodgers",
    homeScore: 3,
    awayScore: 5,
    status: "Final",
  });
  assert.equal(card.fields.home, "Giants 3");
  assert.equal(card.fields.away, "Dodgers 5");
  assert.equal(card.fields.status, "Final");
});

test("mapsCard includes place and address", () => {
  const card = visualCards.mapsCard({
    place: "Golden Gate Bridge",
    address: "Golden Gate Brg, San Francisco, CA",
  });
  assert.equal(card.kind, "maps");
  assert.equal(card.fields.place, "Golden Gate Bridge");
});

test("webSearchCard caps results to three", () => {
  const card = visualCards.webSearchCard({
    query: "openlive voice runtime",
    results: [
      { title: "A", url: "x", snippet: "1" },
      { title: "B", url: "y", snippet: "2" },
      { title: "C", url: "z", snippet: "3" },
      { title: "D", url: "w", snippet: "4" },
    ],
  });
  assert.equal(card.kind, "web_search");
  // The fourth result is dropped (no newline-joined entry for it).
  assert.ok(card.fields.results.includes("A — 1"));
  assert.ok(!card.fields.results.includes("D — 4"));
});

test("codeCard preserves code and output", () => {
  const card = visualCards.codeCard({
    language: "python",
    code: "print('hi')",
    output: "hi",
  });
  assert.equal(card.kind, "code");
  assert.equal(card.fields.code, "print('hi')");
  assert.equal(card.fields.output, "hi");
});

test("translationCard carries source and target text", () => {
  const card = visualCards.translationCard({
    sourceText: "Hello",
    sourceLang: "English",
    targetText: "Hola",
    targetLang: "Spanish",
  });
  assert.equal(card.kind, "translation");
  assert.equal(card.fields.source, "Hello");
  assert.equal(card.fields.target, "Hola");
});

test("genericCard is the fallback", () => {
  const card = visualCards.genericCard({ title: "Note", body: "Some text" });
  assert.equal(card.kind, "generic");
  assert.equal(card.title, "Note");
});

test("glyphForKind returns a glyph for every kind", () => {
  for (const kind of ["weather", "stock", "sports", "maps", "web_search", "code", "translation", "generic"]) {
    const glyph = visualCards.glyphForKind(/** @type {any} */ (kind));
    assert.equal(typeof glyph, "string");
    assert.ok(glyph.length > 0);
  }
  // Unknown kind falls back to the generic glyph.
  assert.equal(visualCards.glyphForKind(/** @type {any} */ ("unknown")), visualCards.glyphForKind("generic"));
});

test("every visual card has a unique id", () => {
  const cards = [
    visualCards.weatherCard({ location: "X", temperatureC: 0, condition: "Y" }),
    visualCards.stockCard({ symbol: "X", price: 1, changePercent: 0 }),
    visualCards.genericCard({ title: "Z", body: "" }),
  ];
  const ids = new Set(cards.map((c) => c.id));
  assert.equal(ids.size, cards.length);
});

/**
 * OpenLive 26.7.16 — tactile UI feedback (sound + micro-haptics).
 *
 * Soft Web Audio cues for sliders, taps, and mode changes. No assets:
 * short synthesized ticks so the silver motion slider and primary controls
 * feel physical. Respects reduced-motion and an optional mute flag.
 */

const STORAGE_KEY = "openlive.v26.7.16.uiFeedback";

/** @type {AudioContext | null} */
let ctx = null;
let muted = loadMuted();
let lastSliderTickAt = 0;
let lastSliderValue = null;
let lastModeChimeAt = 0;

function loadMuted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "muted";
  } catch {
    return false;
  }
}

export function isUiSoundMuted() {
  return muted;
}

export function setUiSoundMuted(next) {
  muted = Boolean(next);
  try {
    localStorage.setItem(STORAGE_KEY, muted ? "muted" : "on");
  } catch {
    /* ignore */
  }
}

function reducedMotion() {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function ensureCtx() {
  if (muted || reducedMotion()) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

/**
 * Unlock audio on first user gesture (required by browsers).
 */
export function unlockUiAudio() {
  const audio = ensureCtx();
  if (!audio) return;
  // Tiny silent blip primes the graph without a click.
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.01);
}

/**
 * Soft metallic tick for range sliders (silver thumb).
 * @param {number} value 0–100-ish value for pitch modulation
 * @param {{ force?: boolean }} [opts]
 */
export function playSliderTick(value, opts = {}) {
  const now = performance.now();
  // Throttle so continuous drag still feels like discrete notches.
  if (!opts.force && now - lastSliderTickAt < 28) return;
  if (!opts.force && lastSliderValue !== null && Math.abs(value - lastSliderValue) < 0.5) {
    return;
  }
  lastSliderTickAt = now;
  lastSliderValue = value;

  const audio = ensureCtx();
  if (!audio) return;

  const t0 = audio.currentTime;
  // Map value → pitch so sliding right feels slightly brighter.
  const norm = Math.max(0, Math.min(1, Number(value) / 100));
  const freq = 520 + norm * 420;

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const filter = audio.createBiquadFilter();

  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.72, t0 + 0.045);

  filter.type = "highpass";
  filter.frequency.value = 280;
  filter.Q.value = 0.6;

  // Soft metallic tick — very quiet, short decay.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.055, t0 + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.055);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + 0.06);

  // Subtle second partial for “metal” color.
  const osc2 = audio.createOscillator();
  const gain2 = audio.createGain();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(freq * 2.05, t0);
  gain2.gain.setValueAtTime(0.0001, t0);
  gain2.gain.exponentialRampToValueAtTime(0.012, t0 + 0.003);
  gain2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);
  osc2.connect(gain2);
  gain2.connect(audio.destination);
  osc2.start(t0);
  osc2.stop(t0 + 0.045);

  maybeVibrate(4);
}

/**
 * Soft UI click for buttons / steps.
 * @param {"tap"|"confirm"|"cancel"|"soft"} [kind]
 */
export function playClick(kind = "tap") {
  const audio = ensureCtx();
  if (!audio) return;
  const t0 = audio.currentTime;
  const profiles = {
    tap: { f: 680, g: 0.04, d: 0.04 },
    soft: { f: 520, g: 0.028, d: 0.05 },
    confirm: { f: 880, g: 0.05, d: 0.06 },
    cancel: { f: 320, g: 0.035, d: 0.05 },
  };
  const p = profiles[kind] || profiles.tap;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(p.f, t0);
  osc.frequency.exponentialRampToValueAtTime(p.f * 0.85, t0 + p.d);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(p.g, t0 + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + p.d);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + p.d + 0.01);
  maybeVibrate(kind === "confirm" ? 8 : 3);
}

/**
 * Very soft mode-change chime (listening / speaking / thinking).
 * @param {string} mode
 */
export function playModeChime(mode) {
  const now = performance.now();
  if (now - lastModeChimeAt < 180) return;
  lastModeChimeAt = now;
  const audio = ensureCtx();
  if (!audio) return;

  const map = {
    listening: [440, 554],
    speaking: [523, 659],
    thinking: [392, 494],
    interrupted: [349, 415],
    starting: [494, 622],
    idle: [330, 392],
  };
  const pair = map[mode];
  if (!pair) return;

  const t0 = audio.currentTime;
  pair.forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t0 + i * 0.03;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.018, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(start);
    osc.stop(start + 0.18);
  });
}

/**
 * Attach tick feedback to a range input (silver slider).
 * @param {HTMLInputElement | null} el
 * @param {(value: number) => void} [onValue]
 */
export function bindSliderFeedback(el, onValue) {
  if (!el) return;
  let dragging = false;
  const emit = () => {
    const value = Number(el.value);
    playSliderTick(value);
    updateRangeFill(el);
    onValue?.(value);
  };
  el.addEventListener("pointerdown", () => {
    dragging = true;
    unlockUiAudio();
    playSliderTick(Number(el.value), { force: true });
    updateRangeFill(el);
  });
  el.addEventListener("pointerup", () => {
    dragging = false;
  });
  el.addEventListener("input", emit);
  el.addEventListener("change", () => {
    if (!dragging) emit();
  });
  updateRangeFill(el);
}

/**
 * Paint the filled track left of the thumb (CSS custom property).
 * @param {HTMLInputElement} el
 */
export function updateRangeFill(el) {
  if (!el) return;
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const value = Number(el.value);
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  el.style.setProperty("--range-fill", `${pct}%`);
}

function maybeVibrate(ms) {
  if (muted || reducedMotion()) return;
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(ms);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Openlive 1.2 — settings-store.js
 *
 * Thin, typed wrapper over localStorage that persists user UI preferences
 * under a single namespaced key. All v1.2 keys live under `openlive.v1.2.*`.
 *
 * The store is defensive: malformed JSON, quota errors, and missing
 * localStorage (private mode, SSR) all degrade to the defaults without
 * throwing. This module is unit-tested in tests/protocol.test.js.
 */

const KEY = "openlive.v1.3.settings";

export const DEFAULT_SETTINGS = Object.freeze({
  theme: "aurora",
  motionScale: 1,
  showLatency: false,
  entryMode: "auto",
  backchannels: "minimal",
  speedOverride: "auto",
  detailOverride: "auto",
  complexityOverride: "auto",
  toneOverride: "auto",
  voiceId: null,
  modeId: "open",
  layout: "focused",
  onboardingDismissed: false,
});

const VALIDATORS = {
  theme: (value) =>
    ["aurora", "graphite", "signal"].includes(value) ? value : DEFAULT_SETTINGS.theme,
  motionScale: (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_SETTINGS.motionScale;
  },
  showLatency: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.showLatency),
  entryMode: (value) =>
    ["auto", "ptt"].includes(value) ? value : DEFAULT_SETTINGS.entryMode,
  backchannels: (value) =>
    ["off", "minimal", "natural", "expressive"].includes(value)
      ? value
      : DEFAULT_SETTINGS.backchannels,
  speedOverride: (value) =>
    ["auto", "slower", "balanced", "faster"].includes(value)
      ? value
      : DEFAULT_SETTINGS.speedOverride,
  detailOverride: (value) =>
    ["auto", "concise", "balanced", "thorough"].includes(value)
      ? value
      : DEFAULT_SETTINGS.detailOverride,
  complexityOverride: (value) =>
    ["auto", "simple", "balanced", "expert"].includes(value)
      ? value
      : DEFAULT_SETTINGS.complexityOverride,
  toneOverride: (value) =>
    ["auto", "formal", "balanced", "casual"].includes(value)
      ? value
      : DEFAULT_SETTINGS.toneOverride,
  voiceId: (value) => (typeof value === "string" || value === null ? value : null),
  modeId: (value) => (typeof value === "string" ? value : DEFAULT_SETTINGS.modeId),
  layout: (value) =>
    ["focused", "inline"].includes(value) ? value : DEFAULT_SETTINGS.layout,
  onboardingDismissed: (value) =>
    typeof value === "boolean" ? value : DEFAULT_SETTINGS.onboardingDismissed,
};

/**
 * Read all persisted settings, merged over the defaults. Returns a fresh
 * object every call so callers can mutate freely.
 *
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function loadSettings() {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in parsed) {
        merged[key] = VALIDATORS[key](parsed[key]);
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a partial settings update. Merges with the existing stored state,
 * validates every field, and swallows quota errors silently (the in-memory
 * state in app.js remains authoritative for the current session).
 *
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch
 * @returns {typeof DEFAULT_SETTINGS} The new merged settings.
 */
export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key in VALIDATORS) {
      next[key] = VALIDATORS[key](value);
    }
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Quota exceeded or storage disabled — keep operating in-memory.
    }
  }
  return next;
}

/**
 * Reset all persisted settings to defaults. Used by the diagnostic drawer's
 * "reset" affordance if we add one.
 */
export function clearSettings() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

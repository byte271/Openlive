/**
 * Openlive 26.7.16 — custom-instructions.js
 *
 * Inline panel state for the AVM-style "talk quicker or slower, with more
 * detail or more concise" affordance. Unlike the v1.2 settings-sheet version,
 * this panel lives inline next to the primary control and applies instantly
 * to the next provider response — matching AVM's behavior where the user
 * can adjust pace mid-conversation.
 *
 * The panel is intentionally orthogonal to the conversation-modes system:
 *   - Conversation modes bake in a baseline instruction prefix.
 *   - Custom instructions stack on top, applied per-response.
 *
 * composeInstruction() in conversation-modes.js already merges both, so this
 * module just owns the inline-panel state and persistence.
 */

import { saveSettings, loadSettings } from "./settings-store.js";

/**
 * The four axes AVM exposes. Each axis has a value of "auto" (no override)
 * or one of the discrete settings.
 *
 * @typedef {Object} CustomInstructions
 * @property {"auto" | "slower" | "balanced" | "faster"} speed
 * @property {"auto" | "concise" | "balanced" | "thorough"} detail
 * @property {"auto" | "simple" | "balanced" | "expert"} complexity
 * @property {"auto" | "formal" | "balanced" | "casual"} tone
 */

export const AXES = Object.freeze({
  speed: {
    label: "Pace",
    options: [
      { value: "auto", label: "Auto" },
      { value: "slower", label: "Slower" },
      { value: "balanced", label: "Balanced" },
      { value: "faster", label: "Faster" },
    ],
    instruction: (value) => {
      if (value === "slower") return "Speak more slowly than usual.";
      if (value === "faster") return "Speak more briskly than usual.";
      return null;
    },
  },
  detail: {
    label: "Detail",
    options: [
      { value: "auto", label: "Auto" },
      { value: "concise", label: "Concise" },
      { value: "balanced", label: "Balanced" },
      { value: "thorough", label: "Thorough" },
    ],
    instruction: (value) => {
      if (value === "concise") return "Keep answers concise.";
      if (value === "thorough") return "Give thorough, detailed answers.";
      return null;
    },
  },
  complexity: {
    label: "Complexity",
    options: [
      { value: "auto", label: "Auto" },
      { value: "simple", label: "Simple" },
      { value: "balanced", label: "Balanced" },
      { value: "expert", label: "Expert" },
    ],
    instruction: (value) => {
      if (value === "simple") return "Use simple, plain-language explanations.";
      if (value === "expert") return "Assume expert background; use precise terminology.";
      return null;
    },
  },
  tone: {
    label: "Tone",
    options: [
      { value: "auto", label: "Auto" },
      { value: "formal", label: "Formal" },
      { value: "balanced", label: "Balanced" },
      { value: "casual", label: "Casual" },
    ],
    instruction: (value) => {
      if (value === "formal") return "Use a formal tone.";
      if (value === "casual") return "Use a casual, friendly tone.";
      return null;
    },
  },
});

/**
 * Load the custom instructions from persisted settings. The settings store
 * already has `speedOverride` and `detailOverride` from v1.2; v1.3 adds
 * `complexityOverride` and `toneOverride`. We bridge both for continuity.
 *
 * @returns {CustomInstructions}
 */
export function loadCustomInstructions() {
  const settings = loadSettings();
  return {
    speed: settings.speedOverride ?? "auto",
    detail: settings.detailOverride ?? "auto",
    complexity: settings.complexityOverride ?? "auto",
    tone: settings.toneOverride ?? "auto",
  };
}

/**
 * Persist a single axis update. Returns the new merged CustomInstructions.
 *
 * @param {keyof CustomInstructions} axis
 * @param {string} value
 * @returns {CustomInstructions}
 */
export function setAxis(axis, value) {
  const current = loadCustomInstructions();
  if (!AXES[axis]) return current;
  const validValues = AXES[axis].options.map((o) => o.value);
  if (!validValues.includes(value)) return current;
  const next = { ...current, [axis]: value };
  saveSettings({
    speedOverride: next.speed,
    detailOverride: next.detail,
    complexityOverride: next.complexity,
    toneOverride: next.tone,
  });
  return next;
}

/**
 * Compose the instruction prefix from the four axes. Returns null when no
 * overrides apply, so callers can omit the field cleanly.
 *
 * @param {CustomInstructions} [instructions]
 * @returns {string | null}
 */
export function composeCustomInstructions(instructions = loadCustomInstructions()) {
  const parts = [];
  for (const axis of Object.keys(AXES)) {
    const value = instructions[axis];
    if (value && value !== "auto") {
      const instruction = AXES[axis].instruction(value);
      if (instruction) parts.push(instruction);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Reset all axes to "auto".
 *
 * @returns {CustomInstructions}
 */
export function resetCustomInstructions() {
  const cleared = {
    speed: "auto",
    detail: "auto",
    complexity: "auto",
    tone: "auto",
  };
  saveSettings({
    speedOverride: "auto",
    detailOverride: "auto",
    complexityOverride: "auto",
    toneOverride: "auto",
  });
  return cleared;
}

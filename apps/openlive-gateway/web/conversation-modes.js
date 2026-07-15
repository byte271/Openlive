/**
 * Openlive 1.2 — conversation-modes.js
 *
 * Conversation mode presets. Each mode packages:
 *   - id, name, description, glyph for the picker UI
 *   - pauseToleranceMs passed to the gateway as `pause_tolerance_ms`
 *   - interruptionSensitivity passed as `interruption_sensitivity`
 *   - instructionPrefix appended to the system instruction for the session
 *
 * Modes are session-scoped: switching mid-call reconfigures the gateway
 * via a `session_configured` control event with the new parameters, and
 * the next cognition task receives the new instruction prefix.
 *
 * Modes are intentionally original Openlive presets; they do not mirror
 * any proprietary mode catalog.
 */

/**
 * @typedef {Object} ConversationMode
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} glyph
 * @property {number} pauseToleranceMs
 * @property {"low" | "balanced" | "high"} interruptionSensitivity
 * @property {string} instructionPrefix
 */

/** @type {ReadonlyArray<ConversationMode>} */
export const MODES = Object.freeze([
  {
    id: "open",
    name: "Open conversation",
    description: "Natural, flowing dialogue. Best default for most uses.",
    glyph: "○",
    pauseToleranceMs: 520,
    interruptionSensitivity: "balanced",
    instructionPrefix: "",
  },
  {
    id: "brainstorm",
    name: "Brainstorm",
    description: "Fast back-and-forth. Shorter pauses, eager turn-taking.",
    glyph: "✦",
    pauseToleranceMs: 320,
    interruptionSensitivity: "high",
    instructionPrefix:
      "You are in brainstorm mode. Keep responses short, build on the user's ideas, and prefer asking a sharp follow-up question over a long explanation.",
  },
  {
    id: "interview",
    name: "Interview",
    description: "One question at a time. Patient pauses, low interruptions.",
    glyph: "?",
    pauseToleranceMs: 900,
    interruptionSensitivity: "low",
    instructionPrefix:
      "You are in interview mode. Ask one focused question at a time. Wait for a complete answer. Avoid stacking follow-ups before the user finishes.",
  },
  {
    id: "tutor",
    name: "Language tutor",
    description: "Slow, clear, encouraging. Welcomes hesitation.",
    glyph: "✎",
    pauseToleranceMs: 1100,
    interruptionSensitivity: "low",
    instructionPrefix:
      "You are in language-tutor mode. Speak slowly and clearly. Pause often. If the user hesitates, encourage them gently. Correct mistakes briefly and move on.",
  },
  {
    id: "standup",
    name: "Stand-up",
    description: "Crisp status check. Short turns, brisk pace.",
    glyph: "▲",
    pauseToleranceMs: 280,
    interruptionSensitivity: "high",
    instructionPrefix:
      "You are in stand-up mode. Keep responses under three sentences. Surface blockers explicitly. End each turn with the next prompt you want from the user.",
  },
]);

export const DEFAULT_MODE_ID = "open";

/**
 * Find a mode by id. Falls back to the default mode if not found.
 *
 * @param {string} id
 * @returns {ConversationMode}
 */
export function selectMode(id) {
  return MODES.find((mode) => mode.id === id) ?? MODES[0];
}

/**
 * Build the gateway-facing interaction profile for a mode, merged with the
 * backchannels preference (which is operator-side, not mode-side).
 *
 * @param {string} modeId
 * @param {string} backchannels - "off" | "minimal" | "natural" | "expressive"
 * @returns {{pause_tolerance_ms: number, interruption_sensitivity: string, backchannels: string}}
 */
export function buildInteractionProfile(modeId, backchannels) {
  const mode = selectMode(modeId);
  return {
    pause_tolerance_ms: mode.pauseToleranceMs,
    interruption_sensitivity: mode.interruptionSensitivity,
    backchannels,
  };
}

/**
 * Compose the effective system instruction for a session: the mode prefix
 * plus any per-call speed/detail override hints. Returns an empty string
 * when no overrides apply, so callers can omit the field cleanly.
 *
 * @param {string} modeId
 * @param {string} speedOverride - "auto" | "slower" | "balanced" | "faster"
 * @param {string} detailOverride - "auto" | "concise" | "balanced" | "thorough"
 * @returns {string}
 */
export function composeInstruction(modeId, speedOverride, detailOverride) {
  const mode = selectMode(modeId);
  const parts = [];
  if (mode.instructionPrefix) parts.push(mode.instructionPrefix);
  if (speedOverride && speedOverride !== "auto") {
    parts.push(
      speedOverride === "slower"
        ? "Speak more slowly than usual."
        : "Speak more briskly than usual.",
    );
  }
  if (detailOverride && detailOverride !== "auto") {
    parts.push(
      detailOverride === "concise"
        ? "Keep answers concise."
        : "Give thorough, detailed answers.",
    );
  }
  return parts.join(" ");
}

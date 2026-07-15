/**
 * Openlive 26.7.14.1 — visual-state.js
 *
 * Central registry of voice surface modes, their presentation copy, their
 * acoustic energy weights, and helpers used by both the UI layer and the
 * voice visualizer. Keeping this in one place means the orb, the copy block,
 * the diagnostics drawer, and the keyboard layer all agree on what each mode
 * means.
 *
 * The mode set is intentionally richer than v1.1: a dedicated YIELDING mode
 * separates "soft-ducked mid-response" from "interrupted with new user turn",
 * which matches how operators diagnose barge-in timing. All modes are
 * data-driven; nothing here touches the DOM directly.
 */

export const VoiceMode = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  YIELDING: "yielding",
  INTERRUPTED: "interrupted",
  MUTED: "muted",
  RECONNECTING: "reconnecting",
  CONNECTION_ERROR: "connection_error",
  ERROR: "error",
});

const PRESENTATIONS = Object.freeze({
  idle: {
    label: "Ready when you are",
    title: "Start a live conversation",
    detail:
      "Natural turn-taking, interruption, and continuous listening.",
    tone: "neutral",
  },
  starting: {
    label: "Opening the room",
    title: "Getting everything ready",
    detail: "Connecting audio and the realtime provider.",
    tone: "neutral",
  },
  listening: {
    label: "Listening",
    title: "Go ahead",
    detail:
      "You can pause naturally or speak over Openlive at any time.",
    tone: "input",
  },
  thinking: {
    label: "Thinking",
    title: "Following your thought",
    detail:
      "The audio channel stays open while the response takes shape.",
    tone: "neutral",
  },
  speaking: {
    label: "Speaking",
    title: "Openlive is responding",
    detail:
      "Interrupt naturally—the response should yield without losing context.",
    tone: "output",
  },
  yielding: {
    label: "Yielding",
    title: "Softly stepping back",
    detail:
      "Output is ducked while you speak. Resume naturally or commit a new turn.",
    tone: "input",
  },
  interrupted: {
    label: "Yielding",
    title: "I'm listening",
    detail:
      "The previous response is being stopped for your new turn.",
    tone: "input",
  },
  muted: {
    label: "Microphone paused",
    title: "You're muted",
    detail: "Resume whenever you want to continue.",
    tone: "neutral",
  },
  reconnecting: {
    label: "Connection interrupted",
    title: "Rejoining the conversation",
    detail:
      "Your microphone stays ready while the realtime session reconnects.",
    tone: "warn",
  },
  connection_error: {
    label: "Session ended",
    title: "Connection lost",
    detail:
      "End this conversation, then start again when the network is available.",
    tone: "bad",
  },
  error: {
    label: "Couldn't start",
    title: "Audio needs attention",
    detail: "Check microphone access, then try again.",
    tone: "bad",
  },
});

/**
 * Resolve the presentation block for a mode. Falls back to idle so callers
 * never receive undefined.
 *
 * @param {string} mode - One of VoiceMode.
 * @returns {{label: string, title: string, detail: string, tone: string}}
 */
export function voicePresentation(mode) {
  return PRESENTATIONS[mode] ?? PRESENTATIONS.idle;
}

/**
 * Acoustic "energy" target for the orb, in [0, 1]. Weights the input and
 * output levels based on the active mode so the orb visibly breathes with
 * the conversation envelope rather than mirroring raw signal levels.
 *
 * @param {number} input - Speech probability in [0, 1].
 * @param {number} output - Output RMS in [0, 1].
 * @param {string} mode - One of VoiceMode.
 * @returns {number} Clamp01 energy target.
 */
export function signalEnergy(input, output, mode) {
  const inputWeight =
    mode === VoiceMode.LISTENING
      ? 0.92
      : mode === VoiceMode.YIELDING
        ? 0.94
        : mode === VoiceMode.INTERRUPTED
          ? 0.86
          : 0.58;
  const outputWeight = mode === VoiceMode.SPEAKING ? 1 : 0.72;
  return clamp01(Math.max(input * inputWeight, output * outputWeight));
}

/**
 * Bounded exponential backoff for reconnect attempts. The first retry is
 * immediate (350ms) so a transient frame drop feels seamless; later retries
 * back off exponentially up to a 5s cap. This is unit-tested and must not
 * change shape without updating the test.
 *
 * @param {number} attempt - Zero-indexed reconnect attempt.
 * @returns {number} Delay in milliseconds.
 */
export function reconnectDelay(attempt) {
  return Math.min(5000, 350 * 2 ** Math.max(0, attempt));
}

/**
 * The set of modes that count as "the user is talking" for the purpose of
 * UI affordances like the live transcript or the barge-in ripple.
 */
export const INPUT_MODES = Object.freeze(
  new Set([VoiceMode.LISTENING, VoiceMode.YIELDING, VoiceMode.INTERRUPTED]),
);

/**
 * The set of modes that count as "Openlive is talking" for the purpose of
 * UI affordances like the barge-in ripple trigger.
 */
export const OUTPUT_MODES = Object.freeze(
  new Set([VoiceMode.SPEAKING, VoiceMode.THINKING]),
);

/**
 * Single source of truth for clamp-to-[0,1]. Mirrored from audio-utils.js
 * intentionally for module independence; both copies are tested.
 *
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

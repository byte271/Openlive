/**
 * Openlive 26.7.15 — visual-state.js
 *
 * Central registry of voice surface modes, their presentation copy, their
 * acoustic energy weights, and helpers used by both the UI layer and the
 * voice visualizer. Keeping this in one place means the orb, the copy block,
 * the diagnostics drawer, and the keyboard layer all agree on what each mode
 * means.
 *
 * Copy is deliberately short and human so mode swaps feel continuous rather
 * than like status-bar telemetry. All modes are data-driven; nothing here
 * touches the DOM directly.
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
    title: "OpenLive",
    detail: "Tap the mic or press Space to start.",
    tone: "neutral",
  },
  starting: {
    label: "Connecting…",
    title: "Opening channel",
    detail: "Opening the voice channel.",
    tone: "neutral",
  },
  listening: {
    label: "Listening",
    title: "Your turn",
    detail: "I'm listening — jump in anytime.",
    tone: "input",
  },
  thinking: {
    label: "Looking it up",
    title: "One moment",
    detail: "Checking that for you — keep talking if you want.",
    tone: "neutral",
  },
  speaking: {
    label: "Speaking",
    title: "Responding",
    detail: "Talk over me anytime — I'll stop.",
    tone: "output",
  },
  yielding: {
    label: "Yielding",
    title: "All yours",
    detail: "You go — I'm listening.",
    tone: "input",
  },
  interrupted: {
    label: "Listening",
    title: "Go ahead",
    detail: "Interrupted — I'm with you.",
    tone: "input",
  },
  muted: {
    label: "Muted",
    title: "Mic paused",
    detail: "Unmute when you're ready.",
    tone: "neutral",
  },
  reconnecting: {
    label: "Reconnecting…",
    title: "Rejoining",
    detail: "Holding the mic open while we rejoin.",
    tone: "warn",
  },
  connection_error: {
    label: "Disconnected",
    title: "Connection lost",
    detail: "Start again when you're ready.",
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

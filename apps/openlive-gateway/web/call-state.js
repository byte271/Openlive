/**
 * Map OpenLive voice modes onto bloub engine states.
 *
 * Warming / listening → idle (gaze drift + blink)
 * Speaking → orbit
 * Interrupted / barge-in → burst, then back to listening
 * Muted → idle (renderer dims the face)
 */

import { VoiceMode } from "./visual-state.js";

const MAP = Object.freeze({
  [VoiceMode.IDLE]: "idle",
  [VoiceMode.STARTING]: "idle",
  [VoiceMode.LISTENING]: "idle",
  [VoiceMode.THINKING]: "thinking",
  [VoiceMode.SPEAKING]: "orbit",
  [VoiceMode.YIELDING]: "wink",
  [VoiceMode.INTERRUPTED]: "burst",
  [VoiceMode.MUTED]: "idle",
  [VoiceMode.RECONNECTING]: "swirl",
  [VoiceMode.CONNECTION_ERROR]: "idle",
  [VoiceMode.ERROR]: "idle",
});

/**
 * @param {string} mode
 * @returns {string}
 */
export function bloubStateFor(mode) {
  return MAP[mode] || "idle";
}

/**
 * @param {string} mode
 * @returns {boolean}
 */
export function bloubShouldDim(mode) {
  return mode === VoiceMode.MUTED;
}

/**
 * GPT-Live entry policy: the default surface is an active call.
 *
 * Browsers often refuse getUserMedia until a user gesture. Auto-join
 * should then fail quietly and wait for a tap — not show a setup wizard
 * or a lab error dump.
 */

/**
 * @param {{ conversationActive?: boolean, joining?: boolean, setupOpen?: boolean }} state
 * @returns {boolean}
 */
export function shouldAutoJoinCall(state = {}) {
  if (state.conversationActive || state.joining || state.setupOpen) return false;
  return true;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isGestureGatedMicError(error) {
  const name = error && typeof error === "object" ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError" || name === "NotFoundError";
}

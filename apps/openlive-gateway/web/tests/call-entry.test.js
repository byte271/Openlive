import assert from "node:assert/strict";
import test from "node:test";

import { isGestureGatedMicError, shouldAutoJoinCall } from "../call-entry.js";

test("auto-join is the default when idle", () => {
  assert.equal(shouldAutoJoinCall({}), true);
  assert.equal(shouldAutoJoinCall({ conversationActive: false, joining: false }), true);
});

test("auto-join does not stack on an active or joining call", () => {
  assert.equal(shouldAutoJoinCall({ conversationActive: true }), false);
  assert.equal(shouldAutoJoinCall({ joining: true }), false);
  assert.equal(shouldAutoJoinCall({ setupOpen: true }), false);
});

test("mic permission and missing-device errors wait for a tap", () => {
  assert.equal(isGestureGatedMicError({ name: "NotAllowedError" }), true);
  assert.equal(isGestureGatedMicError({ name: "SecurityError" }), true);
  assert.equal(isGestureGatedMicError({ name: "NotFoundError" }), true);
  assert.equal(isGestureGatedMicError({ name: "NotReadableError" }), false);
  assert.equal(isGestureGatedMicError(null), false);
});

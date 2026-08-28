import assert from "node:assert/strict";
import test from "node:test";

import { bloubShouldDim, bloubStateFor } from "../call-state.js";
import { VoiceMode } from "../visual-state.js";
import { BARGE_IN_CHAIN } from "../audio-session.js";

test("listening and warming map to idle bloub gaze", () => {
  assert.equal(bloubStateFor(VoiceMode.IDLE), "idle");
  assert.equal(bloubStateFor(VoiceMode.STARTING), "idle");
  assert.equal(bloubStateFor(VoiceMode.LISTENING), "idle");
});

test("speaking and barge-in have distinct expressions", () => {
  assert.equal(bloubStateFor(VoiceMode.SPEAKING), "orbit");
  assert.equal(bloubStateFor(VoiceMode.INTERRUPTED), "burst");
  assert.equal(bloubStateFor(VoiceMode.YIELDING), "wink");
  assert.equal(bloubStateFor(VoiceMode.THINKING), "thinking");
  assert.equal(bloubStateFor(VoiceMode.RECONNECTING), "swirl");
});

test("muted dims the face without leaving idle", () => {
  assert.equal(bloubStateFor(VoiceMode.MUTED), "idle");
  assert.equal(bloubShouldDim(VoiceMode.MUTED), true);
  assert.equal(bloubShouldDim(VoiceMode.LISTENING), false);
});

test("barge-in ducks locally before server yield", () => {
  assert.deepEqual(BARGE_IN_CHAIN, [
    "local_duck",
    "soft_duck",
    "hard_yield",
    "cancel",
  ]);
});

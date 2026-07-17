/**
 * OpenLive 26.7.16 — keyboard-shortcuts.js tests
 */

import assert from "node:assert/strict";
import test from "node:test";

import { installShortcuts } from "../keyboard-shortcuts.js";

/**
 * Minimal KeyboardEvent mock so tests can run in Node without a DOM.
 */
class FakeKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.code = init.code ?? "";
    this.key = init.key ?? "";
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    this.defaultPrevented = false;
    this.repeat = init.repeat ?? false;
    this.metaKey = init.metaKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.altKey = init.altKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.target = init.target ?? null;
    this.isContentEditable = init.isContentEditable ?? false;
    this.tagName = init.tagName ?? "";
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

function withWindow(run) {
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((entry) => entry !== handler),
      );
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) ?? []) {
        handler(event);
      }
      return true;
    },
  };

  try {
    return run();
  } finally {
    delete globalThis.window;
  }
}

function dispatchKey(type, code, extra = {}) {
  // Derive a realistic .key from .code so future tests for letter keys (M, T, etc.) work.
  let key = code;
  if (code === "Space") key = " ";
  else if (code.startsWith("Key")) key = code[3].toLowerCase();
  else if (code.startsWith("Digit")) key = code[5];
  const event = new FakeKeyboardEvent(type, {
    code,
    key,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  window.dispatchEvent(event);
  return event;
}

test("Space starts a conversation when idle", () => {
  withWindow(() => {
    let started = 0;
    const dispose = installShortcuts({
      isConversationActive: () => false,
      onStartConversation: () => {
        started += 1;
      },
    });

    const event = dispatchKey("keydown", "Space");
    assert.equal(started, 1);
    assert.equal(event.defaultPrevented, true);

    dispose();
  });
});

test("Space toggles mute when a conversation is active in auto mode", () => {
  withWindow(() => {
    let muted = 0;
    const dispose = installShortcuts({
      isConversationActive: () => true,
      isPTTMode: () => false,
      toggleMute: () => {
        muted += 1;
      },
    });

    dispatchKey("keydown", "Space");
    assert.equal(muted, 1);

    dispose();
  });
});

test("Space is ignored while setup blocks interaction", () => {
  withWindow(() => {
    let started = 0;
    const dispose = installShortcuts({
      isBlocked: () => true,
      isConversationActive: () => false,
      onStartConversation: () => {
        started += 1;
      },
    });

    dispatchKey("keydown", "Space");
    assert.equal(started, 0);

    dispose();
  });
});

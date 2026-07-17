/**
 * Openlive 26.7.16 — keyboard-shortcuts.js
 *
 * Centralized keyboard shortcut handler. Attaches a single keydown listener
 * and dispatches to a registry of named actions. Shortcuts are:
 *
 *   Space       Start a conversation when idle. During an active session:
 *                hold for push-to-talk (when PTT mode is enabled), otherwise
 *                toggle mute.
 *   M           Toggle microphone mute (in conversation).
 *   T           Toggle the transcript drawer.
 *   D           Toggle the diagnostics drawer.
 *   S           Toggle the settings sheet.
 *   I           Toggle the custom instructions inline panel.
 *   V           Open the voice picker.
 *   N           Cycle to the next conversation mode.
 *   L           Toggle between focused and inline layout.
 *   F           Toggle full-screen mode.
 *   C           Toggle camera input (v1.3: UI affordance).
 *   Shift+C     Toggle screen share (v1.3: UI affordance).
 *   Esc         End conversation, or close any open sheet/drawer first.
 *   ?           Show the onboarding overlay (cheat sheet).
 *
 * Shortcuts are ignored when focus is in a text input, select, or textarea
 * so the user can interact with form fields normally. They are also
 * ignored when the active element is contenteditable.
 *
 * The handler returns a disposer so app.js can tear it down on hot-reload
 * (not strictly necessary for production, but keeps the test harness clean).
 */

/**
 * @typedef {Object} ShortcutActions
 * @property {() => void} [onPTTStart]
 * @property {() => void} [onPTTEnd]
 * @property {() => void} [toggleMute]
 * @property {() => void} [toggleTranscript]
 * @property {() => void} [toggleDiagnostics]
 * @property {() => void} [toggleSettings]
 * @property {() => void} [toggleInstructions]
 * @property {() => void} [toggleLayout]
 * @property {() => void} [toggleFullscreen]
 * @property {() => void} [toggleCamera]
 * @property {() => void} [toggleScreenShare]
 * @property {() => void} [openVoicePicker]
 * @property {() => void} [cycleMode]
 * @property {() => void} [endConversation]
 * @property {() => void} [closeOverlays]
 * @property {() => void} [showOnboarding]
 * @property {() => void} [onStartConversation]
 * @property {() => boolean} [isBlocked] - Returns true when shortcuts should not start/talk.
 * @property {() => boolean} [isPTTMode] - Returns true when PTT entry mode is active.
 * @property {() => boolean} [isConversationActive]
 */

/**
 * Install the keyboard shortcut handler.
 *
 * @param {ShortcutActions} actions
 * @returns {() => void} Disposer that removes the listener.
 */
export function installShortcuts(actions) {
  const onKeyDown = (event) => {
    if (shouldIgnore(event)) return;

    // Space is special: start when idle; in PTT mode hold-to-talk; otherwise mute.
    if (event.code === "Space") {
      if (event.repeat) return;
      if (actions.isBlocked?.()) return;

      const active = actions.isConversationActive?.() ?? false;
      if (!active) {
        event.preventDefault();
        actions.onStartConversation?.();
        return;
      }

      const isPTT = actions.isPTTMode?.() ?? false;
      if (isPTT) {
        event.preventDefault();
        actions.onPTTStart?.();
        return;
      }

      event.preventDefault();
      actions.toggleMute?.();
      return;
    }

    // Esc closes overlays first, then ends the conversation.
    if (event.key === "Escape") {
      actions.closeOverlays?.();
      // The end-conversation Esc is handled when there are no overlays open.
      // We let app.js decide by exposing both actions; closeOverlays returns
      // a boolean indicating whether anything was open.
      return;
    }

    // Single-character shortcuts: ignore if a modifier is held (except Shift for combos).
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // Shift+C → screen share (separate from plain C → camera).
    if (event.shiftKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      actions.toggleScreenShare?.();
      return;
    }
    if (event.shiftKey) return; // Other Shift+key combos not bound.

    switch (event.key.toLowerCase()) {
      case "m":
        if (actions.isConversationActive?.()) {
          event.preventDefault();
          actions.toggleMute?.();
        }
        break;
      case "t":
        event.preventDefault();
        actions.toggleTranscript?.();
        break;
      case "d":
        event.preventDefault();
        actions.toggleDiagnostics?.();
        break;
      case "s":
        event.preventDefault();
        actions.toggleSettings?.();
        break;
      case "i":
        event.preventDefault();
        actions.toggleInstructions?.();
        break;
      case "v":
        event.preventDefault();
        actions.openVoicePicker?.();
        break;
      case "n":
        event.preventDefault();
        actions.cycleMode?.();
        break;
      case "l":
        event.preventDefault();
        actions.toggleLayout?.();
        break;
      case "f":
        event.preventDefault();
        actions.toggleFullscreen?.();
        break;
      case "c":
        event.preventDefault();
        actions.toggleCamera?.();
        break;
      case "?":
        event.preventDefault();
        actions.showOnboarding?.();
        break;
      default:
        break;
    }
  };

  const onKeyUp = (event) => {
    if (shouldIgnore(event)) return;
    if (event.code === "Space") {
      if (actions.isPTTMode?.() && actions.isConversationActive?.()) {
        actions.onPTTEnd?.();
      }
    }
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}

/**
 * Whether the event should be ignored entirely (focus in a form field,
 * modifier held for a non-shortcut combo, etc.).
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function shouldIgnore(event) {
  const target = event.target;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Openlive 26.7.15 — ui.js
 *
 * DOM binding layer. Resolves elements once, exposes mutation helpers, and
 * keeps the rest of the codebase free of `document.querySelector` calls.
 *
 * The module is split into four responsibilities:
 *   1. Element registry (`elements`, `controls`).
 *   2. Core voice-surface mutators (mode, copy, signals, dock state).
 *   3. Sheet & drawer open/close helpers.
 *   4. Transcript, voice picker, mode picker, latency pill, telemetry,
 *      and onboarding renderers.
 *
 * All mutators are defensive: missing elements log a warning and bail
 * rather than throwing. This keeps the UI resilient to partial HTML
 * loads (e.g. while the gateway is hot-reloading the web dir).
 */

import { AXES } from "./custom-instructions.js";
import { glyphForKind } from "./visual-cards.js";
import { voicePresentation, VoiceMode } from "./visual-state.js";

/* ---------------------------------------------------------------------------
   1. Element registry
   --------------------------------------------------------------------------- */

const query = (selector) => document.querySelector(selector);

const elements = {
  brand: query("#brand"),
  primary: query("#primary"),
  primaryLabel: query("#primaryLabel"),
  end: query("#end"),
  settings: query("#settings"),
  settingsPanel: query("#settingsPanel"),
  closeSettings: query("#closeSettings"),
  backchannels: query("#backchannels"),
  entryMode: query("#entryMode"),
  sessionCap: query("#sessionCap"),
  speedOverride: query("#speedOverride"),
  detailOverride: query("#detailOverride"),
  complexityOverride: query("#complexityOverride"),
  toneOverride: query("#toneOverride"),
  themeSelect: query("#themeSelect"),
  motionRange: query("#motionRange"),
  motionValue: query("#motionValue"),
  latencyToggle: query("#latencyToggle"),
  debug: query("#debug"),
  closeDebug: query("#closeDebug"),
  diagnostics: query("#diagnostics"),
  connection: query("#connection"),
  stateLabel: query("#stateLabel"),
  stateTitle: query("#stateTitle"),
  stateDetail: query("#stateDetail"),
  notice: query("#notice"),
  speechProbability: query("#speechProbability"),
  echoProbability: query("#echoProbability"),
  interactionState: query("#interactionState"),
  outputGain: query("#outputGain"),
  playbackBuffer: query("#playbackBuffer"),
  connectionQuality: query("#connectionQuality"),
  latencyP50: query("#latencyP50"),
  latencyP95: query("#latencyP95"),
  assistantText: query("#assistantText"),
  providerHint: query("#providerHint"),
  timeline: query("#timeline"),
  voiceOrb: query("#voiceOrb"),
  orbShell: query("#orbShell"),
  orbRing: query(".orb-ring"),
  backchannelBadge: query("#backchannelBadge"),
  transcriptToggle: query("#transcriptToggle"),
  transcriptDrawer: query("#transcriptDrawer"),
  transcriptLog: query("#transcriptLog"),
  transcriptStatus: query("#transcriptStatus"),
  transcriptClear: query("#transcriptClear"),
  transcriptExport: query("#transcriptExport"),
  transcriptClose: query("#transcriptClose"),
  voice: query("#voice"),
  voiceBadge: query("#voiceBadge"),
  voicePanel: query("#voicePanel"),
  voiceList: query("#voiceList"),
  closeVoice: query("#closeVoice"),
  mode: query("#mode"),
  modeBadge: query("#modeBadge"),
  modePanel: query("#modePanel"),
  modeList: query("#modeList"),
  closeMode: query("#closeMode"),
  instructions: query("#instructions"),
  instructionsBadge: query("#instructionsBadge"),
  instructionsPanel: query("#instructionsPanel"),
  closeInstructions: query("#closeInstructions"),
  resetInstructions: query("#resetInstructions"),
  camera: query("#camera"),
  screenShare: query("#screenShare"),
  layoutToggle: query("#layoutToggle"),
  latencyPill: query("#latencyPill"),
  latencyValue: query("#latencyValue"),
  quotaPill: query("#quotaPill"),
  quotaValue: query("#quotaValue"),
  onboarding: query("#onboarding"),
  onboardingDismiss: query("#onboardingDismiss"),
  onboardingStart: query("#onboardingStart"),
  setupWizard: query("#setupWizard"),
  setupDisplayName: query("#setupDisplayName"),
  setupVoice: query("#setupVoice"),
  setupStripFillers: query("#setupStripFillers"),
  setupBackchannels: query("#setupBackchannels"),
  setupModelUrl: query("#setupModelUrl"),
  setupModelKey: query("#setupModelKey"),
  setupLlmModel: query("#setupLlmModel"),
  setupLlmProvider: query("#setupLlmProvider"),
  setupLlmModelSelect: query("#setupLlmModelSelect"),
  setupFetchModels: query("#setupFetchModels"),
  setupProviderHint: query("#setupProviderHint"),
  setupAgentKind: query("#setupAgentKind"),
  setupAutoDelegate: query("#setupAutoDelegate"),
  setupProbeAgent: query("#setupProbeAgent"),
  setupProbeStatus: query("#setupProbeStatus"),
  setupBack: query("#setupBack"),
  setupNext: query("#setupNext"),
  agentToast: query("#agentToast"),
  composerInput: query("#composerInput"),
  taskAdd: query("#taskAdd"),
  settingsModelUrl: query("#settingsModelUrl"),
  settingsModelKey: query("#settingsModelKey"),
  settingsLlmProvider: query("#settingsLlmProvider"),
  settingsLlmModel: query("#settingsLlmModel"),
  settingsLlmModelSelect: query("#settingsLlmModelSelect"),
  settingsFetchModels: query("#settingsFetchModels"),
  settingsAgentKind: query("#settingsAgentKind"),
  settingsVoice: query("#settingsVoice"),
  settingsSystemVoice: query("#settingsSystemVoice"),
  settingsVoiceStatus: query("#settingsVoiceStatus"),
  settingsRefreshVoices: query("#settingsRefreshVoices"),
  settingsInstallPiper: query("#settingsInstallPiper"),
  settingsExportMemory: query("#settingsExportMemory"),
  settingsClearMemory: query("#settingsClearMemory"),
  settingsExportProfile: query("#settingsExportProfile"),
  settingsClearProfile: query("#settingsClearProfile"),
  settingsRefreshProfile: query("#settingsRefreshProfile"),
  settingsSaveProfile: query("#settingsSaveProfile"),
  settingsClearFacts: query("#settingsClearFacts"),
  settingsProfileStatus: query("#settingsProfileStatus"),
  settingsProfileName: query("#settingsProfileName"),
  settingsProfileTimezone: query("#settingsProfileTimezone"),
  settingsProfileNotes: query("#settingsProfileNotes"),
  settingsProfileFact: query("#settingsProfileFact"),
  settingsProfileFactList: query("#settingsProfileFactList"),
  settingsTtsEngine: query("#settingsTtsEngine"),
  settingsThoughtDepth: query("#settingsThoughtDepth"),
  settingsAgentClass: query("#settingsAgentClass"),
  settingsPiperStatus: query("#settingsPiperStatus"),
  settingsBrowserTts: query("#settingsBrowserTts"),
  settingsPreviewVoice: query("#settingsPreviewVoice"),
  settingsProbeAgent: query("#settingsProbeAgent"),
  settingsProbeStatus: query("#settingsProbeStatus"),
  settingsSandboxStatus: query("#settingsSandboxStatus"),
  settingsSandboxRefresh: query("#settingsSandboxRefresh"),
  settingsSandboxList: query("#settingsSandboxList"),
  settingsSandboxSelfTest: query("#settingsSandboxSelfTest"),
  settingsDeepDemo: query("#settingsDeepDemo"),
  settingsShotDemo: query("#settingsShotDemo"),
  settingsMediaGallery: query("#settingsMediaGallery"),
  settingsSandboxTestStatus: query("#settingsSandboxTestStatus"),
  reopenSetup: query("#reopenSetup"),
};

export const controls = {
  brand: elements.brand,
  primary: elements.primary,
  end: elements.end,
  settings: elements.settings,
  closeSettings: elements.closeSettings,
  backchannels: elements.backchannels,
  entryMode: elements.entryMode,
  sessionCap: elements.sessionCap,
  speedOverride: elements.speedOverride,
  detailOverride: elements.detailOverride,
  complexityOverride: elements.complexityOverride,
  toneOverride: elements.toneOverride,
  themeSelect: elements.themeSelect,
  motionRange: elements.motionRange,
  latencyToggle: elements.latencyToggle,
  voice: elements.voice,
  mode: elements.mode,
  instructions: elements.instructions,
  closeInstructions: elements.closeInstructions,
  resetInstructions: elements.resetInstructions,
  camera: elements.camera,
  screenShare: elements.screenShare,
  layoutToggle: elements.layoutToggle,
  debug: elements.debug,
  closeDebug: elements.closeDebug,
  transcriptToggle: elements.transcriptToggle,
  transcriptClear: elements.transcriptClear,
  transcriptExport: elements.transcriptExport,
  transcriptClose: elements.transcriptClose,
  closeVoice: elements.closeVoice,
  closeMode: elements.closeMode,
  voiceOrb: elements.voiceOrb,
  onboardingDismiss: elements.onboardingDismiss,
  onboardingStart: elements.onboardingStart,
  setupWizard: elements.setupWizard,
  setupDisplayName: elements.setupDisplayName,
  setupVoice: elements.setupVoice,
  setupStripFillers: elements.setupStripFillers,
  setupBackchannels: elements.setupBackchannels,
  setupModelUrl: elements.setupModelUrl,
  setupModelKey: elements.setupModelKey,
  setupLlmModel: elements.setupLlmModel,
  setupLlmProvider: elements.setupLlmProvider,
  setupLlmModelSelect: elements.setupLlmModelSelect,
  setupFetchModels: elements.setupFetchModels,
  setupProviderHint: elements.setupProviderHint,
  setupAgentKind: elements.setupAgentKind,
  setupAutoDelegate: elements.setupAutoDelegate,
  setupProbeAgent: elements.setupProbeAgent,
  setupProbeStatus: elements.setupProbeStatus,
  setupBack: elements.setupBack,
  setupNext: elements.setupNext,
  agentToast: elements.agentToast,
  composerInput: elements.composerInput,
  taskAdd: elements.taskAdd,
  settingsModelUrl: elements.settingsModelUrl,
  settingsModelKey: elements.settingsModelKey,
  settingsLlmProvider: elements.settingsLlmProvider,
  settingsLlmModel: elements.settingsLlmModel,
  settingsLlmModelSelect: elements.settingsLlmModelSelect,
  settingsFetchModels: elements.settingsFetchModels,
  settingsAgentKind: elements.settingsAgentKind,
  settingsVoice: elements.settingsVoice,
  settingsSystemVoice: elements.settingsSystemVoice,
  settingsVoiceStatus: elements.settingsVoiceStatus,
  settingsRefreshVoices: elements.settingsRefreshVoices,
  settingsInstallPiper: elements.settingsInstallPiper,
  settingsExportMemory: elements.settingsExportMemory,
  settingsClearMemory: elements.settingsClearMemory,
  settingsExportProfile: elements.settingsExportProfile,
  settingsClearProfile: elements.settingsClearProfile,
  settingsRefreshProfile: elements.settingsRefreshProfile,
  settingsSaveProfile: elements.settingsSaveProfile,
  settingsClearFacts: elements.settingsClearFacts,
  settingsProfileStatus: elements.settingsProfileStatus,
  settingsProfileName: elements.settingsProfileName,
  settingsProfileTimezone: elements.settingsProfileTimezone,
  settingsProfileNotes: elements.settingsProfileNotes,
  settingsProfileFact: elements.settingsProfileFact,
  settingsProfileFactList: elements.settingsProfileFactList,
  settingsTtsEngine: elements.settingsTtsEngine,
  settingsThoughtDepth: elements.settingsThoughtDepth,
  settingsAgentClass: elements.settingsAgentClass,
  settingsPiperStatus: elements.settingsPiperStatus,
  settingsBrowserTts: elements.settingsBrowserTts,
  settingsPreviewVoice: elements.settingsPreviewVoice,
  settingsProbeAgent: elements.settingsProbeAgent,
  settingsProbeStatus: elements.settingsProbeStatus,
  settingsSandboxStatus: elements.settingsSandboxStatus,
  settingsSandboxRefresh: elements.settingsSandboxRefresh,
  settingsSandboxList: elements.settingsSandboxList,
  settingsSandboxSelfTest: elements.settingsSandboxSelfTest,
  settingsDeepDemo: elements.settingsDeepDemo,
  settingsShotDemo: elements.settingsShotDemo,
  settingsMediaGallery: elements.settingsMediaGallery,
  settingsSandboxTestStatus: elements.settingsSandboxTestStatus,
  reopenSetup: elements.reopenSetup,
};

/* ---------------------------------------------------------------------------
   2. Core voice-surface mutators
   --------------------------------------------------------------------------- */

/**
 * Apply a voice mode: set body[data-mode], update copy, update diagnostics.
 *
 * @param {string} mode - One of VoiceMode.
 * @param {string} [detail] - Optional override for the detail line.
 */
export function setVoiceMode(mode, detail) {
  const presentation = voicePresentation(mode);
  const prevMode = document.body.dataset.mode;
  document.body.dataset.mode = mode;

  const copyRoot =
    elements.stateLabel?.closest(".voice-copy") ||
    document.querySelector(".voice-copy");
  const nextLabel = presentation.label;
  const nextDetail = detail ?? presentation.detail;
  const labelChanged =
    elements.stateLabel && elements.stateLabel.textContent !== nextLabel;
  const detailChanged =
    elements.stateDetail && elements.stateDetail.textContent !== nextDetail;

  // Brief crossfade when floor copy changes so transitions feel continuous.
  if (copyRoot && prevMode !== mode && (labelChanged || detailChanged)) {
    copyRoot.classList.add("is-swapping");
    clearTimeout(setVoiceMode._swapTimer);
    setVoiceMode._swapTimer = setTimeout(() => {
      setText(elements.stateLabel, nextLabel);
      setText(elements.stateTitle, presentation.title);
      setText(elements.stateDetail, nextDetail);
      copyRoot.classList.remove("is-swapping");
    }, 90);
  } else {
    setText(elements.stateLabel, nextLabel);
    setText(elements.stateTitle, presentation.title);
    setText(elements.stateDetail, nextDetail);
  }
  setText(elements.interactionState, mode);

  const floorLabel = document.querySelector("#floorLabel");
  const floorLabels = {
    idle: "Floor open",
    starting: "Opening session",
    listening: "You have the floor",
    thinking: "Reasoning",
    speaking: "OpenLive has the floor",
    yielding: "Yielding",
    interrupted: "Floor returned",
    muted: "Microphone paused",
    reconnecting: "Restoring floor",
    connection_error: "Transport unavailable",
    error: "Attention needed",
  };
  setText(floorLabel, floorLabels[mode] ?? mode);
  const activeTrace = ["speaking"].includes(mode) ? 2 : ["thinking", "starting"].includes(mode) ? 1 : 0;
  document.querySelectorAll(".trace-step").forEach((step, index) => {
    step.classList.toggle("active", index === activeTrace);
  });
}

/**
 * Update the primary dock button to reflect conversation + microphone state.
 * Three shapes:
 *   - Inactive: "Start", full-width pill with mic icon.
 *   - Active + mic on (auto VAD): collapsed circle, mic icon only.
 *   - Active + mic off: "Resume", full-width pill.
 *   - PTT mode + active: shows PTT icon and label "Hold".
 *
 * @param {boolean} active - Whether a conversation is in progress.
 * @param {boolean} [microphoneActive] - Whether the mic is currently captured.
 * @param {boolean} [pttMode] - Whether push-to-talk entry mode is active.
 */
export function setConversationActive(active, microphoneActive = active, pttMode = false) {
  if (!elements.primary) return;
  elements.primary.disabled = false;
  elements.primary.classList.toggle("listening", active && microphoneActive);
  elements.primary.classList.toggle("muted", active && !microphoneActive);
  elements.primary.classList.toggle("ptt-mode", pttMode);
  // Composer mic mirrors dock state for minimal UI.
  elements.primary.classList.toggle("composer-live", active);
  if (!active) {
    setText(elements.primaryLabel, "Start");
    elements.primary.setAttribute("aria-label", "Start conversation");
  } else if (pttMode) {
    setText(elements.primaryLabel, microphoneActive ? "Release" : "Hold");
    elements.primary.setAttribute(
      "aria-label",
      microphoneActive ? "Release to send" : "Hold to talk",
    );
  } else if (microphoneActive) {
    setText(elements.primaryLabel, "Mute");
    elements.primary.setAttribute("aria-label", "Pause microphone");
  } else {
    setText(elements.primaryLabel, "Resume");
    elements.primary.setAttribute("aria-label", "Resume microphone");
  }
  if (elements.end) {
    elements.end.hidden = !active;
    // Force reflow so end-button entrance animation restarts cleanly.
    if (active) {
      void elements.end.offsetWidth;
    }
  }
  const composer = document.querySelector(".composer-bar");
  composer?.classList.toggle("is-live", active);
  composer?.classList.toggle("is-muted", active && !microphoneActive);
  const sessionHeadline = document.querySelector("#sessionHeadline");
  setText(
    sessionHeadline,
    !active
      ? "Ready for a live session"
      : microphoneActive
        ? "Conversation active · microphone live"
        : "Conversation active · microphone paused",
  );
}

/**
 * Disable the primary button and relabel it while a long-running start
 * sequence is in flight.
 *
 * @param {boolean} starting
 */
export function setStarting(starting) {
  if (!elements.primary) return;
  elements.primary.disabled = starting;
  setText(elements.primaryLabel, starting ? "Starting…" : "Start");
}

/**
 * Update the connection dot. Accepts "disconnected" | "connecting" |
 * "connected" | "reconnecting" | "error".
 *
 * @param {"disconnected" | "connecting" | "connected" | "reconnecting" | "error"} state
 */
export function setConnectionState(state) {
  if (!elements.connection) return;
  const labelMap = {
    disconnected: "Disconnected",
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Reconnecting",
    error: "Connection error",
  };
  elements.connection.className = `connection-dot ${state}`;
  elements.connection.setAttribute("aria-label", labelMap[state] ?? state);
  const transport = document.querySelector("#transportLabel");
  const transportMap = {
    disconnected: "Transport idle",
    connecting: "Negotiating session",
    connected: "WebSocket PCM · live",
    reconnecting: "Resuming transport",
    error: "Transport failed",
  };
  setText(transport, transportMap[state] ?? state);
}

/**
 * Push live signal levels into the UI: speech, output, echo. All clamped
 * to [0, 1] and mirrored to CSS variables so the ambient layer and orb
 * glow can react.
 *
 * @param {number} speech
 * @param {number} output
 * @param {number} echo
 */
export function setSignalLevels(speech, output, echo) {
  const safeSpeech = clamp01(speech);
  const safeOutput = clamp01(output);
  document.documentElement.style.setProperty("--input-energy", String(safeSpeech));
  document.documentElement.style.setProperty("--output-energy", String(safeOutput));
  setText(elements.speechProbability, safeSpeech.toFixed(2));
  setText(elements.echoProbability, clamp01(echo).toFixed(2));
}

/**
 * @param {number} value - Output gain in [0, 1].
 */
export function setOutputGain(value) {
  setText(elements.outputGain, `${Math.round(value * 100)}%`);
}

/**
 * @param {number} queuedMs
 * @param {number} targetMs
 */
export function setPlaybackBuffer(queuedMs, targetMs) {
  setText(
    elements.playbackBuffer,
    `${queuedMs.toFixed(0)} / ${targetMs.toFixed(0)} ms`,
  );
}

/**
 * @param {string} value
 */
export function setAssistantText(value) {
  if (!elements.assistantText) return;
  const next = value ?? "";
  // Avoid DOM thrash when streaming identical content.
  if (elements.assistantText.textContent === next) return;
  elements.assistantText.textContent = next;
  elements.assistantText.dataset.hasText = next ? "true" : "false";
}

/**
 * @param {string} model
 * @param {string} providerClass
 */
export function setProviderHint(model, providerClass) {
  const labels = {
    mock: `${model} · offline runtime tone`,
    native_duplex: `${model} · native duplex speech`,
    cascade: `${model} · streaming speech cascade`,
  };
  setText(elements.providerHint, labels[providerClass] ?? `${model} · realtime provider`);
}

/**
 * @param {string} message
 */
export function showNotice(message) {
  if (!elements.notice) return;
  elements.notice.textContent = message ?? "";
  elements.notice.hidden = !message;
}

export function hideNotice() {
  showNotice("");
}

/**
 * Show or hide the first-run setup wizard overlay.
 * @param {boolean} open
 */
export function setSetupOpen(open) {
  if (!elements.setupWizard) return;
  elements.setupWizard.hidden = !open;
  elements.setupWizard.dataset.open = String(!!open);
  document.body.classList.toggle("setup-open", !!open);
}

/**
 * Brief toast for background agent progress / results.
 * @param {string} message
 * @param {{ tone?: "info"|"ok"|"err", holdMs?: number }} [opts]
 */
export function showAgentToast(message, opts = {}) {
  if (!elements.agentToast) return;
  const holdMs = opts.holdMs ?? 4200;
  elements.agentToast.textContent = message ?? "";
  elements.agentToast.hidden = !message;
  elements.agentToast.dataset.tone = opts.tone || "info";
  clearTimeout(showAgentToast._timer);
  if (message) {
    showAgentToast._timer = setTimeout(() => {
      if (elements.agentToast) elements.agentToast.hidden = true;
    }, holdMs);
  }
}

/**
 * Toggle the right-side agent / evidence rail (minimal UI).
 * @param {boolean} [force]
 */
export function setTaskRailVisible(force) {
  const next = force ?? !document.body.classList.contains("show-rail");
  document.body.classList.toggle("show-rail", next);
  return next;
}

/**
 * Fire the barge-in ripple on the orb shell. Used by app.js when the local
 * duck fires before a server round trip.
 */
export function fireBargeInRipple() {
  if (!elements.orbShell) return;
  const ring = elements.orbShell.querySelector(".orb-ring");
  if (!ring) return;
  ring.classList.remove("barge-in");
  // Force a reflow so the animation restarts cleanly on rapid calls.
  void ring.offsetWidth;
  ring.classList.add("barge-in");
}

/**
 * Flash the backchannel badge near the orb. AVM emits a small "mhmm" cue
 * when the model acknowledges the user mid-speech. Openlive surfaces the
 * same affordance when the provider emits a backchannel event.
 */
export function flashBackchannel(text = "mhmm") {
  if (!elements.backchannelBadge) return;
  elements.backchannelBadge.textContent = text;
  elements.backchannelBadge.classList.remove("flash");
  void elements.backchannelBadge.offsetWidth;
  elements.backchannelBadge.classList.add("flash");
}

/* ---------------------------------------------------------------------------
   3. Sheet & drawer open/close helpers
   --------------------------------------------------------------------------- */

/**
 * Toggle the settings sheet. Returns the new open state.
 *
 * @param {boolean} [force]
 * @returns {boolean}
 */
export function toggleSettings(force) {
  return toggleSheet(elements.settingsPanel, force);
}

/**
 * Toggle the voice picker sheet.
 *
 * @param {boolean} [force]
 * @returns {boolean}
 */
export function toggleVoicePicker(force) {
  return toggleSheet(elements.voicePanel, force);
}

/**
 * Toggle the mode picker sheet.
 *
 * @param {boolean} [force]
 * @returns {boolean}
 */
export function toggleModePicker(force) {
  return toggleSheet(elements.modePanel, force);
}

/**
 * Toggle the custom instructions inline sheet.
 *
 * @param {boolean} [force]
 * @returns {boolean}
 */
export function toggleInstructions(force) {
  return toggleSheet(elements.instructionsPanel, force);
}

/**
 * Toggle the diagnostics drawer.
 *
 * @param {boolean} [force]
 * @returns {boolean}
 */
export function toggleDiagnostics(force) {
  if (!elements.diagnostics) return false;
  const next =
    force ?? !elements.diagnostics.classList.contains("open");
  elements.diagnostics.classList.toggle("open", next);
  elements.diagnostics.setAttribute("aria-hidden", String(!next));
  return next;
}

/**
 * Toggle the transcript drawer.
 *
 * @param {boolean} [force]
 * @returns {boolean}
 */
export function toggleTranscript(force) {
  if (!elements.transcriptDrawer) return false;
  const next =
    force ?? elements.transcriptDrawer.dataset.open !== "true";
  elements.transcriptDrawer.dataset.open = String(next);
  if (elements.transcriptToggle) {
    elements.transcriptToggle.setAttribute("aria-pressed", String(next));
  }
  return next;
}

/**
 * Close every overlay. Returns true if any overlay was open.
 *
 * @returns {boolean}
 */
export function closeOverlays() {
  let wasOpen = false;
  if (elements.settingsPanel?.dataset.open === "true") {
    toggleSettings(false);
    wasOpen = true;
  }
  if (elements.instructionsPanel?.dataset.open === "true") {
    toggleInstructions(false);
    wasOpen = true;
  }
  if (elements.voicePanel?.dataset.open === "true") {
    toggleVoicePicker(false);
    wasOpen = true;
  }
  if (elements.modePanel?.dataset.open === "true") {
    toggleModePicker(false);
    wasOpen = true;
  }
  if (elements.diagnostics?.classList.contains("open")) {
    toggleDiagnostics(false);
    wasOpen = true;
  }
  if (elements.transcriptDrawer?.dataset.open === "true") {
    toggleTranscript(false);
    wasOpen = true;
  }
  return wasOpen;
}

/**
 * @param {HTMLElement | null} sheet
 * @param {boolean | undefined} force
 * @returns {boolean}
 */
function toggleSheet(sheet, force) {
  if (!sheet) return false;
  const next = force ?? sheet.dataset.open !== "true";
  sheet.dataset.open = String(next);
  sheet.hidden = false;
  return next;
}

/* ---------------------------------------------------------------------------
   4. Transcript, voice picker, mode picker, telemetry, onboarding
   --------------------------------------------------------------------------- */

/**
 * Render the full transcript log into the drawer. Called after every
 * append/finalize so the DOM stays in sync. Uses keyed reconciliation:
 * existing nodes are reused, new nodes are appended, dropped entries are
 * removed. This avoids the fl/flicker of a full rebuild.
 *
 * @param {import("./transcript-log.js").TranscriptEntry[]} entries
 */
export function renderTranscript(entries) {
  if (!elements.transcriptLog) return;
  const existing = new Map(
    [...elements.transcriptLog.children].map((node) => [
      node.dataset.entryId,
      node,
    ]),
  );
  const seen = new Set();

  for (const entry of entries) {
    seen.add(entry.id);
    let node = existing.get(entry.id);
    if (!node) {
      node = document.createElement("li");
      node.dataset.entryId = entry.id;
      node.dataset.role = entry.role;
      const role = document.createElement("span");
      role.className = "role";
      const bubble = document.createElement("span");
      bubble.className = "bubble";
      node.append(role, bubble);
      elements.transcriptLog.appendChild(node);
    }
    node.dataset.role = entry.role;
    node.dataset.pending = String(entry.pending);
    node.dataset.revision = String(entry.revision ?? 0);
    node.querySelector(".role").textContent =
      entry.role === "user" ? "You" : entry.role === "assistant" ? "Openlive" : "System";
    const bubble = node.querySelector(".bubble");
    if (bubble.textContent !== entry.text) {
      bubble.textContent = entry.text;
      if (entry.revised) {
        bubble.classList.remove("bubble-revise");
        // Force reflow so the animation restarts on successive revisions.
        void bubble.offsetWidth;
        bubble.classList.add("bubble-revise");
        entry.revised = false;
      }
    }
  }

  for (const [id, node] of existing) {
    if (!seen.has(id)) node.remove();
  }

  // Auto-scroll to the latest entry unless the user has scrolled up.
  const log = elements.transcriptLog;
  const nearBottom =
    log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  if (nearBottom) log.scrollTop = log.scrollHeight;

  if (elements.transcriptStatus) {
    if (entries.length === 0) {
      setText(elements.transcriptStatus, "No conversation yet");
    } else {
      const last = entries[entries.length - 1];
      const time = new Date(last.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      setText(elements.transcriptStatus, `Last activity ${time}`);
    }
  }
  if (elements.transcriptClear) {
    elements.transcriptClear.disabled = entries.length === 0;
  }
  if (elements.transcriptExport) {
    elements.transcriptExport.disabled = entries.length === 0;
  }
}

/**
 * @param {boolean} hasEntries
 */
export function setTranscriptEmpty(hasEntries) {
  if (elements.transcriptClear) {
    elements.transcriptClear.disabled = !hasEntries;
  }
}

/**
 * Render the voice picker list.
 *
 * @param {import("./voice-profiles.js").VoiceProfile[]} voices
 * @param {string | null} selectedId
 * @param {(voice: import("./voice-profiles.js").VoiceProfile) => void} onSelect
 */
export function renderVoiceList(voices, selectedId, onSelect) {
  if (!elements.voiceList) return;
  elements.voiceList.replaceChildren();
  for (const voice of voices) {
    const item = document.createElement("li");
    item.setAttribute("role", "option");
    item.dataset.voiceId = voice.id;
    if (voice.family) item.dataset.family = voice.family;
    item.setAttribute("aria-selected", String(voice.id === selectedId));
    const glyph = document.createElement("span");
    glyph.className = "voice-glyph";
    glyph.textContent = voice.glyph;
    const meta = document.createElement("span");
    const name = document.createElement("span");
    name.className = "voice-name";
    name.textContent = voice.name;
    const desc = document.createElement("span");
    desc.className = "voice-desc";
    desc.textContent = voice.description;
    meta.append(name, desc);
    item.append(glyph, meta);
    item.addEventListener("click", () => onSelect(voice));
    elements.voiceList.appendChild(item);
  }
}

/**
 * Update the voice badge in the dock.
 *
 * @param {string} label
 */
export function setVoiceBadge(label) {
  setText(elements.voiceBadge, label ?? "Auto");
}

/**
 * Render the mode picker list.
 *
 * @param {import("./conversation-modes.js").ConversationMode[]} modes
 * @param {string} selectedId
 * @param {(mode: import("./conversation-modes.js").ConversationMode) => void} onSelect
 */
export function renderModeList(modes, selectedId, onSelect) {
  if (!elements.modeList) return;
  elements.modeList.replaceChildren();
  for (const mode of modes) {
    const item = document.createElement("li");
    item.setAttribute("role", "option");
    item.dataset.modeId = mode.id;
    item.setAttribute("aria-selected", String(mode.id === selectedId));
    const glyph = document.createElement("span");
    glyph.className = "mode-glyph";
    glyph.textContent = mode.glyph;
    const meta = document.createElement("span");
    const name = document.createElement("span");
    name.className = "mode-name";
    name.textContent = mode.name;
    const desc = document.createElement("span");
    desc.className = "mode-desc";
    desc.textContent = mode.description;
    meta.append(name, desc);
    item.append(glyph, meta);
    item.addEventListener("click", () => onSelect(mode));
    elements.modeList.appendChild(item);
  }
}

/**
 * Update the mode badge in the dock.
 *
 * @param {string} label
 */
export function setModeBadge(label) {
  setText(elements.modeBadge, label ?? "Open");
}

/**
 * Update the quota pill in the topbar. Shows remaining session time in
 * mm:ss form. Hides the pill when remaining is Infinity (uncapped).
 *
 * @param {number} remainingSeconds - Infinity for uncapped sessions.
 * @param {"ok" | "warn" | "exhausted"} [bucket]
 */
export function setQuotaPill(remainingSeconds, bucket = "ok") {
  if (!elements.quotaPill) return;
  if (!Number.isFinite(remainingSeconds)) {
    elements.quotaPill.hidden = true;
    return;
  }
  elements.quotaPill.hidden = false;
  elements.quotaPill.dataset.bucket = bucket;
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  setText(
    elements.quotaValue,
    `${mins}:${String(secs).padStart(2, "0")}`,
  );
}

/**
 * Update the instructions-badge visibility in the dock. Shows the "!"
 * indicator when any custom-instruction axis is non-auto.
 *
 * @param {boolean} active
 */
export function setInstructionsBadge(active) {
  if (!elements.instructionsBadge) return;
  elements.instructionsBadge.hidden = !active;
}

/**
 * Render the custom-instructions axis options into the inline panel.
 *
 * @param {import("./custom-instructions.js").CustomInstructions} current
 * @param {(axis: string, value: string) => void} onChange
 */
export function renderInstructionsPanel(current, onChange) {
  if (!elements.instructionsPanel) return;
  const groups = elements.instructionsPanel.querySelectorAll(".axis-group");
  groups.forEach((group) => {
    const axis = group.dataset.axis;
    const container = group.querySelector(".axis-options");
    if (!container || !axis) return;
    container.replaceChildren();
    const options = AXES[axis]?.options ?? [];
    const currentValue = current[axis] ?? "auto";
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "axis-option";
      button.dataset.value = option.value;
      button.textContent = option.label;
      button.setAttribute("aria-pressed", String(option.value === currentValue));
      button.addEventListener("click", () => onChange(axis, option.value));
      container.appendChild(button);
    }
  });
}

/**
 * Render a tool-call card into the transcript log. Each call gets its own
 * keyed node so streaming updates don't rebuild the DOM.
 *
 * @param {import("./tool-calls.js").ToolCall} call
 * @param {import("./tool-calls.js").ToolDescriptor} descriptor
 */
export function renderToolCall(call, descriptor) {
  if (!elements.transcriptLog) return null;
  let node = elements.transcriptLog.querySelector(
    `li[data-tool-call-id="${call.id}"]`,
  );
  if (!node) {
    node = document.createElement("li");
    node.dataset.toolCallId = call.id;
    node.dataset.role = "assistant";
    node.classList.add("tool-call");
    const glyph = document.createElement("span");
    glyph.className = "tool-glyph";
    glyph.textContent = descriptor.glyph;
    const meta = document.createElement("div");
    meta.className = "tool-meta";
    const name = document.createElement("span");
    name.className = "tool-name";
    meta.appendChild(name);
    const args = document.createElement("pre");
    args.className = "tool-args";
    meta.appendChild(args);
    const status = document.createElement("span");
    status.className = "tool-status";
    meta.appendChild(status);
    const result = document.createElement("div");
    result.className = "tool-result";
    node.append(glyph, meta, result);
    elements.transcriptLog.appendChild(node);
  }
  node.querySelector(".tool-glyph").textContent = descriptor.glyph;
  node.querySelector(".tool-name").textContent = `${descriptor.name} · ${descriptor.description}`;
  node.querySelector(".tool-args").textContent = call.argumentsText || "(no arguments)";
  node.querySelector(".tool-status").textContent = call.status;
  node.querySelector(".tool-status").dataset.status = call.status;
  const resultEl = node.querySelector(".tool-result");
  resultEl.textContent = call.result ?? "";
  resultEl.hidden = !call.result;
  return node;
}

/**
 * Render a rich visual card into the transcript log.
 *
 * @param {import("./visual-cards.js").VisualCard} card
 */
export function renderVisualCard(card) {
  if (!elements.transcriptLog) return null;
  const existing = elements.transcriptLog.querySelector(
    `li[data-card-id="${card.id}"]`,
  );
  if (existing) return existing;
  const node = document.createElement("li");
  node.dataset.cardId = card.id;
  node.dataset.role = "assistant";
  node.classList.add("visual-card");
  const glyph = document.createElement("span");
  glyph.className = "card-glyph";
  glyph.textContent = glyphForKind(card.kind);
  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = card.title;
  body.appendChild(title);
  const fields = document.createElement("dl");
  fields.className = "card-fields";
  for (const [key, value] of Object.entries(card.fields)) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    fields.append(dt, dd);
  }
  body.appendChild(fields);
  if (card.attribution) {
    const attr = document.createElement("span");
    attr.className = "card-attribution";
    attr.textContent = `via ${card.attribution}`;
    body.appendChild(attr);
  }
  node.append(glyph, body);
  elements.transcriptLog.appendChild(node);
  return node;
}

/**
 * Toggle between focused (orb-centered) and inline (transcript-primary) layouts.
 *
 * @param {"focused" | "inline"} layout
 */
export function setLayout(layout) {
  document.body.dataset.layout = layout;
  if (elements.layoutToggle) {
    elements.layoutToggle.setAttribute("aria-pressed", String(layout === "inline"));
  }
}

/**
 * Show or hide the camera "coming soon" notice. v1.3 surfaces the UI
 * affordance; the actual camera stream requires the WebRTC transport
 * planned for v1.4.
 *
 * @param {boolean} active
 */
export function setCameraActive(active) {
  if (!elements.camera) return;
  elements.camera.classList.toggle("active", active);
  elements.camera.setAttribute("aria-pressed", String(active));
  elements.camera.setAttribute(
    "aria-label",
    active ? "Stop local camera preview" : "Start local camera preview",
  );
}

/**
 * Show or hide the screen-share "coming soon" notice.
 *
 * @param {boolean} active
 */
export function setScreenShareActive(active) {
  if (!elements.screenShare) return;
  elements.screenShare.classList.toggle("active", active);
  elements.screenShare.setAttribute("aria-pressed", String(active));
  elements.screenShare.setAttribute(
    "aria-label",
    active ? "Stop local screen preview" : "Start local screen preview",
  );
}

/**
 * Update the latency pill. Hides it when p50 is null or when the operator
 * has disabled it.
 *
 * @param {number | null} p50Ms
 * @param {"good" | "warn" | "bad" | "unknown"} quality
 * @param {boolean} visible
 */
export function setLatencyPill(p50Ms, quality, visible) {
  if (!elements.latencyPill) return;
  if (!visible || p50Ms === null) {
    elements.latencyPill.hidden = true;
    return;
  }
  elements.latencyPill.hidden = false;
  elements.latencyPill.dataset.quality = quality;
  setText(elements.latencyValue, `${Math.round(p50Ms)} ms`);
}

/**
 * Update the diagnostics telemetry readouts.
 *
 * @param {Object} telemetry
 * @param {number | null} telemetry.p50
 * @param {number | null} telemetry.p95
 * @param {number} telemetry.jitter
 * @param {number} telemetry.loss
 * @param {"good" | "warn" | "bad" | "unknown"} telemetry.quality
 */
export function setTelemetry({ p50, p95, jitter, loss, quality }) {
  setText(elements.latencyP50, p50 === null ? "— ms" : `${Math.round(p50)} ms`);
  setText(elements.latencyP95, p95 === null ? "— ms" : `${Math.round(p95)} ms`);
  setText(elements.connectionQuality, quality);
  if (elements.connectionQuality) {
    elements.connectionQuality.dataset.quality = quality;
  }
}

/**
 * Update the motion slider readout ("100%").
 *
 * @param {number} scale - In [0, 1].
 */
export function setMotionReadout(scale) {
  setText(elements.motionValue, `${Math.round(scale * 100)}%`);
  if (elements.motionRange) {
    elements.motionRange.value = String(Math.round(scale * 100));
  }
}

/**
 * Show or hide the onboarding overlay.
 *
 * @param {boolean} open
 */
export function setOnboardingOpen(open) {
  if (!elements.onboarding) return;
  elements.onboarding.dataset.open = String(open);
  elements.onboarding.hidden = !open;
  elements.onboarding.setAttribute("aria-hidden", String(!open));
}

/* ---------------------------------------------------------------------------
   5. Reset helpers
   --------------------------------------------------------------------------- */

/**
 * Reset the voice surface to its idle state. Called when a conversation
 * ends and on initial load. Note: this does NOT call `transition()` in
 * app.js, so the local `mode` variable in app.js must be reset separately
 * to avoid desync — app.js's `resetExperience` wrapper handles that.
 */
export function resetExperience() {
  setVoiceMode(VoiceMode.IDLE);
  setConversationActive(false);
  setConnectionState("disconnected");
  setSignalLevels(0, 0, 0);
  setAssistantText("");
  hideNotice();
  setLatencyPill(null, "unknown", false);
  setTelemetry({
    p50: null,
    p95: null,
    jitter: 0,
    loss: 0,
    quality: "unknown",
  });
}

/**
 * Append an entry to the diagnostics timeline. Capped at 50 entries.
 *
 * @param {string} kind
 * @param {string} detail
 */
export function addTimeline(kind, detail) {
  if (!elements.timeline) return;
  const item = document.createElement("li");
  const label = document.createElement("span");
  const body = document.createElement("p");
  label.textContent = kind;
  body.textContent = detail;
  item.append(label, body);
  elements.timeline.prepend(item);
  while (elements.timeline.children.length > 50) {
    elements.timeline.lastElementChild.remove();
  }
}

/* ---------------------------------------------------------------------------
   6. Internal utilities
   --------------------------------------------------------------------------- */

/**
 * @param {HTMLElement | null} element
 * @param {string} text
 */
function setText(element, text) {
  if (!element) return;
  element.textContent = text;
}

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/**
 * Openlive 26.7.16 — app.js
 *
 * Orchestrates the voice surface: WebSocket lifecycle, audio session,
 * transcript, first-run setup, background agent bridge, settings, and
 * keyboard shortcuts.
 *
 * Architecture:
 *   - `socket` is the binary WebSocket to /v1/realtime on the gateway.
 *   - `audio` is the AudioSession (mic capture + playback worklets).
 *   - `visualizer` is the canvas orb renderer.
 *   - `transcript` is the in-memory TranscriptLog.
 *   - `telemetry` is the ConnectionTelemetry rolling window.
 *   - `settings` is the persisted UI preferences.
 *   - `setup` is first-run config (API keys, voice, agent).
 *
 * The control flow is event-driven: gateway events flow in through
 * `handleControl`, audio events flow in through AudioSession callbacks,
 * and user events flow in through the DOM listeners wired at the bottom
 * of this file.
 */

import { AudioSession } from "./audio-session.js";
import {
  fetchLlmProviders,
  fetchVoices,
  listRemoteModels,
  playPcmBase64,
  previewVoice,
  probeAgent,
  pushLlmConfig,
  runAgentTask,
  startAgentPool,
  waitAgentPool,
  watchPoolEvents,
} from "./agent-client.js";
import {
  buildInteractionProfile,
  composeInstruction,
  MODES,
  selectMode,
} from "./conversation-modes.js";
import {
  AXES,
  composeCustomInstructions,
  loadCustomInstructions,
  resetCustomInstructions,
  setAxis,
} from "./custom-instructions.js";
import { ConnectionTelemetry } from "./connection-telemetry.js";
import { installShortcuts } from "./keyboard-shortcuts.js";
import { MediaCaptureSession } from "./media-capture.js";
import "./live-desk.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
import {
  decodeOutputAudio,
  encodeInputAudio,
  PROTOCOL_VERSION,
} from "./protocol.js";
import { QuotaTracker } from "./quota-tracker.js";
import {
  loadSettings,
  saveSettings,
} from "./settings-store.js";
import {
  isSetupComplete,
  loadSetup,
  markSetupComplete,
  saveSetup,
} from "./setup-store.js";
import {
  asrLangFor,
  bindLanguageControls,
  hasCjk,
  isChineseLang,
  languageReplyInstruction,
  ttsLangPrefsFor,
} from "./language.js";
import {
  browserTtsAvailable,
  countVoicesForLang,
  isBrowserSpeaking,
  listBrowserVoices,
  speakBrowser,
  stopBrowserSpeech,
  waitForVoices,
} from "./speech-tts.js";
import { exportMemory, saveMemoryItem } from "./memory-client.js";
import { fetchTtsStatus, piperInstallUi, speakOpenLive } from "./tts-client.js";
import {
  BACKCHANNEL_TOKENS,
  identityReply,
  isOnlyFillers,
  looksLikeAgentTask,
  looksLikeIdentity,
  looksLikePlanningJunk,
  pickToolAck,
  softNoAnswer,
  stripFillers,
  stripThinkingForUser,
} from "./speech-utils.js";
import { ToolCallLog } from "./tool-calls.js";
import { TranscriptLog } from "./transcript-log.js";
import * as visualCards from "./visual-cards.js";
import {
  bindSliderFeedback,
  isUiSoundMuted,
  playClick,
  playModeChime,
  setUiSoundMuted,
  unlockUiAudio,
  updateRangeFill,
} from "./ui-feedback.js";
import {
  addTimeline,
  closeOverlays,
  controls,
  fireBargeInRipple,
  flashBackchannel,
  hideNotice,
  renderInstructionsPanel,
  renderModeList,
  renderToolCall,
  renderTranscript,
  renderVisualCard,
  renderVoiceList,
  resetExperience,
  setAssistantText,
  setCameraActive,
  setConnectionState,
  setConversationActive,
  setInstructionsBadge,
  setLayout,
  setLatencyPill,
  setModeBadge,
  setMotionReadout,
  setOnboardingOpen,
  setOutputGain,
  setPlaybackBuffer,
  setProviderHint,
  setQuotaPill,
  setScreenShareActive,
  setSetupOpen,
  setSignalLevels,
  setStarting,
  setTaskRailVisible,
  setTelemetry,
  setVoiceBadge,
  setVoiceMode,
  showAgentToast,
  showNotice,
  toggleDiagnostics,
  toggleInstructions,
  toggleModePicker,
  toggleSettings,
  toggleTranscript,
  toggleVoicePicker,
} from "./ui.js";
import { reconnectDelay, VoiceMode } from "./visual-state.js";
import { VoiceVisualizer } from "./voice-visualizer.js";
import { OFFLINE_VOICES, resolveVoices, selectVoice } from "./voice-profiles.js";

/* ---------------------------------------------------------------------------
   State
   --------------------------------------------------------------------------- */

let socket;
let sessionId;
let connectionWaiter;
let reconnectTimer;
let transcriptTimer;
let sequence = 0;
let mediaTimeUs = 0;
let assistantText = "";
let transcriptVisible = false;
let lastServerSequence = 0;
let reconnectAttempt = 0;
let conversationActive = false;
let microphoneActive = false;
let userEnded = true;
let pttHeld = false;
let inputLevel = 0;
let outputLevel = 0;
let echoLevel = 0;
let mode = VoiceMode.IDLE;
/** Bumped on every barge-in / cancel so in-flight agent + TTS bail out. */
let assistantTurnId = 0;
let lastBargeInAt = 0;

let settings = loadSettings();
/** @type {ReturnType<typeof loadSetup>} */
let setup = loadSetup();
let voices = [...OFFLINE_VOICES];
let selectedVoice = selectVoice(voices, settings.voiceId || setup.voiceId);
let selectedModeId = settings.modeId;
let customInstructions = loadCustomInstructions();
let cameraActive = false;
let screenShareActive = false;
let visualInputSupported = false;
let memoryScope = localStorage.getItem("openlive:v2:memory-scope") ?? "off";
let languagePreference = localStorage.getItem("openlive:v2:language") ?? "auto";
/** When language is not auto, inject translate-mode instructions on configure. */

let pc = null;
let dc = null;
let webrtcMode = false;
/** Guard to prevent multiple simultaneous fallback-to-WebSocket triggers. */
let fallbackInProgress = false;
let activeProvider = null;
/** @type {object|null} */
let gatewayMeta = null;
let gatewayWebRtc = false;

/** Setup wizard step index (0 voice · 1 model · 2 agent). */
let setupStep = 0;
/** In-flight agent task ids (client-side). */
const agentJobs = new Map();
let lastBackchannelAt = 0;
let interimSpeechStartedAt = 0;
/** Dedupe agent / filler handling when client ASR + gateway both finalize. */
let lastHandledUtterance = "";
let lastHandledUtteranceAt = 0;
/** @type {Array<{id:string,name:string,base_url:string,default_model:string,models:string[],free_tier:boolean,description:string,docs_url:string}>} */
let llmProviders = [];

/**
 * Built-in provider details — used when the gateway hasn't started yet so
 * applyProviderPreset can still set base_url / model / description.
 * Mirrors crates/openlive-provider/src/llm_catalog.rs.
 */
const BUILTIN_PROVIDER_DETAILS = {
  nvidia: { id: "nvidia", name: "NVIDIA NIM", base_url: "https://integrate.api.nvidia.com/v1", default_model: "meta/llama-3.1-8b-instruct", models: ["meta/llama-3.1-8b-instruct", "meta/llama-3.3-70b-instruct", "google/gemma-2-9b-it", "mistralai/mistral-7b-instruct-v0.3", "microsoft/phi-3-mini-128k-instruct"], free_tier: true, description: "Free API key via build.nvidia.com — OpenAI-compatible chat." },
  groq: { id: "groq", name: "Groq", base_url: "https://api.groq.com/openai/v1", default_model: "llama-3.3-70b-versatile", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemma2-9b-it"], free_tier: true, description: "Fast open models (Llama, Gemma) via GroqCloud." },
  openrouter: { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", default_model: "meta-llama/llama-3.1-8b-instruct:free", models: ["meta-llama/llama-3.1-8b-instruct:free", "google/gemma-2-9b-it:free", "mistralai/mistral-7b-instruct:free"], free_tier: true, description: "Many open models behind one OpenAI-compatible API." },
  together: { id: "together", name: "Together AI", base_url: "https://api.together.xyz/v1", default_model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", models: ["meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", "mistralai/Mixtral-8x7B-Instruct-v0.1"], free_tier: false, description: "Open-weight models hosted by Together." },
  deepseek: { id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com/v1", default_model: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"], free_tier: false, description: "DeepSeek chat models (OpenAI-compatible)." },
  fireworks: { id: "fireworks", name: "Fireworks", base_url: "https://api.fireworks.ai/inference/v1", default_model: "accounts/fireworks/models/llama-v3p1-8b-instruct", models: ["accounts/fireworks/models/llama-v3p1-8b-instruct", "accounts/fireworks/models/mixtral-8x7b-instruct"], free_tier: false, description: "Fast inference for open models." },
  mistral: { id: "mistral", name: "Mistral", base_url: "https://api.mistral.ai/v1", default_model: "mistral-small-latest", models: ["mistral-small-latest", "mistral-large-latest", "open-mistral-nemo"], free_tier: false, description: "Mistral large / small via official API." },
  ollama: { id: "ollama", name: "Ollama (local)", base_url: "http://127.0.0.1:11434/v1", default_model: "llama3.2", models: ["llama3.2", "mistral", "qwen2.5", "gemma2"], free_tier: true, description: "Fully local open models via Ollama OpenAI shim." },
  openai: { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", default_model: "gpt-4o-mini", models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"], free_tier: false, description: "OpenAI chat completions (paid)." },
  cerebras: { id: "cerebras", name: "Cerebras", base_url: "https://api.cerebras.ai/v1", default_model: "llama3.1-8b", models: ["llama3.1-8b", "llama-3.3-70b"], free_tier: true, description: "Very fast Llama inference." },
  sambanova: { id: "sambanova", name: "SambaNova", base_url: "https://api.sambanova.ai/v1", default_model: "Meta-Llama-3.1-8B-Instruct", models: ["Meta-Llama-3.1-8B-Instruct", "Meta-Llama-3.3-70B-Instruct"], free_tier: true, description: "SambaNova Cloud open models." },
  custom: { id: "custom", name: "Custom", base_url: "http://127.0.0.1:8000/v1", default_model: "default", models: [], free_tier: true, description: "Any OpenAI-compatible base URL. Enter base URL, then pick or type a model id." },
};

const visualizer = new VoiceVisualizer(controls.voiceOrb);
visualizer.setMotionScale(settings.motionScale);

const mediaCapture = new MediaCaptureSession({
  onState: handleCaptureState,
  onError: ({ message }) => showNotice(message),
});
mediaCapture.attachPreviews({
  camera: document.querySelector("#cameraPreview"),
  screen: document.querySelector("#screenPreview"),
});

// Phase 7: Task orchestrator. Owns the client-side task list, evidence
// link index, and localStorage persistence. Transport callbacks route
// through `sendControl` so the orchestrator never touches the socket
// directly — keeping a single egress point for protocol envelopes.
const taskOrchestrator = new TaskOrchestrator({
  send: (envelope) => {
    if (!ready()) return;
    socket.send(JSON.stringify(envelope));
  },
  sequence: nextSequence,
  sessionId: () => sessionId,
  mediaTimeUs: () => mediaTimeUs,
  protocolVersion: PROTOCOL_VERSION,
});
window.addEventListener("openlive:task-requested", () => {
  appendEvidence("Task requested", "Intent sent to gateway", "cyan");
});
window.addEventListener("openlive:task-acknowledged", (event) => {
  const { taskId, deadlineMs, latencyMs } = event.detail ?? {};
  const detail = latencyMs != null
    ? `Latency ${latencyMs} ms · deadline ${new Date(deadlineMs).toLocaleTimeString()}`
    : `Deadline ${new Date(deadlineMs).toLocaleTimeString()}`;
  appendEvidence("Task acknowledged", detail, "green");
});
window.addEventListener("openlive:task-outcome", (event) => {
  const { taskId, result, summary, evidenceIds } = event.detail ?? {};
  const tone = result === "success" ? "green" : result === "failure" ? "yellow" : "cyan";
  appendEvidence(
    `Task ${result}`,
    `${summary} · ${evidenceIds?.length ?? 0} evidence`,
    tone,
  );
});
window.__openliveRequestTask = (intent, options) => taskOrchestrator.requestTask(intent, options);
// Phase 7: expose the orchestrator for the LiveBench scenario suite.
// `live-desk.js` reads this lazily when the user clicks "Run local
// demonstration", so we avoid a circular ES module dependency.
window.__openliveTaskOrchestrator = taskOrchestrator;

window.addEventListener("openlive:evidence", (event) => {
  const { title, detail, tone } = event.detail ?? {};
  appendEvidence(title ?? "Evidence event", detail ?? "", tone ?? "cyan");
});
window.addEventListener("openlive:notice", (event) => {
  showNotice(event.detail?.message ?? "");
});
window.addEventListener("openlive:memory-scope", (event) => {
  memoryScope = event.detail?.scope === "session" ? "session" : "off";
  if (sessionId) configureSession();
});
window.addEventListener("openlive:language", (event) => {
  languagePreference = event.detail?.language ?? "auto";
  // Restart ASR so the new language (e.g. zh-CN) is applied immediately.
  if (conversationActive && microphoneActive && recognition) {
    stopSpeechRecognition();
    startSpeechRecognition();
  }
  if (sessionId) configureSession();
});

const transcript = new TranscriptLog();
const telemetry = new ConnectionTelemetry();
const toolCalls = new ToolCallLog();
const quota = new QuotaTracker(
  { hardCapSeconds: 0 },
  {
    onNotice: (notice) => {
      if (notice.kind === "soft_warning") {
        showNotice(
          `Session ends in ${Math.ceil(notice.remainingSeconds / 60)} minute(s).`,
        );
        addTimeline("quota", `Soft warning at ${notice.remainingSeconds}s remaining`);
      } else if (notice.kind === "hard_limit") {
        showNotice("Session cap reached. Ending the conversation gracefully.");
        addTimeline("quota", "Hard limit reached");
        endConversation();
      }
    },
    onTick: (remaining) => {
      const bucket = remaining <= 60 ? "exhausted" : remaining <= 300 ? "warn" : "ok";
      setQuotaPill(remaining, bucket);
    },
  },
);

const audio = new AudioSession({
  onInputFrame: sendAudioFrame,
  onInputActivity: updateInputActivity,
  onPlayed: acknowledgePlayout,
  onTimeline: addTimeline,
  onBuffer: setPlaybackBuffer,
  onGain: setOutputGain,
  onOutputLevel: updateOutputActivity,
  onInterruption: () => {
    hardInterruptAssistant("audio-session");
  },
  onPlaybackIdle: () => {
    outputLevel = 0;
    updateSignals();
    if (conversationActive) {
      transition(microphoneActive ? VoiceMode.LISTENING : VoiceMode.MUTED);
    }
  },
});

/* ---------------------------------------------------------------------------
   Wire up DOM listeners
   --------------------------------------------------------------------------- */

controls.primary?.addEventListener("pointerdown", (event) => {
  if (!conversationActive || settings.entryMode !== "ptt") return;
  if (event.button !== 0) return;
  event.preventDefault();
  unlockUiAudio();
  playClick("soft");
  handlePttStart();
});
controls.primary?.addEventListener("pointerup", () => {
  if (settings.entryMode === "ptt") handlePttEnd();
});
controls.primary?.addEventListener("pointerleave", () => {
  if (settings.entryMode === "ptt") handlePttEnd();
});
controls.primary?.addEventListener("pointercancel", () => {
  if (settings.entryMode === "ptt") handlePttEnd();
});
controls.primary?.addEventListener("click", () => {
  unlockUiAudio();
  playClick(conversationActive ? "soft" : "confirm");
  if (conversationActive && settings.entryMode === "ptt") return;
  void handlePrimaryAction();
});
controls.orbShell?.addEventListener("click", () => {
  if (conversationActive || controls.primary?.disabled) return;
  unlockUiAudio();
  playClick("confirm");
  void handlePrimaryAction();
});
controls.end?.addEventListener("click", () => {
  playClick("cancel");
  endConversation();
});
controls.settings?.addEventListener("click", () => {
  unlockUiAudio();
  playClick("soft");
  applySetupToSettingsForm();
  try {
    bindLanguageControls();
  } catch {
    /* ignore */
  }
  // Reload system voices when Settings opens (catalog often empty until then).
  void fillSystemVoiceSelect();
  if (!controls.settingsVoice?.options?.length) {
    fillVoiceSelect(voices.length ? voices : OFFLINE_VOICES);
  }
  toggleSettings();
  // Scroll settings body to top on open so the user always sees the first section.
  const settingsBody = document.querySelector(".settings-body");
  if (settingsBody) {
    requestAnimationFrame(() => {
      settingsBody.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
  // Refresh runtime panel every time Settings opens.
  void refreshRuntimeStatus();
});
controls.closeSettings?.addEventListener("click", () => {
  playClick("soft");
  toggleSettings(false);
});
controls.backchannels?.addEventListener("change", (event) =>
  persistField("backchannels", event.target.value, /* reconfigure */ true),
);
controls.entryMode?.addEventListener("change", (event) => {
  persistField("entryMode", event.target.value);
  applyEntryMode();
});
controls.sessionCap?.addEventListener("change", (event) => {
  const minutes = Number(event.target.value);
  quota.configure({ hardCapSeconds: minutes * 60 });
  if (conversationActive && minutes > 0) {
    quota.start();
  } else if (minutes === 0) {
    setQuotaPill(Number.POSITIVE_INFINITY);
  }
  addTimeline("quota", `Session cap set to ${minutes || "unlimited"} minutes`);
});
controls.speedOverride?.addEventListener("change", (event) => {
  persistField("speedOverride", event.target.value, /* reconfigure */ true);
  customInstructions = loadCustomInstructions();
  refreshInstructionsBadge();
  if (document.querySelector("#instructionsPanel")?.dataset.open === "true") {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.detailOverride?.addEventListener("change", (event) => {
  persistField("detailOverride", event.target.value, /* reconfigure */ true);
  customInstructions = loadCustomInstructions();
  refreshInstructionsBadge();
  if (document.querySelector("#instructionsPanel")?.dataset.open === "true") {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.complexityOverride?.addEventListener("change", (event) => {
  persistField("complexityOverride", event.target.value, /* reconfigure */ true);
  customInstructions = loadCustomInstructions();
  refreshInstructionsBadge();
  if (document.querySelector("#instructionsPanel")?.dataset.open === "true") {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.toneOverride?.addEventListener("change", (event) => {
  persistField("toneOverride", event.target.value, /* reconfigure */ true);
  customInstructions = loadCustomInstructions();
  refreshInstructionsBadge();
  if (document.querySelector("#instructionsPanel")?.dataset.open === "true") {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.themeSelect?.addEventListener("change", (event) => {
  playClick("soft");
  applyTheme(event.target.value);
});
// Silver motion slider: tactile ticks + live orb scale.
if (controls.motionRange) {
  controls.motionRange.classList.add("silver-slider");
  bindSliderFeedback(controls.motionRange, (value) => {
    const scale = value / 100;
    visualizer.setMotionScale(scale);
    setMotionReadout(scale);
    settings = saveSettings({ motionScale: scale });
    const readout = document.querySelector("#motionValue");
    readout?.classList.add("is-dragging");
    clearTimeout(bindSliderFeedback._readoutTimer);
    bindSliderFeedback._readoutTimer = setTimeout(() => {
      readout?.classList.remove("is-dragging");
    }, 180);
  });
  updateRangeFill(controls.motionRange);
}
controls.latencyToggle?.addEventListener("change", (event) => {
  settings = saveSettings({ showLatency: event.target.checked });
  refreshLatencyPill();
  playClick("soft");
});
controls.fullscreenToggle?.addEventListener("change", (event) => {
  settings = saveSettings({ fullscreen: event.target.checked });
  applyFullscreen(settings.fullscreen);
  playClick("soft");
});
const exitFullscreenBtn = document.getElementById("exitFullscreen");
exitFullscreenBtn?.addEventListener("click", () => {
  settings = saveSettings({ fullscreen: false });
  applyFullscreen(false);
  if (controls.fullscreenToggle) {
    controls.fullscreenToggle.checked = false;
  }
  playClick("soft");
});
controls.debug?.addEventListener("click", () => {
  playClick("soft");
  toggleDiagnostics();
});
controls.brand?.addEventListener("click", () => {
  playClick("soft");
  toggleDiagnostics();
});
controls.closeDebug?.addEventListener("click", () => {
  playClick("soft");
  toggleDiagnostics(false);
});
controls.transcriptToggle?.addEventListener("click", () => {
  playClick("soft");
  toggleTranscript();
});
controls.transcriptClose?.addEventListener("click", () => {
  playClick("soft");
  toggleTranscript(false);
});
controls.transcriptExport?.addEventListener("click", () => {
  exportTranscript();
});
controls.transcriptClear?.addEventListener("click", () => {
  transcript.clear();
  toolCalls.clear();
  renderTranscript(transcript.entries);
});
controls.voice?.addEventListener("click", () => toggleVoicePicker());
controls.closeVoice?.addEventListener("click", () => toggleVoicePicker(false));
controls.mode?.addEventListener("click", () => toggleModePicker());
controls.closeMode?.addEventListener("click", () => toggleModePicker(false));
controls.instructions?.addEventListener("click", () => {
  const open = toggleInstructions();
  if (open) {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.closeInstructions?.addEventListener("click", () => toggleInstructions(false));
controls.resetInstructions?.addEventListener("click", () => {
  customInstructions = resetCustomInstructions();
  refreshInstructionsBadge();
  renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  syncSettingsFormInstructions();
  if (sessionId) configureSession();
  addTimeline("instructions", "Reset to auto");
});
controls.camera?.addEventListener("click", () => void toggleCamera());
controls.screenShare?.addEventListener("click", () => void toggleScreenShare());
document.querySelector("#snapshotAction")?.addEventListener("click", () => void shareVisualSnapshot());
controls.layoutToggle?.addEventListener("click", () => {
  const next = settings.layout === "focused" ? "inline" : "focused";
  settings = saveSettings({ layout: next });
  setLayout(next);
});
controls.onboardingDismiss?.addEventListener("click", () => {
  settings = saveSettings({ onboardingDismissed: true });
  setOnboardingOpen(false);
});
controls.onboardingStart?.addEventListener("click", () => setOnboardingOpen(false));

/* Setup wizard + model/agent settings */
wireSetupWizard();
wireSetupSettingsBindings();
// Language dropdown (top bar + Settings) — Chinese selectable without multi-click cycle.
try {
  bindLanguageControls();
} catch (e) {
  console.warn("bindLanguageControls failed", e);
}
controls.composerInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  unlockUiAudio();
  playClick("confirm");
  void submitComposerText();
});
// Prime Web Audio on first pointer anywhere in the surface.
document.addEventListener(
  "pointerdown",
  () => {
    unlockUiAudio();
  },
  { once: true, passive: true },
);
wireUiSoundToggle();

window.addEventListener("beforeunload", () => {
  visualizer.destroy();
  void mediaCapture.stopAll();
});

installShortcuts({
  isConversationActive: () => conversationActive,
  isPTTMode: () => settings.entryMode === "ptt",
  isBlocked: () => isInteractionBlocked(),
  onStartConversation: () => {
    unlockUiAudio();
    playClick("confirm");
    void handlePrimaryAction();
  },
  onPTTStart: () => {
    handlePttStart();
  },
  onPTTEnd: () => {
    handlePttEnd();
  },
  toggleMute: handleMuteToggle,
  toggleTranscript: () => toggleTranscript(),
  toggleDiagnostics: () => toggleDiagnostics(),
  toggleSettings: () => toggleSettings(),
  toggleInstructions: () => {
    const open = toggleInstructions();
    if (open) renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  },
  toggleLayout: () => {
    const next = settings.layout === "focused" ? "inline" : "focused";
    settings = saveSettings({ layout: next });
    setLayout(next);
  },
  toggleFullscreen: () => {
    settings = saveSettings({ fullscreen: !settings.fullscreen });
    applyFullscreen(settings.fullscreen);
    if (controls.fullscreenToggle) {
      controls.fullscreenToggle.checked = settings.fullscreen;
    }
  },
  toggleCamera: toggleCamera,
  toggleScreenShare: toggleScreenShare,
  openVoicePicker: () => toggleVoicePicker(),
  cycleMode: cycleMode,
  endConversation: endConversation,
  closeOverlays: () => {
    closeOverlays();
  },
  showOnboarding: () => setOnboardingOpen(true),
});

/* ---------------------------------------------------------------------------
   Initial render
   --------------------------------------------------------------------------- */

// Prefer setup voice + minimal black surface when configured.
if (setup.voiceId) {
  selectedVoice = selectVoice(voices, setup.voiceId);
  settings = saveSettings({ voiceId: setup.voiceId });
}
if (setup.minimalUi && settings.theme !== "minimal") {
  settings = saveSettings({ theme: "minimal" });
}
if (setup.naturalBackchannels && settings.backchannels === "off") {
  settings = saveSettings({ backchannels: "natural" });
} else if (setup.naturalBackchannels && settings.backchannels === "minimal") {
  settings = saveSettings({ backchannels: "natural" });
}

applyTheme(settings.theme);
applyFullscreen(settings.fullscreen);
applyEntryMode();
applySettingsForm();
applySetupToSettingsForm();
applySessionCapFromSettings();
refreshFullscreenToggle();
visualizer.setMode(VoiceMode.IDLE);
resetExperience();
renderVoiceList(voices, selectedVoice.id, onVoiceSelected);
renderModeList(MODES, selectedModeId, onModeSelected);
setVoiceBadge(selectedVoice.glyph);
setModeBadge(selectMode(selectedModeId).name.split(" ")[0]);
setMotionReadout(settings.motionScale);
setLayout(settings.layout);
refreshInstructionsBadge();
// Phase 7: render the task rail from localStorage so a refreshed page
// shows pending tasks without waiting for a new acknowledgement.
initializeTaskRail();

// Load LLM provider catalog + sync gateway config (non-blocking).
void bootstrapLlmUi().then(() => {
  // Dismiss the boot splash once the provider catalog is loaded.
  dismissBootSplash();
});
// Paint Settings → Runtime as soon as the page loads (don't wait for Start).
void refreshRuntimeStatus();

if (!isSetupComplete()) {
  openSetupWizard({ force: true });
} else {
  setSetupOpen(false);
  if (!settings.onboardingDismissed) {
    setOnboardingOpen(true);
  }
  void pushLlmConfig(setup).catch(() => {});
}

// Failsafe: dismiss splash after 3s even if bootstrapLlmUi hangs.
setTimeout(dismissBootSplash, 3000);

// Install ripple click feedback on all interactive elements.
installRippleFeedback();

/* ---------------------------------------------------------------------------
   Primary action / conversation lifecycle
   --------------------------------------------------------------------------- */

function isInteractionBlocked() {
  return document.body.classList.contains("setup-open");
}

function showSetupRequiredNotice() {
  showNotice("Finish setup first — tap Continue at the bottom of the wizard.");
}

function handlePttStart() {
  if (!conversationActive || pttHeld) return;
  pttHeld = true;
  if (!microphoneActive) {
    audio.startMicrophone().then(() => {
      microphoneActive = true;
      setConversationActive(true, true, true);
      transition(VoiceMode.LISTENING);
    }).catch((error) => showNotice(microphoneErrorMessage(error)));
  } else {
    transition(VoiceMode.LISTENING);
  }
}

function handlePttEnd() {
  if (!pttHeld) return;
  pttHeld = false;
  if (microphoneActive) {
    transition(VoiceMode.THINKING);
  }
}

async function handlePrimaryAction() {
  if (isInteractionBlocked()) {
    showSetupRequiredNotice();
    return;
  }
  if (!conversationActive) {
    await beginConversation();
    return;
  }
  if (settings.entryMode === "ptt") {
    handlePttStart();
    return;
  }
  handleMuteToggle();
}

function handleMuteToggle() {
  if (!conversationActive) return;
  if (microphoneActive) {
    audio.stopMicrophone();
    microphoneActive = false;
    setConversationActive(true, false, settings.entryMode === "ptt");
    transition(VoiceMode.MUTED);
    stopSpeechRecognition();
    return;
  }
  audio.startMicrophone().then(() => {
    microphoneActive = true;
    setConversationActive(true, true, settings.entryMode === "ptt");
    hideNotice();
    transition(VoiceMode.LISTENING);
    startSpeechRecognition();
  }).catch((error) => showNotice(microphoneErrorMessage(error)));
}

async function beginConversation() {
  userEnded = false;
  reconnectAttempt = 0;
  mediaTimeUs = 0;
  assistantText = "";
  transcriptVisible = false;
  receivedMediaForGeneration = false;
  fallbackInProgress = false;
  silentWebRtcReconnect._attempts = 0;
  clearTimeout(transcriptTimer);
  transcript.clear();
  toolCalls.clear();
  renderTranscript(transcript.entries);
  setAssistantText("");
  closeOverlays();
  hideNotice();
  setStarting(true);
  transition(VoiceMode.STARTING);
  try {
    setup = loadSetup();
    await pushLlmConfig(setup).catch(() => {});
    await fetchProvider();
    // Mock duplex is more reliable on plain WebSocket + browser ASR.
    // Gateway WebRTC was firing empty prompts and double replies.
    const isMock =
      String(activeProvider?.id || "").includes("mock") ||
      activeProvider?.provider_class === "mock";
    const preferGatewayRtc = gatewayWebRtc && !isMock;
    const preferProviderRtc =
      activeProvider?.provider_class === "native_duplex" ||
      String(activeProvider?.id || "").includes("openai-realtime");
    webrtcMode = preferGatewayRtc || preferProviderRtc;

    let sampleRate;
    if (webrtcMode) {
      sampleRate = await audio.startMicrophone();
      microphoneActive = true;
      addTimeline(
        "microphone",
        `Capture started at ${sampleRate} Hz (WebRTC ${preferGatewayRtc ? "gateway" : "provider"})`,
      );
      if (preferGatewayRtc) {
        await openGatewayWebRtcConnection();
      } else {
        await openConnection();
        await openWebRtcConnection(activeProvider?.id, selectedVoice?.id);
      }
    } else {
      await openConnection();
      sampleRate = await audio.startMicrophone();
      microphoneActive = true;
      addTimeline("microphone", `Capture started at ${sampleRate} Hz`);
    }

    conversationActive = true;
    setConversationActive(true, true, settings.entryMode === "ptt");
    transition(VoiceMode.LISTENING);
    startSpeechRecognition();
    transcript.append("system", "Conversation started.");
    renderTranscript(transcript.entries);
    quota.start();
    if (quota.remainingSeconds() !== Number.POSITIVE_INFINITY) {
      setQuotaPill(quota.remainingSeconds(), "ok");
    }
  } catch (error) {
    userEnded = true;
    fallbackInProgress = false;
    closeWebRtcConnection();
    socket?.close();
    socket = undefined;
    audio.stopMicrophone();
    microphoneActive = false;
    conversationActive = false;
    setConversationActive(false);
    showNotice(microphoneErrorMessage(error));
    transition(VoiceMode.ERROR);
    addTimeline("start_error", error.message);
  } finally {
    setStarting(false);
  }
}

function endConversation() {
  if (!conversationActive && mode === VoiceMode.IDLE) return;
  userEnded = true;
  conversationActive = false;
  microphoneActive = false;
  pttHeld = false;
  fallbackInProgress = false;
  silentWebRtcReconnect._attempts = 0;
  clearTimeout(reconnectTimer);
  clearTimeout(transcriptTimer);
  stopBrowserSpeech();
  quota.stop();
  quota.reset();
  setQuotaPill(Number.POSITIVE_INFINITY);
  stopSpeechRecognition();
  closeWebRtcConnection();
  audio.stopMicrophone();
  audio.reset();
  void mediaCapture.stopAll();
  socket?.close();
  socket = undefined;
  sessionId = undefined;
  assistantText = "";
  reconnectAttempt = 0;
  transcript.append("system", "Conversation ended.");
  renderTranscript(transcript.entries);
  resetExperience();
  visualizer.setMode(VoiceMode.IDLE);
  telemetry.reset();
  addTimeline("session", "Conversation ended");
}

async function fetchProvider() {
  await refreshRuntimeStatus();
}

/** Load gateway meta + provider and paint Settings → Runtime. Safe to call anytime. */
async function refreshRuntimeStatus() {
  const el = document.getElementById("runtimeStatus");
  if (el && !el.dataset.loaded) {
    el.innerHTML = `<p class="sheet-intro">Loading gateway status…</p>`;
  }
  let provider = activeProvider;
  let meta = gatewayMeta;
  try {
    const response = await fetch("/v1/providers");
    if (response.ok) {
      provider = await response.json();
      activeProvider = provider;
      setProviderChip(activeProvider);
      if (controls.providerHint) {
        controls.providerHint.textContent =
          `${activeProvider.id} · v${activeProvider.adapter_version || "?"}`;
      }
    }
  } catch (e) {
    console.warn("Failed to fetch provider manifest:", e);
  }
  try {
    const metaRes = await fetch("/v1/meta");
    if (metaRes.ok) {
      meta = await metaRes.json();
      gatewayMeta = meta;
      gatewayWebRtc = !!(
        meta.gateway_webrtc ||
        meta.features?.gateway_webrtc
      );
    }
  } catch (e) {
    console.warn("Failed to fetch /v1/meta:", e);
  }
  // Also pull live LLM config from gateway when available.
  let llmLive = null;
  try {
    const llmRes = await fetch("/v1/llm/config");
    if (llmRes.ok) llmLive = await llmRes.json();
  } catch {
    /* optional on older binaries */
  }
  if (meta || provider) {
    renderRuntimeStatus(meta || {}, provider || {}, llmLive);
  } else if (el) {
    el.innerHTML = `<p class="sheet-intro settings-hint" style="color:var(--bad)">Gateway unreachable. Is openlive-gateway running on this port?</p>
      <button type="button" class="settings-btn" id="retryRuntimeStatus">Retry</button>`;
    const retry = document.getElementById("retryRuntimeStatus");
    if (retry) {
      retry.onclick = () => {
        void refreshRuntimeStatus();
      };
    }
  }
}

function renderRuntimeStatus(meta, provider, llmLive = null) {
  const el = document.getElementById("runtimeStatus");
  if (!el) return;
  el.dataset.loaded = "1";
  setup = loadSetup();
  const providerId = provider?.id || meta?.provider || "—";
  const providerClass = String(
    provider?.provider_class || meta?.provider_class || "—",
  );
  const isMock = /mock/i.test(providerId) || providerClass === "mock";
  const agentLabel =
    setup.agentKind === "none"
      ? "None (voice only)"
      : "Internal agent · search, time, calc";
  const llmFromGateway = llmLive
    ? `${llmLive.provider_id || "?"} · ${llmLive.model || "?"} · ${
        llmLive.can_chat ? "ready" : llmLive.has_api_key ? "key set" : "no key"
      }`
    : null;
  const llmLabel =
    llmFromGateway ||
    `${setup.llmProviderId || "?"} · ${setup.llmModel || "?"} · ${
      setup.modelApiKey ? "key set" : "no key"
    }`;
  const version =
    meta?.version || meta?.openlive_version || provider?.openlive_version || "?";
  const protocol =
    meta?.protocol_revision ?? provider?.protocol_revision ?? "?";
  const sessions =
    meta?.active_sessions ?? meta?.sessions ?? 0;
  const persist = meta?.persistence ?? meta?.features?.session_persistence;
  const features = meta?.features || provider?.features || {};
  const pills = Object.entries(features)
    .filter(([, on]) => on)
    .slice(0, 10)
    .map(
      ([key]) =>
        `<span class="feature-pill">${escapeHtml(key.replace(/_/g, " "))}</span>`,
    )
    .join("");
  el.innerHTML = `
    <dl>
      <dt>Status</dt><dd style="color:var(--good)">Connected</dd>
      <dt>Voice provider</dt><dd title="${escapeHtml(providerId)}">${escapeHtml(shortProviderName(providerId))}${isMock ? " · mock" : ""}</dd>
      <dt>Class</dt><dd>${escapeHtml(String(providerClass).replace(/_/g, " "))}</dd>
      <dt>Gateway</dt><dd>v${escapeHtml(String(version))} · protocol ${escapeHtml(String(protocol))}</dd>
      <dt>LLM</dt><dd title="${escapeHtml(llmLabel)}">${escapeHtml(llmLabel)}</dd>
      <dt>Agent</dt><dd>${escapeHtml(agentLabel)}</dd>
      <dt>Sessions</dt><dd>${escapeHtml(String(sessions))} active</dd>
      <dt>Persist</dt><dd>${persist ? "JSONL on" : "off"}</dd>
    </dl>
    ${
      isMock
        ? `<p class="settings-hint" style="margin-top:10px">Voice runtime is online. Set LLM provider + API key above for natural answers; agent tools (search/math/time) work without a key.</p>`
        : ""
    }
    <div class="pill-row">${pills || ""}</div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function exportTranscript() {
  const turns = transcript.entries.map((entry) => ({
    role: entry.role,
    text: entry.text,
    pending: entry.pending,
    generationId: entry.generationId,
    createdAt: entry.createdAt,
  }));
  const payload = {
    format: "openlive.transcript.v1",
    session_id: sessionId,
    exported_at: new Date().toISOString(),
    provider: activeProvider?.id ?? null,
    turns,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `openlive-transcript-${sessionId || "local"}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  addTimeline("transcript", `Exported ${turns.length} turns`);
}

async function fetchIceServers() {
  try {
    const response = await fetch("/v1/webrtc/ice");
    if (response.ok) {
      const body = await response.json();
      if (Array.isArray(body.iceServers) && body.iceServers.length) {
        return body.iceServers;
      }
    }
  } catch {
    /* fall through */
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

/**
 * Gateway-native WebRTC: DTLS data channels for events + PCM media packets.
 * This is the primary path when the gateway hub is available.
 */
async function openGatewayWebRtcConnection() {
  addTimeline("webrtc", "Negotiating gateway-native WebRTC...");
  const iceServers = await fetchIceServers();
  pc = new RTCPeerConnection({ iceServers });

  pc.onconnectionstatechange = () => {
    // Use optional chaining — pc may be null by the time this async event
    // fires (closeWebRtcConnection / fallbackToWebSocket set pc = null
    // synchronously after calling pc.close()).
    const state = pc?.connectionState;
    if (state === "failed" || state === "disconnected") {
      addTimeline("webrtc", `Gateway WebRTC ${state}; falling back to WebSocket PCM...`);
      // Use coordinated fallback — guarded against re-entry.
      fallbackToWebSocket(`gateway WebRTC ${state}`).catch(() => {});
    }
  };

  const eventsDc = pc.createDataChannel("openlive-events", { ordered: true });
  const mediaDc = pc.createDataChannel("openlive-media", {
    ordered: false,
    maxRetransmits: 0,
  });
  dc = eventsDc;

  eventsDc.onopen = () => {
    addTimeline("webrtc", "openlive-events channel open");
    setConnectionState("connected");
    configureSession();
  };
  eventsDc.onmessage = (event) => {
    try {
      handleControl(JSON.parse(event.data));
    } catch (e) {
      console.warn("gateway webrtc control parse failed", e);
    }
  };

  mediaDc.onmessage = (event) => {
    try {
      const buffer =
        event.data instanceof ArrayBuffer
          ? event.data
          : event.data?.buffer || event.data;
      const packet = decodeOutputAudio(buffer);
      if (packet) {
        // Track that we received streaming PCM so output_text_final
        // doesn't double-play TTS on top of it.
        receivedMediaForGeneration = true;
        audio.enqueue(packet).catch(() => {});
      }
    } catch {
      /* ignore non-packet frames */
    }
  };

  // Hook existing onInputFrame path via app's sendAudioFrame when webrtcMode.
  window.__openliveMediaDc = mediaDc;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const response = await fetch("/v1/webrtc/offer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "offer",
      sdp: offer.sdp,
      mode: "gateway",
    }),
  });
  if (!response.ok) {
    throw new Error(`Gateway WebRTC offer failed: ${response.statusText}`);
  }
  const body = await response.json();
  if (!body.sdp) {
    throw new Error(body.note || "Gateway did not return an SDP answer");
  }
  await pc.setRemoteDescription(
    new RTCSessionDescription({ type: "answer", sdp: body.sdp }),
  );
  sessionId = body.session_id || sessionId;
  webrtcMode = true;
  receivedMediaForGeneration = false;
  addTimeline("webrtc", "Gateway-native WebRTC established (DTLS data channels)");
  setTransportLabel("WebRTC · gateway");
}

async function openWebRtcConnection(model, voice) {
  addTimeline("webrtc", "Negotiating provider-edge WebRTC transport...");
  const response = await fetch("/v1/realtime/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ephemeral token: ${response.statusText}`);
  }
  const sessionData = await response.json();
  const token = sessionData.client_secret?.value;
  if (!token) {
    throw new Error("Provider did not return a client secret");
  }

  const iceServers = await fetchIceServers();
  pc = new RTCPeerConnection({ iceServers });

  pc.onconnectionstatechange = () => {
    // Use optional chaining — pc may be null by the time this async event
    // fires (silentWebRtcReconnect / fallbackToWebSocket set pc = null
    // synchronously after calling pc.close()).
    const state = pc?.connectionState;
    if (state === "failed" || state === "disconnected") {
      addTimeline("webrtc", `WebRTC transport ${state}, attempting silent renegotiation...`);
      silentWebRtcReconnect();
    }
  };

  pc.ontrack = (event) => {
    const track = event.streams[0].getAudioTracks()[0];
    if (track) {
      audio.connectWebRtcTrack(track);
      addTimeline("webrtc", "Incoming WebRTC audio track connected");
    }
  };

  await audio.ensureContext();
  const localStream = audio.microphoneStream;
  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    addTimeline("webrtc", "Local microphone track added to WebRTC peer");
  }

  dc = pc.createDataChannel("oai-events");
  dc.onopen = () => {
    addTimeline("webrtc", "WebRTC DataChannel opened");
    configureSession();
  };
  dc.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleControl(data);
    } catch (e) {
      console.warn("failed to parse WebRTC message:", e);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const modelName = model ? model.split("/").pop() : "gpt-4o-realtime-preview";
  const webrtcUrl = `https://api.openai.com/v1/realtime?model=${modelName}`;
  const sdpResponse = await fetch(webrtcUrl, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/sdp",
    },
  });

  if (!sdpResponse.ok) {
    const errText = await sdpResponse.text();
    throw new Error(`SDP exchange failed: ${errText}`);
  }

  const sdpAnswer = await sdpResponse.text();
  await pc.setRemoteDescription(
    new RTCSessionDescription({
      type: "answer",
      sdp: sdpAnswer,
    }),
  );
  addTimeline("webrtc", "Provider-edge WebRTC connection established");
  setTransportLabel("WebRTC · Opus");
  receivedMediaForGeneration = false;
}

function closeWebRtcConnection() {
  audio.disconnectWebRtc();
  dc?.close();
  pc?.close();
  dc = null;
  pc = null;
  webrtcMode = false;
  window.__openliveMediaDc = null;
  addTimeline("webrtc", "WebRTC connection closed");
  setTransportLabel("WebSocket PCM");
}

function setTransportLabel(label) {
  const el = document.getElementById("transportLabel");
  if (el) el.textContent = label;
}

function setProviderChip(manifest) {
  const el = document.getElementById("providerChip");
  if (!el) return;
  if (!manifest) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const name = el.querySelector("strong");
  const meta = el.querySelector("span");
  if (name) name.textContent = shortProviderName(manifest.id);
  if (meta) {
    meta.textContent = String(manifest.provider_class || "provider").replace(
      /_/g,
      " ",
    );
  }
}

function shortProviderName(id) {
  if (!id) return "Provider";
  const parts = String(id).split("/");
  return parts[parts.length - 1] || id;
}

/**
 * Coordinated fallback from WebRTC to WebSocket PCM transport.
 *
 * This replaces the ad-hoc closeWebRtcConnection()+openConnection() pattern
 * that was prone to races. It is guarded by `fallbackInProgress` to prevent
 * multiple simultaneous fallbacks (e.g. when onconnectionstatechange fires
 * both "disconnected" and "failed" in quick succession).
 *
 * Steps:
 *   1. Mark fallback in progress (guard against re-entry).
 *   2. Tear down WebRTC resources cleanly.
 *   3. Reset audio state so playback works on the new path.
 *   4. Open a fresh WebSocket connection.
 *   5. If WebSocket succeeds, reconfigure the session.
 *   6. If WebSocket also fails, let the caller / beginConversation catch block handle it.
 *
 * @param {string} [reason] - Human-readable reason for the fallback.
 * @returns {Promise<void>}
 */
async function fallbackToWebSocket(reason = "WebRTC unavailable") {
  // Guard against re-entry — multiple state-change events can fire rapidly.
  if (fallbackInProgress) {
    addTimeline("webrtc", `Fallback already in progress — skipping (${reason})`);
    return;
  }
  if (!conversationActive || userEnded) return;

  fallbackInProgress = true;
  addTimeline("webrtc", `Falling back to WebSocket PCM: ${reason}`);

  try {
    // 1. Tear down WebRTC resources.
    audio.disconnectWebRtc();
    dc?.close();
    pc?.close();
    dc = null;
    pc = null;
    window.__openliveMediaDc = null;
    webrtcMode = false;

    // 2. Reset audio + TTS state so the new transport starts clean.
    receivedMediaForGeneration = false;
    audio.reset();
    assistantText = "";
    setAssistantText("");

    // 3. Open a fresh WebSocket connection — unless one is already open.
    //    In the provider-edge path, openConnection() was called before
    //    openWebRtcConnection(), so the old WebSocket may still be alive.
    if (socket?.readyState === WebSocket.OPEN && sessionId) {
      addTimeline("webrtc", "Reusing existing WebSocket connection for fallback");
    } else {
      // We need a new sessionId since the WebRTC session is gone.
      sessionId = undefined;
      setConnectionState("connecting");
      await openConnection();
    }

    // 4. Success — update transport label and let the conversation continue.
    setTransportLabel("WebSocket PCM");
    addTimeline("webrtc", "WebSocket PCM fallback established");
    // configureSession() is called by the session_created handler in
    // handleControl, so we don't need to call it here.
  } catch (error) {
    addTimeline("webrtc", `WebSocket fallback also failed: ${error.message}`);
    // If even WebSocket fails, let scheduleReconnect handle retries.
    if (!userEnded && conversationActive) {
      scheduleReconnect();
    }
    throw error;
  } finally {
    fallbackInProgress = false;
  }
}

async function silentWebRtcReconnect() {
  if (!conversationActive || userEnded) return;

  // Limit WebRTC re-negotiation attempts to avoid infinite loops when the
  // provider edge is persistently down. After exhausting retries, fall back
  // to WebSocket PCM permanently for the rest of the session.
  silentWebRtcReconnect._attempts = (silentWebRtcReconnect._attempts || 0) + 1;
  if (silentWebRtcReconnect._attempts > 2) {
    addTimeline("webrtc", `WebRTC reconnect attempts exhausted (${silentWebRtcReconnect._attempts - 1}), falling back to WebSocket PCM`);
    silentWebRtcReconnect._attempts = 0;
    try {
      await fallbackToWebSocket("provider-edge WebRTC retry limit reached");
    } catch (fallbackError) {
      console.warn("WebSocket fallback after retry exhaustion also failed:", fallbackError);
    }
    return;
  }

  // Attempt WebRTC re-negotiation.
  try {
    audio.disconnectWebRtc();
    dc?.close();
    pc?.close();
    dc = null;
    pc = null;
    await openWebRtcConnection(activeProvider?.id, selectedVoice?.id);
    addTimeline("webrtc", "WebRTC transport renegotiated successfully");
    silentWebRtcReconnect._attempts = 0; // reset on success
    return; // success — stay on WebRTC
  } catch (e) {
    addTimeline("webrtc", `WebRTC renegotiation failed: ${e.message}`);
  }

  // WebRTC reconnect failed — fall back to WebSocket PCM.
  // NOTE: Do NOT reset _attempts here — the counter must accumulate so
  // the > 2 gate can enforce a hard limit if the fallback path keeps
  // re-entering WebRTC (e.g. lingering pc.onconnectionstatechange).
  addTimeline("webrtc", "Switching to WebSocket PCM after WebRTC failure");
  try {
    await fallbackToWebSocket("provider-edge WebRTC reconnect failed");
  } catch (fallbackError) {
    console.warn("WebSocket fallback after WebRTC failure also failed:", fallbackError);
    // scheduleReconnect is called inside fallbackToWebSocket on failure.
  }
}

let recognition = null;
let lastSpeechTranscript = "";

function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn("Speech recognition not supported in this browser.");
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = asrLangFor(languagePreference);

  recognition.onresult = (event) => {
    let interimTranscript = "";
    let finalTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    const rawText = finalTranscript || interimTranscript;
    if (!rawText || rawText === lastSpeechTranscript) return;

    lastSpeechTranscript = rawText;

    // Barge-in: any new user speech immediately stops assistant speech + cancels generation.
    if (interimTranscript || finalTranscript) {
      if (
        mode === VoiceMode.SPEAKING ||
        mode === VoiceMode.THINKING ||
        mode === VoiceMode.YIELDING ||
        isBrowserSpeaking()
      ) {
        hardInterruptAssistant("client-asr");
      }
    }

    // Soft local listener cue while the user is still mid-utterance (not fillers).
    if (!finalTranscript && interimTranscript) {
      if (!isOnlyFillers(interimTranscript)) {
        maybeLocalBackchannel(interimTranscript);
      }
    } else {
      interimSpeechStartedAt = 0;
    }

    // Keep live transcript natural (with fillers); clean only for agent tasks.
    const displayText = rawText.trim();
    transcript.reviseLatestPending("user", displayText, "client-asr");
    if (finalTranscript) {
      const last = transcript.last();
      if (last?.role === "user" && last.pending) {
        transcript.finalize(last.id, displayText);
      }
      // Pure fillers: show in transcript, do not trigger a full model turn.
      if (isOnlyFillers(displayText)) {
        handleFinalUserUtterance(displayText, { source: "client-asr" });
        renderTranscript(transcript.entries);
        return;
      }
      const cleanedForTools = stripFillers(displayText);
      const toolTurn =
        loadSetup().agentKind !== "none" && looksLikeAgentTask(cleanedForTools);
      handleFinalUserUtterance(displayText, { source: "client-asr" });
      // Tool turns are handled by the agent (spoken there). Skip gateway LLM
      // so we don't get double/conflicting answers.
      if (toolTurn) {
        renderTranscript(transcript.entries);
        return;
      }
    }
    renderTranscript(transcript.entries);
    sendControl("session", mediaTimeUs, "user_transcript_delta", {
      text: displayText,
      is_final: !!finalTranscript && !isOnlyFillers(displayText),
    });
    // Gateway WebRTC bridge also accepts an explicit commit for snappy mock turns.
    if (finalTranscript && webrtcMode && !isOnlyFillers(displayText)) {
      sendWebRtcCommit(displayText);
    }
  };

  recognition.onend = () => {
    if (conversationActive && microphoneActive && !userEnded) {
      try {
        recognition.start();
      } catch (e) {
        // ignore
      }
    }
  };

  try {
    recognition.start();
  } catch (e) {
    console.warn("Speech recognition failed to start:", e);
  }
}

function stopSpeechRecognition() {
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
  lastSpeechTranscript = "";
}

/* ---------------------------------------------------------------------------
   WebSocket lifecycle
   --------------------------------------------------------------------------- */

function openConnection() {
  clearTimeout(reconnectTimer);
  sessionId = undefined;
  sequence = 0;
  lastServerSequence = 0;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const candidate = new WebSocket(`${scheme}://${location.host}/v1/realtime`);
  let established = false;
  candidate.binaryType = "arraybuffer";
  socket = candidate;
  setConnectionState("connecting");

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Realtime connection timed out")),
      8000,
    );
    connectionWaiter = {
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    };
  });

  candidate.addEventListener("open", () => {
    if (candidate !== socket) return;
    addTimeline("socket", "Realtime transport opened");
  });
  candidate.addEventListener("message", ({ data }) => {
    if (candidate !== socket) return;
    try {
      if (typeof data === "string") {
        handleControl(JSON.parse(data));
      } else {
        handleMedia(decodeOutputAudio(data));
      }
    } catch (error) {
      addTimeline("protocol_error", error.message);
    }
  });
  candidate.addEventListener("error", () => {
    if (candidate !== socket) return;
    connectionWaiter?.reject(new Error("Realtime connection failed"));
    connectionWaiter = undefined;
  });
  candidate.addEventListener("close", () => {
    if (candidate !== socket) return;
    sessionId = undefined;
    setConnectionState("disconnected");
    connectionWaiter?.reject(new Error("Realtime connection closed"));
    connectionWaiter = undefined;
    addTimeline("socket", "Realtime transport closed");
    if (established && !userEnded && conversationActive) scheduleReconnect();
  });
  return ready.then(() => {
    established = true;
  });
}

function scheduleReconnect() {
  if (userEnded || !conversationActive) return;
  if (reconnectAttempt >= 5) {
    showNotice(
      "The realtime session could not reconnect. End the conversation and try again.",
    );
    transition(VoiceMode.CONNECTION_ERROR);
    return;
  }
  audio.reset();
  assistantText = "";
  transcriptVisible = false;
  clearTimeout(transcriptTimer);
  setAssistantText("");
  transition(VoiceMode.RECONNECTING);
  setConnectionState("reconnecting");
  transcript.append("system", "Reconnecting…");
  renderTranscript(transcript.entries);
  const delay = reconnectDelay(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(async () => {
    try {
      await openConnection();
      reconnectAttempt = 0;
      hideNotice();
      transition(microphoneActive ? VoiceMode.LISTENING : VoiceMode.MUTED);
      addTimeline("socket", "Realtime session restored");
      transcript.append("system", "Connection restored.");
      renderTranscript(transcript.entries);
      // Phase 7: ask the gateway to replay any buffered outcomes that
      // were emitted while we were disconnected. The orchestrator
      // deduplicates by `event_id`, so re-receiving events we already
      // processed is a no-op.
      resumeSession();
    } catch (error) {
      const failedSocket = socket;
      socket = undefined;
      failedSocket?.close();
      addTimeline("reconnect", error.message);
      scheduleReconnect();
    }
  }, delay);
}

/* ---------------------------------------------------------------------------
   Outbound frames
   --------------------------------------------------------------------------- */

function sendAudioFrame({
  pcm,
  speechProbability,
  outputLevel: playbackLevel,
  echoProbability,
}) {
  mediaTimeUs += 20_000;
  const mediaDc = window.__openliveMediaDc;

  // Path 1: WebRTC media data channel is open — send binary PCM directly.
  if (webrtcMode && mediaDc && mediaDc.readyState === "open") {
    const packet = encodeInputAudio({
      sequence: nextSequence(),
      mediaTimeUs: mediaTimeUs - 20_000,
      pcm,
      sampleRate: audio.inputSampleRate,
      frameDurationMs: 20,
      speechProbability,
      outputLevel: playbackLevel,
      echoProbability,
    });
    mediaDc.send(packet);
    return;
  }

  // Path 2: WebRTC mode but media DC not open (fallback in progress or
  // channel closed). Fall through to WebSocket instead of dropping the frame.
  // This prevents silent audio gaps during WebRTC→WebSocket transitions.
  if (webrtcMode && (!mediaDc || mediaDc.readyState !== "open")) {
    // If the events DC is also down and we have a WebSocket, use it.
    if (socket?.readyState === WebSocket.OPEN && sessionId) {
      socket.send(
        encodeInputAudio({
          sequence: nextSequence(),
          mediaTimeUs: mediaTimeUs - 20_000,
          pcm,
          sampleRate: audio.inputSampleRate,
          frameDurationMs: 20,
          speechProbability,
          outputLevel: playbackLevel,
          echoProbability,
        }),
      );
      telemetry.expectAck();
    }
    // If neither transport is ready, the frame is silently dropped.
    // This is expected during brief transition windows.
    return;
  }

  // Path 3: Plain WebSocket PCM mode.
  if (!ready()) return;
  socket.send(
    encodeInputAudio({
      sequence: nextSequence(),
      mediaTimeUs: mediaTimeUs - 20_000,
      pcm,
      sampleRate: audio.inputSampleRate,
      frameDurationMs: 20,
      speechProbability,
      outputLevel: playbackLevel,
      echoProbability,
    }),
  );
  telemetry.expectAck();
}

function configureSession() {
  if (!sessionId) return;
  setup = loadSetup();
  const profile = buildInteractionProfile(selectedModeId, settings.backchannels);
  // Merge the mode prefix + speed/detail axes with the new complexity/tone axes.
  const modeInstruction = composeInstruction(
    selectedModeId,
    settings.speedOverride,
    settings.detailOverride,
  );
  const customInstruction = composeCustomInstructions(customInstructions);
  const languageInstruction = languageReplyInstruction(languagePreference);
  const nameInstruction = setup.displayName
    ? `The user's name is ${setup.displayName}. Address them naturally when it fits.`
    : null;
  const fillerInstruction = setup.naturalBackchannels
    ? "Use brief natural listener cues (mhmm, yeah, right) sparingly while the user speaks; do not overuse them."
    : null;
  const instruction = [
    modeInstruction,
    customInstruction,
    languageInstruction,
    nameInstruction,
    fillerInstruction,
  ]
    .filter(Boolean)
    .join(" ");
  sendControl("session", mediaTimeUs, "session_configured", {
    interaction_profile: profile,
    voice: selectedVoice.id,
    instruction: instruction || null,
    entry_mode: settings.entryMode,
    camera_active: cameraActive,
    screen_share_active: screenShareActive,
    visual_input_policy: {
      mode: "explicit_snapshot",
      max_width: 1280,
      max_height: 720,
      max_bytes: 393216,
      durable_retention: false,
    },
    memory_scope: memoryScope,
    durable_memory: false,
    language: languagePreference,
  });
}

function offerCapabilities() {
  if (!ready()) return;
  sendControl("capability", mediaTimeUs, "capability_offer", {
    protocol_revision: 4,
    client_id: "openlive-web-v2",
    requested_modalities: {
      input: ["audio", "text", "image", "screen"],
      output: ["audio", "text", "state"],
    },
    visual_input_policy: {
      mode: "explicit_snapshot",
      max_width: 1280,
      max_height: 720,
      max_bytes: 393216,
      durable_retention: false,
    },
    supports_resume: true,
    supported_languages: ["en", "zh-CN", "zh-TW", "es", "fr", "de", "ja"],
  });
  appendEvidence("Capability offer sent", "Audio, text, state, explicit snapshots, and resume requested", "cyan");
}

function acknowledgePlayout(message) {
  if (!ready()) return;
  telemetry.recordAck();
  sendControl(
    "assistant_playout",
    message.mediaEndUs,
    "output_audio_played",
    { last_media_time_us: message.mediaEndUs },
    message.generationId,
  );
}

function generateEventId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for insecure contexts / older browsers.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function sendControl(streamId, eventMediaTimeUs, type, payload, generationId = null) {
  const envelope = {
    protocol_version: PROTOCOL_VERSION,
    event_id: generateEventId(),
    session_id: sessionId,
    stream_id: streamId,
    sequence: nextSequence(),
    media_time_us: eventMediaTimeUs,
    type,
    payload,
  };
  if (generationId) envelope.generation_id = generationId;
  const json = JSON.stringify(envelope);

  // Path 1: WebRTC events data channel is open — send via DC.
  if (dc && dc.readyState === "open" && webrtcMode) {
    dc.send(json);
    return;
  }

  // Path 2: No WebRTC DC, but WebSocket is open — send via WS.
  // This also covers the fallback transition period when webrtcMode is
  // still true but the DC has closed and a WebSocket is available.
  if (socket?.readyState === WebSocket.OPEN && sessionId) {
    socket.send(json);
    return;
  }

  // Path 3: Neither transport is ready.
  // During a fallback transition, buffer critical control messages briefly
  // and retry once. Non-critical messages are dropped to avoid spam.
  if (CRITICAL_CONTROL_TYPES.has(type) && !fallbackInProgress) {
    addTimeline("transport", `No transport ready for ${type} — will retry after fallback`);
    // Retry once after a short delay (fallback should complete by then).
    setTimeout(() => {
      if (dc?.readyState === "open" && webrtcMode) {
        dc.send(json);
      } else if (socket?.readyState === WebSocket.OPEN && sessionId) {
        socket.send(json);
      }
    }, 500);
  }
  // Non-critical messages are silently dropped during transition.
}

/** Lightweight commit for the gateway WebRTC bridge. */
function sendWebRtcCommit(text) {
  if (dc && dc.readyState === "open" && webrtcMode) {
    dc.send(JSON.stringify({ type: "commit", text: text || "" }));
  }
}

/** Tell the gateway to hard-yield (cancel in-flight generation). */
function requestBargeInCancel() {
  if (!ready() && !(dc && dc.readyState === "open")) return;
  try {
    sendControl("session", mediaTimeUs, "interaction_decision", {
      action: "hard_yield",
      confidence: 1,
      reversible: false,
      reason: "client barge-in (user speech while assistant active)",
      evidence_event_ids: [],
    });
  } catch {
    /* ignore */
  }
}

/**
 * Hard stop: kill TTS + cancel server generation.
 * While the agent is looking something up (THINKING), do NOT abort the fetch —
 * that caused fake "I can't" results when mic noise killed real tool work.
 * Only invalidate speech turns when the assistant is actually speaking.
 * @param {string} [source]
 */
function hardInterruptAssistant(source = "barge-in") {
  const now = Date.now();
  if (now - lastBargeInAt < 180) return;
  lastBargeInAt = now;

  const speakingNow =
    isBrowserSpeaking() ||
    mode === VoiceMode.SPEAKING ||
    mode === VoiceMode.YIELDING;

  // Always silence audio.
  stopBrowserSpeech();
  requestBargeInCancel();
  receivedMediaForGeneration = false;

  // Only kill in-flight *spoken* turns. Let tool work finish in THINKING.
  if (speakingNow) {
    assistantTurnId += 1;
  }

  try {
    fireBargeInRipple();
    visualizer.fireBargeIn();
  } catch {
    /* ignore */
  }
  addTimeline("cancel", `barge-in (${source}) mode=${mode}`);
  if (!conversationActive) return;

  if (mode === VoiceMode.THINKING && !speakingNow) {
    // Keep working in the background; floor stays open for the user.
    transition(VoiceMode.THINKING, "Still looking that up…");
    return;
  }

  transition(VoiceMode.INTERRUPTED, "Go ahead — I'm listening.");
  clearTimeout(hardInterruptAssistant._listenTimer);
  hardInterruptAssistant._listenTimer = setTimeout(() => {
    if (
      conversationActive &&
      microphoneActive &&
      !userEnded &&
      (mode === VoiceMode.INTERRUPTED || mode === VoiceMode.YIELDING)
    ) {
      transition(VoiceMode.LISTENING);
    }
  }, 320);
}

let lastSpokenFinal = "";
let lastSpokenAt = 0;
/** Tracks whether we've already received+played streaming PCM for the current
 * generation. When true, speakAssistant is skipped to avoid double audio. */
let receivedMediaForGeneration = false;

/** Control message types that should be buffered + retried during a transport
 * fallback transition (when neither WebRTC DC nor WebSocket is ready yet).
 * Hoisted to module level so the Set isn't recreated on every sendControl call. */
const CRITICAL_CONTROL_TYPES = new Set([
  "session_configured",
  "interaction_decision",
  "user_transcript_delta",
  "user_transcript_final",
]);

/* ---------------------------------------------------------------------------
   Inbound frames
   --------------------------------------------------------------------------- */

function handleMedia(packet) {
  observeServerSequence(packet.sequence);
  // Prefer the gateway's native TTS pipeline (Piper/formant) when it is
  // actively streaming PCM. This is more reliable than browser TTS alone
  // and avoids the intermittent silence/hang issues seen on Windows
  // Chrome/Edge with speechSynthesis.
  if (packet?.pcm?.length > 0 && audio) {
    receivedMediaForGeneration = true;
    audio.enqueue(packet).catch((error) => {
      console.warn("Failed to enqueue server PCM:", error);
    });
  }
}

function handleControl(envelope) {
  observeServerSequence(envelope.sequence);
  const { type, payload } = envelope;
  if (type === "session_created") {
    sessionId = envelope.session_id;
    audio.setInputSampleRate(payload.input_sample_rate);
    setProviderHint(payload.model, payload.provider_class);
    setConnectionState("connected");
    addTimeline("session", `${payload.model} allocated`);
    if (Array.isArray(payload.voices) && payload.voices.length > 0) {
      voices = resolveVoices(payload.voices);
      selectedVoice = selectVoice(voices, settings.voiceId);
      renderVoiceList(voices, selectedVoice.id, onVoiceSelected);
      setVoiceBadge(selectedVoice.glyph);
    }
    configureSession();
    offerCapabilities();
    connectionWaiter?.resolve();
    connectionWaiter = undefined;
    return;
  }
  if (type === "task_created") {
    const kind = payload.kind || "cognition";
    addTimeline("cognition", `Task path: ${kind}`);
    if (kind === "deep_cognition" || kind === "cognition_complex") {
      transition(VoiceMode.THINKING);
    }
    return;
  }
  if (type === "capability_selected") {
    visualInputSupported = payload.visual_mode === "explicit_snapshot";
    const visualBadge = document.querySelector("#visualCapability");
    if (visualBadge) {
      visualBadge.textContent = visualInputSupported
        ? "Visual snapshots negotiated"
        : "Visual preview local only";
      visualBadge.classList.toggle("on", visualInputSupported);
    }
    const snapshotAction = document.querySelector("#snapshotAction");
    if (snapshotAction) {
      snapshotAction.disabled = !(visualInputSupported && (cameraActive || screenShareActive));
      snapshotAction.title = visualInputSupported
        ? "Share one bounded frame with the active provider"
        : "The selected provider does not accept visual input";
    }
    for (const warning of payload.warnings ?? []) {
      appendEvidence("Capability warning", warning, "yellow");
    }
    appendEvidence(
      "Capabilities negotiated",
      `${payload.provider_manifest?.id ?? "provider"} · visual ${payload.visual_mode} · resume ${payload.resume_supported ? "available" : "unavailable"}`,
      visualInputSupported ? "green" : "cyan",
    );
    return;
  }
  if (type === "visual_input_accepted") {
    appendEvidence(
      "Visual frame accepted",
      `${payload.capture_id} · observation ${payload.provider_observation_id ?? "created"}`,
      "green",
    );
    hideNotice();
    return;
  }
  if (type === "visual_input_rejected") {
    appendEvidence(
      "Visual frame rejected",
      `${payload.code} · ${payload.message}`,
      "yellow",
    );
    showNotice(payload.message);
    return;
  }
  // ── Phase 7: Task & Evidence Orchestration ──────────────────────────
  if (type === "task_acknowledged") {
    taskOrchestrator.applyTaskAcknowledged(payload);
    return;
  }
  if (type === "task_outcome") {
    taskOrchestrator.applyTaskOutcome(payload);
    return;
  }
  if (type === "evidence_link") {
    taskOrchestrator.applyEvidenceLink(payload);
    return;
  }
  if (type === "observation") {
    echoLevel = payload.echo_probability;
    updateSignals();
    return;
  }
  if (type === "endpointing_prediction") {
    if (payload.should_respond) {
      transition(VoiceMode.THINKING);
      addTimeline("endpoint", payload.reason);
    }
    return;
  }
  if (type === "interaction_decision") {
    addTimeline(payload.action, payload.reason);
    audio.applyDecision(payload.action, envelope.generation_id);
    if (payload.action === "start_response") transition(VoiceMode.THINKING);
    if (payload.action === "soft_duck") transition(VoiceMode.YIELDING);
    if (payload.action === "hard_yield") transition(VoiceMode.INTERRUPTED);
    if (payload.action === "resume") transition(VoiceMode.SPEAKING);
    return;
  }
  if (type === "user_transcript_delta") {
    const last = transcript.last();
    if (
      last &&
      last.role === "user" &&
      last.pending &&
      last.generationId === envelope.generation_id
    ) {
      transcript.appendDelta(last.id, payload.delta);
    } else {
      const entry = transcript.beginUserStream(envelope.generation_id);
      transcript.appendDelta(entry.id, payload.delta);
    }
    renderTranscript(transcript.entries);
    return;
  }
  if (type === "user_transcript_final") {
    const text = String(payload.text || "").trim();
    const last = transcript.last();
    if (
      last &&
      last.role === "user" &&
      last.pending &&
      last.generationId === envelope.generation_id
    ) {
      transcript.finalize(last.id, text);
    } else {
      transcript.append("user", text, {
        generationId: envelope.generation_id,
      });
    }
    renderTranscript(transcript.entries);
    handleFinalUserUtterance(text, { source: "gateway" });
    return;
  }
  if (type === "output_text_delta") {
    // Skip painting partial deltas that are pure noise / control junk.
    const d = String(payload.delta || "");
    if (!d || /^[\s*_`#]+$/.test(d)) return;
    assistantText += d;
    transcriptVisible = true;
    setAssistantText(assistantText);
    if (mode !== VoiceMode.SPEAKING && mode !== VoiceMode.INTERRUPTED) {
      transition(VoiceMode.THINKING);
    }
    // Mirror into the transcript log so the user has a persistent record.
    const last = transcript.last();
    if (last && last.role === "assistant" && last.pending && last.generationId === envelope.generation_id) {
      transcript.appendDelta(last.id, payload.delta);
    } else {
      // New assistant stream — reset the media flag so a previous turn's
      // leftover streaming PCM doesn't suppress TTS for this one.
      receivedMediaForGeneration = false;
      const entry = transcript.beginAssistantStream(envelope.generation_id);
      transcript.appendDelta(entry.id, payload.delta);
    }
    renderTranscript(transcript.entries);
    return;
  }
  if (type === "output_text_final") {
    transcriptVisible = true;
    // Never show or speak private model thoughts.
    let finalText = stripThinkingForUser(String(payload.text || "").trim());
    if (!finalText) {
      finalText = softNoAnswer();
    }
    // If user just barged in, don't steamroll them with a late final.
    if (mode === VoiceMode.INTERRUPTED || Date.now() - lastBargeInAt < 600) {
      setAssistantText(finalText);
      assistantText = "";
      transcript.finalizeByGeneration(envelope.generation_id, finalText);
      renderTranscript(transcript.entries);
      return;
    }
    setAssistantText(finalText);
    assistantText = "";
    transcript.finalizeByGeneration(envelope.generation_id, finalText);
    renderTranscript(transcript.entries);
    // Robust TTS: prefer gateway Piper/formant PCM, fall back to browser.
    setup = loadSetup();
    const isSoftAck = /^(mm-?hmm|mhmm|mhm)\.?$/i.test(finalText);
    // Dedupe: gateway can emit the same final twice under race conditions.
    const now = Date.now();
    const isDupe =
      finalText &&
      finalText === lastSpokenFinal &&
      now - lastSpokenAt < 2500;
    if (
      !isDupe &&
      finalText &&
      !userEnded &&
      mode !== VoiceMode.INTERRUPTED &&
      !receivedMediaForGeneration
    ) {
      const speakTurn = assistantTurnId;
      lastSpokenFinal = finalText;
      lastSpokenAt = now;
      transition(VoiceMode.SPEAKING);
      void speakAssistant(finalText, speakTurn, isSoftAck);
    } else if (receivedMediaForGeneration && !isDupe && finalText && !userEnded) {
      // Streaming PCM was already played by handleMedia — just transition.
      transition(VoiceMode.SPEAKING);
    }
    // Reset the media flag for the next turn.
    receivedMediaForGeneration = false;
    clearTimeout(transcriptTimer);
    const hold = isSoftAck
      ? 900
      : Math.min(10000, 1200 + finalText.length * 35);
    transcriptTimer = setTimeout(() => {
      transcriptVisible = false;
      setAssistantText("");
    }, hold);
    return;
  }
  if (type === "output_audio_cancel") {
    addTimeline("cancel", payload.reason);
    hardInterruptAssistant("server-cancel");
    audio.cancel(envelope.generation_id, payload.fade_ms);
    // Clear any stale listen-timer from hardInterruptAssistant so the
    // explicit transition below isn't overridden 320ms later.
    clearTimeout(hardInterruptAssistant._listenTimer);
    transition(microphoneActive ? VoiceMode.LISTENING : VoiceMode.MUTED);
    return;
  }
  if (type === "provider_state") {
    addTimeline("provider", payload.state);
    if (payload.state === "generating") audio.providerGenerating();
    if (["transcribing", "reasoning", "synthesizing", "generating"].includes(payload.state)) {
      transition(VoiceMode.THINKING);
    }
    if (payload.state === "complete") audio.complete(envelope.generation_id);
    return;
  }
  if (type === "latency_mark") {
    const elapsedMs = payload.elapsed_us / 1000;
    telemetry.recordLatency(elapsedMs);
    addTimeline("latency", `${payload.phase}: ${elapsedMs.toFixed(1)} ms`);
    refreshLatencyPill();
    refreshTelemetry();
    return;
  }
  if (type === "barge_in_repair") {
    addTimeline("repair", payload.reason ?? "Barge-in repair context scheduled");
    return;
  }
  if (type === "backchannel") {
    // Provider emitted a short acknowledgement ("mhmm", "I see") while the
    // user was speaking. Surface a subtle visual cue without taking the floor.
    flashBackchannel(payload.text ?? "mhmm");
    addTimeline("backchannel", payload.text ?? "mhmm");
    return;
  }
  if (type === "tool_call_begin") {
    const call = toolCalls.beginCall(payload.call_id, payload.name);
    renderToolCall(call, toolCalls.describe(call.name));
    addTimeline("tool", `Begin ${payload.name}`);
    return;
  }
  if (type === "tool_call_arguments_delta") {
    const call = toolCalls.appendArgumentsDelta(payload.call_id, payload.delta);
    if (call) renderToolCall(call, toolCalls.describe(call.name));
    return;
  }
  if (type === "tool_call_arguments_final") {
    const call = toolCalls.finalizeArguments(payload.call_id, payload.arguments);
    if (call) renderToolCall(call, toolCalls.describe(call.name));
    return;
  }
  if (type === "tool_call_result") {
    const call = toolCalls.completeCall(
      payload.call_id,
      payload.result,
      Boolean(payload.error),
    );
    if (call) renderToolCall(call, toolCalls.describe(call.name));
    addTimeline("tool", `${call?.name ?? "tool"} ${payload.error ? "failed" : "completed"}`);
    return;
  }
  if (type === "visual_card") {
    // The gateway emits a structured card payload. We normalize it through
    // the visual-cards module so the renderer always sees a consistent shape.
    const card = payload.kind
      ? { id: `v${Date.now()}`, createdAt: Date.now(), ...payload }
      : visualCards.genericCard({ title: payload.title ?? "Card", body: payload.body ?? "" });
    renderVisualCard(card);
    addTimeline("card", `${card.kind ?? "generic"}: ${card.title}`);
    return;
  }
  if (type === "error") {
    showNotice(payload.message);
    addTimeline("error", `${payload.code}: ${payload.message}`);
  }
}

/* ---------------------------------------------------------------------------
   Signal & mode transitions
   --------------------------------------------------------------------------- */

function updateInputActivity(speechProbability, echoProbability) {
  inputLevel = speechProbability * (1 - echoProbability);
  echoLevel = echoProbability;
  updateSignals();

  // Mic-energy barge-in only while assistant is *speaking* (not while tools run).
  // Cancelling THINKING used to drop real search results and invent "I can't".
  const assistantSpeaking =
    isBrowserSpeaking() ||
    mode === VoiceMode.SPEAKING ||
    mode === VoiceMode.YIELDING;
  if (
    conversationActive &&
    microphoneActive &&
    assistantSpeaking &&
    inputLevel > 0.4 &&
    echoProbability < 0.58
  ) {
    hardInterruptAssistant("mic-energy");
    return;
  }

  if (
    conversationActive &&
    microphoneActive &&
    inputLevel > 0.58 &&
    !isBrowserSpeaking() &&
    outputLevel < 0.04 &&
    mode !== VoiceMode.THINKING
  ) {
    clearTimeout(transcriptTimer);
    if (transcriptVisible) {
      transcriptVisible = false;
      setAssistantText("");
    }
    if (settings.entryMode !== "ptt") {
      transition(VoiceMode.LISTENING);
    }
  }
}

function updateOutputActivity(level) {
  outputLevel = level;
  updateSignals();
  if (
    conversationActive &&
    level > 0.012 &&
    inputLevel < 0.55 &&
    mode !== VoiceMode.INTERRUPTED &&
    mode !== VoiceMode.YIELDING
  ) {
    transition(VoiceMode.SPEAKING);
  }
}

function updateSignals() {
  setSignalLevels(inputLevel, outputLevel, echoLevel);
  visualizer.setSignals(inputLevel, outputLevel);
}

function transition(nextMode, detail) {
  if (nextMode === mode && detail === undefined) return;
  const prev = mode;
  mode = nextMode;
  setVoiceMode(nextMode, detail);
  visualizer.setMode(nextMode);
  // Soft mode chimes for major conversational floor changes only.
  if (
    prev !== nextMode &&
    ["listening", "speaking", "thinking", "starting", "idle", "yielding"].includes(nextMode)
  ) {
    playModeChime(nextMode);
  }
}

function observeServerSequence(serverSequence) {
  if (serverSequence <= lastServerSequence) {
    throw new Error(
      `Server sequence regressed from ${lastServerSequence} to ${serverSequence}`,
    );
  }
  lastServerSequence = serverSequence;
}

function nextSequence() {
  sequence += 1;
  return sequence;
}

function ready() {
  // WebRTC path: data channel open + session ID.
  if (webrtcMode && dc?.readyState === "open" && sessionId) return true;
  // WebSocket path: socket open + session ID.
  // Also true during fallback when webrtcMode is still set but a WS is available.
  if (sessionId && socket?.readyState === WebSocket.OPEN) return true;
  return false;
}

/* ---------------------------------------------------------------------------
   Voice picker & mode picker
   --------------------------------------------------------------------------- */

function onVoiceSelected(voice) {
  selectedVoice = voice;
  settings = saveSettings({ voiceId: voice.id });
  setup = saveSetup({ voiceId: voice.id });
  void pushLlmConfig(setup).catch(() => {});
  setVoiceBadge(voice.glyph);
  renderVoiceList(voices, voice.id, onVoiceSelected);
  toggleVoicePicker(false);
  if (sessionId) configureSession();
  addTimeline("voice", `Voice set to ${voice.name}`);
}

function onModeSelected(modeItem) {
  selectedModeId = modeItem.id;
  settings = saveSettings({ modeId: modeItem.id });
  setModeBadge(modeItem.name.split(" ")[0]);
  renderModeList(MODES, modeItem.id, onModeSelected);
  toggleModePicker(false);
  if (sessionId) configureSession();
  addTimeline("mode", `Mode set to ${modeItem.name}`);
  transcript.append("system", `Switched to ${modeItem.name}.`);
  renderTranscript(transcript.entries);
}

function cycleMode() {
  const index = MODES.findIndex((m) => m.id === selectedModeId);
  const next = MODES[(index + 1) % MODES.length];
  onModeSelected(next);
}

/* ---------------------------------------------------------------------------
   Settings persistence & UI sync
   --------------------------------------------------------------------------- */

function persistField(field, value, reconfigure = false) {
  settings = saveSettings({ [field]: value });
  if (reconfigure && sessionId) configureSession();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Both "minimal" and "chatgpt" (Live Presence) use the minimal UI layout.
  // "classic" is for the older aurora/graphite/signal themes with full rails.
  document.body.dataset.ui = theme === "minimal" || theme === "chatgpt" ? "minimal" : "classic";
  if (controls.themeSelect) controls.themeSelect.value = theme;
  settings = saveSettings({ theme });
}

function applyFullscreen(enabled) {
  const doc = document.documentElement;
  if (!doc) return;
  if (enabled) {
    if (doc.requestFullscreen) {
      doc.requestFullscreen().catch(() => {});
    } else if (doc.webkitRequestFullscreen) {
      doc.webkitRequestFullscreen();
    }
  } else if (document.fullscreenElement) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function refreshFullscreenToggle() {
  if (controls.fullscreenToggle) {
    controls.fullscreenToggle.checked = settings.fullscreen;
  }
}

function applyEntryMode() {
  if (controls.entryMode) controls.entryMode.value = settings.entryMode;
  setConversationActive(
    conversationActive,
    microphoneActive,
    settings.entryMode === "ptt",
  );
}

function applySettingsForm() {
  if (controls.backchannels) controls.backchannels.value = settings.backchannels;
  if (controls.entryMode) controls.entryMode.value = settings.entryMode;
  if (controls.speedOverride) controls.speedOverride.value = settings.speedOverride;
  if (controls.detailOverride) controls.detailOverride.value = settings.detailOverride;
  if (controls.complexityOverride) controls.complexityOverride.value = settings.complexityOverride;
  if (controls.toneOverride) controls.toneOverride.value = settings.toneOverride;
  if (controls.themeSelect) controls.themeSelect.value = settings.theme;
  if (controls.motionRange) {
    controls.motionRange.value = String(Math.round(settings.motionScale * 100));
    updateRangeFill(controls.motionRange);
  }
  if (controls.latencyToggle) controls.latencyToggle.checked = settings.showLatency;
  setMotionReadout(settings.motionScale);
  syncSettingsFormInstructions();
  applySessionCapFromSettings();
}

function syncSettingsFormInstructions() {
  customInstructions = loadCustomInstructions();
  if (controls.speedOverride) controls.speedOverride.value = customInstructions.speed;
  if (controls.detailOverride) controls.detailOverride.value = customInstructions.detail;
  if (controls.complexityOverride) controls.complexityOverride.value = customInstructions.complexity;
  if (controls.toneOverride) controls.toneOverride.value = customInstructions.tone;
}

function applySessionCapFromSettings() {
  if (!controls.sessionCap) return;
  // The session cap is operator-configured at runtime; default to unlimited.
  const minutes = Number(controls.sessionCap.value) || 0;
  quota.configure({ hardCapSeconds: minutes * 60 });
}

function refreshInstructionsBadge() {
  const active = Object.keys(AXES).some(
    (axis) => customInstructions[axis] && customInstructions[axis] !== "auto",
  );
  setInstructionsBadge(active);
}

function onInstructionAxisChange(axis, value) {
  customInstructions = setAxis(axis, value);
  // Mirror into the persisted settings so applySettingsForm shows the right value.
  settings = loadSettings();
  refreshInstructionsBadge();
  syncSettingsFormInstructions();
  renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  if (sessionId) configureSession();
  addTimeline("instructions", `${axis} → ${value}`);
}

function refreshLatencyPill() {
  const p50 = telemetry.p50();
  setLatencyPill(p50, telemetry.quality(), settings.showLatency && conversationActive);
}

function refreshTelemetry() {
  setTelemetry({
    p50: telemetry.p50(),
    p95: telemetry.p95(),
    jitter: telemetry.jitter(),
    loss: telemetry.lossRatio(),
    quality: telemetry.quality(),
  });
}

/* ---------------------------------------------------------------------------
   Visual capture — real local previews and explicit bounded snapshots
   --------------------------------------------------------------------------- */

async function toggleCamera() {
  controls.camera.disabled = true;
  try {
    await mediaCapture.toggleCamera();
    hideNotice();
  } catch (error) {
    showNotice(visualCaptureErrorMessage("camera", error));
  } finally {
    controls.camera.disabled = false;
  }
}

async function toggleScreenShare() {
  controls.screenShare.disabled = true;
  try {
    await mediaCapture.toggleScreen();
    hideNotice();
  } catch (error) {
    if (error?.name !== "NotAllowedError") {
      showNotice(visualCaptureErrorMessage("screen", error));
    }
  } finally {
    controls.screenShare.disabled = false;
  }
}

function handleCaptureState({ kind, status, detail, state }) {
  cameraActive = state.camera.active;
  screenShareActive = state.screen.active;
  setCameraActive(cameraActive);
  setScreenShareActive(screenShareActive);

  const cameraFigure = document.querySelector("#cameraFigure");
  const screenFigure = document.querySelector("#screenFigure");
  const captureEmpty = document.querySelector("#captureEmpty");
  const snapshotAction = document.querySelector("#snapshotAction");
  if (cameraFigure) cameraFigure.hidden = !cameraActive;
  if (screenFigure) screenFigure.hidden = !screenShareActive;
  if (captureEmpty) captureEmpty.hidden = cameraActive || screenShareActive;
  if (snapshotAction) {
    snapshotAction.disabled = !(visualInputSupported && (cameraActive || screenShareActive));
  }
  document.querySelector("#captureStage")?.setAttribute(
    "data-empty",
    String(!(cameraActive || screenShareActive)),
  );
  if (kind === "camera") {
    const truth = document.querySelector("#cameraTruth");
    if (truth) truth.textContent = cameraActive ? "Local · not sent" : status;
  }
  if (kind === "screen") {
    const truth = document.querySelector("#screenTruth");
    if (truth) truth.textContent = screenShareActive ? "Local · not sent" : status;
  }

  addTimeline(kind, `${status}: ${detail}`);
  appendEvidence(
    kind === "camera" ? "Camera state changed" : "Screen state changed",
    `${status} · ${detail}`,
    status === "active" ? "cyan" : "yellow",
  );
  if (sessionId) configureSession();
}

async function shareVisualSnapshot() {
  const source = screenShareActive ? "screen" : cameraActive ? "camera" : null;
  if (!source) return;
  if (!visualInputSupported) {
    showNotice("The selected provider does not accept visual input. Your preview remains local and was not sent.");
    appendEvidence("Visual share blocked", "Provider capability is unsupported; no frame left the browser", "yellow");
    return;
  }
  if (!ready()) {
    showNotice("Start a conversation before sharing a visual frame. The preview remains local.");
    return;
  }

  const button = document.querySelector("#snapshotAction");
  if (button) button.disabled = true;
  try {
    let snapshot = await mediaCapture.snapshot(source);
    if (snapshot.blob.size > 393_216) {
      snapshot = await mediaCapture.snapshot(source, {
        maxWidth: 960,
        maxHeight: 540,
        quality: 0.64,
      });
    }
    if (snapshot.blob.size > 393_216) {
      throw new Error("The visual frame is still larger than the 384 KB safety limit.");
    }
    const dataUrl = await blobToDataUrl(snapshot.blob);
    const captureId = crypto.randomUUID();
    sendControl("visual", mediaTimeUs, "visual_input", {
      capture_id: captureId,
      source,
      mime_type: snapshot.mimeType,
      width: snapshot.width,
      height: snapshot.height,
      byte_length: snapshot.blob.size,
      captured_at: snapshot.capturedAt,
      retention: "ephemeral",
      consent: "explicit_button_press",
      data_url: dataUrl,
    });
    appendEvidence(
      "Visual frame shared",
      `${source} · ${snapshot.width}×${snapshot.height} · ${Math.ceil(snapshot.blob.size / 1024)} KB · ephemeral`,
      "green",
    );
    addTimeline("visual_input", `${source} snapshot ${captureId}`);
    showNotice("One bounded visual frame was shared and recorded in Evidence.");
  } catch (error) {
    showNotice(error?.message ?? "The visual frame could not be shared.");
    appendEvidence("Visual frame failed", error?.message ?? "Capture error", "yellow");
  } finally {
    if (button) {
      button.disabled = !(visualInputSupported && (cameraActive || screenShareActive));
    }
  }
}

function appendEvidence(title, detail, tone = "cyan") {
  const list = document.querySelector("#evidenceFeed");
  if (!list) return;
  const item = document.createElement("li");
  const dot = document.createElement("i");
  dot.className = tone;
  const content = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = detail;
  const time = document.createElement("time");
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  content.append(heading, description, time);
  item.append(dot, content);
  list.prepend(item);
  while (list.children.length > 24) list.lastElementChild?.remove();
  const count = document.querySelector("#evidenceCount");
  if (count) count.textContent = String(list.children.length);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Snapshot read failed.")), { once: true });
    reader.readAsDataURL(blob);
  });
}

/* ---------------------------------------------------------------------------
   Phase 7: Task rail & session resume
   --------------------------------------------------------------------------- */

/**
 * Send a `session_resume` envelope so the gateway replays buffered outcomes
 * whose sequence is strictly greater than `lastServerSequence`. Called
 * automatically after a transport reconnect (see `scheduleReconnect`).
 *
 * Design contract: the client never fabricates `last_sequence_seen`. We use
 * the highest sequence number we have actually observed from the gateway,
 * tracked by `observeServerSequence`. The gateway deduplicates by
 * `event_id` so even if we send a stale value, the replay will not produce
 * duplicate evidence in our ledger.
 */
function resumeSession() {
  if (!ready()) return;
  sendControl("session", mediaTimeUs, "session_resume", {
    session_id: sessionId,
    last_sequence_seen: lastServerSequence,
    replay_evidence: true,
  });
  appendEvidence(
    "Session resume requested",
    `Replaying events after sequence ${lastServerSequence}`,
    "cyan",
  );
}

/**
 * Initialize the task rail UI: wire the "New task" button and render the
 * current task list (loaded from localStorage by the orchestrator
 * constructor).
 */
function initializeTaskRail() {
  const addButton = controls.taskAdd || document.querySelector("#taskAdd");
  if (addButton) {
    addButton.addEventListener("click", () => {
      const fromComposer = controls.composerInput?.value?.trim();
      const intent =
        fromComposer ||
        window.prompt("What should the background agent do?");
      if (!intent || !intent.trim()) return;
      if (fromComposer && controls.composerInput) controls.composerInput.value = "";
      void dispatchUserTask(intent.trim(), { forceAgent: true });
    });
  }
  taskOrchestrator.render();
}

/* ---------------------------------------------------------------------------
   Setup wizard · agent bridge · filler-aware speech
   --------------------------------------------------------------------------- */

function wireSetupWizard() {
  document.querySelectorAll(".setup-step").forEach((btn) => {
    btn.addEventListener("click", () => {
      const step = Number(btn.dataset.step);
      if (Number.isFinite(step)) {
        playClick("soft");
        goSetupStep(step);
      }
    });
  });
  controls.setupBack?.addEventListener("click", () => {
    playClick("soft");
    if (setupStep === "voice" || setupStep === 0) {
      goSetupStep("welcome");
    } else {
      goSetupStep(setupStep - 1);
    }
  });
  controls.setupNext?.addEventListener("click", () => {
    if (setupStep === "welcome") {
      playClick("tap");
      expandNextToVoice();
      return;
    }
    if (typeof setupStep === "number" && setupStep < 2) {
      playClick("tap");
      goSetupStep(setupStep + 1);
      return;
    }
    playClick("confirm");
    finishSetupWizard();
  });
  controls.setupProbeAgent?.addEventListener("click", () => {
    playClick("soft");
    void probeAgentFromForm("setup");
  });
  controls.setupLlmProvider?.addEventListener("change", () => {
    applyProviderPreset(controls.setupLlmProvider.value, "setup");
  });
  controls.setupFetchModels?.addEventListener("click", () => {
    void withLoading(controls.setupFetchModels, fetchModelsInto("setup"));
  });
  controls.setupLlmModelSelect?.addEventListener("change", (e) => {
    if (controls.setupLlmModel) controls.setupLlmModel.value = e.target.value;
  });
}

function wireUiSoundToggle() {
  const host = document.querySelector("#settingsPanel .sheet-body");
  if (!host || document.querySelector("#uiSoundToggle")) return;
  const fieldset = document.createElement("fieldset");
  fieldset.className = "sheet-group";
  fieldset.innerHTML = `
    <legend>Feel</legend>
    <label class="checkbox-row" for="uiSoundToggle">
      <input id="uiSoundToggle" type="checkbox" ${isUiSoundMuted() ? "" : "checked"} />
      <span>Tactile sounds (slider ticks, soft clicks)</span>
    </label>
    <p class="setup-hint">Subtle Web Audio feedback — never interrupts voice.</p>
  `;
  // Insert before Runtime if present, else append.
  const runtime = [...host.querySelectorAll("fieldset")].find((f) =>
    f.querySelector("legend")?.textContent?.includes("Runtime"),
  );
  if (runtime) host.insertBefore(fieldset, runtime);
  else host.appendChild(fieldset);
  document.querySelector("#uiSoundToggle")?.addEventListener("change", (event) => {
    setUiSoundMuted(!event.target.checked);
    if (event.target.checked) {
      unlockUiAudio();
      playClick("confirm");
    }
  });
}

function wireSetupSettingsBindings() {
  const persistLlm = () => {
    setup = saveSetup({
      llmProviderId: controls.settingsLlmProvider?.value || setup.llmProviderId,
      modelBaseUrl: controls.settingsModelUrl?.value?.trim() || setup.modelBaseUrl,
      modelApiKey: controls.settingsModelKey?.value ?? setup.modelApiKey,
      llmModel: controls.settingsLlmModel?.value?.trim() || setup.llmModel,
      agentKind: controls.settingsAgentKind?.value || setup.agentKind,
      voiceId: controls.settingsVoice?.value || setup.voiceId,
    });
    void pushLlmConfig(setup).catch(() => {});
  };
  controls.settingsModelUrl?.addEventListener("change", persistLlm);
  controls.settingsModelKey?.addEventListener("change", persistLlm);
  controls.settingsLlmModel?.addEventListener("change", persistLlm);
  controls.settingsAgentKind?.addEventListener("change", persistLlm);
  controls.settingsLlmProvider?.addEventListener("change", () => {
    applyProviderPreset(controls.settingsLlmProvider.value, "settings");
    persistLlm();
  });
  controls.settingsFetchModels?.addEventListener("click", () =>
    void withLoading(controls.settingsFetchModels, fetchModelsInto("settings")),
  );
  controls.settingsLlmModelSelect?.addEventListener("change", (e) => {
    if (controls.settingsLlmModel) controls.settingsLlmModel.value = e.target.value;
    persistLlm();
  });
  controls.settingsVoice?.addEventListener("change", () => {
    const id = controls.settingsVoice.value;
    setup = saveSetup({ voiceId: id });
    selectedVoice = selectVoice(voices, id);
    settings = saveSettings({ voiceId: id });
    setVoiceBadge(selectedVoice.glyph);
    void pushLlmConfig(setup);
  });
  controls.settingsSystemVoice?.addEventListener("change", () => {
    setup = saveSetup({
      browserVoiceURI: controls.settingsSystemVoice.value || "",
    });
  });
  controls.settingsRefreshVoices?.addEventListener("click", () => {
    playClick("soft");
    void refreshTtsStatusUi().then(() => showNotice("TTS status refreshed."));
  });
  controls.settingsInstallPiper?.addEventListener("click", () => {
    playClick("soft");
    void fetchTtsStatus().then((st) => showPiperInstallModal(piperInstallUi(st)));
  });
  controls.settingsExportMemory?.addEventListener("click", () => {
    playClick("soft");
    void exportMemory().then(() => showNotice("Memory exported as JSON."));
  });
  controls.settingsClearMemory?.addEventListener("click", async () => {
    playClick("soft");
    if (!confirm("Clear saved OpenLive memory?")) return;
    const { clearMemory } = await import("./memory-client.js");
    await clearMemory();
    showNotice("Memory cleared.");
  });
  controls.settingsRefreshProfile?.addEventListener("click", () => {
    playClick("soft");
    void refreshProfileUi({ fillForm: true });
  });
  controls.settingsSaveProfile?.addEventListener("click", () => {
    playClick("confirm");
    void saveProfileFromForm();
  });
  controls.settingsClearFacts?.addEventListener("click", async () => {
    playClick("soft");
    if (!confirm("Remove all saved profile facts?")) return;
    await fetch("/v1/profile/facts/clear", { method: "POST" });
    showNotice("Facts cleared.");
    void refreshProfileUi({ fillForm: true });
  });
  controls.settingsExportProfile?.addEventListener("click", () => {
    playClick("soft");
    void exportProfileJson();
  });
  controls.settingsClearProfile?.addEventListener("click", async () => {
    playClick("soft");
    if (!confirm("Clear durable user profile (name, facts)?")) return;
    await fetch("/v1/profile/clear", { method: "POST" });
    showNotice("Profile cleared.");
    void refreshProfileUi({ fillForm: true });
  });
  controls.settingsTtsEngine?.addEventListener("change", () => {
    setup = saveSetup({ ttsEngine: controls.settingsTtsEngine.value || "auto" });
    void syncSetupToProfile();
  });
  controls.settingsThoughtDepth?.addEventListener("change", () => {
    setup = saveSetup({ thoughtDepth: controls.settingsThoughtDepth.value || "voice" });
    void syncSetupToProfile();
  });
  controls.settingsAgentClass?.addEventListener("change", () => {
    setup = saveSetup({ agentClass: controls.settingsAgentClass.value || "general" });
    void syncSetupToProfile();
  });
  controls.settingsLanguage?.addEventListener("change", () => {
    void syncSetupToProfile();
  });
  controls.settingsVoice?.addEventListener("change", () => {
    void syncSetupToProfile();
  });
  controls.settingsSandboxRefresh?.addEventListener("click", () => {
    playClick("soft");
    void refreshSandboxUi();
  });
  controls.settingsSandboxSelfTest?.addEventListener("click", () => {
    playClick("soft");
    void runSandboxSelfTest();
  });
  controls.settingsDeepDemo?.addEventListener("click", () => {
    playClick("soft");
    void runDeepPoolDemo();
  });
  controls.settingsShotDemo?.addEventListener("click", () => {
    playClick("soft");
    void runScreenshotDemo();
  });
  controls.settingsPreviewVoice?.addEventListener("click", () => void previewSelectedVoice());
  controls.settingsBrowserTts?.addEventListener("change", (e) => {
    setup = saveSetup({ browserTts: !!e.target.checked });
  });
  controls.settingsProbeAgent?.addEventListener("click", () =>
    void withLoading(controls.settingsProbeAgent, probeAgentFromForm("settings")),
  );
  controls.reopenSetup?.addEventListener("click", () => {
    toggleSettings(false);
    openSetupWizard({ force: true });
  });
}

async function bootstrapLlmUi() {
  setBootStatus("Connecting to gateway…");
  try {
    const data = await fetchLlmProviders();
    llmProviders = data.providers || [];
  } catch {
    llmProviders = [];
    setBootStatus("Gateway offline — using defaults…");
  }
  setBootStatus(llmProviders.length ? "Loading voices…" : "Gateway offline — using defaults…");
  fillProviderSelects();
  // Profile roster (always fill, even if gateway voices fail).
  fillVoiceSelect(OFFLINE_VOICES);
  try {
    const v = await fetchVoices();
    if (v.voices?.length) {
      fillVoiceSelect(v.voices);
    }
  } catch {
    /* offline roster already in picker */
  }
  // Real OS voices + Piper status.
  await fillSystemVoiceSelect();
  await refreshTtsStatusUi();
  populateSetupForm(setup);
  applySetupToSettingsForm();
}

async function refreshTtsStatusUi() {
  await fillSystemVoiceSelect();
  try {
    const st = await fetchTtsStatus();
    const ui = piperInstallUi(st);
    const el = controls.settingsPiperStatus;
    if (el) {
      if (ui.available) {
        el.textContent = `Piper ready · ${ui.model || "model ok"}`;
        el.style.color = "var(--good)";
      } else {
        el.textContent = `${ui.note || "Piper not installed."} Click “Piper install cmd”.`;
        el.style.color = "var(--warn)";
      }
    }
    if (controls.settingsTtsEngine && setup.ttsEngine) {
      controls.settingsTtsEngine.value = setup.ttsEngine;
    }
    if (controls.settingsThoughtDepth && setup.thoughtDepth) {
      controls.settingsThoughtDepth.value = setup.thoughtDepth;
    }
    if (controls.settingsAgentClass && setup.agentClass) {
      controls.settingsAgentClass.value = setup.agentClass;
    }
  } catch {
    /* ignore */
  }
  void refreshSandboxUi();
  void refreshProfileUi({ applySetup: true });
}

async function refreshProfileUi(opts = {}) {
  const el = controls.settingsProfileStatus;
  if (!el) return;
  try {
    const r = await fetch("/v1/profile");
    const data = await r.json().catch(() => ({}));
    const p = data.profile || {};
    const hints = data.setup_hints || {};
    const name = p.display_name || "(no name)";
    const facts = Array.isArray(p.facts) ? p.facts.length : 0;
    const tz = p.timezone ? ` · ${p.timezone}` : "";
    el.textContent = `Profile: ${name}${p.preferred_language ? ` · ${p.preferred_language}` : ""}${tz} · ${facts} facts`;
    el.style.color = p.display_name ? "var(--good)" : "";

    if (opts.fillForm !== false) {
      if (controls.settingsProfileName) {
        controls.settingsProfileName.value = p.display_name || "";
      }
      if (controls.settingsProfileTimezone) {
        controls.settingsProfileTimezone.value =
          p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      }
      if (controls.settingsProfileNotes) {
        controls.settingsProfileNotes.value = p.notes || "";
      }
      if (controls.settingsProfileFact) {
        controls.settingsProfileFact.value = "";
      }
    }

    renderProfileFactList(Array.isArray(p.facts) ? p.facts : []);

    // Hydrate setup from durable profile once (or when forced).
    if (opts.applySetup || opts.forceApply) {
      applyProfileHintsToSetup(hints);
    }
  } catch {
    el.textContent = "Profile unavailable (gateway down?).";
    el.style.color = "var(--warn)";
  }
}

function renderProfileFactList(facts) {
  const list = controls.settingsProfileFactList;
  if (!list) return;
  list.innerHTML = "";
  list.classList.add("profile-fact-list-dnd");
  if (!facts.length) {
    const li = document.createElement("li");
    li.className = "profile-fact-empty";
    li.textContent = "(no facts yet — add one above or say “remember that…”)";
    list.appendChild(li);
    return;
  }

  // Keep a working order for DnD until server confirms.
  let order = facts.map((_, i) => i);

  facts.forEach((fact, index) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.index = String(index);
    li.classList.add("profile-fact-item");

    const grip = document.createElement("span");
    grip.className = "profile-fact-grip";
    grip.textContent = "⋮⋮";
    grip.title = "Drag to reorder";
    grip.setAttribute("aria-hidden", "true");

    const span = document.createElement("span");
    span.className = "profile-fact-text";
    span.textContent = fact;
    span.title = "Double-click to edit · drag handle to reorder";
    span.addEventListener("dblclick", () => {
      playClick("soft");
      beginEditProfileFact(li, index, fact);
    });

    const actions = document.createElement("div");
    actions.className = "profile-fact-actions";

    const up = document.createElement("button");
    up.type = "button";
    up.className = "profile-fact-move";
    up.textContent = "↑";
    up.disabled = index === 0;
    up.title = "Move up";
    up.addEventListener("click", () => {
      playClick("soft");
      void moveProfileFact(index, "up");
    });

    const down = document.createElement("button");
    down.type = "button";
    down.className = "profile-fact-move";
    down.textContent = "↓";
    down.disabled = index === facts.length - 1;
    down.title = "Move down";
    down.addEventListener("click", () => {
      playClick("soft");
      void moveProfileFact(index, "down");
    });

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "profile-fact-edit";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      playClick("soft");
      beginEditProfileFact(li, index, fact);
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "profile-fact-remove";
    btn.textContent = "Remove";
    btn.setAttribute("aria-label", `Remove fact: ${fact}`);
    btn.addEventListener("click", () => {
      playClick("soft");
      void removeProfileFactAt(index);
    });

    actions.append(up, down, edit, btn);
    li.append(grip, span, actions);

    li.addEventListener("dragstart", (e) => {
      if (li.dataset.editing === "1") {
        e.preventDefault();
        return;
      }
      li.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
      // Some browsers need a type set for drop to fire.
      e.dataTransfer.setData("application/x-openlive-fact-index", String(index));
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("is-dragging");
      list.querySelectorAll(".profile-fact-item").forEach((el) => {
        el.classList.remove("drag-over");
      });
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      li.classList.add("drag-over");
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drag-over");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("drag-over");
      const fromRaw =
        e.dataTransfer.getData("application/x-openlive-fact-index") ||
        e.dataTransfer.getData("text/plain");
      const from = Number.parseInt(fromRaw, 10);
      const to = Number.parseInt(li.dataset.index || "-1", 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
      // Build new permutation of original indices.
      order = facts.map((_, i) => i);
      const next = order.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      order = next;
      playClick("soft");
      void reorderProfileFacts(order);
    });

    list.appendChild(li);
  });
}

function beginEditProfileFact(li, index, fact) {
  if (!li || li.dataset.editing === "1") return;
  li.dataset.editing = "1";
  li.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "profile-fact-input";
  input.maxLength = 200;
  input.value = fact;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "profile-fact-edit";
  save.textContent = "OK";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "profile-fact-move";
  cancel.textContent = "Cancel";
  const actions = document.createElement("div");
  actions.className = "profile-fact-actions";
  actions.append(save, cancel);
  li.append(input, actions);
  input.focus();
  input.select();

  const finish = async (commit) => {
    if (commit) {
      const next = input.value.trim();
      if (!next) {
        showNotice("Fact cannot be empty.");
        return;
      }
      if (next !== fact) {
        await updateProfileFactAt(index, next);
        return;
      }
    }
    void refreshProfileUi({ fillForm: true });
  };
  save.addEventListener("click", () => void finish(true));
  cancel.addEventListener("click", () => void finish(false));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      void finish(false);
    }
  });
}

async function removeProfileFactAt(index) {
  try {
    const r = await fetch("/v1/profile/facts/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      showNotice(data.error || "Could not remove fact");
      return;
    }
    showNotice("Fact removed.");
    void refreshProfileUi({ fillForm: true });
  } catch (e) {
    showNotice(e?.message || "Remove failed");
  }
}

async function updateProfileFactAt(index, fact) {
  try {
    const r = await fetch("/v1/profile/facts/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index, fact }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      showNotice(data.error || "Could not update fact");
      return;
    }
    showNotice("Fact updated.");
    void refreshProfileUi({ fillForm: true });
  } catch (e) {
    showNotice(e?.message || "Update failed");
  }
}

async function moveProfileFact(from, direction) {
  try {
    const r = await fetch("/v1/profile/facts/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, direction }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      showNotice(data.error || "Could not move fact");
      return;
    }
    void refreshProfileUi({ fillForm: true });
  } catch (e) {
    showNotice(e?.message || "Move failed");
  }
}

async function reorderProfileFacts(order) {
  try {
    const r = await fetch("/v1/profile/facts/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      showNotice(data.error || "Could not reorder facts");
      void refreshProfileUi({ fillForm: true });
      return;
    }
    void refreshProfileUi({ fillForm: true });
  } catch (e) {
    showNotice(e?.message || "Reorder failed");
    void refreshProfileUi({ fillForm: true });
  }
}

async function saveProfileFromForm() {
  const body = {
    display_name: controls.settingsProfileName?.value?.trim() || undefined,
    timezone: controls.settingsProfileTimezone?.value?.trim() || undefined,
    notes: controls.settingsProfileNotes?.value?.trim() || undefined,
    fact: controls.settingsProfileFact?.value?.trim() || undefined,
    // Keep setup prefs in sync when saving form.
    tts_engine: setup.ttsEngine || undefined,
    voice_id: setup.voiceId || undefined,
    thought_depth: setup.thoughtDepth || undefined,
    agent_class: setup.agentClass || undefined,
  };
  // Drop empty keys so patch doesn't fail on empty-only payload.
  Object.keys(body).forEach((k) => {
    if (body[k] === undefined || body[k] === "") delete body[k];
  });
  if (!Object.keys(body).length) {
    showNotice("Nothing to save.");
    return;
  }
  try {
    const r = await fetch("/v1/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      showNotice(data.error || "Save failed");
      return;
    }
    showNotice("Profile saved.");
    void refreshProfileUi({ fillForm: true });
  } catch (e) {
    showNotice(e?.message || "Save failed");
  }
}

function applyProfileHintsToSetup(hints) {
  if (!hints || typeof hints !== "object") return;
  const patch = {};
  if (hints.tts_engine && !setup.ttsEngineFromUser) {
    patch.ttsEngine = hints.tts_engine;
  }
  if (hints.voice_id) patch.voiceId = hints.voice_id;
  if (hints.thought_depth) patch.thoughtDepth = hints.thought_depth;
  if (hints.agent_class) patch.agentClass = hints.agent_class;
  if (Object.keys(patch).length) {
    setup = saveSetup(patch);
    if (controls.settingsTtsEngine && patch.ttsEngine) {
      controls.settingsTtsEngine.value = patch.ttsEngine;
    }
    if (controls.settingsThoughtDepth && patch.thoughtDepth) {
      controls.settingsThoughtDepth.value = patch.thoughtDepth;
    }
    if (controls.settingsAgentClass && patch.agentClass) {
      controls.settingsAgentClass.value = patch.agentClass;
    }
    if (controls.settingsVoice && patch.voiceId) {
      controls.settingsVoice.value = patch.voiceId;
    }
    if (controls.settingsLanguage && hints.preferred_language) {
      // Map bare codes loosely onto language select when possible.
      const lang = String(hints.preferred_language);
      const opt = [...(controls.settingsLanguage.options || [])].find(
        (o) => o.value === lang || o.value.startsWith(lang),
      );
      if (opt) controls.settingsLanguage.value = opt.value;
    }
  }
}

/** Persist current setup prefs into durable profile (best-effort). */
async function syncSetupToProfile() {
  try {
    await fetch("/v1/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tts_engine: setup.ttsEngine || "auto",
        voice_id: setup.voiceId || undefined,
        thought_depth: setup.thoughtDepth || "voice",
        agent_class: setup.agentClass || "general",
        preferred_language: controls.settingsLanguage?.value || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
      }),
    });
  } catch {
    /* ignore */
  }
}

async function exportProfileJson() {
  try {
    const r = await fetch("/v1/profile/export");
    const data = await r.json().catch(() => ({}));
    const blob = new Blob([JSON.stringify(data.profile || data, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `openlive-profile-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showNotice("Profile exported.");
  } catch (e) {
    showNotice(e?.message || "Export failed");
  }
}

async function refreshSandboxUi() {
  const statusEl = controls.settingsSandboxStatus;
  const listEl = controls.settingsSandboxList;
  if (!statusEl && !listEl) return;
  try {
    const r = await fetch("/v1/sandbox/status");
    const data = await r.json().catch(() => ({}));
    const sb = data.sandbox || {};
    if (statusEl) {
      statusEl.textContent = sb.exists
        ? `Workspace: ${sb.workspace || "ready"} · ${(sb.files || []).length} top-level items`
        : "Sandbox not created yet (will initialize on first file tool use).";
      statusEl.style.color = sb.exists ? "var(--good)" : "var(--warn)";
    }
    if (listEl) {
      listEl.innerHTML = "";
      const files = sb.files || [];
      if (!files.length) {
        const li = document.createElement("li");
        li.textContent = "(empty — ask the agent to write_file notes/hello.txt)";
        li.className = "sandbox-file-empty";
        listEl.appendChild(li);
      } else {
        for (const f of files.slice(0, 40)) {
          const li = document.createElement("li");
          li.textContent = f;
          listEl.appendChild(li);
        }
      }
    }
    void refreshMediaGallery();
  } catch {
    if (statusEl) {
      statusEl.textContent = "Sandbox status unavailable (is the gateway running?).";
      statusEl.style.color = "var(--warn)";
    }
  }
}

async function refreshMediaGallery() {
  const host = controls.settingsMediaGallery;
  if (!host) return;
  try {
    const r = await fetch("/v1/sandbox/media");
    const data = await r.json().catch(() => ({}));
    const items = Array.isArray(data.items) ? data.items : [];
    host.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "settings-hint";
      empty.style.margin = "8px";
      empty.textContent = "No captures yet — use Demo screenshot or ask the agent to screenshot a URL.";
      host.appendChild(empty);
      return;
    }
    for (const item of items.slice(0, 12)) {
      const card = document.createElement("div");
      card.className = "media-card";
      const meta = document.createElement("div");
      meta.className = "media-card-meta";
      meta.textContent = `${item.kind}: ${item.name} · ${Math.round((item.bytes || 0) / 1024)} KB`;
      card.appendChild(meta);
      if (item.kind === "screenshot") {
        // Lazy-load preview
        const img = document.createElement("img");
        img.alt = item.name;
        img.loading = "lazy";
        img.className = "media-card-img";
        card.appendChild(img);
        void loadMediaPreview(item.relative_path, img);
      } else {
        const badge = document.createElement("div");
        badge.className = "media-card-pdf";
        badge.textContent = "PDF";
        card.appendChild(badge);
      }
      host.appendChild(card);
    }
  } catch {
    host.innerHTML = `<p class="settings-hint" style="margin:8px">Media gallery unavailable.</p>`;
  }
}

async function loadMediaPreview(path, imgEl) {
  try {
    const r = await fetch("/v1/sandbox/media/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.base64 && data.mime) {
      imgEl.src = `data:${data.mime};base64,${data.base64}`;
    } else {
      imgEl.replaceWith(Object.assign(document.createElement("div"), {
        className: "media-card-pdf",
        textContent: "preview n/a",
      }));
    }
  } catch {
    /* ignore */
  }
}

async function runScreenshotDemo() {
  const el = controls.settingsSandboxTestStatus;
  if (el) {
    el.textContent = "Capturing screenshot of example.com…";
    el.style.color = "";
  }
  try {
    const r = await fetch("/v1/sandbox/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", width: 1280, height: 800 }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (el) {
        el.textContent = data.error || "Screenshot failed";
        el.style.color = "var(--warn)";
      }
      return;
    }
    const rel = data.screenshot?.relative_path || "ok";
    const bytes = data.screenshot?.bytes || 0;
    if (el) {
      el.textContent = `Screenshot saved: ${rel} (${bytes} bytes)`;
      el.style.color = "var(--good)";
    }
    showNotice("Screenshot captured.");
    void refreshSandboxUi();
  } catch (e) {
    if (el) {
      el.textContent = e?.message || "Screenshot failed";
      el.style.color = "var(--warn)";
    }
  }
}

async function runSandboxSelfTest() {
  const el = controls.settingsSandboxTestStatus;
  if (el) {
    el.textContent = "Running self-tests…";
    el.style.color = "";
  }
  try {
    const r = await fetch("/v1/sandbox/test/run", { method: "POST" });
    const data = await r.json().catch(() => ({}));
    const line = data.ok
      ? `Self-test passed (${data.passed}/${data.total})`
      : `Self-test issues (${data.passed || 0}/${data.total || 0})`;
    if (el) {
      el.textContent = line;
      el.style.color = data.ok ? "var(--good)" : "var(--warn)";
    }
    showNotice(line);
    void refreshSandboxUi();
  } catch (e) {
    if (el) {
      el.textContent = e?.message || "Self-test failed";
      el.style.color = "var(--warn)";
    }
  }
}

/** Recent transcript as plain text for multi-turn agent continuity. */
function buildPriorContext(log, maxTurns = 8) {
  try {
    const entries = (log?.entries || [])
      .filter((e) => e && (e.role === "user" || e.role === "assistant") && e.text)
      .slice(-maxTurns);
    return entries
      .map((e) => `${e.role}: ${String(e.text).slice(0, 280)}`)
      .join("\n");
  } catch {
    return "";
  }
}

async function runDeepPoolDemo() {
  const el = controls.settingsSandboxTestStatus;
  if (el) {
    el.textContent = "Starting deep pool…";
    el.style.color = "";
  }
  showResearchProgress("Demo · starting multi-agent pool…");
  try {
    const started = await startAgentPool("what is an AI agent", {
      maxAgents: 3,
      thoughtDepth: "deep",
    });
    const id = started.pool_id;
    if (!id) throw new Error("no pool_id");
    const watch = watchPoolEvents(id, (st) => {
      showResearchProgress(
        `Demo agents ${st.completed || 0}/${st.total || "?"} · ${st.status || "running"}`,
      );
      if (el) {
        el.textContent = `Pool ${st.completed || 0}/${st.total || "?"} · ${st.status}`;
      }
    });
    const finished = await waitAgentPool(id, {
      timeoutMs: 90000,
      onTick: (st) => {
        showResearchProgress(
          `Demo agents ${st.completed || 0}/${st.total || "?"} · ${st.status || "running"}`,
        );
      },
    });
    watch.close();
    const snip = (finished.synthesis || finished.error || "done").slice(0, 120);
    if (el) {
      el.textContent = `Deep demo ${finished.status}: ${snip}`;
      el.style.color =
        finished.status === "completed" ? "var(--good)" : "var(--warn)";
    }
    showNotice(`Deep pool ${finished.status}`);
    showResearchProgress(`Demo done · ${finished.status}`, { done: true });
    hideResearchProgressSoon();
  } catch (e) {
    if (el) {
      el.textContent = e?.message || "Deep demo failed";
      el.style.color = "var(--warn)";
    }
    hideResearchProgressSoon();
  }
}

function fillProviderSelects() {
  // Built-in provider catalog — used as a fallback when the gateway hasn't
  // started yet (e.g. desktop app launch). This mirrors llm_catalog.rs so
  // users see all 12 providers immediately instead of just 2.
  const BUILTIN_PROVIDERS = [
    { id: "nvidia", name: "NVIDIA NIM", free_tier: true },
    { id: "groq", name: "Groq", free_tier: true },
    { id: "openrouter", name: "OpenRouter", free_tier: true },
    { id: "together", name: "Together AI", free_tier: false },
    { id: "deepseek", name: "DeepSeek", free_tier: false },
    { id: "fireworks", name: "Fireworks", free_tier: false },
    { id: "mistral", name: "Mistral", free_tier: false },
    { id: "ollama", name: "Ollama (local)", free_tier: true },
    { id: "openai", name: "OpenAI", free_tier: false },
    { id: "cerebras", name: "Cerebras", free_tier: true },
    { id: "sambanova", name: "SambaNova", free_tier: true },
    { id: "custom", name: "Custom", free_tier: true },
  ];

  const providers = llmProviders.length ? llmProviders : BUILTIN_PROVIDERS;

  for (const sel of [controls.setupLlmProvider, controls.settingsLlmProvider]) {
    if (!sel) continue;
    sel.innerHTML = "";
    for (const p of providers) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name}${p.free_tier ? " · free tier" : ""}`;
      sel.appendChild(opt);
    }
    if (!providers.length) {
      sel.innerHTML = `<option value="nvidia">NVIDIA NIM · free tier</option><option value="custom">Custom</option>`;
    }
  }
}

function fillVoiceSelect(list) {
  const sel = controls.settingsVoice;
  if (!sel) return;
  sel.innerHTML = "";
  const roster = list?.length ? list : OFFLINE_VOICES;
  for (const v of roster) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.name || v.id;
    sel.appendChild(opt);
  }
  // Always ensure at least one profile option.
  if (!sel.options.length) {
    const opt = document.createElement("option");
    opt.value = "en_US-lessac-medium";
    opt.textContent = "Lessac (default)";
    sel.appendChild(opt);
  }
  sel.value = setup.voiceId || selectedVoice?.id || roster[0]?.id || "en_US-lessac-medium";
}

/**
 * Load real OS/browser TTS voices into Settings → System voice.
 * This is what actually speaks (profiles are style hints only).
 */
async function fillSystemVoiceSelect() {
  const sel = controls.settingsSystemVoice;
  const status = controls.settingsVoiceStatus;
  if (!sel) return;
  setup = loadSetup();
  try {
    await waitForVoices(4000);
    const list = await listBrowserVoices();
    const prev = setup.browserVoiceURI || sel.value || "";
    sel.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Auto (match language)";
    sel.appendChild(auto);
    for (const v of list) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) {
      sel.value = prev;
    } else {
      sel.value = "";
    }
    const zhCount = countVoicesForLang("zh");
    if (status) {
      if (!list.length) {
        status.textContent =
          "No system voices found. On Windows: Settings → Time & language → Speech → Manage voices → Add Chinese (or any voice). Then click Refresh voices. Also try Edge browser.";
        status.style.color = "var(--warn)";
      } else if (
        (languagePreference || "").startsWith("zh") &&
        zhCount === 0
      ) {
        status.textContent = `Found ${list.length} voice(s), but none are Chinese. Install “Microsoft Huihui” / Chinese speech pack, or pick an English system voice below to hear speech.`;
        status.style.color = "var(--warn)";
      } else {
        status.textContent = `Found ${list.length} system voice(s)${zhCount ? ` · ${zhCount} Chinese` : ""}. Pick one and Preview.`;
        status.style.color = "";
      }
    }
  } catch (e) {
    if (status) {
      status.textContent = e?.message || "Could not load system voices.";
      status.style.color = "var(--bad)";
    }
  }
}

/** Options object shared by all speakBrowser calls. */
function speechOpts(extra = {}) {
  setup = loadSetup();
  const lang = languagePreference || "auto";
  const hint = extra.textHint || "";
  delete extra.textHint;
  return {
    voiceId: setup.voiceId || selectedVoice?.id,
    voiceURI: setup.browserVoiceURI || null,
    langPrefs: ttsLangPrefsFor(
      isChineseLang(lang) || hasCjk(hint)
        ? lang.startsWith("zh")
          ? lang
          : "zh-CN"
        : lang,
    ),
    ...extra,
  };
}

/**
 * Speak assistant text with the best available engine.
 * Tries gateway TTS (Piper/formant) first, then browser TTS as fallback.
 * Handles failures gracefully and transitions back to listening when done.
 */
async function speakAssistant(text, speakTurn, isSoftAck = false) {
  const localSetup = loadSetup();
  const ttsEngine = localSetup.ttsEngine || "auto";
  const useGatewayTts = ttsEngine !== "browser";
  let gatewayOk = false;

  // Ensure the audio graph is unlocked before attempting TTS.
  unlockUiAudio();
  try {
    await audio.ensureContext();
  } catch {
    /* ignore */
  }

  if (useGatewayTts) {
    try {
      const result = await speakOpenLive(text, {
        voiceId: localSetup.voiceId || selectedVoice?.id,
        ttsEngine,
        langPrefs: speechOpts({ textHint: text }).langPrefs,
      });
      gatewayOk = result.ok;
      if (!gatewayOk && result.error) {
        addTimeline("tts", `Gateway TTS failed: ${result.error}`);
      }
    } catch (error) {
      addTimeline("tts", `Gateway TTS exception: ${error?.message || String(error)}`);
    }
  }

  // Fallback to browser TTS if gateway TTS is disabled or failed.
  if (!gatewayOk && localSetup.browserTts !== false && browserTtsAvailable()) {
    try {
      const fullySpoken = await speakBrowser(
        text,
        speechOpts({
          textHint: text,
          shouldAbort: () =>
            speakTurn !== assistantTurnId ||
            mode === VoiceMode.INTERRUPTED ||
            userEnded,
        }),
      );
      if (!fullySpoken) {
        addTimeline("tts", "Browser TTS did not complete");
      }
    } catch (error) {
      addTimeline("tts", `Browser TTS exception: ${error?.message || String(error)}`);
    }
  }

  // If neither engine could speak, at least keep the conversation alive.
  if (!gatewayOk && (localSetup.browserTts === false || !browserTtsAvailable())) {
    addTimeline("tts", "No TTS engine available; text shown only");
  }

  // Transition back to listening when appropriate.
  const hold = isSoftAck
    ? 900
    : Math.min(10000, 1200 + text.length * 35);
  clearTimeout(speakAssistant._listenTimer);
  speakAssistant._listenTimer = setTimeout(() => {
    if (
      conversationActive &&
      microphoneActive &&
      !userEnded &&
      mode === VoiceMode.SPEAKING &&
      speakTurn === assistantTurnId
    ) {
      transition(VoiceMode.LISTENING);
    }
  }, hold);
}

/** Modal with copy-paste Piper install command. */
function showPiperInstallModal(ui) {
  let el = document.getElementById("piperInstallModal");
  if (!el) {
    el = document.createElement("div");
    el.id = "piperInstallModal";
    el.className = "ol-modal";
    el.innerHTML = `
      <div class="ol-modal-card textured-border">
        <header class="ol-modal-head">
          <strong>Install open-source Piper TTS</strong>
          <button type="button" class="icon-button" data-close aria-label="Close">×</button>
        </header>
        <p class="settings-hint" data-note></p>
        <p class="settings-hint"><code data-dir></code></p>
        <textarea data-cmd readonly rows="12" class="ol-code"></textarea>
        <footer class="ol-modal-foot">
          <button type="button" class="settings-btn" data-copy>Copy command</button>
          <button type="button" class="settings-btn ghost" data-close>Close</button>
        </footer>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest("[data-close]")) el.hidden = true;
    });
    el.querySelector("[data-copy]")?.addEventListener("click", async () => {
      const cmd = el.querySelector("[data-cmd]")?.value || "";
      try {
        await navigator.clipboard.writeText(cmd);
        showNotice("Install command copied.");
      } catch {
        showNotice("Select the command and copy manually (Ctrl+C).");
      }
    });
  }
  el.querySelector("[data-note]").textContent =
    ui.note || "Piper neural TTS is missing. Run this install command, then restart the gateway.";
  el.querySelector("[data-dir]").textContent = ui.dataDir || "";
  el.querySelector("[data-cmd]").value = ui.command || "";
  el.hidden = false;
}

/**
 * Always try to speak assistant text.
 * Prefers open-source Piper → formant → browser.
 * @param {string} text
 * @param {object} [extra]
 * @returns {Promise<boolean>}
 */
async function speakAssistantOutLoud(text, extra = {}) {
  const line = String(text || "").trim();
  if (!line) return false;
  setup = loadSetup();
  unlockUiAudio();
  setAssistantText(line);
  transition(VoiceMode.SPEAKING);

  // Auto-bind a system voice if user never picked one.
  if (!setup.browserVoiceURI) {
    try {
      const list = await listBrowserVoices();
      if (list.length) {
        // Prefer Chinese if UI language is zh, else first English, else first.
        const zh = list.find((v) => v.lang.toLowerCase().startsWith("zh"));
        const en = list.find((v) => v.lang.toLowerCase().startsWith("en"));
        const pick =
          (isChineseLang(languagePreference) && zh) || en || list[0];
        if (pick?.id) {
          setup = saveSetup({ browserVoiceURI: pick.id });
          if (controls.settingsSystemVoice) {
            controls.settingsSystemVoice.value = pick.id;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Prefer open-source Piper → formant → browser (browser quality is last resort).
  const spoken = await speakOpenLive(line, {
    voiceId: setup.voiceId || selectedVoice?.id,
    voiceURI: setup.browserVoiceURI || null,
    ttsEngine: setup.ttsEngine || "auto",
    langPrefs: speechOpts({ textHint: line }).langPrefs,
    onStatus: (m) => showNotice(m),
    ...extra,
  });
  const ok = !!spoken.ok;
  if (ok) {
    hideNotice();
  } else if (spoken.piper && !spoken.piper.available) {
    const ui = piperInstallUi({ piper: spoken.piper });
    showPiperInstallModal(ui);
  } else {
    showNotice(
      spoken.error ||
        "Speech failed. Settings → TTS: try Formant or install Piper (open-source).",
    );
  }

  if (conversationActive && microphoneActive && !userEnded) {
    transition(VoiceMode.LISTENING);
  }
  return ok;
}

function applyProviderPreset(providerId, target) {
  // Try live providers first, then fall back to built-in details.
  let p = llmProviders.find((x) => x.id === providerId);
  if (!p) {
    p = BUILTIN_PROVIDER_DETAILS[providerId] || null;
  }
  if (!p && providerId !== "custom") return;
  const base = p?.base_url || "http://127.0.0.1:8000/v1";
  const model = p?.default_model || "default";
  const models = p?.models || [];
  if (target === "setup") {
    if (controls.setupModelUrl) controls.setupModelUrl.value = base;
    if (controls.setupLlmModel) controls.setupLlmModel.value = model;
    fillModelSelect(controls.setupLlmModelSelect, models, model);
    if (controls.setupProviderHint) {
      controls.setupProviderHint.textContent = p?.description || "Custom OpenAI-compatible endpoint";
    }
    const isCustom = providerId === "custom";
    if (controls.setupModelUrl) controls.setupModelUrl.readOnly = !isCustom && !!p;
  } else {
    if (controls.settingsModelUrl) controls.settingsModelUrl.value = base;
    if (controls.settingsLlmModel) controls.settingsLlmModel.value = model;
    fillModelSelect(controls.settingsLlmModelSelect, models, model);
  }
}

function fillModelSelect(select, models, selected) {
  if (!select) return;
  select.innerHTML = "";
  const list = models?.length ? models : selected ? [selected] : [];
  for (const id of list) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    select.appendChild(opt);
  }
  if (selected) select.value = selected;
}

async function fetchModelsInto(target) {
  const cfg =
    target === "setup"
      ? {
          modelBaseUrl: controls.setupModelUrl?.value?.trim(),
          modelApiKey: controls.setupModelKey?.value,
        }
      : {
          modelBaseUrl: controls.settingsModelUrl?.value?.trim(),
          modelApiKey: controls.settingsModelKey?.value,
        };
  try {
    const models = await listRemoteModels(cfg);
    if (!models.length) {
      showNotice("No models returned — type a model id manually.");
      return;
    }
    if (target === "setup") {
      fillModelSelect(controls.setupLlmModelSelect, models, models[0]);
      if (controls.setupLlmModel) controls.setupLlmModel.value = models[0];
    } else {
      fillModelSelect(controls.settingsLlmModelSelect, models, models[0]);
      if (controls.settingsLlmModel) controls.settingsLlmModel.value = models[0];
    }
    showNotice(`Loaded ${models.length} model id(s).`);
  } catch (e) {
    showNotice(e?.message || "Could not fetch models");
  }
}

async function previewSelectedVoice() {
  setup = loadSetup();
  const id =
    controls.settingsVoice?.value || setup.voiceId || selectedVoice?.id || "en_US-lessac-medium";
  let uri = controls.settingsSystemVoice?.value || setup.browserVoiceURI || "";
  const zh = isChineseLang(languagePreference);
  const line = zh
    ? "你好，这是 OpenLive 语音试听。如果你能听到这句话，说明系统语音可用。"
    : "Hi, this is a voice preview. If you can hear this, system speech is working.";
  try {
    unlockUiAudio();
    await waitForVoices(5000);
    const catalog = await listBrowserVoices();
    if (!uri && catalog.length) {
      uri = catalog[0].id;
      setup = saveSetup({ browserVoiceURI: uri });
      if (controls.settingsSystemVoice) controls.settingsSystemVoice.value = uri;
    }
    if (setup.browserTts !== false && browserTtsAvailable() && catalog.length) {
      showNotice(`Playing: ${catalog.find((c) => c.id === uri)?.name || "system voice"}…`);
      stopBrowserSpeech();
      const ok = await speakBrowser(
        line,
        speechOpts({ voiceId: id, voiceURI: uri || null, textHint: line }),
      );
      if (ok) {
        hideNotice();
        return;
      }
    }
    // Always offer formant backup on preview failure.
    showNotice("Browser voice failed — playing backup formant voice…");
    const data = await previewVoice(id, line);
    await playPcmBase64(data.pcm_base64, data.sample_rate || 24000);
    hideNotice();
    showNotice(
      catalog.length
        ? "Backup voice works. For natural speech, pick a System voice and try Preview again (Edge works best)."
        : "No system voices found. Install Windows Speech voices, or keep using backup formant voice.",
    );
  } catch (e) {
    showNotice(e?.message || "Preview failed");
  }
}

/**
 * @param {{ force?: boolean }} [opts]
 */
function openSetupWizard(opts = {}) {
  setup = loadSetup();
  populateSetupForm(setup);
  // First-time users see the Welcome screen before the standard steps.
  goSetupStep("welcome");
  setSetupOpen(true);
  if (opts.force) setOnboardingOpen(false);
}

function populateSetupForm(cfg) {
  if (controls.setupDisplayName) controls.setupDisplayName.value = cfg.displayName || "";
  if (controls.setupStripFillers) controls.setupStripFillers.checked = cfg.stripFillers !== false;
  if (controls.setupBackchannels) controls.setupBackchannels.checked = cfg.naturalBackchannels !== false;
  if (controls.setupLlmProvider) controls.setupLlmProvider.value = cfg.llmProviderId || "nvidia";
  if (controls.setupModelUrl) controls.setupModelUrl.value = cfg.modelBaseUrl || "";
  if (controls.setupModelKey) controls.setupModelKey.value = cfg.modelApiKey || "";
  if (controls.setupLlmModel) controls.setupLlmModel.value = cfg.llmModel || "";
  if (controls.setupAgentKind) {
    controls.setupAgentKind.value =
      cfg.agentKind === "none" ? "none" : "internal";
  }
  if (controls.setupAutoDelegate) controls.setupAutoDelegate.checked = cfg.agentAutoDelegate !== false;
  populateSetupVoiceSelect(cfg.voiceId || selectedVoice?.id);
  applyProviderPreset(cfg.llmProviderId || "nvidia", "setup");
  if (controls.setupModelUrl && cfg.modelBaseUrl) controls.setupModelUrl.value = cfg.modelBaseUrl;
  if (controls.setupLlmModel && cfg.llmModel) controls.setupLlmModel.value = cfg.llmModel;
  if (controls.setupProbeStatus) {
    controls.setupProbeStatus.textContent = "";
    controls.setupProbeStatus.className = "setup-probe-status";
  }
  // Render swipeable voice cards when the wizard is opened.
  if (controls.setupVoiceSwipe) {
    renderSetupVoiceCards();
  }
}

function populateSetupVoiceSelect(selectedId) {
  const select = controls.setupVoice;
  if (!select) return;
  const list = voices.length ? voices : OFFLINE_VOICES;
  select.innerHTML = "";
  for (const voice of list) {
    const opt = document.createElement("option");
    opt.value = voice.id;
    opt.textContent = voice.name || voice.label || voice.id;
    select.appendChild(opt);
  }
  const pick = selectVoice(list, selectedId);
  select.value = pick.id;
}

const SETUP_STEPS = ["welcome", "voice", 1, 2];

function setupStepIndex(step) {
  return SETUP_STEPS.indexOf(step);
}

function goSetupStep(step) {
  setupStep = step;
  const isWelcome = step === "welcome";
  const isVoice = step === "voice";

  document.querySelectorAll(".setup-step").forEach((btn) => {
    const btnStep = Number(btn.dataset.step);
    btn.classList.toggle("active", isVoice ? btnStep === 0 : typeof setupStep === "number" && btnStep === setupStep);
  });

  document.querySelectorAll(".setup-panel").forEach((panel) => {
    const panelKey = panel.dataset.panel;
    let active = false;
    if (isWelcome) {
      active = panelKey === "welcome";
    } else if (isVoice || setupStep === 0) {
      active = panelKey === "voice";
    } else {
      active = Number(panelKey) === setupStep;
    }
    panel.hidden = !active;
    panel.classList.toggle("active", active);
    if (active) {
      panel.style.animation = "none";
      void panel.offsetWidth;
      panel.style.animation = "";
    }
  });

  const title = document.getElementById("setupTitle");
  const subtitle = document.getElementById("setupSubtitle");
  const steps = document.getElementById("setupSteps");

  if (isWelcome) {
    if (title) title.textContent = "Welcome";
    if (subtitle) subtitle.textContent = "Let's get you set up so you can start talking.";
    if (steps) steps.hidden = true;
    if (controls.setupBack) controls.setupBack.hidden = true;
    if (controls.setupNext) {
      controls.setupNext.textContent = "Next";
      controls.setupNext.classList.add("welcome-next");
    }
    return;
  }

  if (isVoice) {
    renderSetupVoiceCards();
  }

  if (title) title.textContent = "Get ready to talk";
  if (subtitle) {
    if (setupStep === 2) {
      subtitle.textContent = "Final step — pick agent preferences, then tap \"Start talking\" to begin.";
    } else {
      subtitle.textContent = "Configure voice, model access, and a background agent. You can change these later in Settings.";
    }
  }
  if (steps) steps.hidden = false;
  if (controls.setupBack) controls.setupBack.hidden = setupStep === 0;
  if (controls.setupNext) {
    controls.setupNext.textContent = setupStep === 2 ? "Start talking" : "Continue";
    controls.setupNext.classList.remove("welcome-next");
  }
}

function readSetupForm() {
  // Prefer the swipeable voice card selection, fall back to the legacy select.
  let voiceId = selectedVoice?.id || setup.voiceId;
  const activeCard = document.querySelector(".voice-card.active");
  if (activeCard?.dataset.voiceId) {
    voiceId = activeCard.dataset.voiceId;
  } else if (controls.setupVoice?.value) {
    voiceId = controls.setupVoice.value;
  }

  return {
    displayName: controls.setupDisplayName?.value?.trim() || "",
    voiceId: voiceId || selectedVoice?.id || "",
    stripFillers: controls.setupStripFillers?.checked !== false,
    naturalBackchannels: controls.setupBackchannels?.checked !== false,
    llmProviderId: controls.setupLlmProvider?.value || "nvidia",
    modelBaseUrl: controls.setupModelUrl?.value?.trim() || setup.modelBaseUrl,
    modelApiKey: controls.setupModelKey?.value || "",
    llmModel: controls.setupLlmModel?.value?.trim() || setup.llmModel,
    agentKind: controls.setupAgentKind?.value === "none" ? "none" : "internal",
    agentAutoDelegate: controls.setupAutoDelegate?.checked !== false,
    minimalUi: true,
  };
}

/**
 * Animate the Welcome "Next" button expanding into the voice selection
 * interface, then switch to the voice panel.
 */
function expandNextToVoice() {
  const nextBtn = controls.setupNext;
  if (!nextBtn) {
    goSetupStep("voice");
    return;
  }

  nextBtn.classList.add("is-expanding");
  nextBtn.disabled = true;

  // Halfway through the expansion, fade the welcome content and swap panels.
  setTimeout(() => {
    goSetupStep("voice");
  }, 350);

  // After expansion completes, clean up the animation class.
  setTimeout(() => {
    nextBtn.classList.remove("is-expanding");
    nextBtn.disabled = false;
  }, 750);
}

/**
 * Render swipeable voice cards into the setup wizard voice panel.
 */
function renderSetupVoiceCards() {
  const container = document.getElementById("setupVoiceSwipe");
  const dotsContainer = document.getElementById("voiceDots");
  if (!container) return;

  container.replaceChildren();
  if (dotsContainer) dotsContainer.replaceChildren();

  const displayVoices = voices.length ? voices : OFFLINE_VOICES;
  displayVoices.forEach((voice, index) => {
    const card = document.createElement("div");
    card.className = "voice-card";
    card.dataset.voiceId = voice.id;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", String(voice.id === setup.voiceId));
    if (voice.id === setup.voiceId) card.classList.add("active");

    const avatar = document.createElement("div");
    avatar.className = "voice-card-avatar";
    avatar.textContent = voice.glyph;

    const name = document.createElement("div");
    name.className = "voice-card-name";
    name.textContent = voice.name;

    const desc = document.createElement("div");
    desc.className = "voice-card-desc";
    desc.textContent = voice.description;

    card.append(avatar, name, desc);
    card.addEventListener("click", () => {
      selectSetupVoice(voice.id);
    });
    container.appendChild(card);

    if (dotsContainer) {
      const dot = document.createElement("span");
      dot.className = "voice-dot";
      dot.dataset.index = String(index);
      if (voice.id === setup.voiceId) dot.classList.add("active");
      dotsContainer.appendChild(dot);
    }
  });

  // Scroll the selected voice into view.
  const selected = container.querySelector(".voice-card.active");
  if (selected) {
    selected.scrollIntoView({ behavior: "auto", inline: "center", block: "nearest" });
  }

  // Update active dot on scroll.
  container.onscroll = () => updateVoiceDots(container);

  // Keyboard navigation for the listbox.
  container.onkeydown = (event) => {
    const cards = [...container.querySelectorAll(".voice-card")];
    const activeIndex = cards.findIndex((c) => c.classList.contains("active"));
    let nextIndex = activeIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = Math.min(cards.length - 1, Math.max(0, activeIndex) + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = Math.max(0, activeIndex - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (activeIndex >= 0) selectSetupVoice(cards[activeIndex].dataset.voiceId);
      return;
    } else {
      return;
    }
    if (nextIndex !== activeIndex && cards[nextIndex]) {
      event.preventDefault();
      selectSetupVoice(cards[nextIndex].dataset.voiceId);
    }
  };
}

function selectSetupVoice(voiceId) {
  setup = saveSetup({ ...setup, voiceId });
  selectedVoice = selectVoice(voices, voiceId);
  settings = saveSettings({ voiceId });
  setVoiceBadge(selectedVoice.glyph);

  document.querySelectorAll(".voice-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.voiceId === voiceId);
    card.setAttribute("aria-selected", String(card.dataset.voiceId === voiceId));
  });

  const container = document.getElementById("setupVoiceSwipe");
  const selected = container?.querySelector(`.voice-card[data-voice-id="${voiceId}"]`);
  selected?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  updateVoiceDots(container);
}

function updateVoiceDots(container) {
  if (!container) return;
  const cards = [...container.querySelectorAll(".voice-card")];
  const center = container.scrollLeft + container.clientWidth / 2;
  let activeIndex = 0;
  let closest = Infinity;
  cards.forEach((card, index) => {
    const cardCenter = card.offsetLeft + card.clientWidth / 2;
    const dist = Math.abs(cardCenter - center);
    if (dist < closest) {
      closest = dist;
      activeIndex = index;
    }
  });

  // Sync visual active state with the centered card (without writing to storage).
  cards.forEach((card, index) => {
    card.classList.toggle("active", index === activeIndex);
    card.setAttribute("aria-selected", String(index === activeIndex));
  });

  document.querySelectorAll(".voice-dot").forEach((dot, index) => {
    dot.classList.toggle("active", index === activeIndex);
  });
}

function finishSetupWizard() {
  const partial = readSetupForm();
  setup = markSetupComplete(partial);
  if (partial.voiceId) {
    selectedVoice = selectVoice(voices, partial.voiceId);
    settings = saveSettings({ voiceId: partial.voiceId });
    setVoiceBadge(selectedVoice.glyph);
    renderVoiceList(voices, selectedVoice.id, onVoiceSelected);
  }
  if (partial.naturalBackchannels) {
    settings = saveSettings({ backchannels: "natural" });
  } else {
    settings = saveSettings({ backchannels: "off" });
  }
  settings = saveSettings({
    theme: "minimal",
    onboardingDismissed: true,
  });
  applyTheme("minimal");
  applySettingsForm();
  applySetupToSettingsForm();
  setSetupOpen(false);
  setOnboardingOpen(false);
  void pushLlmConfig(setup).then((r) => {
    if (r?.can_chat) showNotice("LLM connected — voice will answer naturally.");
    else showNotice("Saved. Add an API key for smarter replies (NVIDIA free tier works).");
    setTimeout(() => hideNotice(), 4000);
  });
  if (sessionId) configureSession();
  addTimeline("setup", "Configuration saved");
}

function applySetupToSettingsForm() {
  setup = loadSetup();
  if (controls.settingsLlmProvider) {
    controls.settingsLlmProvider.value = setup.llmProviderId || "nvidia";
  }
  if (controls.settingsModelUrl) controls.settingsModelUrl.value = setup.modelBaseUrl || "";
  if (controls.settingsModelKey) controls.settingsModelKey.value = setup.modelApiKey || "";
  if (controls.settingsLlmModel) controls.settingsLlmModel.value = setup.llmModel || "";
  if (controls.settingsAgentKind) {
    controls.settingsAgentKind.value =
      setup.agentKind === "none" ? "none" : "internal";
  }
  if (controls.settingsVoice) {
    controls.settingsVoice.value = setup.voiceId || selectedVoice?.id || "";
  }
  if (controls.settingsSystemVoice) {
    controls.settingsSystemVoice.value = setup.browserVoiceURI || "";
  }
  if (controls.settingsBrowserTts) {
    controls.settingsBrowserTts.checked = setup.browserTts !== false;
  }
  if (controls.settingsTtsEngine) {
    controls.settingsTtsEngine.value = setup.ttsEngine || "auto";
  }
  if (controls.settingsThoughtDepth) {
    controls.settingsThoughtDepth.value = setup.thoughtDepth || "voice";
  if (controls.settingsAgentClass) {
    controls.settingsAgentClass.value = setup.agentClass || "general";
  }
  }
  if (controls.settingsProbeStatus) {
    controls.settingsProbeStatus.textContent = "";
    controls.settingsProbeStatus.className = "setup-probe-status";
  }
}

/**
 * @param {"setup"|"settings"} source
 */
async function probeAgentFromForm(source) {
  const statusEl =
    source === "setup" ? controls.setupProbeStatus : controls.settingsProbeStatus;
  const cfg =
    source === "setup"
      ? { ...setup, ...readSetupForm() }
      : {
          ...setup,
          llmProviderId: controls.settingsLlmProvider?.value || setup.llmProviderId,
          modelBaseUrl: controls.settingsModelUrl?.value?.trim() || setup.modelBaseUrl,
          modelApiKey: controls.settingsModelKey?.value ?? setup.modelApiKey,
          llmModel: controls.settingsLlmModel?.value?.trim() || setup.llmModel,
          agentKind:
            controls.settingsAgentKind?.value === "none" ? "none" : "internal",
          voiceId: controls.settingsVoice?.value || setup.voiceId,
        };
  setup = saveSetup(cfg);
  await pushLlmConfig(setup).catch(() => {});
  if (statusEl) {
    statusEl.textContent = "Testing…";
    statusEl.className = "setup-probe-status";
  }
  try {
    const result = await probeAgent(cfg);
    const ok = result.ok === true || result.status === "ok" || result.status === "disabled";
    if (statusEl) {
      statusEl.textContent = ok
        ? result.detail || result.status || "Reachable"
        : result.error || "Unreachable";
      statusEl.className = `setup-probe-status ${ok ? "ok" : "err"}`;
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = error?.message || "Probe failed";
      statusEl.className = "setup-probe-status err";
    }
  }
}

/**
 * Handle a finalized user utterance: ignore pure fillers for agent work,
 * strip fillers when configured, and auto-delegate task-like speech.
 * @param {string} text
 * @param {{ source?: string }} [meta]
 */
function handleFinalUserUtterance(text, meta = {}) {
  if (!text) return;
  const normalized = text.trim().toLowerCase();
  const now = Date.now();
  // Client ASR and gateway finals can land within the same second.
  if (normalized === lastHandledUtterance && now - lastHandledUtteranceAt < 2500) {
    return;
  }
  lastHandledUtterance = normalized;
  lastHandledUtteranceAt = now;

  setup = loadSetup();
  if (isOnlyFillers(text)) {
    // Pure filler turns stay in transcript but don't trigger agent work.
    addTimeline("speech", `Filler-only turn ignored for tasks (${meta.source || "asr"})`);
    return;
  }
  const cleaned = setup.stripFillers ? stripFillers(text) : text.trim();
  if (!cleaned) return;

  // "你是谁" / who are you — instant self-intro + speak (never Wikipedia).
  if (looksLikeIdentity(cleaned)) {
    const intro = identityReply(cleaned, { lang: languagePreference });
    transcript.append("assistant", intro);
    renderTranscript(transcript.entries);
    void speakAssistantOutLoud(intro);
    return;
  }

  // Every real turn goes through the agent when enabled so the model + tools
  // actually handle the task (not only keyword-matched "search" lines).
  if (setup.agentKind !== "none") {
    void runBackgroundAgent(cleaned, { source: meta.source || "speech" });
    return;
  }
}

/**
 * Soft local backchannel while the user is mid-speech (client-side only).
 * Respects setup.naturalBackchannels and settings.backchannels.
 * @param {string} interim
 */
function maybeLocalBackchannel(interim) {
  setup = loadSetup();
  if (!setup.naturalBackchannels) return;
  if (settings.backchannels === "off") return;
  if (isOnlyFillers(interim)) return;
  const now = Date.now();
  if (!interimSpeechStartedAt) interimSpeechStartedAt = now;
  // Wait for a short stretch of continuous speech before cueing.
  if (now - interimSpeechStartedAt < 1400) return;
  if (now - lastBackchannelAt < 4500) return;
  lastBackchannelAt = now;
  const token =
    BACKCHANNEL_TOKENS[Math.floor(Math.random() * BACKCHANNEL_TOKENS.length)] || "mhmm";
  flashBackchannel(token);
}

/**
 * Submit typed composer text as a user turn + optional agent task.
 */
async function submitComposerText() {
  const input = controls.composerInput;
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  input.value = "";
  await dispatchUserTask(raw, { forceAgent: false, asUserTurn: true });
}

/**
 * @param {string} intent
 * @param {{ forceAgent?: boolean, asUserTurn?: boolean }} [opts]
 */
async function dispatchUserTask(intent, opts = {}) {
  setup = loadSetup();
  const cleaned = setup.stripFillers ? stripFillers(intent) : intent.trim();
  if (!cleaned) return;

  if (opts.asUserTurn) {
    transcript.append("user", intent.trim());
    renderTranscript(transcript.entries);
    if (ready()) {
      sendControl("session", mediaTimeUs, "user_transcript_delta", {
        text: intent.trim(),
        is_final: true,
      });
      if (webrtcMode) sendWebRtcCommit(intent.trim());
    }
  }

  if (looksLikeIdentity(cleaned)) {
    const intro = identityReply(cleaned, { lang: languagePreference });
    transcript.append("assistant", intro);
    renderTranscript(transcript.entries);
    await speakAssistantOutLoud(intro);
    return;
  }

  // Agent-on: always handle the turn (tools + LLM). Agent-off: optional force.
  const shouldAgent =
    opts.forceAgent ||
    (setup.agentKind !== "none" && setup.agentAutoDelegate !== false);

  if (shouldAgent && setup.agentKind !== "none") {
    await runBackgroundAgent(cleaned, { source: "composer" });
    return;
  }

  // Fallback: gateway task orchestrator (requires live session).
  if (conversationActive) {
    const taskId = taskOrchestrator.requestTask(cleaned, {
      evidenceRequired: ["transcript", "tool_call"],
    });
    if (taskId) {
      setTaskRailVisible(true);
      showAgentToast(`Task queued: ${cleaned.slice(0, 72)}`);
    } else {
      showNotice("Could not queue task — try again once connected.");
    }
  } else if (opts.forceAgent) {
    showNotice("Start a conversation or configure an agent in Setup to run tasks.");
  }
}

/**
 * Fire-and-forget background agent call via gateway proxy. Voice continues.
 * Speaks a human ack ("Let me check…") while tools run, then the answer.
 * Honors barge-in via assistantTurnId.
 * @param {string} intent cleaned task text
 * @param {{ source?: string }} [meta]
 */
async function runBackgroundAgent(intent, meta = {}) {
  setup = loadSetup();
  if (setup.agentKind === "none") {
    showNotice("Agent is off. Enable OpenLive agent in Settings.");
    return;
  }
  // Speech turn id — only used to stop *speaking*, not to drop tool work.
  const speakTurn = assistantTurnId;
  const localId = crypto.randomUUID();
  agentJobs.set(localId, { intent, startedAt: Date.now(), status: "running" });
  setTaskRailVisible(true);
  addTimeline("agent", `Run (${meta.source || "auto"}): ${intent.slice(0, 100)}`);

  const speechAborted = () => speakTurn !== assistantTurnId || userEnded;
  const isIdentity = looksLikeIdentity(intent);

  // Short ack only for explicit search-like intents (keeps chat fluid).
  const wantsSearchAck =
    !isIdentity &&
    (looksLikeAgentTask(intent) ||
      /search|查|搜|what is|什么是|capital|首都/i.test(intent));
  if (wantsSearchAck) {
    const ack = pickToolAck(intent, { lang: languagePreference });
    appendEvidence("Looking up", intent, "cyan");
    if (conversationActive) {
      transition(VoiceMode.THINKING, ack);
      setAssistantText(ack);
    }
    showAgentToast(ack, { holdMs: 2500 });
    if (!speechAborted()) {
      await speakAssistant(ack, assistantTurnId, true);
    }
  } else if (conversationActive) {
    transition(VoiceMode.THINKING, "…");
  }

  if (userEnded) {
    agentJobs.set(localId, { intent, status: "cancelled" });
    return;
  }

  const deepResearch =
    (setup.thoughtDepth || "voice") === "deep" ||
    /\b(research|deep dive|thoroughly|investigate|调研|深入研究)\b/i.test(intent);
  if (deepResearch) {
    showResearchProgress(
      (setup.thoughtDepth || "") === "deep"
        ? "Deep research · multi-agent pool…"
        : "Looking across sources…",
    );
  }

  let poolWatcher = null;
  try {
    await pushLlmConfig(setup).catch(() => {});

    // Deep mode: start background pool + SSE progress, then use synthesis (fast path).
    // Still falls back to normal agent if pool fails.
    let result;
    if (deepResearch && (setup.thoughtDepth || "") === "deep" && setup.agentKind !== "none") {
      try {
        const started = await startAgentPool(intent, {
          maxAgents: 4,
          thoughtDepth: "deep",
        });
        const poolId = started.pool_id;
        if (poolId) {
          poolWatcher = watchPoolEvents(poolId, (st) => {
            showResearchProgress(
              `Agents ${st.completed || 0}/${st.total || "?"} · ${st.status || "running"}`,
            );
          });
          const finished = await waitAgentPool(poolId, {
            timeoutMs: 90000,
            onTick: (st) => {
              showResearchProgress(
                `Agents ${st.completed || 0}/${st.total || "?"} · ${st.status || "running"}`,
              );
            },
          });
          if (finished.status === "completed" && finished.synthesis) {
            result = {
              status: "completed",
              result: finished.synthesis,
              tools_used: ["research_pool", "web_search"],
              sources: (finished.partial || [])
                .filter((p) => p.result)
                .slice(0, 5)
                .map((p, i) => ({
                  title: p.intent || `agent ${i + 1}`,
                  url: `agent://pool/${p.index ?? i}`,
                  snippet: String(p.result || "").slice(0, 160),
                })),
              pool_id: poolId,
              agent_kind: "internal",
            };
          }
        }
      } catch {
        result = null;
      }
    }

    if (!result) {
      // Always run tools — do not drop this for barge-in noise.
      result = await runAgentTask(setup, intent, {
        sessionId: sessionId || `local-${localId}`,
        language: languagePreference,
        priorContext: buildPriorContext(transcript, 8),
      });
    }
    if (userEnded) {
      agentJobs.set(localId, { intent, status: "cancelled" });
      return;
    }
    const tools = result.tools_used || [];
    const sources = Array.isArray(result.sources) ? result.sources : [];
    agentJobs.set(localId, {
      intent,
      status: result.status,
      result: result.result,
      error: result.error,
      tools,
      sources,
      pool_id: result.pool_id,
    });
    if (result.status === "needs_confirm" && result.pending) {
      const msg =
        result.pending.message ||
        result.result ||
        "This action needs your approval.";
      setAssistantText(msg);
      showAgentToast("Waiting for your confirmation…", { tone: "info", holdMs: 5000 });
      appendEvidence("Confirm", msg, "yellow");
      await speakAssistantOutLoud(msg, { shouldAbort: () => userEnded });
      const approved = await showAgentConfirmDialog(result.pending);
      if (approved?.ok && approved.approved) {
        const done = approved.message || "Done.";
        showAgentToast(done.slice(0, 100), { tone: "ok", holdMs: 5000 });
        transcript.append("assistant", done);
        renderTranscript(transcript.entries);
        setAssistantText(done);
        await speakAssistantOutLoud(done, { shouldAbort: () => userEnded });
        void refreshSandboxUi();
      } else {
        const cancelled = "Cancelled — I didn’t change anything.";
        showAgentToast(cancelled, { tone: "info" });
        setAssistantText(cancelled);
        await speakAssistantOutLoud(cancelled, { shouldAbort: () => userEnded });
      }
      addTimeline("agent", approved?.approved ? "confirm approved" : "confirm denied");
    } else if (result.status === "completed") {
      let summary = String(result.result || "").trim();
      // Tool/identity results are trusted. Only strip think-tags.
      if (tools.length) {
        summary = stripThinkingForUser(summary) || summary;
      } else {
        summary = stripThinkingForUser(summary);
        if (!summary || looksLikePlanningJunk(summary)) {
          summary = softNoAnswer();
        }
      }
      if (!summary) summary = softNoAnswer();

      const toolLabel = tools.length ? tools.join(", ") : "none";
      const classChip = result.agent_class || setup.agentClass || "general";
      const poolChip = result.pool_id ? ` · pool ${String(result.pool_id).slice(0, 8)}` : "";
      showAgentToast(
        `${summary.slice(0, 80)}  [${classChip}${poolChip}]`,
        { tone: "ok", holdMs: 7000 },
      );
      appendEvidence(
        `Found (${toolLabel}) · ${classChip}`,
        summary.slice(0, 500),
        "green",
      );
      transcript.append("assistant", summary);
      renderTranscript(transcript.entries);
      setAssistantText(summary);

      if (sources.length) {
        renderAgentSourceCard(intent, sources, tools);
      } else if (
        tools.some((t) =>
          ["web_search", "deep_search", "research_pool", "browse_url", "browse_site"].includes(t),
        )
      ) {
        renderVisualCard(
          visualCards.webSearchCard(
            {
              query: intent.slice(0, 80),
              results: [
                {
                  title: tools.join(", "),
                  url: "",
                  snippet: summary.slice(0, 160),
                },
              ],
            },
            "OpenLive tools",
          ),
        );
      }

      if (deepResearch || tools.includes("research_pool")) {
        showResearchProgress(
          `Done · ${tools.includes("research_pool") ? "pool" : "tools"} · ${sources.length || "—"} sources`,
          { done: true },
        );
      }

      // ALWAYS speak the answer — this is the voice product.
      await speakAssistantOutLoud(summary, {
        shouldAbort: () => userEnded,
      });
      addTimeline(
        "agent",
        `done tools=${toolLabel} class=${classChip}${result.pool_id ? ` pool=${result.pool_id}` : ""}`,
      );
    } else if (result.status === "skipped") {
      showAgentToast("Skipped.", { tone: "info" });
      if (conversationActive) transition(VoiceMode.LISTENING);
    } else {
      const err = result.error || "Lookup failed — try again.";
      const code = result.status_label || result.model_code || "";
      const shown = code ? `${err} (${code})` : err;
      showAgentToast(shown, { tone: "err", holdMs: 7000 });
      appendEvidence("Agent error", shown, "yellow");
      setAssistantText(shown);
      await speakAssistantOutLoud(err);
      addTimeline("agent", shown);
    }
  } catch (error) {
    if (userEnded) return;
    const msg = error?.message || "Request failed";
    agentJobs.set(localId, { intent, status: "error", error: msg });
    showAgentToast(msg, { tone: "err" });
    appendEvidence("Agent error", msg, "yellow");
    setAssistantText(msg);
    await speakAssistantOutLoud(msg);
  } finally {
    try {
      poolWatcher?.close?.();
    } catch {
      /* ignore */
    }
    hideResearchProgressSoon();
    taskOrchestrator.render();
  }
}

function showResearchProgress(label, opts = {}) {
  const el = document.getElementById("researchProgress");
  const lab = document.getElementById("researchProgressLabel");
  if (!el) return;
  el.hidden = false;
  if (lab) lab.textContent = label || "Research agents…";
  el.dataset.done = opts.done ? "1" : "0";
  clearTimeout(showResearchProgress._timer);
}

/**
 * Modal confirm for destructive sandbox actions.
 * @param {{ id: string, message?: string, path?: string, preview?: string, kind?: string }} pending
 * @returns {Promise<{ok:boolean, approved?:boolean, message?:string}|null>}
 */
function showAgentConfirmDialog(pending) {
  return new Promise((resolve) => {
    const modal = document.getElementById("agentConfirmModal");
    const msg = document.getElementById("agentConfirmMessage");
    const prev = document.getElementById("agentConfirmPreview");
    const title = document.getElementById("agentConfirmTitle");
    const approveBtn = document.getElementById("agentConfirmApprove");
    const denyBtn = document.getElementById("agentConfirmDeny");
    if (!modal || !approveBtn || !denyBtn) {
      resolve(null);
      return;
    }
    if (title) {
      title.textContent =
        pending.kind === "delete_file" ? "Delete file?" : "Confirm write?";
    }
    if (msg) msg.textContent = pending.message || `Confirm ${pending.path || "action"}?`;
    if (prev) {
      if (pending.preview) {
        prev.hidden = false;
        prev.textContent = pending.preview;
      } else {
        prev.hidden = true;
        prev.textContent = "";
      }
    }
    modal.hidden = false;

    const cleanup = () => {
      modal.hidden = true;
      approveBtn.onclick = null;
      denyBtn.onclick = null;
    };

    approveBtn.onclick = async () => {
      playClick("confirm");
      cleanup();
      try {
        const r = await fetch("/v1/agent/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: pending.id, approve: true }),
        });
        const data = await r.json().catch(() => ({}));
        resolve({ ok: r.ok && data.ok, approved: true, message: data.message || "Approved." });
      } catch (e) {
        resolve({ ok: false, approved: false, message: e?.message || "Confirm failed" });
      }
    };
    denyBtn.onclick = async () => {
      playClick("cancel");
      cleanup();
      try {
        await fetch("/v1/agent/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: pending.id, approve: false }),
        });
      } catch {
        /* ignore */
      }
      resolve({ ok: true, approved: false });
    };
  });
}

function hideResearchProgressSoon() {
  const el = document.getElementById("researchProgress");
  if (!el || el.hidden) return;
  clearTimeout(showResearchProgress._timer);
  showResearchProgress._timer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

function renderAgentSourceCard(intent, sources, tools) {
  try {
    const results = sources.slice(0, 5).map((s) => ({
      title: s.title || "Source",
      url: s.url || "",
      snippet: s.snippet || "",
    }));
    const card = visualCards.webSearchCard(
      { query: String(intent || "").slice(0, 80), results },
      (tools || []).join(", ") || "search",
    );
    const node = renderVisualCard(card);
    // Make first real http source clickable if present.
    const link = results.find((r) => /^https?:\/\//i.test(r.url));
    if (node && link) {
      const attr = node.querySelector(".card-attribution");
      if (attr) {
        attr.innerHTML = "";
        const a = document.createElement("a");
        a.className = "card-source-link";
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = `via ${link.title || "source"}`;
        attr.appendChild(a);
      }
    }
  } catch {
    /* ignore card errors */
  }
}

function visualCaptureErrorMessage(kind, error) {
  const label = kind === "screen" ? "Screen sharing" : "Camera access";
  if (error?.name === "NotAllowedError") return `${label} was not granted. No visual data was captured.`;
  if (error?.name === "NotFoundError") return `No compatible ${kind === "screen" ? "display surface" : "camera"} was found.`;
  return error?.message ?? `${label} could not start.`;
}

/* ---------------------------------------------------------------------------
   Misc
   --------------------------------------------------------------------------- */

function microphoneErrorMessage(error) {
  if (error?.name === "NotAllowedError") {
    return "Microphone access was blocked. Allow microphone access and try again.";
  }
  if (error?.name === "NotFoundError") {
    return "No microphone was found. Connect an input device and try again.";
  }
  return error?.message ?? "The conversation could not start.";
}

/* ---------------------------------------------------------------------------
   Boot splash lifecycle + ripple click feedback (v26.7.16 UI revamp)
   --------------------------------------------------------------------------- */

let bootSplashDismissed = false;
window.__openliveBootStart = performance.now();

/**
 * Fade out the boot/splash overlay and mark the app as ready.
 * Called after bootstrapLlmUi completes or a 3s failsafe timeout.
 */
/**
 * Fade out the boot/splash overlay and mark the app shell as ready.
 * Boot sequence: white sphere scales in, then after 1s "Openlive" slides
 * out and fades before the splash is removed. The splash stays for at
 * least 2.4s so the brand animation can complete.
 */
function dismissBootSplash() {
  if (bootSplashDismissed) return;
  bootSplashDismissed = true;

  // Keep the splash visible long enough for the brand animation to play:
  // 1s delay + 1.2s slide/fade = ~2.2s minimum. Add a small buffer.
  const splashStart = window.__openliveBootStart || performance.now();
  const elapsed = performance.now() - splashStart;
  const minDuration = 2400;
  const remaining = Math.max(0, minDuration - elapsed);

  const doDismiss = () => {
    const splash = document.getElementById("bootSplash");
    if (splash) {
      splash.classList.add("is-hidden");
      setTimeout(() => {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
      }, 900);
    }
    document.body.dataset.boot = "ready";
  };

  if (remaining <= 0) {
    doDismiss();
  } else {
    setTimeout(doDismiss, remaining);
  }
}

/**
 * Update the boot status text shown during splash.
 * @param {string} text
 */
function setBootStatus(text) {
  const el = document.getElementById("bootStatus");
  if (el) el.textContent = text;
}

/**
 * Install Material-style ripple click feedback on interactive elements.
 * Adds a span.ripple that expands from the click point and fades.
 */
function installRippleFeedback() {
  const selectors = [
    ".primary-control",
    ".dock-button",
    ".icon-button",
    ".composer-mic",
    ".composer-icon",
    ".composer-end",
    ".setup-primary",
    ".ghost-button",
    ".settings-btn",
    ".setup-step",
  ];

  document.addEventListener("pointerdown", (event) => {
    const target = event.target.closest(selectors.join(","));
    if (!target) return;
    // Skip if the element is disabled.
    if (target.disabled || target.getAttribute("aria-disabled") === "true") return;

    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;

    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    target.appendChild(ripple);

    // Clean up after the animation completes.
    setTimeout(() => {
      if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    }, 650);
  }, { passive: true });
}

/**
 * Set a button to a loading state (spinner) while an async operation runs.
 * Restores the original label when done. Safe to call on any button element.
 *
 * @param {HTMLButtonElement} btn
 * @param {Promise} promise
 */
async function withLoading(btn, promise) {
  if (!btn) return promise;
  const wasDisabled = btn.disabled;
  btn.classList.add("is-loading");
  btn.disabled = true;
  try {
    return await promise;
  } finally {
    btn.classList.remove("is-loading");
    btn.disabled = wasDisabled;
  }
}

// Re-exported for testing.
export { transcript, telemetry, toolCalls, quota, customInstructions };

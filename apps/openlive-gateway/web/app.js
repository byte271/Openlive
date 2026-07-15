/**
 * Openlive 1.2 — app.js
 *
 * Orchestrates the voice surface: WebSocket lifecycle, audio session,
 * transcript, voice picker, mode picker, settings, telemetry, and
 * keyboard shortcuts.
 *
 * Architecture:
 *   - `socket` is the binary WebSocket to /v1/realtime on the gateway.
 *   - `audio` is the AudioSession (mic capture + playback worklets).
 *   - `visualizer` is the canvas orb renderer.
 *   - `transcript` is the in-memory TranscriptLog.
 *   - `telemetry` is the ConnectionTelemetry rolling window.
 *   - `settings` is the persisted user preferences.
 *
 * The control flow is event-driven: gateway events flow in through
 * `handleControl`, audio events flow in through AudioSession callbacks,
 * and user events flow in through the DOM listeners wired at the bottom
 * of this file.
 */

import { AudioSession } from "./audio-session.js";
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
import { ToolCallLog } from "./tool-calls.js";
import { TranscriptLog } from "./transcript-log.js";
import * as visualCards from "./visual-cards.js";
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
  setSignalLevels,
  setStarting,
  setTelemetry,
  setVoiceBadge,
  setVoiceMode,
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

let settings = loadSettings();
let voices = [...OFFLINE_VOICES];
let selectedVoice = selectVoice(voices, settings.voiceId);
let selectedModeId = settings.modeId;
let customInstructions = loadCustomInstructions();
let cameraActive = false;
let screenShareActive = false;
let visualInputSupported = false;
let memoryScope = localStorage.getItem("openlive:v2:memory-scope") ?? "off";
let languagePreference = localStorage.getItem("openlive:v2:language") ?? "auto";

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
    fireBargeInRipple();
    visualizer.fireBargeIn();
    transition(VoiceMode.INTERRUPTED);
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

controls.primary.addEventListener("click", handlePrimaryAction);
controls.end.addEventListener("click", endConversation);
controls.settings.addEventListener("click", () => toggleSettings());
controls.closeSettings.addEventListener("click", () => toggleSettings(false));
controls.backchannels.addEventListener("change", (event) =>
  persistField("backchannels", event.target.value, /* reconfigure */ true),
);
controls.entryMode.addEventListener("change", (event) => {
  persistField("entryMode", event.target.value);
  applyEntryMode();
});
controls.sessionCap.addEventListener("change", (event) => {
  const minutes = Number(event.target.value);
  quota.configure({ hardCapSeconds: minutes * 60 });
  if (conversationActive && minutes > 0) {
    quota.start();
  } else if (minutes === 0) {
    setQuotaPill(Number.POSITIVE_INFINITY);
  }
  addTimeline("quota", `Session cap set to ${minutes || "unlimited"} minutes`);
});
controls.speedOverride.addEventListener("change", (event) => {
  persistField("speedOverride", event.target.value, /* reconfigure */ true);
  customInstructions = loadCustomInstructions();
  refreshInstructionsBadge();
  if (controls.instructionsPanel?.dataset.open === "true") {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.detailOverride.addEventListener("change", (event) => {
  persistField("detailOverride", event.target.value, /* reconfigure */ true);
  customInstructions = loadCustomInstructions();
  refreshInstructionsBadge();
  if (controls.instructionsPanel?.dataset.open === "true") {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.complexityOverride.addEventListener("change", (event) => {
  persistField("complexityOverride", event.target.value, /* reconfigure */ true);
  customInstructions = loadCustomInstructions();
  refreshInstructionsBadge();
  if (controls.instructionsPanel?.dataset.open === "true") {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.toneOverride.addEventListener("change", (event) => {
  persistField("toneOverride", event.target.value, /* reconfigure */ true);
  customInstructions = loadCustomInstructions();
  refreshInstructionsBadge();
  if (controls.instructionsPanel?.dataset.open === "true") {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.themeSelect.addEventListener("change", (event) =>
  applyTheme(event.target.value),
);
controls.motionRange.addEventListener("input", (event) => {
  const scale = Number(event.target.value) / 100;
  visualizer.setMotionScale(scale);
  setMotionReadout(scale);
  settings = saveSettings({ motionScale: scale });
});
controls.latencyToggle.addEventListener("change", (event) => {
  settings = saveSettings({ showLatency: event.target.checked });
  refreshLatencyPill();
});
controls.debug.addEventListener("click", () => toggleDiagnostics());
controls.brand.addEventListener("click", () => toggleDiagnostics());
controls.closeDebug.addEventListener("click", () => toggleDiagnostics(false));
controls.transcriptToggle.addEventListener("click", () => toggleTranscript());
controls.transcriptClose.addEventListener("click", () => toggleTranscript(false));
controls.transcriptClear.addEventListener("click", () => {
  transcript.clear();
  toolCalls.clear();
  renderTranscript(transcript.entries);
});
controls.voice.addEventListener("click", () => toggleVoicePicker());
controls.closeVoice.addEventListener("click", () => toggleVoicePicker(false));
controls.mode.addEventListener("click", () => toggleModePicker());
controls.closeMode.addEventListener("click", () => toggleModePicker(false));
controls.instructions.addEventListener("click", () => {
  const open = toggleInstructions();
  if (open) {
    renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  }
});
controls.closeInstructions.addEventListener("click", () => toggleInstructions(false));
controls.resetInstructions.addEventListener("click", () => {
  customInstructions = resetCustomInstructions();
  refreshInstructionsBadge();
  renderInstructionsPanel(customInstructions, onInstructionAxisChange);
  syncSettingsFormInstructions();
  if (sessionId) configureSession();
  addTimeline("instructions", "Reset to auto");
});
controls.camera.addEventListener("click", () => void toggleCamera());
controls.screenShare.addEventListener("click", () => void toggleScreenShare());
document.querySelector("#snapshotAction")?.addEventListener("click", () => void shareVisualSnapshot());
controls.layoutToggle.addEventListener("click", () => {
  const next = settings.layout === "focused" ? "inline" : "focused";
  settings = saveSettings({ layout: next });
  setLayout(next);
});
controls.onboardingDismiss.addEventListener("click", () => {
  settings = saveSettings({ onboardingDismissed: true });
  setOnboardingOpen(false);
});
controls.onboardingStart.addEventListener("click", () => setOnboardingOpen(false));

window.addEventListener("beforeunload", () => {
  visualizer.destroy();
  void mediaCapture.stopAll();
});

installShortcuts({
  isConversationActive: () => conversationActive,
  isPTTMode: () => settings.entryMode === "ptt",
  onPTTStart: () => {
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
  },
  onPTTEnd: () => {
    if (!pttHeld) return;
    pttHeld = false;
    // In PTT mode, releasing commits the turn: keep mic hot for a moment
    // so trailing audio is captured, then yield to thinking.
    if (microphoneActive) {
      transition(VoiceMode.THINKING);
    }
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

applyTheme(settings.theme);
applyEntryMode();
applySettingsForm();
applySessionCapFromSettings();
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
if (!settings.onboardingDismissed) {
  setOnboardingOpen(true);
}

/* ---------------------------------------------------------------------------
   Primary action / conversation lifecycle
   --------------------------------------------------------------------------- */

async function handlePrimaryAction() {
  if (!conversationActive) {
    await beginConversation();
    return;
  }
  if (settings.entryMode === "ptt") {
    // In PTT mode the primary button mirrors the spacebar.
    if (pttHeld) return;
    pttHeld = true;
    if (!microphoneActive) {
      try {
        await audio.startMicrophone();
        microphoneActive = true;
        setConversationActive(true, true, true);
        transition(VoiceMode.LISTENING);
      } catch (error) {
        showNotice(microphoneErrorMessage(error));
      }
    }
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
    return;
  }
  audio.startMicrophone().then(() => {
    microphoneActive = true;
    setConversationActive(true, true, settings.entryMode === "ptt");
    hideNotice();
    transition(VoiceMode.LISTENING);
  }).catch((error) => showNotice(microphoneErrorMessage(error)));
}

async function beginConversation() {
  userEnded = false;
  reconnectAttempt = 0;
  mediaTimeUs = 0;
  assistantText = "";
  transcriptVisible = false;
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
    await openConnection();
    const sampleRate = await audio.startMicrophone();
    microphoneActive = true;
    conversationActive = true;
    setConversationActive(true, true, settings.entryMode === "ptt");
    addTimeline("microphone", `Capture started at ${sampleRate} Hz`);
    transition(VoiceMode.LISTENING);
    transcript.append("system", "Conversation started.");
    renderTranscript(transcript.entries);
    quota.start();
    if (quota.remainingSeconds() !== Number.POSITIVE_INFINITY) {
      setQuotaPill(quota.remainingSeconds(), "ok");
    }
  } catch (error) {
    userEnded = true;
    socket?.close();
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
  clearTimeout(reconnectTimer);
  clearTimeout(transcriptTimer);
  quota.stop();
  quota.reset();
  setQuotaPill(Number.POSITIVE_INFINITY);
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
  if (!ready()) return;
  socket.send(
    encodeInputAudio({
      sequence: nextSequence(),
      mediaTimeUs,
      pcm,
      sampleRate: audio.inputSampleRate,
      frameDurationMs: 20,
      speechProbability,
      outputLevel: playbackLevel,
      echoProbability,
    }),
  );
  mediaTimeUs += 20_000;
  telemetry.expectAck();
}

function configureSession() {
  if (!sessionId) return;
  const profile = buildInteractionProfile(selectedModeId, settings.backchannels);
  // Merge the mode prefix + speed/detail axes with the new complexity/tone axes.
  const modeInstruction = composeInstruction(
    selectedModeId,
    settings.speedOverride,
    settings.detailOverride,
  );
  const customInstruction = composeCustomInstructions(customInstructions);
  const instruction = [modeInstruction, customInstruction]
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
    protocol_revision: 3,
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
    supported_languages: ["en", "es", "fr", "de", "ja"],
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

function sendControl(streamId, eventMediaTimeUs, type, payload, generationId = null) {
  if (!ready()) return;
  const envelope = {
    protocol_version: PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    session_id: sessionId,
    stream_id: streamId,
    sequence: nextSequence(),
    media_time_us: eventMediaTimeUs,
    type,
    payload,
  };
  if (generationId) envelope.generation_id = generationId;
  socket.send(JSON.stringify(envelope));
}

/* ---------------------------------------------------------------------------
   Inbound frames
   --------------------------------------------------------------------------- */

function handleMedia(packet) {
  observeServerSequence(packet.sequence);
  audio.enqueue(packet).catch((error) => {
    showNotice("Audio playback could not start.");
    addTimeline("playback_error", error.message);
  });
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
    const last = transcript.last();
    if (
      last &&
      last.role === "user" &&
      last.pending &&
      last.generationId === envelope.generation_id
    ) {
      transcript.finalize(last.id, payload.text);
    } else {
      transcript.append("user", payload.text, {
        generationId: envelope.generation_id,
      });
    }
    renderTranscript(transcript.entries);
    return;
  }
  if (type === "output_text_delta") {
    assistantText += payload.delta;
    transcriptVisible = true;
    setAssistantText(assistantText);
    // Mirror into the transcript log so the user has a persistent record.
    const last = transcript.last();
    if (last && last.role === "assistant" && last.pending && last.generationId === envelope.generation_id) {
      transcript.appendDelta(last.id, payload.delta);
    } else {
      transcript.beginAssistantStream(envelope.generation_id);
      transcript.appendDelta(transcript.last().id, payload.delta);
    }
    renderTranscript(transcript.entries);
    return;
  }
  if (type === "output_text_final") {
    transcriptVisible = true;
    setAssistantText(payload.text);
    assistantText = "";
    transcript.finalizeByGeneration(envelope.generation_id, payload.text);
    renderTranscript(transcript.entries);
    clearTimeout(transcriptTimer);
    transcriptTimer = setTimeout(() => {
      transcriptVisible = false;
      setAssistantText("");
    }, 7000);
    return;
  }
  if (type === "output_audio_cancel") {
    addTimeline("cancel", payload.reason);
    audio.cancel(envelope.generation_id, payload.fade_ms);
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
  if (
    conversationActive &&
    microphoneActive &&
    inputLevel > 0.58 &&
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
  mode = nextMode;
  setVoiceMode(nextMode, detail);
  visualizer.setMode(nextMode);
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
  return sessionId && socket?.readyState === WebSocket.OPEN;
}

/* ---------------------------------------------------------------------------
   Voice picker & mode picker
   --------------------------------------------------------------------------- */

function onVoiceSelected(voice) {
  selectedVoice = voice;
  settings = saveSettings({ voiceId: voice.id });
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
  if (controls.themeSelect) controls.themeSelect.value = theme;
  settings = saveSettings({ theme });
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
  if (controls.motionRange) controls.motionRange.value = String(Math.round(settings.motionScale * 100));
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
  const addButton = document.querySelector("#taskAdd");
  if (addButton) {
    addButton.addEventListener("click", () => {
      const intent = window.prompt("What should OpenLive do?");
      if (!intent || !intent.trim()) return;
      const taskId = taskOrchestrator.requestTask(intent.trim(), {
        evidenceRequired: ["transcript", "tool_call"],
      });
      if (!taskId) {
        showNotice("Start a conversation before issuing a task.");
      }
    });
  }
  // Render any tasks loaded from localStorage.
  taskOrchestrator.render();
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

// Re-exported for testing.
export { transcript, telemetry, toolCalls, quota, customInstructions };

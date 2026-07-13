import { AudioSession } from "./audio-session.js";
import {
  decodeOutputAudio,
  encodeInputAudio,
  PROTOCOL_VERSION,
} from "./protocol.js";
import {
  addTimeline,
  controls,
  setAssistantText,
  setConnected,
  setConnecting,
  setEchoProbability,
  setInteractionState,
  setMicrophoneActive,
  setOutputGain,
  setPlaybackBuffer,
  setProviderHint,
  setSpeechProbability,
} from "./ui.js";

let socket;
let sessionId;
let sequence = 0;
let mediaTimeUs = 0;
let assistantText = "";
let inputSampleRate = 16000;
let lastServerSequence = 0;

const audio = new AudioSession({
  onInputFrame: sendAudioFrame,
  onPlayed: acknowledgePlayout,
  onTimeline: addTimeline,
  onBuffer: setPlaybackBuffer,
  onGain: setOutputGain,
});

controls.connect.addEventListener("click", connect);
controls.disconnect.addEventListener("click", disconnect);
controls.microphone.addEventListener("click", toggleMicrophone);
controls.backchannels.addEventListener("change", configureSession);

function connect() {
  sessionId = undefined;
  sequence = 0;
  mediaTimeUs = 0;
  lastServerSequence = 0;
  assistantText = "";
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/v1/realtime`);
  socket.binaryType = "arraybuffer";
  setConnecting();

  socket.addEventListener("open", () => {
    setConnected(true);
    addTimeline("socket", "Realtime connection opened");
  });
  socket.addEventListener("message", ({ data }) => {
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
  socket.addEventListener("close", () => {
    audio.stopMicrophone();
    setMicrophoneActive(false);
    setConnected(false);
    sessionId = undefined;
    addTimeline("socket", "Realtime connection closed");
  });
}

function disconnect() {
  socket?.close();
}

async function toggleMicrophone() {
  if (audio.isMicrophoneActive()) {
    audio.stopMicrophone();
    setMicrophoneActive(false);
    return;
  }
  try {
    const sampleRate = await audio.startMicrophone();
    setMicrophoneActive(true);
    addTimeline("microphone", `Capture started at ${sampleRate} Hz`);
  } catch (error) {
    addTimeline("microphone_error", error.message);
  }
}

function sendAudioFrame({
  pcm,
  speechProbability,
  outputLevel,
  echoProbability,
}) {
  if (!ready()) return;
  socket.send(
    encodeInputAudio({
      sequence: nextSequence(),
      mediaTimeUs,
      pcm,
      sampleRate: inputSampleRate,
      frameDurationMs: 20,
      speechProbability,
      outputLevel,
      echoProbability,
    }),
  );
  mediaTimeUs += 20_000;
}

function configureSession() {
  if (!sessionId) return;
  sendControl("session", mediaTimeUs, "session_configured", {
    interaction_profile: {
      backchannels: controls.backchannels.value,
      pause_tolerance_ms: 650,
      interruption_sensitivity: "balanced",
    },
  });
}

function acknowledgePlayout(message) {
  if (!ready()) return;
  sendControl(
    "assistant_playout",
    message.mediaEndUs,
    "output_audio_played",
    { last_media_time_us: message.mediaEndUs },
    message.generationId,
  );
}

function sendControl(
  streamId,
  eventMediaTimeUs,
  type,
  payload,
  generationId = null,
) {
  socket.send(
    JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      session_id: sessionId,
      stream_id: streamId,
      sequence: nextSequence(),
      media_time_us: eventMediaTimeUs,
      generation_id: generationId,
      parent_event_id: null,
      type,
      payload,
    }),
  );
}

function handleMedia(packet) {
  observeServerSequence(packet.sequence);
  audio.enqueue(packet).catch((error) => {
    addTimeline("playback_error", error.message);
  });
}

function handleControl(envelope) {
  observeServerSequence(envelope.sequence);
  const { type, payload } = envelope;
  if (type === "session_created") {
    sessionId = envelope.session_id;
    inputSampleRate = payload.input_sample_rate;
    audio.setInputSampleRate(inputSampleRate);
    setProviderHint(payload.provider_class);
    addTimeline("session", `${payload.model} allocated`);
    configureSession();
    return;
  }
  if (type === "observation") {
    setSpeechProbability(payload.speech_probability);
    setEchoProbability(payload.echo_probability);
    return;
  }
  if (type === "endpointing_prediction") {
    if (payload.should_respond) addTimeline("endpoint", payload.reason);
    return;
  }
  if (type === "interaction_decision") {
    setInteractionState(payload.action);
    addTimeline(payload.action, payload.reason);
    audio.applyDecision(payload.action, envelope.generation_id);
    return;
  }
  if (type === "output_text_delta") {
    assistantText += payload.delta;
    setAssistantText(assistantText);
    return;
  }
  if (type === "output_text_final") {
    setAssistantText(payload.text);
    assistantText = "";
    return;
  }
  if (type === "output_audio_cancel") {
    addTimeline("cancel", payload.reason);
    audio.cancel(envelope.generation_id, payload.fade_ms);
    return;
  }
  if (type === "provider_state") {
    addTimeline("provider", payload.state);
    if (payload.state === "generating") audio.providerGenerating();
    if (payload.state === "complete") audio.complete(envelope.generation_id);
    return;
  }
  if (type === "latency_mark") {
    addTimeline(
      "latency",
      `${payload.phase}: ${(payload.elapsed_us / 1000).toFixed(1)} ms`,
    );
    return;
  }
  if (type === "error") {
    addTimeline("error", `${payload.code}: ${payload.message}`);
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
  return sessionId && socket?.readyState === WebSocket.OPEN;
}

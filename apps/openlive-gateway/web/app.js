const elements = {
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  microphone: document.querySelector("#microphone"),
  connection: document.querySelector("#connection"),
  backchannels: document.querySelector("#backchannels"),
  speechProbability: document.querySelector("#speechProbability"),
  interactionState: document.querySelector("#interactionState"),
  outputGain: document.querySelector("#outputGain"),
  assistantText: document.querySelector("#assistantText"),
  timeline: document.querySelector("#timeline"),
};

let socket;
let sessionId;
let sequence = 0;
let mediaTimeUs = 0;
let audioContext;
let microphoneStream;
let captureNode;
let outputGain;
let outputGainConnected = false;
let nextPlaybackTime = 0;
let activeSources = new Map();
let assistantText = "";

elements.connect.addEventListener("click", connect);
elements.disconnect.addEventListener("click", disconnect);
elements.microphone.addEventListener("click", toggleMicrophone);
elements.backchannels.addEventListener("change", configureSession);

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/v1/realtime`);
  setConnection("connecting", "Connecting");

  socket.addEventListener("open", () => {
    setConnection("connected", "Connected");
    elements.connect.disabled = true;
    elements.disconnect.disabled = false;
    elements.microphone.disabled = false;
    elements.backchannels.disabled = false;
    addTimeline("socket", "Realtime connection opened");
  });

  socket.addEventListener("message", ({ data }) => {
    const envelope = JSON.parse(data);
    handleEvent(envelope);
  });

  socket.addEventListener("close", () => {
    stopMicrophone();
    setConnection("disconnected", "Disconnected");
    elements.connect.disabled = false;
    elements.disconnect.disabled = true;
    elements.microphone.disabled = true;
    elements.backchannels.disabled = true;
    addTimeline("socket", "Realtime connection closed");
  });
}

function disconnect() {
  socket?.close();
}

async function toggleMicrophone() {
  if (microphoneStream) {
    stopMicrophone();
    return;
  }

  audioContext ??= new AudioContext({ latencyHint: "interactive" });
  await audioContext.resume();
  await audioContext.audioWorklet.addModule("/audio-capture-worklet.js");
  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const source = audioContext.createMediaStreamSource(microphoneStream);
  captureNode = new AudioWorkletNode(audioContext, "openlive-capture");
  captureNode.port.onmessage = ({ data }) => sendAudioFrame(data);
  source.connect(captureNode);
  captureNode.connect(audioContext.destination);
  elements.microphone.textContent = "Stop microphone";
  addTimeline("microphone", `Capture started at ${audioContext.sampleRate} Hz`);
}

function stopMicrophone() {
  microphoneStream?.getTracks().forEach((track) => track.stop());
  captureNode?.disconnect();
  microphoneStream = undefined;
  captureNode = undefined;
  elements.microphone.textContent = "Start microphone";
}

function sendAudioFrame(floatSamples) {
  if (!sessionId || socket?.readyState !== WebSocket.OPEN) return;
  const samples = resample(floatSamples, audioContext.sampleRate, 16000);
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = value < 0 ? value * 32768 : value * 32767;
  }
  sendEvent("microphone", mediaTimeUs, "input_audio_frame", {
    audio_b64: bytesToBase64(new Uint8Array(pcm.buffer)),
    sample_rate: 16000,
    channels: 1,
    frame_duration_ms: 20,
  });
  mediaTimeUs += 20000;
}

function configureSession() {
  if (!sessionId) return;
  sendEvent("session", mediaTimeUs, "session_configured", {
    interaction_profile: {
      backchannels: elements.backchannels.value,
      pause_tolerance_ms: 650,
      interruption_sensitivity: "balanced",
    },
  });
}

function sendEvent(streamId, eventMediaTimeUs, type, payload) {
  socket.send(
    JSON.stringify({
      protocol_version: "0.1",
      event_id: crypto.randomUUID(),
      session_id: sessionId,
      stream_id: streamId,
      sequence: ++sequence,
      media_time_us: eventMediaTimeUs,
      generation_id: null,
      parent_event_id: null,
      type,
      payload,
    }),
  );
}

function handleEvent(envelope) {
  const { type, payload } = envelope;
  if (type === "session_created") {
    sessionId = envelope.session_id;
    addTimeline("session", `${payload.model} allocated`);
    configureSession();
    return;
  }
  if (type === "observation") {
    elements.speechProbability.textContent =
      payload.speech_probability.toFixed(2);
    return;
  }
  if (type === "interaction_decision") {
    elements.interactionState.textContent = payload.action;
    addTimeline(payload.action, payload.reason);
    if (payload.action === "soft_duck") setOutputGain(0.18, 0.04);
    if (payload.action === "resume") setOutputGain(1, 0.08);
    if (payload.action === "hard_yield") stopGeneration(envelope.generation_id);
    return;
  }
  if (type === "output_text_delta") {
    assistantText += payload.delta;
    elements.assistantText.textContent = assistantText;
    return;
  }
  if (type === "output_text_final") {
    elements.assistantText.textContent = payload.text;
    assistantText = "";
    return;
  }
  if (type === "output_audio_frame") {
    playPcmFrame(envelope.generation_id, payload);
    return;
  }
  if (type === "output_audio_cancel") {
    addTimeline("cancel", payload.reason);
    stopGeneration(envelope.generation_id);
    return;
  }
  if (type === "provider_state") {
    addTimeline("provider", payload.state);
    if (payload.state === "generating") setOutputGain(1, 0.02);
    return;
  }
  if (type === "error") {
    addTimeline("error", `${payload.code}: ${payload.message}`);
  }
}

async function playPcmFrame(generationId, payload) {
  audioContext ??= new AudioContext({ latencyHint: "interactive" });
  await audioContext.resume();
  ensureOutputGain();

  const bytes = base64ToBytes(payload.audio_b64);
  const samples = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 2,
  );
  const buffer = audioContext.createBuffer(1, samples.length, payload.sample_rate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) {
    channel[index] = samples[index] / 32768;
  }

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(outputGain);
  const startAt = Math.max(audioContext.currentTime + 0.025, nextPlaybackTime);
  nextPlaybackTime = startAt + buffer.duration;
  source.start(startAt);
  const sources = activeSources.get(generationId) ?? new Set();
  sources.add(source);
  activeSources.set(generationId, sources);
  source.onended = () => sources.delete(source);
}

function stopGeneration(generationId) {
  const sources = activeSources.get(generationId);
  if (sources) {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    activeSources.delete(generationId);
  }
  nextPlaybackTime = audioContext?.currentTime ?? 0;
  setOutputGain(1, 0.05);
}

function setOutputGain(value, seconds) {
  if (!audioContext) return;
  ensureOutputGain();
  outputGain.gain.cancelScheduledValues(audioContext.currentTime);
  outputGain.gain.linearRampToValueAtTime(
    value,
    audioContext.currentTime + seconds,
  );
  elements.outputGain.textContent = `${Math.round(value * 100)}%`;
}

function ensureOutputGain() {
  outputGain ??= audioContext.createGain();
  if (!outputGainConnected) {
    outputGain.connect(audioContext.destination);
    outputGainConnected = true;
  }
}

function resample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function setConnection(className, label) {
  elements.connection.className = `status ${className}`;
  elements.connection.textContent = label;
}

function addTimeline(kind, detail) {
  const item = document.createElement("li");
  item.innerHTML = `<span>${escapeHtml(kind)}</span><p>${escapeHtml(detail)}</p>`;
  elements.timeline.prepend(item);
  while (elements.timeline.children.length > 40) {
    elements.timeline.lastElementChild.remove();
  }
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}

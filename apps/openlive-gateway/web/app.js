const elements = {
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  microphone: document.querySelector("#microphone"),
  connection: document.querySelector("#connection"),
  backchannels: document.querySelector("#backchannels"),
  speechProbability: document.querySelector("#speechProbability"),
  interactionState: document.querySelector("#interactionState"),
  outputGain: document.querySelector("#outputGain"),
  playbackBuffer: document.querySelector("#playbackBuffer"),
  assistantText: document.querySelector("#assistantText"),
  providerHint: document.querySelector("#providerHint"),
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
let playbackNode;
let playbackModulePromise;
let playbackFrameCounts = new Map();
let canceledGenerations = new Set();
let assistantText = "";
let localNoiseFloor = 0.006;
let locallyDucked = false;
let localResumeTimer;
let hardYielded = false;
let inputSampleRate = 16000;

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
  const localSpeechProbability = estimateLocalSpeech(floatSamples);
  applyLocalInterruption(localSpeechProbability);
  const samples = resample(
    floatSamples,
    audioContext.sampleRate,
    inputSampleRate,
  );
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = value < 0 ? value * 32768 : value * 32767;
  }
  sendEvent("microphone", mediaTimeUs, "input_audio_frame", {
    audio_b64: bytesToBase64(new Uint8Array(pcm.buffer)),
    sample_rate: inputSampleRate,
    channels: 1,
    frame_duration_ms: 20,
    client_speech_probability: localSpeechProbability,
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

function sendEvent(
  streamId,
  eventMediaTimeUs,
  type,
  payload,
  generationId = null,
) {
  socket.send(
    JSON.stringify({
      protocol_version: "0.2",
      event_id: crypto.randomUUID(),
      session_id: sessionId,
      stream_id: streamId,
      sequence: ++sequence,
      media_time_us: eventMediaTimeUs,
      generation_id: generationId,
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
    inputSampleRate = payload.input_sample_rate;
    addTimeline("session", `${payload.model} allocated`);
    if (payload.provider_class === "mock") {
      elements.providerHint.textContent =
        "The mock provider emits a tone. Select a configured real provider for speech.";
    } else if (payload.provider_class === "native_duplex") {
      elements.providerHint.textContent =
        "A native realtime speech session is active with continuous audio input and generation cancellation.";
    } else {
      elements.providerHint.textContent =
        "An OpenAI-compatible ASR → LLM → PCM TTS cascade is active.";
    }
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
    if (payload.action === "resume") {
      locallyDucked = false;
      setOutputGain(1, 0.08);
    }
    if (payload.action === "hard_yield") {
      hardYielded = true;
      stopGeneration(envelope.generation_id);
    }
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
    if (canceledGenerations.has(envelope.generation_id)) return;
    playPcmFrame(envelope);
    return;
  }
  if (type === "output_audio_cancel") {
    addTimeline("cancel", payload.reason);
    stopGeneration(envelope.generation_id, payload.fade_ms);
    return;
  }
  if (type === "provider_state") {
    addTimeline("provider", payload.state);
    if (payload.state === "generating") {
      hardYielded = false;
      locallyDucked = false;
      setOutputGain(1, 0.02);
    }
    if (payload.state === "complete" && playbackNode) {
      playbackNode.port.postMessage({
        type: "complete",
        generationId: envelope.generation_id,
      });
    }
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

async function playPcmFrame(envelope) {
  const { generation_id: generationId, media_time_us: frameMediaTimeUs } =
    envelope;
  const payload = envelope.payload;
  await ensurePlayback();

  const bytes = base64ToBytes(payload.audio_b64);
  const pcm = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 2,
  );
  const decoded = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    decoded[index] = pcm[index] / 32768;
  }
  const samples = resample(decoded, payload.sample_rate, audioContext.sampleRate);
  playbackFrameCounts.set(
    generationId,
    (playbackFrameCounts.get(generationId) ?? 0) + 1,
  );
  playbackNode.port.postMessage(
    {
      type: "enqueue",
      generationId,
      mediaEndUs: frameMediaTimeUs + payload.frame_duration_ms * 1000,
      samples: samples.buffer,
    },
    [samples.buffer],
  );
}

function stopGeneration(generationId, fadeMs = 35) {
  if (generationId) {
    canceledGenerations.add(generationId);
    while (canceledGenerations.size > 256) {
      canceledGenerations.delete(canceledGenerations.values().next().value);
    }
  }
  playbackFrameCounts.delete(generationId);
  if (playbackNode && generationId) {
    playbackNode.port.postMessage({
      type: "cancel",
      generationId,
      fadeMs,
    });
  }
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

async function ensurePlayback() {
  audioContext ??= new AudioContext({ latencyHint: "interactive" });
  await audioContext.resume();
  ensureOutputGain();
  if (!playbackNode) {
    playbackModulePromise ??= audioContext.audioWorklet.addModule(
      "/audio-playback-worklet.js",
    );
    await playbackModulePromise;
    playbackNode = new AudioWorkletNode(audioContext, "openlive-playback", {
      outputChannelCount: [1],
    });
    playbackNode.port.onmessage = ({ data }) => handlePlaybackMessage(data);
    playbackNode.connect(outputGain);
  }
}

function handlePlaybackMessage(message) {
  if (message.type === "played") {
    const remaining = Math.max(
      0,
      (playbackFrameCounts.get(message.generationId) ?? 1) - 1,
    );
    if (remaining === 0) playbackFrameCounts.delete(message.generationId);
    else playbackFrameCounts.set(message.generationId, remaining);
    if (
      !canceledGenerations.has(message.generationId) &&
      socket?.readyState === WebSocket.OPEN &&
      sessionId
    ) {
      sendEvent(
        "assistant_playout",
        message.mediaEndUs,
        "output_audio_played",
        { last_media_time_us: message.mediaEndUs },
        message.generationId,
      );
    }
    return;
  }
  if (message.type === "canceled" || message.type === "idle") {
    playbackFrameCounts.delete(message.generationId);
    return;
  }
  if (message.type === "underflow") {
    addTimeline(
      "jitter",
      `Playback underflow; target raised to ${message.targetMs.toFixed(0)} ms`,
    );
    return;
  }
  if (message.type === "buffer") {
    elements.playbackBuffer.textContent =
      `${message.queuedMs.toFixed(0)} / ${message.targetMs.toFixed(0)} ms`;
  }
}

function estimateLocalSpeech(samples) {
  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    energy += samples[index] * samples[index];
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  const outputActive = hasActiveOutput();
  if (!outputActive && rms < localNoiseFloor * 2.2) {
    localNoiseFloor = localNoiseFloor * 0.98 + rms * 0.02;
  }
  const ratio = rms / Math.max(0.001, localNoiseFloor);
  return Math.max(0, Math.min(1, (ratio - 1.8) / 5.5));
}

function applyLocalInterruption(probability) {
  if (!hasActiveOutput()) return;
  if (probability >= 0.62 && !locallyDucked) {
    clearTimeout(localResumeTimer);
    locallyDucked = true;
    setOutputGain(0.18, 0.02);
    addTimeline("local_duck", "Playback attenuated before server confirmation");
    return;
  }
  if (probability <= 0.28 && locallyDucked && !hardYielded) {
    clearTimeout(localResumeTimer);
    localResumeTimer = setTimeout(() => {
      if (!hardYielded) {
        locallyDucked = false;
        setOutputGain(1, 0.06);
      }
    }, 120);
  }
}

function hasActiveOutput() {
  for (const count of playbackFrameCounts.values()) {
    if (count > 0) return true;
  }
  return false;
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

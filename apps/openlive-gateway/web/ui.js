const elements = {
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  microphone: document.querySelector("#microphone"),
  connection: document.querySelector("#connection"),
  backchannels: document.querySelector("#backchannels"),
  speechProbability: document.querySelector("#speechProbability"),
  echoProbability: document.querySelector("#echoProbability"),
  interactionState: document.querySelector("#interactionState"),
  outputGain: document.querySelector("#outputGain"),
  playbackBuffer: document.querySelector("#playbackBuffer"),
  assistantText: document.querySelector("#assistantText"),
  providerHint: document.querySelector("#providerHint"),
  timeline: document.querySelector("#timeline"),
};

export const controls = {
  connect: elements.connect,
  disconnect: elements.disconnect,
  microphone: elements.microphone,
  backchannels: elements.backchannels,
};

export function setConnected(connected) {
  elements.connection.className = `status ${connected ? "connected" : "disconnected"}`;
  elements.connection.textContent = connected ? "Connected" : "Disconnected";
  elements.connect.disabled = connected;
  elements.disconnect.disabled = !connected;
  elements.microphone.disabled = !connected;
  elements.backchannels.disabled = !connected;
}

export function setConnecting() {
  elements.connection.className = "status connecting";
  elements.connection.textContent = "Connecting";
}

export function setMicrophoneActive(active) {
  elements.microphone.textContent = active
    ? "Stop microphone"
    : "Start microphone";
}

export function setSpeechProbability(value) {
  elements.speechProbability.textContent = value.toFixed(2);
}

export function setEchoProbability(value) {
  elements.echoProbability.textContent = value.toFixed(2);
}

export function setInteractionState(value) {
  elements.interactionState.textContent = value;
}

export function setOutputGain(value) {
  elements.outputGain.textContent = `${Math.round(value * 100)}%`;
}

export function setPlaybackBuffer(queuedMs, targetMs) {
  elements.playbackBuffer.textContent =
    `${queuedMs.toFixed(0)} / ${targetMs.toFixed(0)} ms`;
}

export function setAssistantText(value) {
  elements.assistantText.textContent = value;
}

export function setProviderHint(providerClass) {
  const hints = {
    mock: "The mock provider emits a tone. Select a configured real provider for speech.",
    native_duplex:
      "Native realtime speech is active with continuous input and generation cancellation.",
    cascade:
      "An OpenAI-compatible streaming ASR → LLM → PCM TTS cascade is active.",
  };
  elements.providerHint.textContent =
    hints[providerClass] ?? "A configured realtime provider is active.";
}

export function addTimeline(kind, detail) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  const body = document.createElement("p");
  label.textContent = kind;
  body.textContent = detail;
  item.append(label, body);
  elements.timeline.prepend(item);
  while (elements.timeline.children.length > 40) {
    elements.timeline.lastElementChild.remove();
  }
}

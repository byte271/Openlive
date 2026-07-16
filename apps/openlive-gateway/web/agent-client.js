/**
 * OpenLive 26.7.15 — internal agent + LLM config client (no OpenCode).
 */

import { setupToLlmPayload } from "./setup-store.js";

/**
 * Push setup LLM credentials to the gateway (voice + agent share this).
 */
export async function pushLlmConfig(setup) {
  const body = setupToLlmPayload(setup);
  const response = await fetch("/v1/llm/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => ({ ok: false }));
}

export async function fetchLlmProviders() {
  const response = await fetch("/v1/llm/providers");
  if (!response.ok) return { providers: [] };
  return response.json();
}

export async function listRemoteModels(setup) {
  const response = await fetch("/v1/llm/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_url: setup.modelBaseUrl,
      api_key: setup.modelApiKey || undefined,
    }),
  });
  const data = await response.json().catch(() => ({ models: [] }));
  return data.models || [];
}

export async function runAgentTask(setup, intent, opts = {}) {
  const llm = setupToLlmPayload(setup);
  // Typo-correct client-side first for snappier search (server also corrects).
  let cleanIntent = intent;
  try {
    const tr = await fetch("/v1/typo/correct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: intent }),
    }).then((r) => r.json());
    if (tr?.corrected) cleanIntent = tr.corrected;
  } catch {
    /* ignore */
  }
  const body = {
    intent: cleanIntent,
    agent_kind: setup.agentKind === "none" ? "none" : "internal",
    ...llm,
    session_id: opts.sessionId || null,
    session_hint: opts.sessionId || null,
    prior_context: opts.priorContext || null,
    language: opts.language || null,
    thought_depth: setup.thoughtDepth || opts.thoughtDepth || "voice",
    agent_class: setup.agentClass || opts.agentClass || "general",
  };
  const response = await fetch("/v1/agent/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.model_status || data.http_status || response.status;
    const codeHint = data.model_code ? ` [${data.model_code}]` : "";
    return {
      task_id: data.task_id || crypto.randomUUID(),
      status: "error",
      error: data.error || response.statusText,
      model_status: code,
      model_code: data.model_code || null,
      http_status: response.status,
      // UI-friendly chip text
      status_label: `HTTP ${code}${codeHint}`,
    };
  }
  return data;
}

/**
 * Start a multi-agent research pool in the background (returns pool_id immediately).
 */
export async function startAgentPool(intent, opts = {}) {
  const r = await fetch("/v1/agent/pool/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: String(intent || "").slice(0, 400),
      max_agents: opts.maxAgents || 4,
      thought_depth: opts.thoughtDepth || "deep",
      use_llm: !!opts.useLlm,
    }),
  });
  return r.json().catch(() => ({ status: "error" }));
}

/**
 * Poll pool status until completed/error or timeout.
 */
export async function waitAgentPool(poolId, opts = {}) {
  const timeoutMs = opts.timeoutMs || 90000;
  const onTick = opts.onTick || (() => {});
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`/v1/agent/pool/status?id=${encodeURIComponent(poolId)}`);
    const st = await r.json().catch(() => ({}));
    onTick(st);
    if (st.status === "completed" || st.status === "error") return st;
    await new Promise((res) => setTimeout(res, 350));
  }
  return { status: "error", error: "pool timeout", pool_id: poolId };
}

/**
 * Subscribe to SSE pool progress.
 */
export function watchPoolEvents(poolId, onEvent) {
  let es = null;
  const ctrl = {
    close() {
      if (es) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
        es = null;
      }
    },
  };
  if (!poolId || typeof EventSource === "undefined") return ctrl;
  es = new EventSource(`/v1/agent/pool/events?id=${encodeURIComponent(poolId)}`);
  es.addEventListener("pool", (ev) => {
    try {
      onEvent?.(JSON.parse(ev.data || "{}"));
    } catch {
      /* ignore */
    }
  });
  es.onerror = () => ctrl.close();
  return ctrl;
}

export async function probeAgent(setup) {
  const llm = setupToLlmPayload(setup);
  const response = await fetch("/v1/agent/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_kind: setup.agentKind === "none" ? "none" : "internal",
      ...llm,
    }),
  });
  return response.json().catch(() => ({ ok: false, error: "probe failed" }));
}

/**
 * Preview a formant voice; returns decoded AudioBuffer-ready PCM info.
 */
export async function previewVoice(voiceId, text = "") {
  const response = await fetch("/v1/voices/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice_id: voiceId, text }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "preview failed");
  }
  return data;
}

export async function fetchVoices() {
  const response = await fetch("/v1/voices");
  if (!response.ok) return { voices: [] };
  return response.json();
}

/** Play base64 s16le PCM through Web Audio. */
export async function playPcmBase64(pcmBase64, sampleRate = 24000) {
  const binary = atob(pcmBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const samples = new Int16Array(bytes.buffer);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) {
    channel[i] = samples[i] / 32768;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return new Promise((resolve) => {
    src.onended = () => {
      void ctx.close();
      resolve();
    };
  });
}

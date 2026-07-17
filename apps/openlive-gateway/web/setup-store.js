/**
 * OpenLive 26.7.16 — setup store (LLM providers, voice, agent).
 * OpenCode removed. Agent is the built-in tool loop on the gateway.
 *
 * Security: API keys are NEVER written to the project folder, disk files,
 * or localStorage. They live only in process/browser memory for the tab
 * session (or gateway process memory after POST /v1/llm/config).
 */

const KEY = "openlive.v26.7.16.setup";

/** In-memory only — cleared on full page reload. Never serialized. */
let sessionApiKey = "";

export const AGENT_KINDS = Object.freeze([
  {
    id: "internal",
    name: "OpenLive agent",
    description: "Built-in tools: web search, time, calculator via your LLM.",
  },
  {
    id: "none",
    name: "Voice only",
    description: "Conversation only — no background agent tasks.",
  },
]);

export const DEFAULT_SETUP = Object.freeze({
  completed: false,
  displayName: "",
  /** LLM provider (nvidia, groq, …, custom) */
  llmProviderId: "nvidia",
  modelBaseUrl: "https://integrate.api.nvidia.com/v1",
  /** Always empty in persisted JSON; use session memory via loadSetup(). */
  modelApiKey: "",
  llmModel: "meta/llama-3.1-8b-instruct",
  ttsModel: "formant",
  asrModel: "browser",
  voiceId: "en_US-lessac-medium",
  /**
   * Explicit browser SpeechSynthesis voiceURI (system voice).
   * Empty = auto-pick by language.
   */
  browserVoiceURI: "",
  /** Background agent */
  agentKind: "internal",
  agentAutoDelegate: true,
  /** UX */
  stripFillers: true,
  naturalBackchannels: true,
  minimalUi: true,
  /** Prefer OS/browser neural voices over robotic formant synth */
  browserTts: true,
  /**
   * TTS engine preference:
   * - auto: Piper if installed, else formant, else browser
   * - piper: open-source neural (requires install)
   * - formant: built-in gateway synth
   * - browser: Web Speech API
   */
  ttsEngine: "auto",
  /** Thought depth: voice (short) | balanced | deep (long, research-style) */
  thoughtDepth: "voice",
  /**
   * Agent class (tool allow-list + memory slice):
   * general | researcher | coder | safe
   */
  agentClass: "general",
  /** Session memory on/off */
  memoryEnabled: true,
});

/** Fields that must never be written to localStorage or project files. */
const SECRET_FIELDS = Object.freeze(["modelApiKey", "api_key", "apiKey", "model_api_key"]);

function stripSecrets(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of SECRET_FIELDS) {
    if (k in out) out[k] = "";
  }
  return out;
}

function sanitize(raw) {
  const base = { ...DEFAULT_SETUP };
  if (!raw || typeof raw !== "object") return base;
  for (const key of Object.keys(DEFAULT_SETUP)) {
    if (raw[key] === undefined) continue;
    // Ignore any leaked secret fields from legacy storage.
    if (SECRET_FIELDS.includes(key)) continue;
    const def = DEFAULT_SETUP[key];
    if (typeof def === "boolean") {
      base[key] = Boolean(raw[key]);
    } else if (typeof def === "string") {
      base[key] = typeof raw[key] === "string" ? raw[key] : def;
    } else {
      base[key] = raw[key] ?? def;
    }
  }
  // Migrate legacy OpenCode setup → internal agent.
  if (raw.agentKind === "opencode" || raw.agentKind === "openai_compatible") {
    base.agentKind = "internal";
  }
  if (!AGENT_KINDS.some((a) => a.id === base.agentKind)) {
    base.agentKind = DEFAULT_SETUP.agentKind;
  }
  return base;
}

/**
 * Persist non-secret prefs. Always rewrite storage without API keys
 * (scrubs legacy localStorage entries that may have stored a key).
 */
function writeStorage(setup) {
  if (typeof localStorage === "undefined") return;
  try {
    const safe = stripSecrets(setup);
    safe.modelApiKey = "";
    localStorage.setItem(KEY, JSON.stringify(safe));
  } catch {
    /* quota */
  }
}

export function loadSetup() {
  let base = { ...DEFAULT_SETUP };
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // One-time scrub: if a legacy key was stored, drop it from disk.
        if (
          parsed &&
          typeof parsed === "object" &&
          SECRET_FIELDS.some((k) => parsed[k] && String(parsed[k]).length > 0)
        ) {
          writeStorage(sanitize(parsed));
        }
        base = sanitize(parsed);
      }
    } catch {
      base = { ...DEFAULT_SETUP };
    }
  }
  base.modelApiKey = sessionApiKey;
  return base;
}

export function saveSetup(partial) {
  if (partial && typeof partial === "object" && partial.modelApiKey !== undefined) {
    sessionApiKey =
      typeof partial.modelApiKey === "string" ? partial.modelApiKey : "";
  }
  const merged = { ...loadSetup(), ...partial };
  // loadSetup already re-injects sessionApiKey; re-apply after merge.
  if (partial && partial.modelApiKey !== undefined) {
    merged.modelApiKey = sessionApiKey;
  } else {
    merged.modelApiKey = sessionApiKey;
  }
  const next = sanitize(merged);
  next.modelApiKey = sessionApiKey;
  writeStorage(next);
  return next;
}

export function isSetupComplete() {
  return loadSetup().completed === true;
}

export function markSetupComplete(partial = {}) {
  return saveSetup({ ...partial, completed: true });
}

export function resetSetup() {
  sessionApiKey = "";
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETUP, modelApiKey: "" };
}

/** Clear in-memory API key only (prefs stay). */
export function clearSessionApiKey() {
  sessionApiKey = "";
  const s = loadSetup();
  s.modelApiKey = "";
  writeStorage(s);
  return s;
}

/** Payload for gateway /v1/llm/config and agent routes. */
export function setupToLlmPayload(setup) {
  const s = setup || loadSetup();
  const key = (s.modelApiKey || sessionApiKey || "").trim();
  return {
    provider_id: s.llmProviderId,
    base_url: s.modelBaseUrl,
    api_key: key || undefined,
    model: s.llmModel,
    voice_id: s.voiceId,
  };
}

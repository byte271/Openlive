/**
 * Openlive 26.7.15 — voice-profiles.js
 *
 * Voice roster shown in the in-app voice picker. The provider manifest
 * (fetched from /v1/providers) is the authoritative source when present;
 * the offline roster below is the fallback used by the mock provider and
 * any provider that does not declare voices.
 *
 * Voices are presented in the AVM pattern: name + one-line descriptor.
 * Open-source Piper voice ids are first-class so operators can match
 * openedai-speech / LocalAI / Piper HTTP servers without renaming.
 *
 * Descriptors are original Openlive copy — they do not mirror any
 * proprietary voice catalog.
 */

/**
 * @typedef {Object} VoiceProfile
 * @property {string} id - Stable identifier sent to the gateway.
 * @property {string} name - Display name.
 * @property {string} description - One-line personality descriptor.
 * @property {string} glyph - Single-character glyph for the picker avatar.
 * @property {string} [family] - Optional provenance tag (piper, open, mock).
 */

/**
 * Piper / open neural voices (MIT/GPL model weights downloaded by the
 * operator — OpenLive does not redistribute weights).
 *
 * @type {ReadonlyArray<VoiceProfile>}
 */
export const PIPER_VOICES = Object.freeze([
  {
    id: "en_US-lessac-medium",
    name: "Lessac",
    description: "Clear US English · Piper open neural voice.",
    glyph: "L",
    family: "piper",
  },
  {
    id: "en_US-amy-medium",
    name: "Amy",
    description: "Warm and conversational · Piper.",
    glyph: "Am",
    family: "piper",
  },
  {
    id: "en_US-ryan-high",
    name: "Ryan",
    description: "Lower, direct delivery · Piper high quality.",
    glyph: "R",
    family: "piper",
  },
  {
    id: "en_US-joe-medium",
    name: "Joe",
    description: "Steady narrative tone · Piper.",
    glyph: "J",
    family: "piper",
  },
  {
    id: "en_US-kathleen-low",
    name: "Kathleen",
    description: "Soft, measured · Piper low footprint.",
    glyph: "K",
    family: "piper",
  },
  {
    id: "en_GB-alba-medium",
    name: "Alba",
    description: "British English · Piper.",
    glyph: "Al",
    family: "piper",
  },
]);

/**
 * Generic OpenAI-compatible voice ids kept for hosted cascade endpoints.
 * @type {ReadonlyArray<VoiceProfile>}
 */
export const COMPAT_VOICES = Object.freeze([
  {
    id: "alloy",
    name: "Alloy",
    description: "Neutral cascade default (API-compatible id).",
    glyph: "A",
    family: "compat",
  },
  {
    id: "aria",
    name: "Aria",
    description: "Warm and conversational.",
    glyph: "Ar",
    family: "compat",
  },
  {
    id: "cove",
    name: "Cove",
    description: "Composed and direct.",
    glyph: "C",
    family: "compat",
  },
  {
    id: "ember",
    name: "Ember",
    description: "Confident and optimistic.",
    glyph: "E",
    family: "compat",
  },
  {
    id: "juniper",
    name: "Juniper",
    description: "Open and upbeat.",
    glyph: "J",
    family: "compat",
  },
  {
    id: "maple",
    name: "Maple",
    description: "Cheerful and grounded.",
    glyph: "M",
    family: "compat",
  },
  {
    id: "sage",
    name: "Sage",
    description: "Thoughtful and measured.",
    glyph: "S",
    family: "compat",
  },
  {
    id: "vale",
    name: "Vale",
    description: "Calm and attentive.",
    glyph: "V",
    family: "compat",
  },
]);

/** Offline roster: Piper-first, then API-compatible fallbacks. */
export const OFFLINE_VOICES = Object.freeze([...PIPER_VOICES, ...COMPAT_VOICES]);

/**
 * Default voice. Prefer Piper Lessac for open stacks; cascade servers that
 * only accept `alloy` still work when the user picks a compat voice.
 */
export const DEFAULT_VOICE_ID = "en_US-lessac-medium";

/**
 * @param {Array<{id?: string, name?: string, label?: string, description?: string, glyph?: string}>|null|undefined} manifestVoices
 * @returns {VoiceProfile[]}
 */
export function resolveVoices(manifestVoices) {
  if (!Array.isArray(manifestVoices) || manifestVoices.length === 0) {
    return [...OFFLINE_VOICES];
  }
  return manifestVoices.map((entry, index) => {
    const id = typeof entry.id === "string" && entry.id ? entry.id : `voice-${index}`;
    const known = OFFLINE_VOICES.find((v) => v.id === id);
    const displayName =
      (typeof entry.name === "string" && entry.name) ||
      (typeof entry.label === "string" && entry.label) ||
      known?.name ||
      id;
    return {
      id,
      name: displayName,
      description: entry.description || known?.description || "Provider voice.",
      glyph: entry.glyph || known?.glyph || id.slice(0, 2).toUpperCase(),
      family: known?.family || "provider",
    };
  });
}

/**
 * @param {ReadonlyArray<VoiceProfile>} voices
 * @param {string|null|undefined} preferredId
 * @returns {VoiceProfile}
 */
export function selectVoice(voices, preferredId) {
  if (!voices.length) {
    return {
      id: DEFAULT_VOICE_ID,
      name: "Lessac",
      description: "Clear US English · Piper open neural voice.",
      glyph: "L",
      family: "piper",
    };
  }
  if (preferredId) {
    const match = voices.find((v) => v.id === preferredId);
    if (match) return match;
  }
  const lessac = voices.find((v) => v.id === DEFAULT_VOICE_ID);
  if (lessac) return lessac;
  const alloy = voices.find((v) => v.id === "alloy");
  if (alloy) return alloy;
  return voices[0];
}

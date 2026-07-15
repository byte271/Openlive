/**
 * Openlive 26.7.14 — voice-profiles.js
 *
 * Voice roster shown in the in-app voice picker. The provider manifest
 * (fetched from /v1/providers) is the authoritative source when present;
 * the offline roster below is the fallback used by the mock provider and
 * any provider that does not declare voices.
 *
 * Voices are presented in the AVM pattern: name + one-line descriptor.
 * The descriptors here are original Openlive copy — they do not mirror any
 * proprietary voice catalog.
 */

/**
 * @typedef {Object} VoiceProfile
 * @property {string} id - Stable identifier sent to the gateway.
 * @property {string} name - Display name.
 * @property {string} description - One-line personality descriptor.
 * @property {string} glyph - Single-character glyph for the picker avatar.
 */

/** @type {ReadonlyArray<VoiceProfile>} */
export const OFFLINE_VOICES = Object.freeze([
  {
    id: "alloy",
    name: "Alloy",
    description: "Neutral and even-handed.",
    glyph: "A",
  },
  {
    id: "aria",
    name: "Aria",
    description: "Warm and conversational.",
    glyph: "Ar",
  },
  {
    id: "cove",
    name: "Cove",
    description: "Composed and direct.",
    glyph: "C",
  },
  {
    id: "ember",
    name: "Ember",
    description: "Confident and optimistic.",
    glyph: "E",
  },
  {
    id: "juniper",
    name: "Juniper",
    description: "Open and upbeat.",
    glyph: "J",
  },
  {
    id: "maple",
    name: "Maple",
    description: "Cheerful and grounded.",
    glyph: "M",
  },
  {
    id: "sage",
    name: "Sage",
    description: "Thoughtful and measured.",
    glyph: "S",
  },
  {
    id: "vale",
    name: "Vale",
    description: "Calm and attentive.",
    glyph: "V",
  },
]);

/**
 * Default voice used when no preference is persisted and the provider
 * manifest does not nominate one. Kept as `alloy` for cross-provider
 * compatibility — most OpenAI-compatible endpoints accept it.
 */
export const DEFAULT_VOICE_ID = "alloy";

/**
 * Resolve the effective voice roster for the picker.
 *
 * @param {Array<{id: string, label?: string, description?: string}> | null | undefined} manifestVoices
 * @returns {VoiceProfile[]}
 */
export function resolveVoices(manifestVoices) {
  if (!Array.isArray(manifestVoices) || manifestVoices.length === 0) {
    return [...OFFLINE_VOICES];
  }
  return manifestVoices.map((voice) => ({
    id: voice.id,
    name: voice.label ?? voice.id,
    description: voice.description ?? "Provider voice.",
    glyph: glyphFor(voice.label ?? voice.id),
  }));
}

/**
 * Find a voice by id. Falls back to the default voice if not found, then
 * to the first available voice if even the default is missing.
 *
 * @param {VoiceProfile[]} voices
 * @param {string | null | undefined} id
 * @returns {VoiceProfile}
 */
export function selectVoice(voices, id) {
  if (id) {
    const match = voices.find((voice) => voice.id === id);
    if (match) return match;
  }
  const fallback = voices.find((voice) => voice.id === DEFAULT_VOICE_ID);
  return fallback ?? voices[0];
}

/**
 * Derive a one- or two-character glyph from a label. Uses the first
 * alphabetic character, plus a second if the label has an obvious word
 * boundary. This keeps the picker avatar readable for any voice name.
 *
 * @param {string} label
 * @returns {string}
 */
function glyphFor(label) {
  if (typeof label !== "string" || label.length === 0) return "?";
  const cleaned = label.trim();
  if (cleaned.length <= 2) return cleaned.toUpperCase();
  // CamelCase or kebab-snake boundary → first letter of first two chunks.
  const boundary = cleaned.match(/[ \-_]/);
  if (boundary && boundary.index && boundary.index < cleaned.length - 1) {
    return (cleaned[0] + cleaned[boundary.index + 1]).toUpperCase();
  }
  // CamelCase interior capital.
  const interior = cleaned.slice(1).match(/[A-Z]/);
  if (interior && interior.index !== undefined) {
    return (cleaned[0] + cleaned[interior.index + 1]).toUpperCase();
  }
  return cleaned.slice(0, 1).toUpperCase();
}

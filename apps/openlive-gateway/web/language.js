/**
 * OpenLive 26.7.15 — language preference helpers (ASR, TTS, reply instructions).
 */

/** @typedef {{ id: string, label: string, asr: string, tts: string[], replyName: string }} LangOption */

/** Chinese first so it is easy to find and select. */
/** @type {LangOption[]} */
export const LANGUAGE_OPTIONS = [
  { id: "auto", label: "Auto", asr: "en-US", tts: ["en"], replyName: "English" },
  {
    id: "zh-CN",
    label: "中文 · 简体",
    asr: "zh-CN",
    tts: ["zh-CN", "zh", "cmn-Hans", "zh-Hans"],
    replyName: "Simplified Chinese (简体中文)",
  },
  {
    id: "zh-TW",
    label: "中文 · 繁體",
    asr: "zh-TW",
    tts: ["zh-TW", "zh-HK", "zh", "cmn-Hant", "zh-Hant"],
    replyName: "Traditional Chinese (繁體中文)",
  },
  { id: "en", label: "English", asr: "en-US", tts: ["en-US", "en"], replyName: "English" },
  { id: "ja", label: "日本語", asr: "ja-JP", tts: ["ja"], replyName: "Japanese" },
  { id: "es", label: "Español", asr: "es-ES", tts: ["es"], replyName: "Spanish" },
  { id: "fr", label: "Français", asr: "fr-FR", tts: ["fr"], replyName: "French" },
  { id: "de", label: "Deutsch", asr: "de-DE", tts: ["de"], replyName: "German" },
];

const STORAGE_KEY = "openlive:v2:language";

/**
 * @param {string} [id]
 * @returns {LangOption}
 */
export function resolveLanguage(id) {
  let key = (id || localStorage.getItem(STORAGE_KEY) || "auto").trim();
  // Map legacy ids
  if (key === "en-US") key = "en";
  if (key === "zh") key = "zh-CN";
  return LANGUAGE_OPTIONS.find((o) => o.id === key) || LANGUAGE_OPTIONS[0];
}

export function getStoredLanguageId() {
  const raw = localStorage.getItem(STORAGE_KEY) || "auto";
  return resolveLanguage(raw).id;
}

/**
 * @param {string} id
 */
export function storeLanguageId(id) {
  const opt = resolveLanguage(id);
  localStorage.setItem(STORAGE_KEY, opt.id);
  return opt;
}

/** Web Speech recognition BCP-47 tag. */
export function asrLangFor(id) {
  return resolveLanguage(id).asr;
}

/** Preferred TTS language tags (first match wins against system voices). */
export function ttsLangPrefsFor(id) {
  return resolveLanguage(id).tts;
}

export function isChineseLang(id) {
  const k = (id || "").toLowerCase();
  return k.startsWith("zh");
}

/** True if text contains CJK ideographs. */
export function hasCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text || ""));
}

/**
 * System instruction fragment for the voice model.
 * @param {string} id
 */
export function languageReplyInstruction(id) {
  const opt = resolveLanguage(id);
  if (opt.id === "auto") {
    return "Match the user's language. If they speak Chinese, reply in natural spoken Chinese. If English, reply in English. Never invent a different language.";
  }
  if (isChineseLang(opt.id)) {
    return `Always reply in natural spoken ${opt.replyName}. Keep answers short (1-2 sentences). Do not switch to English unless the user asks. For facts, state them clearly in Chinese.`;
  }
  return `Always reply in natural spoken ${opt.replyName}. Keep answers short (1-2 sentences). Prefer natural spoken phrasing.`;
}

/**
 * Wire top-bar + settings language selects. Safe to call multiple times.
 */
export function bindLanguageControls() {
  const top = document.getElementById("languageSelect");
  const settings = document.getElementById("settingsLanguage");
  const legacy = document.getElementById("languageValue");
  const current = getStoredLanguageId();

  const applyUi = (id) => {
    const opt = storeLanguageId(id);
    if (top && top.value !== opt.id) top.value = opt.id;
    if (settings && settings.value !== opt.id) settings.value = opt.id;
    if (legacy) legacy.textContent = opt.label;
    window.dispatchEvent(
      new CustomEvent("openlive:language", { detail: { language: opt.id } }),
    );
  };

  // Ensure selects have Chinese options even if HTML was cached empty.
  for (const sel of [top, settings]) {
    if (!sel) continue;
    if (![...sel.options].some((o) => o.value === "zh-CN")) {
      sel.innerHTML = "";
      for (const opt of LANGUAGE_OPTIONS) {
        const el = document.createElement("option");
        el.value = opt.id;
        el.textContent = opt.label;
        sel.appendChild(el);
      }
    }
    sel.value = current;
  }
  if (legacy) legacy.textContent = resolveLanguage(current).label;

  if (top && !top.dataset.langBound) {
    top.dataset.langBound = "1";
    top.addEventListener("change", () => applyUi(top.value));
  }
  if (settings && !settings.dataset.langBound) {
    settings.dataset.langBound = "1";
    settings.addEventListener("change", () => applyUi(settings.value));
  }
}

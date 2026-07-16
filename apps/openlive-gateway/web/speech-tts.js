/**
 * OpenLive 26.7.15 — browser TTS (Web Speech API), hardened for Windows Chrome/Edge.
 * Falls back gracefully; never leaves the app silent without a clear reason.
 */

/** @type {SpeechSynthesisVoice[]} */
let cachedVoices = [];

function refreshVoices() {
  if (typeof speechSynthesis === "undefined") return [];
  try {
    cachedVoices = speechSynthesis.getVoices() || [];
  } catch {
    cachedVoices = [];
  }
  return cachedVoices;
}

if (typeof speechSynthesis !== "undefined") {
  try {
    speechSynthesis.addEventListener("voiceschanged", () => refreshVoices());
  } catch {
    speechSynthesis.onvoiceschanged = () => refreshVoices();
  }
  refreshVoices();
}

/**
 * Chrome/Edge often return [] until voiceschanged fires.
 * @param {number} [timeoutMs]
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
export function waitForVoices(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === "undefined") {
      resolve([]);
      return;
    }
    const now = refreshVoices();
    if (now.length) {
      resolve(now);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(refreshVoices());
    };
    const timer = setTimeout(finish, timeoutMs);
    const onChange = () => {
      const v = refreshVoices();
      if (v.length) {
        clearTimeout(timer);
        try {
          speechSynthesis.removeEventListener("voiceschanged", onChange);
        } catch {
          /* ignore */
        }
        finish();
      }
    };
    try {
      speechSynthesis.addEventListener("voiceschanged", onChange);
    } catch {
      speechSynthesis.onvoiceschanged = onChange;
    }
    // Nudge catalog load.
    try {
      speechSynthesis.getVoices();
    } catch {
      /* ignore */
    }
  });
}

function preferForProfile(voiceId, langHint = "en") {
  const id = (voiceId || "").toLowerCase();
  const langRoot = (langHint || "en").toLowerCase().split("-")[0];
  if (id.includes("ryan") || id.includes("joe") || id.includes("cove") || id.includes("vale")) {
    return { lang: langRoot, gender: "male", rate: 1.0, pitch: 0.95 };
  }
  if (
    id.includes("amy") ||
    id.includes("aria") ||
    id.includes("kathleen") ||
    id.includes("alba") ||
    id.includes("juniper")
  ) {
    return { lang: langRoot, gender: "female", rate: 1.0, pitch: 1.05 };
  }
  return { lang: langRoot, gender: "neutral", rate: 1.0, pitch: 1.0 };
}

/**
 * @param {string} voiceId
 * @param {{ langPrefs?: string[], voiceURI?: string|null }} [opts]
 */
export function selectBrowserVoice(voiceId, opts = {}) {
  const voices = refreshVoices();
  if (!voices.length) return null;

  if (opts.voiceURI) {
    const exact =
      voices.find((v) => v.voiceURI === opts.voiceURI) ||
      voices.find((v) => v.name === opts.voiceURI);
    if (exact) return exact;
  }

  const langPrefs = (opts.langPrefs || ["en-US", "en"]).map((l) => String(l).toLowerCase());
  const primary = langPrefs[0] || "en";
  const pref = preferForProfile(voiceId, primary);

  const matchLang = (v) => {
    const vl = (v.lang || "").toLowerCase();
    return langPrefs.some(
      (p) => vl === p || vl.startsWith(p) || vl.startsWith(p.split("-")[0]),
    );
  };

  // Prefer matching language, then local voices, then anything.
  let pool = voices.filter(matchLang);
  if (!pool.length) pool = voices.filter((v) => v.localService);
  if (!pool.length) pool = voices;

  const score = (v) => {
    const name = `${v.name} ${v.voiceURI}`.toLowerCase();
    const vl = (v.lang || "").toLowerCase();
    let s = 0;
    for (let i = 0; i < langPrefs.length; i++) {
      const p = langPrefs[i];
      if (vl === p) s += 20 - i;
      else if (vl.startsWith(p)) s += 14 - i;
      else if (vl.startsWith(p.split("-")[0])) s += 8 - i;
    }
    if (primary.startsWith("zh")) {
      if (/chinese|zh-|huihui|kangkang|yaoyao|xiaoxiao|xiaoyi|yunxi|yunyang|hanhan|lili/.test(name))
        s += 10;
      if (/zh-cn|cmn-hans|china|simplified|mandarin/.test(name + " " + vl)) s += 6;
    }
    if (pref.gender === "female" && /female|zira|samantha|huihui|xiaoxiao|yaoyao/.test(name))
      s += 3;
    if (pref.gender === "male" && /male|david|mark|kangkang|yunxi/.test(name)) s += 3;
    if (v.localService) s += 5; // local is more reliable on Windows
    if (v.default) s += 2;
    if (/microsoft|google|natural|neural/.test(name)) s += 2;
    return s;
  };

  return pool.slice().sort((a, b) => score(b) - score(a))[0] || voices[0] || null;
}

let speakGen = 0;
let ttsClaimed = false;

export function isBrowserSpeaking() {
  if (typeof speechSynthesis === "undefined") return false;
  return ttsClaimed || speechSynthesis.speaking || speechSynthesis.pending;
}

/** Soft cancel — do NOT speak empty utterances (that breaks Windows TTS). */
export function stopBrowserSpeech() {
  speakGen += 1;
  ttsClaimed = false;
  if (typeof speechSynthesis === "undefined") return;
  try {
    speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

function sanitizeSpeechText(text) {
  return String(text || "")
    .replace(/[*_`#>[\]{}|\\]/g, " ")
    .replace(
      /[^\x20-\x7E\u00A0-\u024F\u3000-\u303F\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u2010-\u2027。，、！？：；「」『』（）…—·]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function chunkForSpeech(text) {
  const t = sanitizeSpeechText(text);
  if (!t) return [];
  const hasCjk = /[\u3400-\u9fff]/.test(t);
  if (hasCjk) {
    if (t.length <= 100) return [t];
    const parts = t.split(/(?<=[。！？!?.])/) || [t];
    const chunks = [];
    let buf = "";
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      if ((buf + s).length > 100 && buf) {
        chunks.push(buf.trim());
        buf = s;
      } else buf += s;
    }
    if (buf.trim()) chunks.push(buf.trim());
    return chunks.length ? chunks : [t];
  }
  if (t.length < 180) return [t];
  const parts = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [t];
  const chunks = [];
  let buf = "";
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if ((buf + " " + s).trim().length > 180 && buf) {
      chunks.push(buf.trim());
      buf = s;
    } else buf = (buf + " " + s).trim();
  }
  if (buf) chunks.push(buf.trim());
  return chunks.length ? chunks : [t];
}

/**
 * Speak one chunk. Resolves true if spoken (or interrupted by us after starting).
 */
function speakOne(clean, opts, gen) {
  return new Promise((resolve) => {
    if (gen !== speakGen || typeof speechSynthesis === "undefined") {
      resolve(false);
      return;
    }

    const langPrefs = opts.langPrefs || ["en-US", "en"];
    const pref = preferForProfile(opts.voiceId, langPrefs[0]);
    const utter = new SpeechSynthesisUtterance(clean);
    const voice = selectBrowserVoice(opts.voiceId || "", {
      langPrefs,
      voiceURI: opts.voiceURI || null,
    });
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang || langPrefs[0] || "en-US";
    } else {
      // Still attempt default OS voice with language tag.
      utter.lang = langPrefs[0] || "en-US";
    }

    const isZh = (utter.lang || "").toLowerCase().startsWith("zh") || /[\u3400-\u9fff]/.test(clean);
    utter.rate = opts.rate ?? (isZh ? 1.0 : 1.05);
    utter.pitch = opts.pitch ?? pref.pitch;
    utter.volume = opts.volume ?? 1.0;

    let settled = false;
    let started = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(ok);
    };

    // Safety: if engine never fires end/error (Windows hang).
    const watchdog = setTimeout(() => {
      console.warn("speechSynthesis watchdog — forcing complete");
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
      // If audio started, count as partial success.
      done(started);
    }, Math.min(60000, 8000 + clean.length * 80));

    utter.onstart = () => {
      started = true;
    };
    utter.onend = () => {
      // Success if this generation still owns the floor, or we finished naturally.
      done(true);
    };
    utter.onerror = (ev) => {
      const err = String(ev?.error || "");
      // interrupted/canceled often means we cancelled on purpose for next utterance.
      if (err === "interrupted" || err === "canceled") {
        done(started); // if we already started, don't treat as hard fail of whole pipeline
        return;
      }
      console.warn("speechSynthesis error:", err, "lang=", utter.lang, "voice=", voice?.name);
      done(false);
    };

    // Small delay so prior cancel() settles (Windows).
    setTimeout(() => {
      if (gen !== speakGen) {
        done(false);
        return;
      }
      try {
        // Ensure not stuck paused.
        try {
          if (speechSynthesis.paused) speechSynthesis.resume();
        } catch {
          /* ignore */
        }
        speechSynthesis.speak(utter);
        // Chromium: sometimes needs resume after speak.
        setTimeout(() => {
          try {
            if (speechSynthesis.paused) speechSynthesis.resume();
          } catch {
            /* ignore */
          }
        }, 50);
      } catch (e) {
        console.warn("speechSynthesis.speak threw", e);
        done(false);
      }
    }, 40);
  });
}

/**
 * @param {string} text
 * @param {{
 *   voiceId?: string,
 *   voiceURI?: string|null,
 *   rate?: number,
 *   pitch?: number,
 *   volume?: number,
 *   langPrefs?: string[],
 *   shouldAbort?: () => boolean,
 * }} [opts]
 * @returns {Promise<boolean>}
 */
export function speakBrowser(text, opts = {}) {
  return (async () => {
    if (typeof speechSynthesis === "undefined") {
      console.warn("speechSynthesis unavailable");
      return false;
    }

    await waitForVoices(5000);
    let chunks = chunkForSpeech(text);
    if (!chunks.length) {
      // Last resort: speak raw trimmed text.
      const raw = String(text || "").trim();
      if (!raw) return false;
      chunks = [raw.slice(0, 400)];
    }

    const gen = ++speakGen;
    ttsClaimed = true;

    // Cancel only — no dummy utterance.
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }

    // Give cancel a moment on Windows.
    await new Promise((r) => setTimeout(r, 60));
    if (gen !== speakGen) {
      ttsClaimed = false;
      return false;
    }

    let anyOk = false;
    for (const chunk of chunks) {
      if (gen !== speakGen || opts.shouldAbort?.()) {
        ttsClaimed = false;
        return anyOk;
      }
      let ok = await speakOne(chunk, opts, gen);
      // Retry once: drop explicit voiceURI / force English engine for mixed text.
      if (!ok && gen === speakGen && !opts.shouldAbort?.()) {
        ok = await speakOne(chunk, {
          ...opts,
          voiceURI: null,
          langPrefs: /[\u3400-\u9fff]/.test(chunk)
            ? ["zh-CN", "zh", "en-US", "en"]
            : ["en-US", "en"],
        }, gen);
      }
      if (ok) anyOk = true;
      else if (!anyOk) {
        // First chunk hard-failed — try whole text as single utterance once more.
        break;
      }
    }

    // Final whole-text retry if nothing worked.
    if (!anyOk && gen === speakGen && !opts.shouldAbort?.()) {
      const whole = sanitizeSpeechText(text) || String(text || "").trim();
      if (whole) {
        anyOk = await speakOne(whole.slice(0, 500), {
          voiceId: opts.voiceId,
          voiceURI: null,
          langPrefs: ["en-US", "en", "zh-CN", "zh"],
          rate: 1.0,
        }, gen);
      }
    }

    if (gen === speakGen) ttsClaimed = false;
    return anyOk;
  })();
}

export function browserTtsAvailable() {
  return typeof speechSynthesis !== "undefined";
}

/**
 * @returns {Promise<Array<{id:string,name:string,lang:string,local:boolean,label:string}>>}
 */
export async function listBrowserVoices() {
  const voices = await waitForVoices(5000);
  return voices
    .map((v) => ({
      id: v.voiceURI,
      name: v.name,
      lang: v.lang || "",
      local: !!v.localService,
      label: `${v.name} (${v.lang || "?"})${v.localService ? " · local" : " · online"}`,
    }))
    .sort((a, b) => {
      const rank = (lang) => {
        const l = lang.toLowerCase();
        if (l.startsWith("zh")) return 0;
        if (l.startsWith("en")) return 1;
        return 2;
      };
      const d = rank(a.lang) - rank(b.lang);
      if (d !== 0) return d;
      // local first
      if (a.local !== b.local) return a.local ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function countVoicesForLang(langPrefix) {
  const p = (langPrefix || "").toLowerCase();
  return refreshVoices().filter((v) => (v.lang || "").toLowerCase().startsWith(p)).length;
}

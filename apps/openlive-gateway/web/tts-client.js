/**
 * OpenLive 26.7.15 — TTS client (Piper via gateway, formant, then browser).
 */

import { playPcmBase64 } from "./agent-client.js";
import { listBrowserVoices, speakBrowser, waitForVoices } from "./speech-tts.js";

/**
 * @returns {Promise<object>}
 */
export async function fetchTtsStatus() {
  const r = await fetch("/v1/tts/status");
  return r.json().catch(() => ({ preferred: "formant", piper: { available: false } }));
}

/**
 * Speak text with best available engine.
 * @param {string} text
 * @param {{
 *   voiceId?: string,
 *   voiceURI?: string|null,
 *   ttsEngine?: string,
 *   langPrefs?: string[],
 *   onStatus?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<{ok:boolean, engine:string, error?:string, piper?:object}>}
 */
export async function speakOpenLive(text, opts = {}) {
  const line = String(text || "").trim();
  if (!line) return { ok: false, engine: "none", error: "empty" };

  const engine = opts.ttsEngine || "auto";
  const onStatus = opts.onStatus || (() => {});

  // 1) Piper / formant via gateway (most reliable path for this product).
  if (engine === "auto" || engine === "piper" || engine === "formant") {
    try {
      onStatus(engine === "formant" ? "Speaking (formant)…" : "Speaking (open-source TTS)…");
      const r = await fetch("/v1/tts/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: line.slice(0, 800),
          voice_id: opts.voiceId || "en_US-lessac-medium",
          engine: engine === "formant" ? "formant" : "auto",
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.pcm_base64) {
        await playPcmBase64(data.pcm_base64, data.sample_rate || 24000);
        return { ok: true, engine: data.engine || "formant", piper: data.piper };
      }
      if (engine === "piper") {
        return {
          ok: false,
          engine: "piper",
          error: data.error || "Piper unavailable",
          piper: data.piper,
        };
      }
    } catch (e) {
      if (engine === "piper" || engine === "formant") {
        return { ok: false, engine, error: e?.message || String(e) };
      }
    }
  }

  // 2) Browser Web Speech (last resort — quality varies a lot).
  if (engine === "auto" || engine === "browser") {
    try {
      onStatus("Speaking (browser)…");
      await waitForVoices(4000);
      const voices = await listBrowserVoices();
      if (!voices.length && engine === "browser") {
        return { ok: false, engine: "browser", error: "no browser voices" };
      }
      const ok = await speakBrowser(line, {
        voiceId: opts.voiceId,
        voiceURI: opts.voiceURI,
        langPrefs: opts.langPrefs,
      });
      if (ok) return { ok: true, engine: "browser" };
    } catch (e) {
      return { ok: false, engine: "browser", error: e?.message || String(e) };
    }
  }

  return { ok: false, engine: "none", error: "all TTS engines failed" };
}

/** Build a user-facing install panel model from /v1/tts/status. */
export function piperInstallUi(status) {
  const p = status?.piper || {};
  const isWin = navigator.platform?.toLowerCase().includes("win");
  return {
    available: !!p.available,
    note: p.note || "",
    dataDir: p.data_dir || "",
    command: isWin ? p.install_command_windows || "" : p.install_command_unix || "",
    bin: p.piper_bin || "",
    model: p.model_path || "",
  };
}

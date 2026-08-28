/**
 * OpenLive demo-path voice policy.
 *
 * Happy path (ttsEngine === "auto"): speak only with real neural TTS (Piper).
 * Never pad with formant/mock — the fake→real switch is an audible tell.
 * Formant is allowed only when the user explicitly selects that engine
 * (first-run / last-resort fallback).
 */

export const DEMO_TTS_POLICY = "neural-or-silence";

/**
 * @param {{ ttsEngine?: string } | null | undefined} setup
 * @returns {boolean}
 */
export function demoAllowsFormant(setup) {
  return (setup?.ttsEngine || "auto") === "formant";
}

/**
 * Engine string sent to `/v1/tts/speak`. Auto never requests formant.
 *
 * @param {{ ttsEngine?: string } | null | undefined} setup
 * @returns {"auto" | "piper" | "formant" | "browser"}
 */
export function neuralSpeakEngine(setup) {
  const engine = setup?.ttsEngine || "auto";
  if (engine === "formant" || engine === "browser" || engine === "piper") {
    return engine;
  }
  return "piper";
}

/**
 * @param {{ piper?: { available?: boolean }, preferred?: string } | null | undefined} status
 * @returns {boolean}
 */
export function isRealTtsReady(status) {
  return Boolean(status?.piper?.available);
}

/**
 * Whether inbound provider PCM may play on the demo path.
 * Mock formant frames are dropped unless the user opted into formant TTS.
 *
 * @param {{ ttsEngine?: string } | null | undefined} setup
 * @param {{ id?: string, provider_class?: string } | null | undefined} provider
 * @returns {boolean}
 */
export function allowInboundProviderPcm(setup, provider) {
  if (demoAllowsFormant(setup)) return true;
  const id = String(provider?.id || "");
  const klass = String(provider?.provider_class || "");
  const isMock = klass === "mock" || id.includes("mock");
  return !isMock;
}

/**
 * Morphicons (MIT) on the default call chrome: Mute, End, Settings.
 * Uses lucide data exports, not lucide-react.
 */

import { createMorph, Mic, MicOff, PhoneOff, Settings, X } from "./vendor/morphicons.js";

function svgPathHost() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(ns, "path");
  svg.append(path);
  return { svg, path };
}

/**
 * @param {HTMLElement | null} host
 * @param {unknown} icon
 */
function mountMorph(host, icon) {
  if (!host) return null;
  host.replaceChildren();
  const { svg, path } = svgPathHost();
  host.append(svg);
  return createMorph(path, icon, { reducedMotion: "user" });
}

/**
 * Wire Mute / End / Settings morphs. Safe to call once after DOM is ready.
 *
 * @returns {{
 *   setMuted: (muted: boolean) => void,
 *   setSettingsOpen: (open: boolean) => void,
 * }}
 */
export function installCallMorphs() {
  const mute = mountMorph(document.querySelector('[data-morph="mute"]'), Mic);
  mountMorph(document.querySelector('[data-morph="end"]'), PhoneOff);
  const settings = mountMorph(
    document.querySelector('[data-morph="settings"]'),
    Settings,
  );

  return {
    setMuted(muted) {
      mute?.morphTo(muted ? MicOff : Mic, "snappy");
    },
    setSettingsOpen(open) {
      settings?.morphTo(open ? X : Settings, "snappy");
    },
  };
}

/**
 * Default call face: bloub orb. Keeps the VoiceVisualizer API used by app.js.
 */

import { BloubOrb } from "./bloub-orb.js";

export class VoiceVisualizer {
  /**
   * @param {SVGSVGElement | HTMLCanvasElement | null} host
   */
  constructor(host) {
    const svg =
      host instanceof SVGSVGElement
        ? host
        : document.getElementById("bloubOrb");
    this.canvas = host instanceof HTMLCanvasElement ? host : null;
    if (this.canvas) this.canvas.hidden = true;
    this.orb = svg instanceof SVGSVGElement ? new BloubOrb(svg) : null;
    this.mode = "idle";
  }

  setMode(mode) {
    this.mode = mode;
    this.orb?.setMode(mode);
  }

  setSignals(input, output) {
    this.orb?.setSignals(input, output);
  }

  setMotionScale(scale) {
    this.orb?.setMotionScale(scale);
  }

  fireBargeIn() {
    this.orb?.fireBargeIn();
  }

  destroy() {
    this.orb?.destroy();
  }
}

/**
 * Openlive 1.2 — voice-visualizer.js
 *
 * Multi-layer canvas voice orb. The composition is original Openlive
 * geometry — it does not reproduce any proprietary visual.
 *
 * Layers, back to front:
 *   1. Outer aura halo       — slow breathing, modulated by total energy.
 *   2. Energy ribbons        — three rotating arcs whose amplitude tracks
 *                              input/output activity. Reads like a circular
 *                              equalizer but stays smooth.
 *   3. Procedural blob body  — the main silhouette; distorts on barge-in
 *                              via a transient noise term.
 *   4. Inner core gradient   — radial highlight with a soft shadow.
 *   5. Barge-in ripple       — a stroked ring that radiates outward when
 *                              the local duck fires. Only the visualizer
 *                              owns the ripple state so app.js can fire it
 *                              idempotently.
 *
 * The renderer honors `prefers-reduced-motion` (animation phase is frozen
 * to 0, only the energy-driven components move) and the runtime
 * `--motion-scale` CSS variable (set by the settings sheet's motion slider).
 */

import { signalEnergy, VoiceMode } from "./visual-state.js";

const PALETTES = {
  // v1.3 palette refinement: deeper saturated blues for IDLE/SPEAKING to
  // evoke the AVM signature mood while keeping Openlive's original violet
  // and cyan accents. All colors are original Openlive values.
  [VoiceMode.IDLE]: ["#3d5bff", "#7d6bff", "#c8d4ff"],
  [VoiceMode.STARTING]: ["#5a73ff", "#8a7dff", "#d4d8ff"],
  [VoiceMode.LISTENING]: ["#3f9cff", "#5cd9ff", "#bdeaff"],
  [VoiceMode.THINKING]: ["#7769ff", "#d17dff", "#f2ceff"],
  [VoiceMode.SPEAKING]: ["#4a6dff", "#a55fff", "#e8c4ff"],
  [VoiceMode.YIELDING]: ["#5eaeff", "#8aa0ff", "#d3edff"],
  [VoiceMode.INTERRUPTED]: ["#54b9ff", "#7898ff", "#d3edff"],
  [VoiceMode.MUTED]: ["#606574", "#8b91a1", "#d1d3da"],
  [VoiceMode.RECONNECTING]: ["#c68b58", "#a475ff", "#f5d4b1"],
  [VoiceMode.CONNECTION_ERROR]: ["#d9566d", "#f19a63", "#ffd0bc"],
  [VoiceMode.ERROR]: ["#d9566d", "#f19a63", "#ffd0bc"],
};

const RIPPLE_DURATION_MS = 720;

export class VoiceVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.mode = VoiceMode.IDLE;
    this.input = 0;
    this.output = 0;
    this.energy = 0;
    this.bargeIntensity = 0;
    this.motionScale = 1;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.startTime = performance.now();
    this.ripples = [];
    this.frame = requestAnimationFrame((time) => this.draw(time));

    // Honor prefers-reduced-motion at the system level too.
    this.motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    this.motionQuery.addEventListener?.("change", (event) => {
      this.reducedMotion = event.matches;
    });
  }

  /**
   * Update the active mode. The palette swap is per-frame so transitions
   * are smooth, not snapped.
   *
   * @param {string} mode
   */
  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Update the input and output signal levels. Both are clamped to [0, 1].
   *
   * @param {number} input
   * @param {number} output
   */
  setSignals(input, output) {
    this.input = clamp01(input);
    this.output = clamp01(output);
  }

  /**
   * Scale all motion by this factor. Set from the settings sheet's motion
   * slider (0..1). 0 effectively freezes the orb while still showing the
   * current energy state.
   *
   * @param {number} scale
   */
  setMotionScale(scale) {
    this.motionScale = clamp01(scale);
  }

  /**
   * Fire a barge-in ripple. Safe to call multiple times in rapid succession;
   * each call enqueues an independent ripple.
   */
  fireBargeIn() {
    if (this.ripples.length > 4) return;
    this.ripples.push({
      start: performance.now(),
      intensity: clamp01(0.6 + this.output * 0.4),
    });
    this.bargeIntensity = 1;
  }

  /**
   * Stop the animation loop. Called on page unload.
   */
  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  draw(time) {
    if (!this.frame) return;
    const context = this.context;
    const { width, height } = this.canvas;
    const elapsed = (time - this.startTime) / 1000;
    const targetEnergy = signalEnergy(this.input, this.output, this.mode);
    this.energy += (targetEnergy - this.energy) * 0.12;
    this.bargeIntensity *= 0.88;

    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width / 2, height / 2);
    context.globalCompositeOperation = "screen";

    const palette = PALETTES[this.mode] ?? PALETTES[VoiceMode.IDLE];
    const motion = this.reducedMotion ? 0 : elapsed * this.motionScale;
    const pulse = 1 + Math.sin(motion * 1.35) * 0.018 + this.energy * 0.08;

    this.drawAura(220 * pulse, motion, palette);
    this.drawRibbons(196 * pulse, motion, palette);
    this.drawBlob(178 * pulse, 0.075 + this.energy * 0.08 + this.bargeIntensity * 0.05, motion * 0.42, palette, 0.42);
    this.drawBlob(160 * pulse, 0.095 + this.energy * 0.12, -motion * 0.58, palette, 0.58);
    this.drawCore(135 * pulse, palette);
    this.drawHighlights(142 * pulse, motion, palette);
    this.drawRipples(time, palette);

    context.restore();
    this.frame = requestAnimationFrame((nextTime) => this.draw(nextTime));
  }

  drawAura(radius, time, palette) {
    const context = this.context;
    const drift = Math.sin(time * 0.18) * 6;
    const gradient = context.createRadialGradient(
      drift,
      -drift,
      radius * 0.5,
      0,
      0,
      radius,
    );
    gradient.addColorStop(0, withAlpha(palette[1], 0.06 + this.energy * 0.06));
    gradient.addColorStop(0.6, withAlpha(palette[0], 0.03 + this.energy * 0.04));
    gradient.addColorStop(1, withAlpha(palette[0], 0));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();
  }

  drawRibbons(radius, time, palette) {
    const context = this.context;
    const ribbons = 3;
    for (let index = 0; index < ribbons; index += 1) {
      const phase = time * (0.5 + index * 0.18) + index * 1.7;
      const amplitude = 4 + this.energy * 22 + this.input * 10;
      const offset = (index - 1) * 0.18;
      context.strokeStyle = withAlpha(palette[index % 3], 0.32 + this.energy * 0.28);
      context.lineWidth = 1.6;
      context.beginPath();
      const segments = 80;
      for (let segment = 0; segment <= segments; segment += 1) {
        const angle = (segment / segments) * Math.PI * 2;
        const wave = Math.sin(angle * (3 + index) + phase) * amplitude;
        const localRadius = radius + offset * 18 + wave;
        const x = Math.cos(angle) * localRadius;
        const y = Math.sin(angle) * localRadius;
        if (segment === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.stroke();
    }
  }

  drawBlob(radius, distortion, phase, palette, alpha) {
    const context = this.context;
    const gradient = context.createRadialGradient(
      -radius * 0.28,
      -radius * 0.34,
      radius * 0.04,
      0,
      0,
      radius * 1.18,
    );
    gradient.addColorStop(0, withAlpha(palette[2], alpha + 0.18));
    gradient.addColorStop(0.42, withAlpha(palette[1], alpha));
    gradient.addColorStop(1, withAlpha(palette[0], 0));
    context.fillStyle = gradient;
    context.beginPath();
    const points = 84;
    for (let index = 0; index <= points; index += 1) {
      const angle = (index / points) * Math.PI * 2;
      const wave =
        Math.sin(angle * 3 + phase) * 0.48 +
        Math.sin(angle * 5 - phase * 1.7) * 0.31 +
        Math.sin(angle * 7 + phase * 0.7) * 0.21;
      // Barge-in adds a high-frequency jitter to the silhouette.
      const jitter = this.bargeIntensity * Math.sin(angle * 11 + phase * 3.4) * 0.18;
      const localRadius = radius * (1 + (wave + jitter) * distortion);
      const x = Math.cos(angle) * localRadius;
      const y = Math.sin(angle) * localRadius;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.fill();
  }

  drawCore(radius, palette) {
    const context = this.context;
    const gradient = context.createRadialGradient(
      -radius * 0.34,
      -radius * 0.38,
      radius * 0.08,
      0,
      0,
      radius,
    );
    gradient.addColorStop(0, withAlpha("#ffffff", 0.94));
    gradient.addColorStop(0.27, withAlpha(palette[2], 0.82));
    gradient.addColorStop(0.68, withAlpha(palette[1], 0.52));
    gradient.addColorStop(1, withAlpha(palette[0], 0.08));
    context.fillStyle = gradient;
    context.shadowColor = withAlpha(palette[0], 0.55);
    context.shadowBlur = 34 + this.energy * 30;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }

  drawHighlights(radius, time, palette) {
    const context = this.context;
    context.save();
    context.rotate(time * 0.08);
    context.strokeStyle = withAlpha(palette[2], 0.2 + this.energy * 0.18);
    context.lineWidth = 2;
    context.beginPath();
    context.arc(-radius * 0.06, -radius * 0.04, radius * 0.78, 3.65, 5.42);
    context.stroke();
    context.restore();
  }

  drawRipples(now, palette) {
    const context = this.context;
    const survivors = [];
    for (const ripple of this.ripples) {
      const age = now - ripple.start;
      if (age > RIPPLE_DURATION_MS) continue;
      const progress = age / RIPPLE_DURATION_MS;
      const radius = 180 + progress * 140;
      const alpha = (1 - progress) * 0.6 * ripple.intensity;
      context.strokeStyle = withAlpha(palette[2], alpha);
      context.lineWidth = 2 * (1 - progress * 0.5);
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.stroke();
      survivors.push(ripple);
    }
    this.ripples = survivors;
  }
}

/**
 * Convert a #rrggbb hex color to an rgba() string with the given alpha.
 * Hex parsing is strict; malformed input falls back to white so the orb
 * never disappears due to a bad palette entry.
 *
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
function withAlpha(hex, alpha) {
  const safeAlpha = clamp01(alpha);
  if (typeof hex !== "string" || hex.length !== 7 || hex[0] !== "#") {
    return `rgba(255, 255, 255, ${safeAlpha})`;
  }
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
    return `rgba(255, 255, 255, ${safeAlpha})`;
  }
  return `rgba(${red}, ${green}, ${blue}, ${safeAlpha})`;
}

/**
 * Clamp a number to [0, 1]. Non-finite values become 0.
 *
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/**
 * SVG host for the vendored bloub engine (MIT, Jérémy Perret).
 * Eyes are mask holes in the body, matching the x.ai-style face.
 * Not affiliated with xAI.
 */

import {
  BotEngine,
  DEMI_VIEWBOX,
  NOTIF_BLUE,
  RAYON,
} from "./vendor/bloub/engine.js";
import { bloubShouldDim, bloubStateFor } from "./call-state.js";

const VB = DEMI_VIEWBOX;
// On OpenLive's black call surface the face reads as a light orb with dark
// eye holes (paper shows through the mask). Swapping these makes the body
// disappear into the page.
const PAPER = "#0a0a0c";
const INK = "#f4f4f2";

export class BloubOrb {
  /**
   * @param {SVGSVGElement} svg
   */
  constructor(svg) {
    this.svg = svg;
    this.engine = new BotEngine(RAYON, "idle");
    this.clock = 0;
    this.last = 0;
    this.mode = "idle";
    this.uid = `bloub-${Math.random().toString(36).slice(2, 8)}`;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.motionScale = 1;
    this.frame = null;
    this.mount();
    this.tick = (now) => this.draw(now);
    this.frame = requestAnimationFrame(this.tick);
  }

  mount() {
    const svg = this.svg;
    svg.setAttribute("viewBox", `${-VB} ${-VB} ${VB * 2} ${VB * 2}`);
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      "OpenLive face — inspired by the x.ai avatar; not affiliated with xAI",
    );
    const ns = "http://www.w3.org/2000/svg";
    svg.replaceChildren();
    const defs = document.createElementNS(ns, "defs");
    const mask = document.createElementNS(ns, "mask");
    mask.id = `${this.uid}-mask`;
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.setAttribute("x", String(-VB));
    mask.setAttribute("y", String(-VB));
    mask.setAttribute("width", String(VB * 2));
    mask.setAttribute("height", String(VB * 2));
    this.bodyMask = document.createElementNS(ns, "path");
    this.bodyMask.setAttribute("fill", "#fff");
    this.eyeMasks = [0, 1].map(() => {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("fill", "#000");
      return p;
    });
    this.notch = document.createElementNS(ns, "circle");
    this.notch.setAttribute("fill", "#000");
    this.notch.setAttribute("visibility", "hidden");
    mask.append(this.bodyMask, ...this.eyeMasks, this.notch);
    defs.append(mask);
    this.gradRoot = document.createElementNS(ns, "g");
    defs.append(this.gradRoot);

    this.arcBack = document.createElementNS(ns, "g");
    this.arcBack.setAttribute("fill", "none");
    this.arcBack.setAttribute("stroke-linecap", "round");
    this.dotsBehind = document.createElementNS(ns, "g");
    this.bodyGroup = document.createElementNS(ns, "g");
    this.paperPath = document.createElementNS(ns, "path");
    this.paperPath.setAttribute("fill", PAPER);
    const inkGroup = document.createElementNS(ns, "g");
    inkGroup.setAttribute("mask", `url(#${mask.id})`);
    const ink = document.createElementNS(ns, "rect");
    ink.setAttribute("x", String(-VB));
    ink.setAttribute("y", String(-VB));
    ink.setAttribute("width", String(VB * 2));
    ink.setAttribute("height", String(VB * 2));
    ink.setAttribute("fill", INK);
    inkGroup.append(ink);
    this.bodyGroup.append(this.paperPath, inkGroup);
    this.dotsFront = document.createElementNS(ns, "g");
    this.notif = document.createElementNS(ns, "circle");
    this.notif.setAttribute("fill", NOTIF_BLUE);
    this.notif.setAttribute("visibility", "hidden");
    this.arcFront = document.createElementNS(ns, "g");
    this.arcFront.setAttribute("fill", "none");
    this.arcFront.setAttribute("stroke-linecap", "round");

    svg.append(
      defs,
      this.arcBack,
      this.dotsBehind,
      this.bodyGroup,
      this.dotsFront,
      this.notif,
      this.arcFront,
    );
  }

  /**
   * @param {string} mode
   */
  setMode(mode) {
    this.mode = mode;
    const state = bloubStateFor(mode);
    this.engine.setState(state, this.clock);
    this.svg.classList.toggle("is-dimmed", bloubShouldDim(mode));
  }

  /**
   * @param {number} input
   * @param {number} output
   */
  setSignals(input, output) {
    const speaking = output > 0.04;
    const listening = input > 0.12 && !speaking;
    this.engine.setLook(
      {
        yaw: (input - 0.5) * 18,
        pitch: speaking ? -8 : listening ? 6 : 0,
        mix: speaking || listening ? 0.35 : 0,
        spin: 0,
        wander: bloubShouldDim(this.mode) ? 0.15 : 1,
      },
      this.clock,
    );
  }

  fireBargeIn() {
    this.engine.setState("burst", this.clock);
  }

  /**
   * @param {number} scale
   */
  setMotionScale(scale) {
    this.motionScale = Math.max(0, Math.min(1, scale));
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  draw(now) {
    if (!this.frame) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last ? (now - this.last) / 1000 : 0;
    this.last = now;
    const advance = this.reducedMotion ? 0 : dt * this.motionScale;
    this.clock += advance;
    this.paint(this.engine.sample(this.clock));
  }

  /**
   * @param {import("./vendor/bloub/engine.js").BotFrame} frame
   */
  paint(frame) {
    this.bodyMask.setAttribute("d", frame.bodyPath);
    this.paperPath.setAttribute("d", frame.bodyPath);
    this.bodyGroup.setAttribute("opacity", String(frame.bodyAlpha));
    for (let i = 0; i < 2; i++) {
      const eye = frame.eyes[i];
      const node = this.eyeMasks[i];
      if (!eye) {
        node.setAttribute("d", "");
        continue;
      }
      node.setAttribute("d", eye.d);
      node.setAttribute("transform", eye.matrix);
      node.setAttribute("opacity", String(eye.alpha));
    }
    if (frame.notch) {
      this.notch.setAttribute("visibility", "visible");
      this.notch.setAttribute("cx", String(frame.notch.x));
      this.notch.setAttribute("cy", String(frame.notch.y));
      this.notch.setAttribute("r", String(frame.notch.r));
    } else {
      this.notch.setAttribute("visibility", "hidden");
    }
    if (frame.notif) {
      this.notif.setAttribute("visibility", "visible");
      this.notif.setAttribute("cx", String(frame.notif.x));
      this.notif.setAttribute("cy", String(frame.notif.y));
      this.notif.setAttribute("r", String(frame.notif.r));
    } else {
      this.notif.setAttribute("visibility", "hidden");
    }
    this.paintDots(frame);
    this.paintArcs(frame);
  }

  paintDots(frame) {
    const host = frame.dotsBehind ? this.dotsBehind : this.dotsFront;
    const other = frame.dotsBehind ? this.dotsFront : this.dotsBehind;
    other.replaceChildren();
    const ns = "http://www.w3.org/2000/svg";
    while (host.childNodes.length > frame.dots.length) {
      host.lastChild.remove();
    }
    frame.dots.forEach((dot, i) => {
      let node = host.childNodes[i];
      const isPath = Boolean(dot.d);
      if (!node || node.tagName !== (isPath ? "path" : "circle")) {
        node = document.createElementNS(ns, isPath ? "path" : "circle");
        if (host.childNodes[i]) host.replaceChild(node, host.childNodes[i]);
        else host.append(node);
      }
      node.setAttribute("fill", INK);
      node.setAttribute("opacity", String(dot.opacity));
      if (isPath) {
        node.setAttribute("d", dot.d);
        node.setAttribute(
          "transform",
          `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`,
        );
      } else {
        node.setAttribute("cx", String(dot.x));
        node.setAttribute("cy", String(dot.y));
        node.setAttribute("r", String(dot.r));
        node.removeAttribute("transform");
      }
    });
  }

  paintArcs(frame) {
    const ns = "http://www.w3.org/2000/svg";
    this.gradRoot.replaceChildren();
    this.arcBack.replaceChildren();
    this.arcFront.replaceChildren();
    for (const arc of frame.arcs) {
      const gid = `${this.uid}-${arc.id}`;
      const grad = document.createElementNS(ns, "linearGradient");
      grad.id = gid;
      grad.setAttribute("gradientUnits", "userSpaceOnUse");
      grad.setAttribute("x1", String(arc.grad.x1));
      grad.setAttribute("y1", String(arc.grad.y1));
      grad.setAttribute("x2", String(arc.grad.x2));
      grad.setAttribute("y2", String(arc.grad.y2));
      const stops = arc.grad.stops || [];
      stops.forEach((c, i) => {
        const stop = document.createElementNS(ns, "stop");
        stop.setAttribute("offset", String(stops.length > 1 ? i / (stops.length - 1) : 0));
        stop.setAttribute("stop-color", c);
        grad.append(stop);
      });
      this.gradRoot.append(grad);
      for (const [host, d] of [
        [this.arcBack, arc.back],
        [this.arcFront, arc.front],
      ]) {
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", d);
        path.setAttribute("stroke", `url(#${gid})`);
        path.setAttribute("stroke-width", String(arc.width));
        path.setAttribute("opacity", String(arc.opacity));
        host.append(path);
      }
    }
  }
}

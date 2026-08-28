// vendor/bloub/src/math.ts
var TAU = Math.PI * 2;
var clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
var lerp = (a, b, t) => a + (b - a) * t;
var easings = {
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,
  easeOutQuint: (t) => 1 - (1 - t) ** 5
};
function loopNoise(t, period, seed = 0) {
  const p = t / period * TAU;
  return 0.55 * Math.sin(p + seed) + 0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) + 0.15 * Math.sin(3 * p + seed * 2.3 + 2.4);
}
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var r2 = (v) => Math.round(v * 100) / 100;

// vendor/bloub/src/decor.ts
function wheel(hue, s = 0.55, l = 0.62) {
  const h = (hue % 360 + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(h / 60 % 2 - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
function arcRender(seed, t, scale, id, opacity = 1) {
  const spin2 = seed.phase + t * seed.speed * TAU;
  const cu = Math.cos(seed.tilt);
  const su = Math.sin(seed.tilt);
  const kz = Math.sqrt(Math.max(0, 1 - seed.k * seed.k));
  const N = 64;
  const span = seed.sweep * TAU;
  let front = "";
  let back = "";
  let prev = null;
  for (let i = 0; i <= N; i++) {
    const th = spin2 + i / N * span;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const x = seed.a * (ct * cu + st * -su * seed.k) + seed.cx;
    const y = seed.a * (ct * su + st * cu * seed.k) + seed.cy;
    const z = seed.a * st * kz;
    const behind = z < 0;
    const sx = r2(x * scale);
    const sy = r2(y * scale);
    const cmd = behind !== prev ? "M" : "L";
    if (behind) back += `${cmd}${sx} ${sy}`;
    else front += `${cmd}${sx} ${sy}`;
    prev = behind;
  }
  const gx = Math.cos(seed.tilt) * seed.a * scale;
  const gy = Math.sin(seed.tilt) * seed.a * scale;
  return {
    id,
    front,
    back,
    width: seed.width * scale,
    opacity,
    grad: {
      x1: r2(seed.cx * scale - gx),
      y1: r2(seed.cy * scale - gy),
      x2: r2(seed.cx * scale + gx),
      y2: r2(seed.cy * scale + gy),
      stops: [wheel(seed.hue), wheel(seed.hue + seed.hueSpan * 0.5), wheel(seed.hue + seed.hueSpan)]
    }
  };
}
var RING_RNG = createRng(659918);
var RINGS = Array.from({ length: 6 }, (_, i) => ({
  a: 1.3 + RING_RNG() * 0.1,
  k: 0.05 + RING_RNG() * 0.4,
  tilt: i / 6 * Math.PI + RING_RNG() * 0.5,
  speed: 3 + RING_RNG() * 0.7,
  phase: RING_RNG() * TAU,
  sweep: 0.6 + RING_RNG() * 0.25,
  hue: i * 360 / 6 + RING_RNG() * 30,
  hueSpan: 60 + RING_RNG() * 60,
  width: 0.05 + RING_RNG() * 0.012,
  cx: 0,
  cy: 0.1
}));
var SWOOSH = Array.from({ length: 4 }, (_, i) => ({
  a: 0.78 + i * 0.2,
  k: 0.05 + i * 0.02,
  tilt: -0.62 + i * 0.05,
  speed: 0.3,
  phase: 0.06 * i,
  sweep: 0.4,
  hue: 95 + i * 62,
  hueSpan: 100,
  width: 0.05,
  cx: 0,
  cy: -0.12
}));
var DOT_X = [-0.557, -0.013, 0.532];
var DOT_R = 0.165;
var DOT_PEAK = 1.25;
var P_RNG = createRng(48879);
var PARTICLES = Array.from({ length: 5 }, (_, i) => ({
  birth: i * 0.2,
  angle: P_RNG() * TAU,
  rho: 0.58 + P_RNG() * 0.18
}));
function particles(t, scale) {
  const out = [];
  for (const p of PARTICLES) {
    const u = t - p.birth;
    if (u < 0 || u > 0.62) continue;
    const rho = p.rho * Math.pow(0.75, u * 10);
    const a = p.angle + u * 100 * Math.PI / 180;
    out.push({
      x: Math.cos(a) * rho * scale,
      y: Math.sin(a) * rho * scale,
      r: (0.04 + 0.028 * clamp(u / 0.55)) * scale,
      depth: clamp(1 - rho / 0.8),
      opacity: clamp(u / 0.06) * clamp((0.62 - u) / 0.08)
    });
  }
  return out;
}
var COMET_RNG = createRng(49383);
var COMET_RIBBONS = Array.from({ length: 4 }, (_, i) => {
  const d = i - 1.5;
  return {
    a: 0.85 * (1 + d * 0.03),
    // meme aplatissement a +-5 % pres : les rubans forment un faisceau serre
    k: 0.15 / 0.85 * (1 + d * 0.16),
    tilt: 34 * Math.PI / 180 + d * 0.035,
    speed: 210 / 360,
    // dephasage mesure : 10 a 20 degres entre rubans, pas davantage
    phase: -i * 0.045 + COMET_RNG() * 0.012,
    sweep: 0.34,
    hue: i * 85 + COMET_RNG() * 20,
    hueSpan: 80,
    width: 0.095,
    cx: 0,
    cy: 0
  };
});
var COMET_DOT = 0.129;
var NOTIF_BLUE = "#2496e8";
var NOTIF_ANGLE = -42;
var NOTIF_DIST = 1.003;
var NOTIF_R = 0.15;
var NOTIF_POP = 1.14;
var NOTIF_MARGIN = 0.054;

// vendor/bloub/src/face.ts
var EYE_SPLIT = 15.46;
var EYE_W = 0.186;
var EYE_H = 0.412;
var REST_GAZE = { yaw: 28.49, pitch: 28.62, roll: -13 };
var deg = (d) => d * Math.PI / 180;
function spin(u, v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s]
  ];
}
function eyePoses(gaze, scale, split = EYE_SPLIT) {
  let f = [0, 0, 1];
  let right = [1, 0, 0];
  let down = [0, 1, 0];
  [f, right] = spin(f, right, deg(gaze.yaw));
  [down, f] = spin(down, f, deg(gaze.pitch));
  [right, down] = spin(right, down, deg(gaze.roll));
  const build = (side) => {
    const [ef, er] = spin(f, right, deg(split * side));
    return {
      x: ef[0] * scale,
      y: ef[1] * scale,
      a: er[0],
      b: er[1],
      c: down[0],
      d: down[1],
      depth: ef[2]
    };
  };
  return [build(-1), build(1)];
}
var BLINK_RNG = createRng(24301);
var BLINKS = (() => {
  const out = [];
  let t = 1.4;
  while (t < 900) {
    out.push(t);
    t += 1.9 + BLINK_RNG() * 2.7;
    if (BLINK_RNG() < 0.18) {
      out.push(t);
      t += 0.24;
    }
  }
  return out;
})();
var BLINK_DUR = 0.18;
function blinkLid(t) {
  for (let i = 0; i < BLINKS.length; i++) {
    const start = BLINKS[i];
    if (t < start) break;
    const k = (t - start) / BLINK_DUR;
    if (k >= 0 && k <= 1) {
      return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
    }
  }
  return 1;
}
function liveliness(t, opt = {}) {
  const { wander = 1, blink = true, float = true } = opt;
  return {
    dYaw: (loopNoise(t, 11.3, 0.4) * 5.5 + loopNoise(t, 3.7, 2.1) * 1.6) * wander,
    dPitch: (loopNoise(t, 9.1, 1.3) * 4.2 + loopNoise(t, 4.3, 0.7) * 1.3) * wander,
    dRoll: loopNoise(t, 13.7, 3.2) * 2.2 * wander,
    lid: blink ? blinkLid(t) : 1,
    // Au repos la video est quasiment immobile (centre stable a +-0.003, rayon
    // constant) : toute la vie passe par le regard et les clignements. On garde
    // juste de quoi ne pas figer completement l'image.
    driftX: float ? loopNoise(t, 7.9, 1.9) * 6e-3 : 0,
    driftY: float ? loopNoise(t, 5.3, 0.3) * 7e-3 : 0,
    // La largeur est constante, seule la hauteur respire tres legerement.
    breath: float ? 1 + Math.sin(t / 3.4 * Math.PI * 2) * 5e-3 : 1
  };
}
function blinkScale(lid) {
  return 0.06 + 0.94 * clamp(lid);
}

// vendor/bloub/src/expressions.ts
var eye = (w, h, tilt = 0, open = 1) => ({ w, h, tilt, open });
var pair = (w, h, tilt = 0, open = 1) => [
  eye(w, h, tilt, open),
  eye(w, h, -tilt, open)
];
var EXPRESSIONS = [
  {
    // la pose relevée image par image sur la vidéo de référence
    id: "neutre",
    gaze: { ...REST_GAZE },
    split: EYE_SPLIT,
    eyes: [eye(EYE_W, EYE_H), eye(EYE_W, EYE_H)]
  },
  {
    id: "attentif",
    gaze: { yaw: 4, pitch: 5, roll: -4 },
    split: 16,
    eyes: pair(0.21, 0.44)
  },
  {
    id: "surpris",
    gaze: { yaw: 3, pitch: -3, roll: 0 },
    split: 19,
    eyes: pair(0.45, 0.47)
  },
  {
    id: "excite",
    gaze: { yaw: 6, pitch: -14, roll: 0 },
    split: 19.5,
    eyes: pair(0.4, 0.56, -10)
  },
  {
    // yeux plissés en arc : les hauts convergent légèrement
    id: "heureux",
    gaze: { yaw: 5, pitch: 9, roll: 0 },
    split: 17,
    eyes: pair(0.27, 0.17, 14)
  },
  {
    id: "hilare",
    gaze: { yaw: 4, pitch: 14, roll: 0 },
    split: 18,
    eyes: pair(0.34, 0.13, 20)
  },
  {
    // hauts des yeux qui convergent fort vers le centre + yeux étrécis
    id: "colere",
    gaze: { yaw: 3, pitch: 7, roll: 0 },
    split: 17,
    eyes: pair(0.34, 0.15, 30)
  },
  {
    // l'inverse : les hauts divergent, et le regard tombe
    id: "triste",
    gaze: { yaw: 3, pitch: -13, roll: 0 },
    split: 16,
    eyes: pair(0.22, 0.4, -28)
  },
  {
    id: "effraye",
    gaze: { yaw: 2, pitch: -20, roll: 0 },
    split: 20.5,
    eyes: pair(0.4, 0.6)
  },
  {
    // un œil franchement plus fermé que l'autre
    id: "mefiant",
    gaze: { yaw: 12, pitch: 6, roll: -6 },
    split: 16,
    eyes: [eye(0.21, 0.4), eye(0.22, 0.15)]
  },
  {
    // asymétrique sur les deux axes : tailles ET inclinaisons dépareillées.
    // L'œil plissé est volontairement plat (rapport 1,6) : à un rapport proche
    // de 1 il serait rond, et son inclinaison ne se verrait pas.
    id: "confus",
    gaze: { yaw: -14, pitch: 3, roll: 8 },
    split: 16.5,
    eyes: [eye(0.2, 0.44, -18), eye(0.28, 0.17, 14)]
  },
  {
    // la tête penche : c'est le roulis qui porte la curiosité
    id: "curieux",
    gaze: { yaw: 16, pitch: -9, roll: -15 },
    split: 16.5,
    eyes: [eye(0.24, 0.46, -8), eye(0.2, 0.38, -8)]
  },
  {
    id: "fier",
    gaze: { yaw: 5, pitch: 17, roll: 0 },
    split: 17,
    eyes: pair(0.3, 0.15, 18)
  },
  {
    id: "timide",
    gaze: { yaw: -19, pitch: -14, roll: -7 },
    split: 14,
    eyes: pair(0.17, 0.3)
  },
  {
    // fentes horizontales et regard qui part sur le côté
    id: "blase",
    gaze: { yaw: -22, pitch: 2, roll: 0 },
    split: 16,
    eyes: pair(0.3, 0.12)
  },
  {
    // paupières à moitié tombées : on passe par `open`, donc l'écrasement
    // vertical à l'écran, le même mécanisme que le clignement
    id: "somnolent",
    gaze: { yaw: 6, pitch: -9, roll: -3 },
    split: 16,
    eyes: pair(0.2, 0.42, 0, 0.42)
  }
];
var EXPRESSION_BY_ID = new Map(EXPRESSIONS.map((e) => [e.id, e]));
var lerpEyeCfg = (a, b, t) => ({
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t),
  open: lerp(a.open, b.open, t)
});
function blendExpression(a, b, t) {
  return {
    id: b.id,
    gaze: {
      yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
      pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
      roll: lerp(a.gaze.roll, b.gaze.roll, t)
    },
    split: lerp(a.split, b.split, t),
    eyes: [lerpEyeCfg(a.eyes[0], b.eyes[0], t), lerpEyeCfg(a.eyes[1], b.eyes[1], t)]
  };
}

// vendor/bloub/src/profiles.ts
var PROFILE_SAMPLES = 64;
var PROFILES = {
  // oeuf : meme hauteur que la boule, retreci en largeur
  // image 164, empreinte mesuree 1.647 x 2.000
  egg: [0.8369, 0.8424, 0.8497, 0.8585, 0.8674, 0.8775, 0.8878, 0.8983, 0.9089, 0.9185, 0.9288, 0.9374, 0.9445, 0.9504, 0.9543, 0.9559, 0.9555, 0.9519, 0.9466, 0.9389, 0.9302, 0.9193, 0.9085, 0.8969, 0.8852, 0.8734, 0.8625, 0.8513, 0.8411, 0.8325, 0.8243, 0.8179, 0.8137, 0.8112, 0.8102, 0.8128, 0.8178, 0.8262, 0.8374, 0.8518, 0.8702, 0.8922, 0.9169, 0.9446, 0.9741, 1.0023, 1.0267, 1.0433, 1.0481, 1.0393, 1.0216, 0.997, 0.9697, 0.9418, 0.9169, 0.8949, 0.876, 0.8604, 0.849, 0.8394, 0.8337, 0.8314, 0.8305, 0.8326],
  // hexagone pointe en haut, coins tres arrondis
  // image 174, empreinte mesuree 1.826 x 2.011
  hexagon: [0.921, 0.9282, 0.9441, 0.9706, 0.9984, 1.0059, 0.9896, 0.9562, 0.929, 0.9124, 0.9047, 0.9058, 0.9157, 0.9349, 0.9642, 0.9873, 0.9882, 0.9665, 0.9336, 0.9105, 0.8968, 0.8918, 0.8955, 0.908, 0.9293, 0.9611, 0.982, 0.9812, 0.959, 0.9282, 0.9089, 0.8978, 0.8964, 0.9026, 0.9189, 0.9439, 0.9778, 0.999, 0.9964, 0.9713, 0.9439, 0.9274, 0.9196, 0.9206, 0.9308, 0.9502, 0.9799, 1.0121, 1.0226, 1.0071, 0.9752, 0.951, 0.9366, 0.9316, 0.9351, 0.9485, 0.9711, 1.0026, 1.0213, 1.0155, 0.9863, 0.9547, 0.9347, 0.9232],
  // triangle pointe en haut, coins tres arrondis
  // image 190, empreinte mesuree 1.995 x 1.884
  triangle: [0.7819, 0.8211, 0.8747, 0.944, 1.0223, 1.096, 1.1401, 1.134, 1.0808, 1.0047, 0.9265, 0.8603, 0.8104, 0.773, 0.745, 0.7273, 0.7151, 0.7118, 0.7148, 0.7245, 0.7427, 0.768, 0.8037, 0.8518, 0.9148, 0.9876, 1.0583, 1.1073, 1.1109, 1.0667, 0.994, 0.9164, 0.8482, 0.7948, 0.7555, 0.7261, 0.7056, 0.6925, 0.6859, 0.6869, 0.6938, 0.7084, 0.7305, 0.7615, 0.804, 0.8595, 0.9311, 1.0092, 1.0791, 1.1171, 1.1054, 1.0501, 0.9779, 0.905, 0.845, 0.799, 0.7656, 0.7413, 0.7258, 0.716, 0.7146, 0.7204, 0.733, 0.7528]
};

// vendor/bloub/src/shape.ts
var ANGLES = Array.from({ length: PROFILE_SAMPLES }, (_, i) => i / PROFILE_SAMPLES * TAU);
var COS = ANGLES.map(Math.cos);
var SIN = ANGLES.map(Math.sin);
function silhouette(name, pose = {}) {
  return {
    radii: [...PROFILES[name]],
    rot: 0,
    cx: 0,
    cy: 0,
    sx: 1,
    sy: 1,
    ...pose
  };
}
function circle(radius, pose = {}) {
  return {
    radii: new Array(PROFILE_SAMPLES).fill(radius),
    rot: 0,
    cx: 0,
    cy: 0,
    sx: 1,
    sy: 1,
    ...pose
  };
}
function blend(a, b, t, out) {
  const dst = out ?? { radii: new Array(PROFILE_SAMPLES), rot: 0, cx: 0, cy: 0, sx: 1, sy: 1 };
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    dst.radii[i] = lerp(a.radii[i] ?? 1, b.radii[i] ?? 1, t);
  }
  let dRot = b.rot - a.rot;
  while (dRot > Math.PI) dRot -= TAU;
  while (dRot < -Math.PI) dRot += TAU;
  dst.rot = a.rot + dRot * t;
  dst.cx = lerp(a.cx, b.cx, t);
  dst.cy = lerp(a.cy, b.cy, t);
  dst.sx = lerp(a.sx, b.sx, t);
  dst.sy = lerp(a.sy, b.sy, t);
  return dst;
}
function toPoints(s, scale, out = []) {
  const cr = Math.cos(s.rot);
  const sr = Math.sin(s.rot);
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    const r = s.radii[i] ?? 1;
    const x = r * (COS[i] ?? 0);
    const y = r * (SIN[i] ?? 0);
    const rx = x * cr - y * sr;
    const ry = x * sr + y * cr;
    const p = out[i] ?? { x: 0, y: 0 };
    p.x = (rx * s.sx + s.cx) * scale;
    p.y = (ry * s.sy + s.cy) * scale;
    out[i] = p;
  }
  out.length = PROFILE_SAMPLES;
  return out;
}
function closedPath(pts, tension = 1 / 6) {
  const n = pts.length;
  if (n < 3) return "";
  const first = pts[0];
  let d = `M${r2(first.x)} ${r2(first.y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += `C${r2(c1x)} ${r2(c1y)} ${r2(c2x)} ${r2(c2y)} ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return `${d}Z`;
}
function profileFromPolygon(poly, cx, cy) {
  const radii = new Array(PROFILE_SAMPLES).fill(0);
  const n = poly.length;
  for (let k = 0; k < PROFILE_SAMPLES; k++) {
    const dx = COS[k] ?? 0;
    const dy = SIN[k] ?? 0;
    let best = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const px = a.x - cx;
      const py = a.y - cy;
      const t = (px * ey - py * ex) / den;
      const u = (px * dy - py * dx) / den;
      if (t > best && u >= 0 && u <= 1) best = t;
    }
    radii[k] = best;
  }
  return radii;
}
function hullOfCircles(x1, y1, r1, x2, y2, r2v, steps = 96) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1e-6;
  const base2 = Math.atan2(dy, dx);
  const spread = Math.acos(Math.max(-1, Math.min(1, (r1 - r2v) / dist)));
  const pts = [];
  for (let i = 0; i <= steps / 2; i++) {
    const a = base2 + spread + (TAU - 2 * spread) * i / (steps / 2);
    pts.push({ x: x1 + Math.cos(a) * r1, y: y1 + Math.sin(a) * r1 });
  }
  for (let i = 0; i <= steps / 2; i++) {
    const a = base2 - spread + 2 * spread * i / (steps / 2);
    pts.push({ x: x2 + Math.cos(a) * r2v, y: y2 + Math.sin(a) * r2v });
  }
  return pts;
}
function radiusAtAngle(radii, angle) {
  const n = radii.length;
  const t = (angle / TAU % 1 + 1) % 1 * n;
  const i = Math.floor(t);
  return lerp(radii[i % n] ?? 1, radii[(i + 1) % n] ?? 1, t - i);
}
function superellipseProfile(n, sx = 1, sy = 1) {
  return ANGLES.map((_, i) => {
    const c = Math.abs((COS[i] ?? 0) / sx) ** n;
    const s = Math.abs((SIN[i] ?? 0) / sy) ** n;
    return (c + s) ** (-1 / n);
  });
}
function unionOfCirclesProfile(circles) {
  const out = new Array(PROFILE_SAMPLES).fill(0);
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    const dx = COS[i] ?? 0;
    const dy = SIN[i] ?? 0;
    let best = 0;
    for (const c of circles) {
      const b = dx * c.x + dy * c.y;
      const disc = b * b - (c.x * c.x + c.y * c.y - c.r * c.r);
      if (disc < 0) continue;
      const t = b + Math.sqrt(disc);
      if (t > best) best = t;
    }
    out[i] = best;
  }
  return out;
}
function roundedPolygon(verts, rc, arcSteps = 10) {
  const n = verts.length;
  const out = [];
  const normal = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return Math.atan2(-dx / len, dy / len);
  };
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n];
    const cur = verts[i];
    const next = verts[(i + 1) % n];
    const a0 = normal(prev, cur);
    const a1 = normal(cur, next);
    let d = a1 - a0;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    for (let k = 0; k <= arcSteps; k++) {
      const a = a0 + d * k / arcSteps;
      out.push({ x: cur.x + Math.cos(a) * rc, y: cur.y + Math.sin(a) * rc });
    }
  }
  return out;
}
function regularPolygonProfile(sides, radius, rc, rotationDeg = 0) {
  const rot = rotationDeg * Math.PI / 180;
  const verts = Array.from({ length: sides }, (_, i) => {
    const a = rot + i / sides * TAU;
    return { x: Math.cos(a) * (radius - rc), y: Math.sin(a) * (radius - rc) };
  });
  return profileFromPolygon(roundedPolygon(verts, rc), 0, 0);
}
function polyPath(pts, scale = 1) {
  if (pts.length < 3) return "";
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    d += `${i === 0 ? "M" : "L"}${r2(p.x * scale)} ${r2(p.y * scale)}`;
  }
  return `${d}Z`;
}
function capsulePath(w, h) {
  const hw = Math.max(w, 0.01) / 2;
  const hh = Math.max(h, 0.01) / 2;
  const r = Math.min(hw, hh);
  return `M${r2(-hw)} ${r2(-hh + r)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw + r)} ${r2(-hh)}L${r2(hw - r)} ${r2(-hh)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw)} ${r2(-hh + r)}L${r2(hw)} ${r2(hh - r)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw - r)} ${r2(hh)}L${r2(-hw + r)} ${r2(hh)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw)} ${r2(hh - r)}Z`;
}

// vendor/bloub/src/skins.ts
function normalize(radii, max = 1) {
  const peak = Math.max(...radii);
  if (peak <= 0) return radii;
  const k = max / peak;
  return radii.map((r) => r * k);
}
var ANGLES2 = Array.from({ length: PROFILE_SAMPLES }, (_, i) => i / PROFILE_SAMPLES * Math.PI * 2);
var pebble = normalize(
  ANGLES2.map((a) => 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1)),
  1.02
);
var cloud = normalize(
  unionOfCirclesProfile([
    { x: -0.44, y: 0.2, r: 0.54 },
    { x: 0.46, y: 0.2, r: 0.5 },
    { x: 0.02, y: 0.3, r: 0.6 },
    { x: -0.24, y: -0.3, r: 0.48 },
    { x: 0.3, y: -0.24, r: 0.44 }
  ]),
  1.02
);
var droplet = normalize(
  profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05), 0, 0),
  1.04
);
var capsule = profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62), 0, 0);
var SHAPES = [
  { id: "cercle", radii: new Array(PROFILE_SAMPLES).fill(1) },
  { id: "galet", radii: pebble },
  // 1.15 et pas 1.02 : sur une superellipse le rayon maximal est la diagonale,
  // donc normaliser dessus donne une forme qui parait plus petite que le cercle.
  { id: "squircle", radii: normalize(superellipseProfile(4.2), 1.15) },
  { id: "capsule", radii: capsule },
  // -90deg : un sommet vers le haut de l'ecran (y est oriente vers le bas)
  { id: "triangle", radii: regularPolygonProfile(3, 1.12, 0.34, -90) },
  // 0deg : sommets a gauche et a droite, donc aretes du haut et du bas plates
  { id: "hexagone", radii: regularPolygonProfile(6, 1.04, 0.26, 0) },
  { id: "nuage", radii: cloud },
  { id: "goutte", radii: droplet }
];
var SHAPE_BY_ID = new Map(SHAPES.map((s) => [s.id, s]));
var COLORS = [
  { id: "encre", hex: "#0a0a0c" },
  { id: "brun", hex: "#8b5e3c" },
  { id: "rouge", hex: "#e8483f" },
  { id: "orange", hex: "#f08a24" },
  { id: "ambre", hex: "#f0b429" },
  { id: "vert", hex: "#3ecf8e" },
  { id: "turquoise", hex: "#2fbfa0" },
  { id: "bleu", hex: "#3b93f0" },
  { id: "violet", hex: "#8b5cf6" },
  { id: "rose", hex: "#e152b0" },
  { id: "gris", hex: "#a3a3a3" },
  { id: "creme", hex: "#f1efe9" }
];
var COLOR_BY_ID = new Map(COLORS.map((c) => [c.id, c]));

// vendor/bloub/src/states.ts
var pair2 = (w, h) => [
  { w, h, open: 1 },
  { w, h, open: 1 }
];
function base(over = {}) {
  return {
    sil: circle(1),
    offX: 0,
    offY: 0,
    gaze: { ...REST_GAZE },
    split: EYE_SPLIT,
    eyes: pair2(EYE_W, EYE_H),
    eyeAlpha: 1,
    bodyAlpha: 1,
    dots: [],
    arcs: [],
    notif: null,
    dotsBehind: false,
    ...over
  };
}
var BAR_UPRIGHT_CY = -0.1875;
var BAR_UPRIGHT = profileFromPolygon(
  hullOfCircles(0, -0.505, 0.132, 0, 0.13, 0.075),
  0,
  BAR_UPRIGHT_CY
);
var BAR_ITALIC = profileFromPolygon(hullOfCircles(0, -0.2535, 0.1345, 0, 0.2535, 0.1345), 0, 0);
var barUpright = (pose = {}) => ({
  radii: [...BAR_UPRIGHT],
  rot: 0,
  cx: 0,
  cy: BAR_UPRIGHT_CY,
  sx: 1,
  sy: 1,
  ...pose
});
var barItalic = (pose = {}) => ({
  radii: [...BAR_ITALIC],
  rot: 0,
  cx: 0,
  cy: 0,
  sx: 1,
  sy: 1,
  ...pose
});
var TEAR = polyPath(hullOfCircles(0, 0, 0.118, 0, 0.172, 0.012));
var TRI_ORBIT = 0.213;
function spinningTriangle(rot) {
  return silhouette("triangle", {
    rot,
    cx: -TRI_ORBIT * Math.sin(rot),
    cy: TRI_ORBIT * Math.cos(rot)
  });
}
function dotPulse(t, index) {
  const p = ((t - index * 0.5) / 1.5 % 1 + 1) % 1;
  const k = p < 0.5 ? 0.5 - 0.5 * Math.cos(p * TAU) : 0;
  return clamp(k * 2);
}
var STATES = [
  {
    id: "idle",
    duration: 2.4,
    morph: 0.45,
    blinkIn: false,
    baseFace: true,
    baseBody: true,
    pose: () => base()
  },
  {
    id: "thinking",
    duration: 2.6,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: (t) => {
      const mid = dotPulse(t, 1);
      const emerge = 0.3 + 0.7 * easings.easeOutCubic(clamp(t / 0.3));
      return base({
        // la boule DEVIENT le point du milieu : le morph reste continu
        sil: circle(DOT_R * (1 + (DOT_PEAK - 1) * mid), { cx: DOT_X[1] }),
        eyeAlpha: 0,
        dots: [0, 2].map((i) => {
          const k = dotPulse(t, i);
          return {
            x: DOT_X[i] * emerge,
            y: 0,
            r: DOT_R * (1 + (DOT_PEAK - 1) * k),
            opacity: 0.55 + 0.45 * k
          };
        })
      });
    }
  },
  {
    id: "wink",
    duration: 1.6,
    morph: 0.3,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () => base({
      gaze: { yaw: -5.37, pitch: 4.55, roll: 6.7 },
      split: 16.25,
      // L'oeil ferme n'est pas l'oeil ouvert ecrase : c'est un tiret
      // horizontal PLUS LARGE que l'oeil ouvert (0.447 contre 0.236).
      eyes: [
        { w: 0.236, h: 0.464, open: 1 },
        { w: 0.447, h: 0.089, open: 1 }
      ]
    })
  },
  {
    id: "wide",
    duration: 1.8,
    morph: 0.55,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () => base({
      gaze: { yaw: 6.92, pitch: -21.96, roll: 11.6 },
      split: 18.43,
      eyes: pair2(0.356, 0.875)
    })
  },
  {
    id: "alert",
    duration: 2.4,
    // le "!" revient en place a 1.6 + 0.4
    minDuration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      const p = clamp(t / 1.5);
      const travel = easings.easeInOutCubic(p) * 0.82 - 0.087;
      const back = t > 1.6 ? clamp((t - 1.6) / 0.4) : 0;
      const x = travel * (1 - back) + 0.1 * back;
      const buzz = Math.sin(t * 2.5 * TAU) * 5e-3;
      const tilt = 17.7 * Math.PI / 180;
      return base({
        sil: barItalic({ rot: tilt, cx: x, cy: -0.325 - buzz }),
        eyeAlpha: 0,
        dots: [
          {
            // le point suit l'axe du glyphe, a 0.580 du centre de la barre
            x: x - Math.sin(tilt) * 0.58,
            y: -0.325 + Math.cos(tilt) * 0.58 + buzz * 2.8,
            r: 0.118,
            d: TEAR,
            rot: tilt * 180 / Math.PI,
            opacity: 1
          }
        ]
      });
    }
  },
  {
    id: "notify",
    duration: 2.2,
    morph: 0.5,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: (t) => {
      const p = clamp(t / 0.45);
      const pop = 1 + (NOTIF_POP - 1) * Math.sin(p * Math.PI) * (1 - p * 0.35);
      const r = NOTIF_R * (p < 1 ? pop : 1);
      const a = NOTIF_ANGLE * Math.PI / 180;
      return base({
        // le regard part a l'oppose de la pastille
        gaze: { yaw: -21.94, pitch: -5.82, roll: -12.2 },
        split: 18.89,
        eyes: pair2(0.505, 0.498),
        notif: {
          x: Math.cos(a) * NOTIF_DIST,
          y: Math.sin(a) * NOTIF_DIST,
          r,
          notch: r + NOTIF_MARGIN
        }
      });
    }
  },
  {
    id: "exclaim",
    duration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: () => base({
      sil: barUpright(),
      eyeAlpha: 0,
      dots: [{ x: -0.012, y: 0.526, r: 0.113, opacity: 1 }]
    })
  },
  {
    id: "sleep",
    duration: 2.4,
    morph: 0.5,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => base({
      // Rebond vertical mesure : +-0.19 autour de +0.11, periode 0.6 s.
      sil: circle(0.1585, { cy: 0.11 + Math.sin(t * (TAU / 0.6)) * 0.19 }),
      eyeAlpha: 0
    })
  },
  {
    id: "egg",
    duration: 1.8,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: () => base({
      sil: silhouette("egg"),
      gaze: { yaw: 19.97, pitch: 26.01, roll: -17.1 },
      // les yeux se resserrent comme le corps
      split: 11.07,
      eyes: pair2(0.164, 0.385)
    })
  },
  {
    id: "hexagon",
    duration: 1.6,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: () => base({
      sil: silhouette("hexagon"),
      gaze: { yaw: 23.11, pitch: 24.42, roll: -13.3 },
      split: 13.37,
      eyes: pair2(0.177, 0.411)
    })
  },
  {
    id: "play",
    duration: 2,
    morph: 0.5,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: (t) => {
      const fade = clamp(t / 0.35) * clamp((2.2 - t) / 0.5);
      return base({
        sil: spinningTriangle(0),
        gaze: { yaw: 12, pitch: -8, roll: -6 },
        split: 15,
        eyes: pair2(0.18, 0.34),
        // le bouquet balaie de la droite vers la gauche par-dessus le triangle
        arcs: SWOOSH.map((s, i) => ({
          id: `sw${i}`,
          seed: { ...s, cx: 0.45 - t * 0.42 },
          t,
          opacity: fade
        }))
      });
    }
  },
  {
    id: "orbit",
    duration: 3.4,
    // le corps a fini de se relacher du triangle vers la boule a 1.6 + 0.9
    minDuration: 2.5,
    morph: 0.6,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      const ramp = easings.easeInOutCubic(clamp(t / 0.35));
      const rot = -TAU * 1.25 * t * ramp;
      const back = easings.easeInOutCubic(clamp((t - 1.6) / 0.9));
      const tri = spinningTriangle(rot);
      const ball = circle(1, { rot });
      const sil = {
        radii: tri.radii.map((r, i) => r + (ball.radii[i] - r) * back),
        rot,
        cx: tri.cx * (1 - back),
        cy: tri.cy * (1 - back),
        sx: 1,
        sy: 1
      };
      const fade = clamp(t / 0.8) * clamp((3.6 - t) / 0.9);
      return base({
        sil,
        // les yeux filent autour de la sphere ~3x plus vite que la silhouette
        gaze: {
          yaw: REST_GAZE.yaw + Math.sin(t * 6.5) * 65 * (1 - back),
          pitch: -4 + back * 32,
          roll: -13
        },
        eyes: pair2(0.18, 0.34 + back * 0.07),
        // les anneaux entrent un par un sur 0.8 s
        arcs: RINGS.map((s, i) => ({
          id: `rg${i}`,
          seed: s,
          t,
          opacity: fade * clamp((t - i * 0.13) / 0.3)
        }))
      });
    }
  },
  {
    /**
     * Entree dans la vue des reglages.
     *
     * SEUL etat qui n'est pas releve sur la video : il est CHOISI, comme la
     * couleur `--ink`. Il emprunte le vocabulaire d'`orbit` — les memes anneaux,
     * avec leurs parametres mesures — mais coupe court : 1 s au lieu de 3,4, la
     * moitie des anneaux, et aucun triangle.
     *
     * Les deux drapeaux a `true` sont tout l'interet de cet etat :
     *
     * - `baseBody` laisse la forme choisie remplacer le corps, donc la vue peut
     *   imposer le cercle et le galet ou la goutte y MORPHENT au lieu de sauter ;
     * - `baseFace` fait porter le visage de repos, donc le suivi du curseur
     *   s'applique des cette entree. Un etat qui aurait sa propre pose de regard
     *   (comme `orbit`) rendrait la main a l'etat suivant en pleine course, et
     *   les yeux sauteraient d'un coup a la reprise.
     *
     * Il n'est volontairement PAS dans `SEQUENCE` : ce n'est pas une animation du
     * catalogue, c'est une transition d'interface.
     */
    id: "swirl",
    // un peu plus que le tour du regard (`TURN_TIME`, 1,1 s) : les yeux doivent
    // etre poses a gauche avant que les anneaux ne s'effacent
    duration: 1.3,
    minDuration: 1.3,
    morph: 0.3,
    baseFace: true,
    baseBody: true,
    // le morph de forme est masque par un clignement, comme partout ailleurs
    blinkIn: true,
    pose: (t) => base({
      // trois anneaux sur les six d'`orbit` : la moitie du bouquet suffit a le
      // reconnaitre, et c'est autant d'arcs en moins a rasteriser par image
      arcs: RINGS.slice(0, 3).map((s, i) => ({
        id: `sw${i}`,
        seed: s,
        t,
        // ils entrent l'un apres l'autre puis s'effacent avant la fin du bloc,
        // pour que la reprise au repos se fasse sur une image deja propre
        opacity: clamp((t - i * 0.06) / 0.14) * clamp((1.22 - t) / 0.34)
      }))
    })
  },
  {
    id: "burst",
    duration: 2.6,
    // le corps est recompose a 1.7 + 0.7
    minDuration: 2.4,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      const collapse = 1 - 0.834 * easings.easeOutQuint(clamp(t / 0.7));
      const regrow = easings.easeOutQuint(clamp((t - 1.7) / 0.7));
      return base({
        sil: circle(collapse + (1 - collapse) * regrow),
        eyeAlpha: clamp((t - 1.85) / 0.4),
        dots: particles(t, 1),
        dotsBehind: true
      });
    }
  },
  {
    id: "comet",
    duration: 2.4,
    // le point se recompose a 1.85 + 0.6 = 2.45, soit 0.05 s apres la coupe de
    // la video : ce reliquat se termine pendant le fondu suivant, comme dans la
    // reference. On ne descend donc pas sous la duree mesuree.
    minDuration: 2.4,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      const collapse = 1 - (1 - COMET_DOT) * easings.easeOutQuint(clamp(t / 0.55));
      const regrow = easings.easeOutQuint(clamp((t - 1.85) / 0.6));
      const fade = clamp((t - 0.15) / 0.25) * clamp((1.95 - t) / 0.3);
      return base({
        // Le point derive de 0.035 vers le bas puis remonte (wobble mesure).
        sil: circle(collapse + (1 - collapse) * regrow, {
          cy: Math.sin(clamp(t / 1.7) * Math.PI) * 0.035
        }),
        eyeAlpha: clamp((t - 2) / 0.35),
        arcs: COMET_RIBBONS.map((s, i) => ({ id: `cm${i}`, seed: s, t, opacity: fade }))
      });
    }
  }
];
var STATE_BY_ID = new Map(STATES.map((s) => [s.id, s]));

// vendor/bloub/src/eyefit.ts
var R = 100;
var DERIVE_YAW = 5.5 + 1.6;
var DERIVE_PITCH = 4.2 + 1.3;
var DERIVE_X = 6e-3;
var DERIVE_Y = 7e-3;
function empreintes(visage, sil, radii) {
  const out = [];
  const poses = eyePoses(visage.gaze, R, visage.split);
  for (let i = 0; i < 2; i++) {
    const e = poses[i];
    if (e.depth <= 0.02) continue;
    const cfg = visage.eyes[i];
    const phi = (cfg.tilt ?? 0) * Math.PI / 180;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const ax = e.a * cp + e.c * sp;
    const ay = e.b * cp + e.d * sp;
    const cx = -e.a * sp + e.c * cp;
    const cy = -e.b * sp + e.d * cp;
    const hw = Math.max(cfg.w * R, 0.01) / 2;
    const hh = Math.max(cfg.h * R, 0.01) / 2;
    const r = Math.min(hw, hh);
    const long = hh > hw;
    const demi = long ? hh - r : hw - r;
    const fit = radiusAtAngle(radii, Math.atan2(e.y, e.x) - sil.rot);
    out.push({
      x: e.x * fit,
      y: e.y * fit,
      ax: (long ? cx : ax) * demi,
      ay: (long ? cy : ay) * demi,
      r,
      m: [ax, ay, cx, cy]
    });
  }
  return out;
}
function approche(pts, x0, y0, x1, y1) {
  const sx = x1 - x0;
  const sy = y1 - y0;
  const len2 = sx * sx + sy * sy;
  let best = Infinity;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    let t = len2 > 0 ? ((p.x - x0) * sx + (p.y - y0) * sy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x0 + t * sx - p.x;
    const ey = y0 + t * sy - p.y;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) {
      best = d2;
      vx = ex;
      vy = ey;
    }
  }
  const d = Math.sqrt(best);
  return { d, ux: d > 1e-9 ? vx / d : 0, uy: d > 1e-9 ? vy / d : 0 };
}
var FLOTTEMENT = Math.hypot(DERIVE_X, DERIVE_Y) * R;
function pire(pts, emps, tx, ty) {
  let marge = Infinity;
  let ux = 0;
  let uy = 0;
  for (const e of emps) {
    const x = e.x + tx;
    const y = e.y + ty;
    const a = approche(pts, x - e.ax, y - e.ay, x + e.ax, y + e.ay);
    const [m0, m1, m2, m3] = e.m;
    const rayon = e.r * Math.hypot(m0 * a.ux + m1 * a.uy, m2 * a.ux + m3 * a.uy) + FLOTTEMENT;
    if (a.d - rayon < marge) {
      marge = a.d - rayon;
      ux = a.ux;
      uy = a.uy;
    }
  }
  return { marge, ux, uy };
}
var DIRECTIONS = 12;
var DICHOTOMIE = 8;
function resous(epreuves) {
  if (!epreuves.length) return { x: 0, y: 0 };
  const marge = (tx, ty) => {
    let m = Infinity;
    for (const ep of epreuves) m = Math.min(m, pire(ep.contour, ep.empreintes, tx, ty).marge);
    return m;
  };
  let requis = Infinity;
  for (const ep of epreuves) {
    requis = Math.min(requis, pire(ep.calContour, ep.reference, 0, 0).marge);
  }
  let mx = 0;
  let my = 0;
  const emps = epreuves[0].empreintes;
  for (const e of emps) {
    mx -= e.x / emps.length;
    my -= e.y / emps.length;
  }
  const course = Math.max(0.35 * R, Math.hypot(mx, my) * 1.25);
  requis = Math.min(requis, marge(mx, my));
  const depart = marge(0, 0);
  if (depart >= requis && depart >= 0) return { x: 0, y: 0 };
  const cible = Math.max(requis, 0);
  let meilleurX = 0;
  let meilleurY = 0;
  let meilleureNorme = Infinity;
  let secoursX = 0;
  let secoursY = 0;
  let secours = depart;
  for (let d = 0; d < DIRECTIONS; d++) {
    const a = d / DIRECTIONS * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    if (marge(ux * course, uy * course) < cible) {
      for (const k of [0.3, 0.6, 1]) {
        const m = marge(ux * course * k, uy * course * k);
        if (m > secours) {
          secours = m;
          secoursX = ux * course * k;
          secoursY = uy * course * k;
        }
      }
      continue;
    }
    let bas = 0;
    let haut = course;
    for (let i = 0; i < DICHOTOMIE; i++) {
      const mid = (bas + haut) / 2;
      if (marge(ux * mid, uy * mid) >= cible) haut = mid;
      else bas = mid;
    }
    if (haut < meilleureNorme) {
      meilleureNorme = haut;
      meilleurX = ux * haut;
      meilleurY = uy * haut;
    }
  }
  const x = meilleureNorme === Infinity ? secoursX : meilleurX;
  const y = meilleureNorme === Infinity ? secoursY : meilleurY;
  return { x: +(x / R).toFixed(6), y: +(y / R).toFixed(6) };
}
function visageDe(def, pose, expr) {
  if (def.baseFace && expr) return { gaze: expr.gaze, split: expr.split, eyes: expr.eyes };
  return { gaze: pose.gaze, split: pose.split, eyes: pose.eyes };
}
function dates(def) {
  const signature = (p) => JSON.stringify([p.gaze, p.split, p.eyes, p.sil.rot, p.sil.cx, p.sil.cy, p.sil.sx, p.sil.sy]);
  if (signature(def.pose(0)) === signature(def.pose(def.duration))) return [0];
  const n = 3;
  return Array.from({ length: n }, (_, i) => i / (n - 1) * def.duration);
}
function decalagePour(def, radii, expr) {
  const epreuves = [];
  for (const t of dates(def)) {
    const pose = def.pose(t);
    const contour = toPoints({ ...pose.sil, radii }, R);
    const calContour = toPoints(pose.sil, R);
    const v = visageDe(def, pose, expr);
    const coins = [];
    for (const dy of [-DERIVE_YAW, DERIVE_YAW]) {
      for (const dp of [-DERIVE_PITCH, DERIVE_PITCH]) {
        coins.push({
          ...v,
          gaze: { yaw: v.gaze.yaw + dy, pitch: v.gaze.pitch + dp, roll: v.gaze.roll }
        });
      }
    }
    for (const c of coins) {
      epreuves.push({
        empreintes: empreintes(c, pose.sil, radii),
        reference: empreintes(c, pose.sil, pose.sil.radii),
        contour,
        calContour
      });
    }
  }
  return resous(epreuves);
}
var NUL = { x: 0, y: 0 };
var clef = (state, expr) => `${state}|${expr ?? ""}`;
function batir() {
  return new Map(
    SHAPES.map((forme) => {
      const par = /* @__PURE__ */ new Map();
      for (const def of STATES) {
        if (!def.baseBody) continue;
        const expressions = def.baseFace ? [null, ...EXPRESSIONS] : [null];
        for (const expr of expressions) {
          par.set(clef(def.id, expr?.id ?? null), decalagePour(def, forme.radii, expr));
        }
      }
      return [forme.radii, par];
    })
  );
}
var DECALAGES = batir();
function decalageDesYeux(radii, state, expr) {
  if (!radii) return NUL;
  const par = DECALAGES.get(radii);
  if (!par) return NUL;
  return par.get(clef(state, expr)) ?? par.get(clef(state, null)) ?? NUL;
}

// vendor/bloub/src/engine.ts
var NO_LOOK = { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 };
var lerpLook = (a, b, t) => ({
  yaw: lerp(a.yaw, b.yaw, t),
  pitch: lerp(a.pitch, b.pitch, t),
  mix: lerp(a.mix, b.mix, t),
  spin: lerp(a.spin, b.spin, t),
  wander: lerp(a.wander, b.wander, t)
});
var lerpEye = (a, b, t) => ({
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  open: lerp(a.open, b.open, t),
  tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t)
});
function blendPose(a, b, t) {
  const out = 1 - t;
  return {
    sil: blend(a.sil, b.sil, t),
    offX: lerp(a.offX, b.offX, t),
    offY: lerp(a.offY, b.offY, t),
    gaze: {
      yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
      pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
      roll: lerp(a.gaze.roll, b.gaze.roll, t)
    },
    split: lerp(a.split, b.split, t),
    eyes: [lerpEye(a.eyes[0], b.eyes[0], t), lerpEye(a.eyes[1], b.eyes[1], t)],
    eyeAlpha: lerp(a.eyeAlpha, b.eyeAlpha, t),
    bodyAlpha: lerp(a.bodyAlpha, b.bodyAlpha, t),
    dots: [
      ...a.dots.map((d) => ({ ...d, opacity: d.opacity * out })),
      ...b.dots.map((d) => ({ ...d, opacity: d.opacity * t }))
    ],
    arcs: [
      ...a.arcs.map((r) => ({ ...r, id: `a${r.id}`, opacity: r.opacity * out })),
      ...b.arcs.map((r) => ({ ...r, id: `b${r.id}`, opacity: r.opacity * t }))
    ],
    // la pastille appartient a un seul des deux etats, elle ne se melange pas
    notif: t < 0.5 ? a.notif : b.notif,
    dotsBehind: t < 0.5 ? a.dotsBehind : b.dotsBehind
  };
}
var BotEngine = class _BotEngine {
  /** rayon de la boule au repos, en unites de viewBox */
  scale;
  cur;
  prev = null;
  /**
   * Pose de depart FIGEE, posee seulement quand un changement d'etat arrive alors qu'un
   * fondu est deja en cours. Cf. `setState`.
   */
  departFige = null;
  tCur = 0;
  tPrev = 0;
  blinkAt = -10;
  pts = [];
  shape = null;
  shapePrev = null;
  shapeAt = -10;
  expr = null;
  exprPrev = null;
  exprAt = -10;
  look = NO_LOOK;
  lookPrev = NO_LOOK;
  lookAt = -10;
  /** duree de rattrapage en cours ; voir `LOOK_MORPH`, sa valeur par defaut */
  lookMorph = 0.24;
  /** duree du morph quand on change la forme du corps */
  static SHAPE_MORPH = 0.45;
  /**
   * Duree de rattrapage du regard vers la cible. Plus court que `SHAPE_MORPH` :
   * un regard qui suit doit paraitre attentif, pas visqueux. Comme la cible est
   * reposee a chaque mouvement de souris, c'est cette duree qui donne au suivi
   * son inertie — le regard n'atteint jamais tout a fait un curseur qui bouge.
   */
  static LOOK_MORPH = 0.24;
  constructor(scale = 100, initial = "idle", shape = null, expression = null) {
    this.scale = scale;
    this.cur = initial;
    this.shape = shape;
    this.expr = expression;
  }
  /**
   * Expression de repos choisie dans le personnalisateur. Comme la forme, elle
   * glisse vers la nouvelle valeur au lieu de sauter.
   */
  setExpression(expression, now = 0) {
    if (expression === this.expr) return;
    this.exprPrev = this.expr;
    this.expr = expression;
    this.exprAt = now;
  }
  /** Expression effective a l'instant `now`, morph en cours compris. */
  exprAtTime(now) {
    const to = this.expr;
    const from = this.exprPrev;
    if (!to || !from) return to;
    const k = (now - this.exprAt) / _BotEngine.SHAPE_MORPH;
    if (k >= 1) return to;
    return blendExpression(from, to, easings.easeOutQuint(clamp(k)));
  }
  /**
   * Forme choisie dans le personnalisateur. Elle ne remplace le corps que sur
   * les etats au repos (`baseBody`) : sur les autres, la silhouette EST
   * l'animation et ne doit pas etre ecrasee.
   *
   * Le changement se fait en morph, pas d'un coup : comme toutes les formes sont
   * echantillonnees aux memes angles, il suffit d'interpoler les rayons.
   */
  setShape(radii, now = 0) {
    if (radii === this.shape) return;
    this.shapePrev = this.shape;
    this.shape = radii;
    this.shapeAt = now;
  }
  /**
   * Forme effective a l'instant `now`, morph en cours compris.
   *
   * Ne remet PAS `shapePrev` a null en fin de morph : `sample` doit rester une
   * fonction pure du temps, donc relire une date passee doit redonner l'image
   * intermediaire. On garde juste une reference de plus.
   */
  shapeAtTime(now) {
    const to = this.shape;
    const from = this.shapePrev;
    if (!to || !from) return to;
    const k = (now - this.shapeAt) / _BotEngine.SHAPE_MORPH;
    if (k >= 1) return to;
    const t = easings.easeOutQuint(clamp(k));
    return to.map((r, i) => lerp(from[i] ?? r, r, t));
  }
  /**
   * Nouvelle cible de regard, `null` pour revenir a celui de l'etat.
   *
   * Elle repart de la valeur COURANTE, et non de la cible precedente comme
   * `setShape` : cette methode est appelee a chaque mouvement de pointeur, et
   * repartir de l'ancienne cible ferait reculer le regard d'un cran avant
   * chaque rattrapage — le suivi tremblerait au lieu de glisser.
   *
   * Meme contrat que `setShape` par ailleurs : l'etat externe entre par un
   * setter horodate, jamais par une variable lue pendant `sample`, sinon le
   * moteur cesse d'etre une fonction pure du temps.
   */
  setLook(look, now, morph = _BotEngine.LOOK_MORPH) {
    if (look && !Number.isFinite(look.yaw + look.pitch + look.mix + look.spin + look.wander)) {
      return;
    }
    this.lookPrev = this.lookAtTime(now);
    this.look = look ?? NO_LOOK;
    this.lookAt = now;
    this.lookMorph = morph;
  }
  /** Regard effectif a l'instant `now`, rattrapage en cours compris. */
  lookAtTime(now) {
    const k = (now - this.lookAt) / this.lookMorph;
    if (k >= 1) return this.look;
    return lerpLook(this.lookPrev, this.look, easings.easeOutQuint(clamp(k)));
  }
  posed(def, t, shape, expr) {
    let pose = def.pose(t);
    if (def.baseBody && shape) {
      pose = { ...pose, sil: { ...pose.sil, radii: shape } };
    }
    if (def.baseFace && expr) {
      pose = { ...pose, gaze: expr.gaze, split: expr.split, eyes: expr.eyes };
    }
    return pose;
  }
  /**
   * Decalage des yeux a l'instant `now` pour un etat donne, en unites de rayon de boule.
   *
   * Il est LU dans une table et interpole, jamais recalcule : `eyefit.ts` explique
   * pourquoi cette distinction est tout le correctif. Ici il ne reste qu'a l'interpoler
   * sur l'axe de la forme, avec exactement la courbe et la duree du morph de silhouette
   * — c'est la meme cause, donc ce doit etre le meme mouvement.
   *
   * On interroge la table sur les BORNES du morph (`shapePrev` et `shape`) et non sur le
   * profil que rend `shapeAtTime` : celui-la est un tableau neuf alloue a chaque image,
   * donc sans identite, et il n'existe dans aucune table.
   */
  decalageAtTime(now, state) {
    const surAxe = (debut, duree, a, b) => {
      if (a === b) return b;
      const k = (now - debut) / duree;
      if (k >= 1) return b;
      const t = easings.easeOutQuint(clamp(k));
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    };
    const parForme = (radii) => surAxe(
      this.exprAt,
      _BotEngine.SHAPE_MORPH,
      decalageDesYeux(radii, state, this.exprPrev?.id ?? null),
      decalageDesYeux(radii, state, this.expr?.id ?? null)
    );
    return surAxe(
      this.shapeAt,
      _BotEngine.SHAPE_MORPH,
      parForme(this.shapePrev),
      parForme(this.shape)
    );
  }
  get state() {
    return this.cur;
  }
  /**
   * Repart sur `id` SANS etat precedent, comme un moteur neuf pose sur cet etat.
   *
   * C'est ce que veut dire « rembobiner » pour ce moteur. `setState` seul ne peut pas le
   * faire : il garde l'etat quitte pour le fondre, ce qui est exactement son role en
   * lecture, et exactement ce qu'il ne faut pas quand on revient au debut d'une sequence.
   * Rejouer l'image 0 apres une passe complete melangeait le premier etat avec le DERNIER,
   * et l'export GIF s'ouvrait sur une boule sans yeux — la comete a un `eyeAlpha` nul.
   *
   * `sample` reste une fonction pure du temps : comme `setState`, ceci est un setter DATE,
   * appele par le pilote de la sequence, jamais pendant un echantillonnage.
   */
  reset(id, now) {
    this.cur = id;
    this.prev = null;
    this.departFige = null;
    this.tCur = now;
    this.tPrev = now;
    this.blinkAt = -10;
  }
  /**
   * Origine du fondu en cours : la pose figee s'il y en a une, sinon l'etat quitte evalue
   * a son propre temps ecoule — donc encore en train de s'animer, ce qui est voulu.
   */
  origine(now, shape, expr) {
    if (this.departFige) return this.departFige;
    if (!this.prev) return null;
    const prevDef = STATE_BY_ID.get(this.prev);
    return this.posed(prevDef, Math.max(0, now - this.tPrev), shape, expr);
  }
  /**
   * Pose composite a l'instant `now`, fondu en cours compris : exactement ce que `sample`
   * melange, avant la couche de vie au repos et de regard. Extraite pour que `setState`
   * puisse la figer.
   */
  poseComposee(now) {
    const def = STATE_BY_ID.get(this.cur);
    const shape = this.shapeAtTime(now);
    const expr = this.exprAtTime(now);
    const pose = this.posed(def, Math.max(0, now - this.tCur), shape, expr);
    const since = now - this.tCur;
    if (since >= def.morph) return pose;
    const origine = this.origine(now, shape, expr);
    if (!origine) return pose;
    return blendPose(origine, pose, easings.easeOutQuint(clamp(since / def.morph)));
  }
  /**
   * Changement d'etat, date.
   *
   * Le moteur ne garde qu'UNE case d'historique, donc un changement qui arrive pendant un
   * fondu remplacait l'origine du melange par la pose PLEINE de l'etat qu'on quittait, au
   * lieu de l'image partiellement melangee qui etait a l'ecran. Mesure sur
   * `idle -> wide -> idle` a 100 ms : 35,9 px de saut contre 8,0 px de mouvement normal.
   *
   * On fige donc la pose composite courante et on melange depuis elle. Continu par
   * construction, quel que soit le nombre de changements enchaines.
   *
   * Et SEULEMENT dans ce cas. Figer a chaque changement arreterait net l'animation de
   * l'etat qu'on quitte pendant tout le fondu — le « ! » d'`alert` se figerait en pleine
   * course — alors qu'il n'y a rien a corriger hors morph : l'etat quitte y est deja
   * exactement l'image affichee. La lecture d'un montage, dont les blocs durent au moins
   * le plus long fondu (`MIN_BLOCK`), ne fige donc jamais rien et rend au bit ce qu'elle
   * rendait.
   */
  setState(id, now) {
    if (id === this.cur) return;
    const morph = STATE_BY_ID.get(this.cur).morph;
    const enPleinFondu = this.prev !== null && now - this.tCur < morph;
    this.departFige = enPleinFondu ? this.poseComposee(now) : null;
    this.prev = this.cur;
    this.tPrev = this.tCur;
    this.cur = id;
    this.tCur = now;
    if (STATE_BY_ID.get(id)?.blinkIn) this.blinkAt = now;
  }
  sample(now) {
    const R2 = this.scale;
    const def = STATE_BY_ID.get(this.cur);
    const shape = this.shapeAtTime(now);
    const expr = this.exprAtTime(now);
    let pose = this.posed(def, Math.max(0, now - this.tCur), shape, expr);
    let decalage = this.decalageAtTime(now, this.cur);
    const since = now - this.tCur;
    const origine = since < def.morph ? this.origine(now, shape, expr) : null;
    if (origine) {
      const ratio = easings.easeOutQuint(clamp(since / def.morph));
      pose = blendPose(origine, pose, ratio);
      const quitte = this.prev;
      if (quitte) {
        const avant = this.decalageAtTime(now, quitte);
        decalage = {
          x: lerp(avant.x, decalage.x, ratio),
          y: lerp(avant.y, decalage.y, ratio)
        };
      }
    }
    const alive = pose.eyeAlpha > 0.01;
    const look = this.lookAtTime(now);
    const life = liveliness(now, { wander: alive ? look.wander : 0, blink: alive });
    const gaze = {
      // Les deux visees REMPLACENT celles de la pose au lieu de s'y ajouter (voir
      // `Look`), et le tour se retranche en chemin. La derive s'ajoute APRES le
      // melange, sinon la cible l'annulerait en meme temps que la pose — or elle
      // doit survivre a une tete tournee sans pointeur.
      yaw: lerp(pose.gaze.yaw, look.yaw, look.mix) + life.dYaw - look.spin,
      pitch: lerp(pose.gaze.pitch, look.pitch, look.mix) + life.dPitch,
      // le roulis, lui, ne suit rien : la tete du bot est penchee de -13deg dans
      // la video, et la faire rouler avec le curseur casse cette signature
      roll: pose.gaze.roll + life.dRoll
    };
    const forced = clamp((now - this.blinkAt) / 0.2);
    const forcedLid = forced < 1 ? Math.abs(forced * 2 - 1) : 1;
    const lid = Math.min(life.lid, forcedLid);
    const offX = pose.offX + life.driftX;
    const offY = pose.offY + life.driftY;
    const sil = {
      ...pose.sil,
      cx: pose.sil.cx + offX,
      cy: pose.sil.cy + offY,
      sy: pose.sil.sy * life.breath
    };
    const bodyPath = closedPath(toPoints(sil, R2, this.pts));
    const bodyRadius = (x, y) => radiusAtAngle(pose.sil.radii, Math.atan2(y, x) - pose.sil.rot);
    const eyes = [];
    if (pose.eyeAlpha > 0.01) {
      const poses = eyePoses(gaze, R2, pose.split);
      for (let i = 0; i < 2; i++) {
        const e = poses[i];
        if (e.depth <= 0.02) continue;
        const cfg = pose.eyes[i];
        const fit = bodyRadius(e.x, e.y);
        const phi = (cfg.tilt ?? 0) * Math.PI / 180;
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        const ax = e.a * cp + e.c * sp;
        const ay = e.b * cp + e.d * sp;
        const cx2 = -e.a * sp + e.c * cp;
        const cy2 = -e.b * sp + e.d * cp;
        const k = blinkScale(Math.min(lid, cfg.open));
        eyes.push({
          d: capsulePath(cfg.w * R2, cfg.h * R2),
          matrix: `matrix(${r2(ax)},${r2(ay * k)},${r2(cx2)},${r2(cy2 * k)},${r2(e.x * fit + (offX + decalage.x) * R2)},${r2(e.y * fit + (offY + decalage.y) * R2)})`,
          alpha: pose.eyeAlpha * clamp(e.depth / 0.12)
        });
      }
    }
    const dots = pose.dots.filter((p) => p.opacity > 0.01 && p.r > 5e-4).map((p) => ({ ...p, x: (p.x + offX) * R2, y: (p.y + offY) * R2, r: p.r * R2 }));
    const nFit = pose.notif ? bodyRadius(pose.notif.x, pose.notif.y) : 1;
    const nx = pose.notif ? (pose.notif.x * nFit + offX) * R2 : 0;
    const ny = pose.notif ? (pose.notif.y * nFit + offY) * R2 : 0;
    const notif = pose.notif ? { x: nx, y: ny, r: pose.notif.r * R2 } : null;
    const notch = pose.notif ? { x: nx, y: ny, r: pose.notif.notch * R2 } : null;
    return {
      bodyPath,
      bodyAlpha: pose.bodyAlpha,
      eyes,
      dots,
      dotsBehind: pose.dotsBehind,
      // Les etats declarent des arcs en unites de rayon de boule ; le moteur
      // est le seul a connaitre l'echelle du viewBox, donc c'est lui qui trace.
      arcs: pose.arcs.filter((a) => a.opacity > 0.01).map((a) => arcRender(a.seed, a.t, R2, a.id, a.opacity)),
      notif,
      notch
    };
  }
};

// vendor/bloub/src/repere.ts
var RAYON = 100;
var DEMI_VIEWBOX = 158;
export {
  BotEngine,
  DEMI_VIEWBOX,
  NOTIF_BLUE,
  RAYON,
  STATE_BY_ID
};

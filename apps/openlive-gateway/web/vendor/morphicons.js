// node_modules/morphicons/dist/normalize-CYnN3Npw.js
var COMMANDS = "MmLlHhVvCcSsQqTtAaZz";
function parsePath(d) {
  const subs = [];
  const n = d.length;
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cur = null;
  let cmd = "";
  let px = 0;
  let py = 0;
  let prev = "";
  let started = false;
  const err = (msg) => {
    throw new Error(`morphicons: ${msg} at d[${i}]`);
  };
  const isDigit = (c) => c >= 48 && c <= 57;
  const skip = () => {
    while (i < n) {
      const c = d.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) i++;
      else break;
    }
  };
  const num = () => {
    skip();
    const start = i;
    if (i < n && (d[i] === "+" || d[i] === "-")) i++;
    let dig = false;
    while (i < n && isDigit(d.charCodeAt(i))) {
      i++;
      dig = true;
    }
    if (i < n && d[i] === ".") {
      i++;
      while (i < n && isDigit(d.charCodeAt(i))) {
        i++;
        dig = true;
      }
    }
    if (!dig) err("expected number");
    if (i < n && (d[i] === "e" || d[i] === "E")) {
      const save = i;
      i++;
      if (i < n && (d[i] === "+" || d[i] === "-")) i++;
      let ed = false;
      while (i < n && isDigit(d.charCodeAt(i))) {
        i++;
        ed = true;
      }
      if (!ed) i = save;
    }
    return Number(d.slice(start, i));
  };
  const flag = () => {
    skip();
    const c = d[i];
    if (c === "0" || c === "1") {
      i++;
      return c === "1" ? 1 : 0;
    }
    return err("expected arc flag (0|1)");
  };
  const open = () => {
    if (!started) err("path must start with M/m");
    if (!cur) {
      cur = {
        x0: cx,
        y0: cy,
        segs: [],
        closed: false
      };
      subs.push(cur);
    }
    return cur;
  };
  let rel = false;
  const nx = () => num() + (rel ? cx : 0);
  const ny = () => num() + (rel ? cy : 0);
  while (true) {
    skip();
    if (i >= n) break;
    const ch = d[i];
    if (COMMANDS.includes(ch)) {
      cmd = ch;
      i++;
    } else if (cmd === "") err("path must start with M/m");
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    else if (cmd === "Z" || cmd === "z") err("stray data after Z");
    rel = cmd >= "a";
    switch (rel ? cmd.toUpperCase() : cmd) {
      case "M": {
        started = true;
        const x = nx();
        const y = ny();
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        cur = {
          x0: x,
          y0: y,
          segs: [],
          closed: false
        };
        subs.push(cur);
        prev = "";
        break;
      }
      case "L": {
        const x = nx();
        const y = ny();
        open().segs.push([
          "L",
          x,
          y
        ]);
        cx = x;
        cy = y;
        prev = "";
        break;
      }
      case "H": {
        const x = nx();
        open().segs.push([
          "L",
          x,
          cy
        ]);
        cx = x;
        prev = "";
        break;
      }
      case "V": {
        const y = ny();
        open().segs.push([
          "L",
          cx,
          y
        ]);
        cy = y;
        prev = "";
        break;
      }
      case "C":
      case "S": {
        let x1;
        let y1;
        if (cmd === "C" || cmd === "c") {
          x1 = nx();
          y1 = ny();
        } else {
          x1 = prev === "C" ? 2 * cx - px : cx;
          y1 = prev === "C" ? 2 * cy - py : cy;
        }
        const x2 = nx();
        const y2 = ny();
        const x = nx();
        const y = ny();
        open().segs.push([
          "C",
          x1,
          y1,
          x2,
          y2,
          x,
          y
        ]);
        px = x2;
        py = y2;
        cx = x;
        cy = y;
        prev = "C";
        break;
      }
      case "Q":
      case "T": {
        let x1;
        let y1;
        if (cmd === "Q" || cmd === "q") {
          x1 = nx();
          y1 = ny();
        } else {
          x1 = prev === "Q" ? 2 * cx - px : cx;
          y1 = prev === "Q" ? 2 * cy - py : cy;
        }
        const x = nx();
        const y = ny();
        open().segs.push([
          "Q",
          x1,
          y1,
          x,
          y
        ]);
        px = x1;
        py = y1;
        cx = x;
        cy = y;
        prev = "Q";
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const x = nx();
        const y = ny();
        open().segs.push([
          "A",
          rx,
          ry,
          rot,
          large,
          sweep,
          x,
          y
        ]);
        cx = x;
        cy = y;
        prev = "";
        break;
      }
      case "Z":
        if (cur) {
          cur.closed = true;
          cur = null;
        }
        cx = sx;
        cy = sy;
        prev = "";
        break;
      default:
        err(`unsupported command "${cmd}"`);
    }
  }
  return subs.filter((s) => s.segs.length > 0);
}
function fmt(v) {
  return String(Math.round(v * 100) / 100);
}
function serialize(subs, closed) {
  let d = "";
  for (let k = 0; k < subs.length; k++) {
    const o = subs[k];
    const n = o.length / 2;
    d += `M${fmt(o[0])} ${fmt(o[1])}`;
    for (let i = 1; i < n; i++) d += `L${fmt(o[2 * i])} ${fmt(o[2 * i + 1])}`;
    if (closed?.[k]) d += "Z";
  }
  return d;
}
function fmtCanon(v) {
  return String(Math.round(v * 1e4) / 1e4);
}
function cubicsToPathD(paths) {
  let d = "";
  for (const { pts, closed } of paths) {
    d += `M${fmtCanon(pts[0])} ${fmtCanon(pts[1])}`;
    for (let i = 2; i < pts.length; i += 6) d += `C${fmtCanon(pts[i])} ${fmtCanon(pts[i + 1])} ${fmtCanon(pts[i + 2])} ${fmtCanon(pts[i + 3])} ${fmtCanon(pts[i + 4])} ${fmtCanon(pts[i + 5])}`;
    if (closed) d += "Z";
  }
  return d;
}
var KAPPA = 4 / 3 * Math.tan(Math.PI / 8);
var TAU = 2 * Math.PI;
function builder(x0, y0) {
  const pts = [x0, y0];
  let cx = x0;
  let cy = y0;
  const cubic = (x1, y1, x2, y2, x, y) => {
    pts.push(x1, y1, x2, y2, x, y);
    cx = x;
    cy = y;
  };
  const line = (x, y) => {
    if (Math.abs(x - cx) < 1e-12 && Math.abs(y - cy) < 1e-12) return;
    cubic(cx + (x - cx) / 3, cy + (y - cy) / 3, cx + 2 * (x - cx) / 3, cy + 2 * (y - cy) / 3, x, y);
  };
  const quad = (x1, y1, x, y) => {
    cubic(cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy), x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y), x, y);
  };
  const arc = (rx0, ry0, rotDeg, large, sweep, x, y) => {
    const x1 = cx;
    const y1 = cy;
    if (Math.abs(x - x1) < 1e-12 && Math.abs(y - y1) < 1e-12) return;
    let rx = Math.abs(rx0);
    let ry = Math.abs(ry0);
    if (rx < 1e-12 || ry < 1e-12) {
      line(x, y);
      return;
    }
    const phi = rotDeg * Math.PI / 180;
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);
    const hx = (x1 - x) / 2;
    const hy = (y1 - y) / 2;
    const x1p = cosP * hx + sinP * hy;
    const y1p = -sinP * hx + cosP * hy;
    const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if (lam > 1) {
      const s = Math.sqrt(lam);
      rx *= s;
      ry *= s;
    }
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    const xp2 = x1p * x1p;
    const yp2 = y1p * y1p;
    let rad = (rx2 * ry2 - rx2 * yp2 - ry2 * xp2) / (rx2 * yp2 + ry2 * xp2);
    if (rad < 0) rad = 0;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(rad);
    const cxp = co * rx * y1p / ry;
    const cyp = -co * ry * x1p / rx;
    const ccx = cosP * cxp - sinP * cyp + (x1 + x) / 2;
    const ccy = sinP * cxp + cosP * cyp + (y1 + y) / 2;
    const th1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
    let dth = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - th1;
    if (sweep === 0 && dth > 0) dth -= TAU;
    else if (sweep === 1 && dth < 0) dth += TAU;
    const slices = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
    const delta = dth / slices;
    const alpha = 4 / 3 * Math.tan(delta / 4);
    const ex = (t) => ccx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP;
    const ey = (t) => ccy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP;
    const dx = (t) => -rx * Math.sin(t) * cosP - ry * Math.cos(t) * sinP;
    const dy = (t) => -rx * Math.sin(t) * sinP + ry * Math.cos(t) * cosP;
    let t0 = th1;
    let p0x = x1;
    let p0y = y1;
    for (let s = 1; s <= slices; s++) {
      const t1 = th1 + delta * s;
      const p1x = s === slices ? x : ex(t1);
      const p1y = s === slices ? y : ey(t1);
      cubic(p0x + alpha * dx(t0), p0y + alpha * dy(t0), p1x - alpha * dx(t1), p1y - alpha * dy(t1), p1x, p1y);
      t0 = t1;
      p0x = p1x;
      p0y = p1y;
    }
  };
  const finish = (closed) => {
    if (closed) line(pts[0], pts[1]);
    if (pts.length < 8) return null;
    return {
      pts: Float64Array.from(pts),
      closed
    };
  };
  return [
    cubic,
    line,
    quad,
    arc,
    finish
  ];
}
function lowerSubpath(raw) {
  const [cubic, line, quad, arc, finish] = builder(raw.x0, raw.y0);
  for (const s of raw.segs) switch (s[0]) {
    case "L":
      line(s[1], s[2]);
      break;
    case "C":
      cubic(s[1], s[2], s[3], s[4], s[5], s[6]);
      break;
    case "Q":
      quad(s[1], s[2], s[3], s[4]);
      break;
    case "A":
      arc(s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
  }
  return finish(raw.closed);
}
function attrNum(attrs, key, fallback = 0) {
  const v = attrs[key];
  if (v === void 0) return fallback;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : fallback;
}
function parsePoints(v) {
  const s = String(v ?? "").trim();
  if (!s) return [];
  const nums = s.split(/[\s,]+/).map(Number);
  if (nums.some((x) => !Number.isFinite(x))) throw new Error(`morphicons: invalid points: "${s}"`);
  return nums;
}
function polyPath(nums, closed) {
  if (nums.length < 4) return null;
  const [, line, , , finish] = builder(nums[0], nums[1]);
  for (let i = 2; i + 1 < nums.length; i += 2) line(nums[i], nums[i + 1]);
  return finish(closed);
}
function ellipsePath(cx, cy, rx, ry) {
  if (rx < 1e-12 || ry < 1e-12) return null;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  const e = cx + rx;
  const w = cx - rx;
  const s = cy + ry;
  const n = cy - ry;
  const [cubic, , , , finish] = builder(e, cy);
  cubic(e, cy + ky, cx + kx, s, cx, s);
  cubic(cx - kx, s, w, cy + ky, w, cy);
  cubic(w, cy - ky, cx - kx, n, cx, n);
  cubic(cx + kx, n, e, cy - ky, e, cy);
  return finish(true);
}
function rectPath(attrs) {
  const x = attrNum(attrs, "x");
  const y = attrNum(attrs, "y");
  const w = attrNum(attrs, "width");
  const h = attrNum(attrs, "height");
  if (w < 1e-12 || h < 1e-12) return null;
  let rx = attrNum(attrs, "rx", NaN);
  let ry = attrNum(attrs, "ry", NaN);
  if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
  if (Number.isNaN(ry)) ry = rx;
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (rx < 1e-12 || ry < 1e-12) return polyPath([
    x,
    y,
    x + w,
    y,
    x + w,
    y + h,
    x,
    y + h
  ], true);
  const xa = x + rx;
  const xb = x + w - rx;
  const xr = x + w;
  const ya = y + ry;
  const yb = y + h - ry;
  const yd = y + h;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  const [cubic, line, , , finish] = builder(xa, y);
  line(xb, y);
  cubic(xb + kx, y, xr, ya - ky, xr, ya);
  line(xr, yb);
  cubic(xr, yb + ky, xb + kx, yd, xb, yd);
  line(xa, yd);
  cubic(xa - kx, yd, x, yb + ky, x, yb);
  line(x, ya);
  cubic(x, ya - ky, xa - kx, y, xa, y);
  return finish(true);
}
function iconToCubics(input) {
  const out = [];
  const push = (p) => {
    if (p) out.push(p);
  };
  if (typeof input === "string") {
    for (const s of parsePath(input)) push(lowerSubpath(s));
    return out;
  }
  for (const [tag, attrs] of input) switch (tag) {
    case "path":
      for (const s of parsePath(String(attrs.d ?? ""))) push(lowerSubpath(s));
      break;
    case "line": {
      const [, line, , , finish] = builder(attrNum(attrs, "x1"), attrNum(attrs, "y1"));
      line(attrNum(attrs, "x2"), attrNum(attrs, "y2"));
      push(finish(false));
      break;
    }
    case "circle": {
      const r = attrNum(attrs, "r");
      push(ellipsePath(attrNum(attrs, "cx"), attrNum(attrs, "cy"), r, r));
      break;
    }
    case "ellipse":
      push(ellipsePath(attrNum(attrs, "cx"), attrNum(attrs, "cy"), attrNum(attrs, "rx"), attrNum(attrs, "ry")));
      break;
    case "rect":
      push(rectPath(attrs));
      break;
    case "polyline":
      push(polyPath(parsePoints(attrs.points), false));
      break;
    case "polygon":
      push(polyPath(parsePoints(attrs.points), true));
      break;
    default:
      throw new Error(`morphicons: unsupported tag <${tag}>`);
  }
  return out;
}

// node_modules/morphicons/dist/spring-CFHloqPP.js
function allocOutputs(plan) {
  return plan.items.map(() => new Float64Array(2 * plan.n));
}
function interpPolar(plan, t, out) {
  for (let k = 0; k < plan.items.length; k++) {
    const it = plan.items[k];
    const o = out[k];
    const n = plan.n;
    const s = Math.exp(it.lnSigma * t);
    const ang = it.theta * t;
    const cos = Math.cos(ang) * s;
    const sin = Math.sin(ang) * s;
    let cx;
    let cy;
    if (it.block) {
      const [ox, oy] = it.block.off;
      const [dx, dy] = it.block.drift;
      cx = it.ca[0] + dx * t + (ox * cos - oy * sin - ox);
      cy = it.ca[1] + dy * t + (ox * sin + oy * cos - oy);
    } else {
      cx = it.ca[0] + (it.cb[0] - it.ca[0]) * t;
      cy = it.ca[1] + (it.cb[1] - it.ca[1]) * t;
    }
    for (let i = 0; i < n; i++) {
      const px = it.aC[2 * i] + (it.bT[2 * i] - it.aC[2 * i]) * t;
      const py = it.aC[2 * i + 1] + (it.bT[2 * i + 1] - it.aC[2 * i + 1]) * t;
      o[2 * i] = cx + px * cos - py * sin;
      o[2 * i + 1] = cy + px * sin + py * cos;
    }
  }
}
var LEN_WEIGHT = 0.35;
var LAMBDA = 0.05;
var GLOBAL_EPS = 5e-3;
var PERM_MAX = 8;
var SURJ_MAX = 1e5;
function centroid(p) {
  const n = p.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += p[2 * i];
    cy += p[2 * i + 1];
  }
  return [cx / n, cy / n];
}
function polyLen(p) {
  const n = p.length / 2;
  let L = 0;
  for (let i = 1; i < n; i++) L += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
  return L;
}
function reversePts(p) {
  const n = p.length / 2;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    out[2 * i] = p[2 * (n - 1 - i)];
    out[2 * i + 1] = p[2 * (n - 1 - i) + 1];
  }
  return out;
}
function rotatePts(p, off) {
  const n = p.length / 2;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const j = (i + off) % n;
    out[2 * i] = p[2 * j];
    out[2 * i + 1] = p[2 * j + 1];
  }
  return out;
}
function procrustes(a, b, ca, cb) {
  const n = a.length / 2;
  let sxx = 0;
  let sxy = 0;
  let syx = 0;
  let syy = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const ax = a[2 * i] - ca[0];
    const ay = a[2 * i + 1] - ca[1];
    const bx = b[2 * i] - cb[0];
    const by = b[2 * i + 1] - cb[1];
    sxx += ax * bx;
    syy += ay * by;
    sxy += ax * by;
    syx += ay * bx;
    na += ax * ax + ay * ay;
    nb += bx * bx + by * by;
  }
  const theta = Math.atan2(sxy - syx, sxx + syy);
  const num = Math.cos(theta) * (sxx + syy) + Math.sin(theta) * (sxy - syx);
  let sigma = na > 1e-12 ? num / na : 1;
  if (!(sigma > 1e-6)) sigma = 1e-6;
  const res2 = Math.max(0, sigma * sigma * na - 2 * sigma * num + nb);
  const res = nb > 1e-12 ? Math.sqrt(res2 / nb) : 0;
  return {
    theta,
    sigma,
    res
  };
}
function alignPair(aPts, bPts, aClosed = false, bClosed = false) {
  const ca = centroid(aPts);
  const cb = centroid(bPts);
  const varyA = aClosed && !bClosed;
  const base = varyA ? aPts : bPts;
  const offs = aClosed || bClosed ? base.length / 2 : 1;
  let bestScore = Number.POSITIVE_INFINITY;
  let best = base;
  let sim = {
    theta: 0,
    sigma: 1,
    res: 0
  };
  for (let dir = 0; dir < 2; dir++) {
    const walk = dir ? reversePts(base) : base;
    for (let off = 0; off < offs; off++) {
      const cand = off ? rotatePts(walk, off) : walk;
      const s = varyA ? procrustes(cand, bPts, ca, cb) : procrustes(aPts, cand, ca, cb);
      const score = s.res + LAMBDA * Math.abs(s.theta) / Math.PI;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
        sim = s;
      }
    }
  }
  return varyA ? {
    ca,
    cb,
    a: best,
    b: bPts,
    ...sim
  } : {
    ca,
    cb,
    a: aPts,
    b: best,
    ...sim
  };
}
function costMatrix(A, B) {
  const cbs = B.map(centroid);
  const lbs = B.map(polyLen);
  return A.map((a) => {
    const ca = centroid(a);
    const la = polyLen(a);
    return cbs.map((cb, j) => Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) + LEN_WEIGHT * Math.abs(la - lbs[j]));
  });
}
function bestPermutation(C) {
  const n = C.length;
  if (n > PERM_MAX) {
    const pairs = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) pairs.push([
      C[i][j],
      i,
      j
    ]);
    pairs.sort((x, y) => x[0] - y[0]);
    const out = new Array(n).fill(-1);
    const used = new Array(n).fill(false);
    for (const [, i, j] of pairs) if (out[i] < 0 && !used[j]) {
      out[i] = j;
      used[j] = true;
    }
    return out;
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  let best = idx.slice();
  let bc = Number.POSITIVE_INFINITY;
  const perm = (arr, k, acc) => {
    if (acc >= bc) return;
    if (k === n) {
      bc = acc;
      best = arr.slice();
      return;
    }
    for (let i = k; i < n; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1, acc + C[k][arr[k]]);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm(idx, 0, 0);
  return best;
}
function bestSurjection(C) {
  const B = C.length;
  const S = C[0].length;
  if (S ** B > SURJ_MAX) {
    const f2 = C.map((row) => {
      let m = 0;
      for (let j = 1; j < row.length; j++) if (row[j] < row[m]) m = j;
      return m;
    });
    const mult2 = new Array(S).fill(0);
    for (const s of f2) mult2[s]++;
    for (let s = 0; s < S; s++) {
      if (mult2[s] > 0) continue;
      let bi = -1;
      let bc2 = Number.POSITIVE_INFINITY;
      for (let i = 0; i < B; i++) {
        if (mult2[f2[i]] < 2) continue;
        const extra = C[i][s] - C[i][f2[i]];
        if (extra < bc2) {
          bc2 = extra;
          bi = i;
        }
      }
      mult2[f2[bi]]--;
      f2[bi] = s;
      mult2[s]++;
    }
    return f2;
  }
  let best = null;
  let bc = Number.POSITIVE_INFINITY;
  const f = new Array(B);
  const mult = new Array(S).fill(0);
  const rec = (i, acc, covered) => {
    if (acc >= bc || S - covered > B - i) return;
    if (i === B) {
      bc = acc;
      best = f.slice();
      return;
    }
    for (let s = 0; s < S; s++) {
      f[i] = s;
      mult[s]++;
      rec(i + 1, acc + C[i][s], covered + (mult[s] === 1 ? 1 : 0));
      mult[s]--;
    }
  };
  rec(0, 0, 0);
  if (!best) throw new Error("morphicons: no valid surjection (B < S)");
  return best;
}
function applyGlobal(items, n) {
  const T = items.length * n;
  const ga = new Float64Array(2 * T);
  const gb = new Float64Array(2 * T);
  items.forEach((it, k) => {
    ga.set(it.a, 2 * n * k);
    gb.set(it.bO, 2 * n * k);
  });
  const gca = centroid(ga);
  const g = procrustes(ga, gb, gca, centroid(gb));
  if (g.res >= GLOBAL_EPS) return;
  const cos = Math.cos(-g.theta);
  const sin = Math.sin(-g.theta);
  const rc = Math.cos(g.theta);
  const rs = Math.sin(g.theta);
  for (const it of items) {
    let e2 = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
      const bx = it.bO[2 * i] - it.cb[0];
      const by = it.bO[2 * i + 1] - it.cb[1];
      it.bT[2 * i] = (bx * cos - by * sin) / g.sigma;
      it.bT[2 * i + 1] = (bx * sin + by * cos) / g.sigma;
      const ex = g.sigma * (rc * it.aC[2 * i] - rs * it.aC[2 * i + 1]) - bx;
      const ey = g.sigma * (rs * it.aC[2 * i] + rc * it.aC[2 * i + 1]) - by;
      e2 += ex * ex + ey * ey;
      nb += bx * bx + by * by;
    }
    it.theta = g.theta;
    it.lnSigma = Math.log(g.sigma);
    it.res = nb > 1e-12 ? Math.sqrt(e2 / nb) : 0;
    const s1 = Math.exp(it.lnSigma);
    const c1 = Math.cos(it.theta) * s1;
    const n1 = Math.sin(it.theta) * s1;
    const ox = it.ca[0] - gca[0];
    const oy = it.ca[1] - gca[1];
    const rx = ox * c1 - oy * n1 - ox;
    const ry = ox * n1 + oy * c1 - oy;
    it.block = {
      off: [ox, oy],
      drift: [it.cb[0] - it.ca[0] - rx, it.cb[1] - it.ca[1] - ry]
    };
  }
}
function buildPlan(srcSubs, dstSubs) {
  const p = srcSubs.length;
  const q = dstSubs.length;
  if (p === 0 || q === 0) throw new Error("morphicons: icon has no subpaths");
  const A = srcSubs.map((s) => s.pts);
  const B = dstSubs.map((s) => s.pts);
  const pairs = [];
  if (p === q) {
    const perm = bestPermutation(costMatrix(A, B));
    for (let i = 0; i < p; i++) pairs.push([i, perm[i]]);
  } else if (p < q) {
    const f = bestSurjection(costMatrix(B, A));
    for (let j = 0; j < q; j++) pairs.push([f[j], j]);
  } else {
    const f = bestSurjection(costMatrix(A, B));
    for (let i = 0; i < p; i++) pairs.push([i, f[i]]);
  }
  const n = A[0].length / 2;
  const items = pairs.map(([si, di]) => {
    const al = alignPair(A[si], B[di], srcSubs[si].closed, dstSubs[di].closed);
    const a = al.a;
    const aC = new Float64Array(2 * n);
    const bT = new Float64Array(2 * n);
    const bO = new Float64Array(2 * n);
    const cos = Math.cos(-al.theta);
    const sin = Math.sin(-al.theta);
    for (let i = 0; i < n; i++) {
      aC[2 * i] = a[2 * i] - al.ca[0];
      aC[2 * i + 1] = a[2 * i + 1] - al.ca[1];
      const bx = al.b[2 * i] - al.cb[0];
      const by = al.b[2 * i + 1] - al.cb[1];
      bT[2 * i] = (bx * cos - by * sin) / al.sigma;
      bT[2 * i + 1] = (bx * sin + by * cos) / al.sigma;
      bO[2 * i] = al.b[2 * i];
      bO[2 * i + 1] = al.b[2 * i + 1];
    }
    return {
      a,
      aC,
      bT,
      bO,
      ca: al.ca,
      cb: al.cb,
      theta: al.theta,
      lnSigma: Math.log(al.sigma),
      res: al.res,
      closed: srcSubs[si].closed && dstSubs[di].closed,
      block: null
    };
  });
  if (items.length > 1) applyGlobal(items, n);
  return {
    items,
    n
  };
}
var CORNER_THRESHOLD = Math.PI / 8;
var GX = [
  0.18343464249564978,
  0.525532409916329,
  0.7966664774136267,
  0.9602898564975363
];
var GW = [
  0.362683783378362,
  0.31370664587788727,
  0.22238103445337448,
  0.10122853629037626
];
function speed(p, k, t) {
  const i = 6 * k;
  const u = 1 - t;
  const c0 = 3 * u * u;
  const c1 = 6 * u * t;
  const c2 = 3 * t * t;
  const dx = c0 * (p[i + 2] - p[i]) + c1 * (p[i + 4] - p[i + 2]) + c2 * (p[i + 6] - p[i + 4]);
  const dy = c0 * (p[i + 3] - p[i + 1]) + c1 * (p[i + 5] - p[i + 3]) + c2 * (p[i + 7] - p[i + 5]);
  return Math.hypot(dx, dy);
}
function segLen(p, k, t1 = 1) {
  const half = t1 / 2;
  let s = 0;
  for (let j = 0; j < 4; j++) s += GW[j] * (speed(p, k, half + half * GX[j]) + speed(p, k, half - half * GX[j]));
  return s * half;
}
function point(p, k, t, out, o) {
  const i = 6 * k;
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  out[o] = b0 * p[i] + b1 * p[i + 2] + b2 * p[i + 4] + b3 * p[i + 6];
  out[o + 1] = b0 * p[i + 1] + b1 * p[i + 3] + b2 * p[i + 5] + b3 * p[i + 7];
}
function tangent(p, k, atEnd) {
  const i = 6 * k;
  const b = atEnd ? i + 6 : i;
  const s = atEnd ? -1 : 1;
  for (const j of atEnd ? [
    4,
    2,
    0
  ] : [
    2,
    4,
    6
  ]) {
    const dx = s * (p[i + j] - p[b]);
    const dy = s * (p[i + j + 1] - p[b + 1]);
    if (dx * dx + dy * dy > 1e-18) return [dx, dy];
  }
  return null;
}
function detectCorners(path, threshold = CORNER_THRESHOLD) {
  const p = path.pts;
  const m = (p.length / 2 - 1) / 3;
  const active = [];
  for (let k = 0; k < m; k++) if (segLen(p, k) > 1e-9) active.push(k);
  if (active.length === 0) return [];
  const corners = /* @__PURE__ */ new Set();
  const test = (a, b) => {
    const u = tangent(p, a, true);
    const v = tangent(p, b, false);
    if (!u || !v) return;
    if (Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) > threshold) corners.add(b);
  };
  for (let j = 0; j + 1 < active.length; j++) test(active[j], active[j + 1]);
  if (path.closed && active.length > 1) test(active[active.length - 1], active[0]);
  return [...corners].sort((a, b) => a - b);
}
function invert(p, k, s, ls) {
  if (s <= 0) return 0;
  if (s >= ls) return 1;
  let lo = 0;
  let hi = 1;
  let t = s / ls;
  for (let it = 0; it < 12; it++) {
    const f = segLen(p, k, t) - s;
    if (Math.abs(f) < 1e-10 * ls + 1e-14) break;
    if (f > 0) hi = t;
    else lo = t;
    const sp = speed(p, k, t);
    let nt = sp > 1e-12 ? t - f / sp : (lo + hi) / 2;
    if (!(nt > lo && nt < hi)) nt = (lo + hi) / 2;
    t = nt;
  }
  return t;
}
function resamplePath(path, N = 64, cornerThreshold = CORNER_THRESHOLD) {
  const p = path.pts;
  const m = (p.length / 2 - 1) / 3;
  const out = new Float64Array(2 * N);
  const fill = () => {
    for (let i = 0; i < N; i++) {
      out[2 * i] = p[0];
      out[2 * i + 1] = p[1];
    }
    return out;
  };
  if (m < 1) return fill();
  const lens = new Array(m);
  let L = 0;
  for (let k = 0; k < m; k++) {
    lens[k] = segLen(p, k);
    L += lens[k];
  }
  if (L < 1e-12) return fill();
  const cs = detectCorners(path, cornerThreshold);
  const anchors = path.closed ? cs.length > 0 ? cs : [0] : [.../* @__PURE__ */ new Set([
    0,
    ...cs,
    m
  ])].sort((a, b) => a - b);
  const runs = [];
  if (path.closed) for (let j = 0; j < anchors.length; j++) {
    const a = anchors[j];
    const b = j + 1 < anchors.length ? anchors[j + 1] : anchors[0] + m;
    runs.push([a, b]);
  }
  else for (let j = 0; j + 1 < anchors.length; j++) runs.push([anchors[j], anchors[j + 1]]);
  const rl = runs.map(([a, b]) => {
    let s = 0;
    for (let k = a; k < b; k++) s += lens[k % m];
    return s;
  });
  const intervals = path.closed ? N : N - 1;
  if (runs.length > intervals) throw new Error(`morphicons: N=${N} too small (${runs.length} runs)`);
  const total = rl.reduce((a, b) => a + b, 0) || 1;
  const ideal = rl.map((l) => intervals * l / total);
  const counts = ideal.map((q) => Math.max(1, Math.floor(q)));
  let R = intervals - counts.reduce((a, b) => a + b, 0);
  if (R > 0) {
    const order = ideal.map((q, idx) => [Math.round((q - Math.floor(q)) * 1e9), idx]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let j = 0; j < R; j++) counts[order[j % counts.length][1]]++;
  }
  while (R < 0) {
    let bi = 0;
    for (let idx = 1; idx < counts.length; idx++) if (counts[idx] > counts[bi]) bi = idx;
    if (counts[bi] <= 1) break;
    counts[bi]--;
    R++;
  }
  let w = 0;
  for (let r = 0; r < runs.length; r++) {
    const [k0, k1] = runs[r];
    const cnt = counts[r];
    const Lr = rl[r];
    const vi = 6 * (k0 % m);
    out[2 * w] = p[vi];
    out[2 * w + 1] = p[vi + 1];
    w++;
    let seg = k0;
    let acc = 0;
    for (let j = 1; j < cnt; j++) {
      const target = Lr * j / cnt;
      while (seg < k1 - 1 && acc + lens[seg % m] < target) {
        acc += lens[seg % m];
        seg++;
      }
      const k = seg % m;
      const ls = lens[k];
      point(p, k, ls > 1e-12 ? invert(p, k, target - acc, ls) : 0, out, 2 * w);
      w++;
    }
  }
  if (!path.closed) {
    const vi = 6 * m;
    out[2 * w] = p[vi];
    out[2 * w + 1] = p[vi + 1];
  }
  return out;
}
function resampleIcon(input, N = 64) {
  return iconToCubics(input).map((path) => ({
    pts: resamplePath(path, N),
    closed: path.closed
  }));
}
var Spring = class {
  x = 1;
  v = 0;
  k = 250;
  c = 24;
  config(k, c) {
    this.k = k;
    this.c = c;
  }
  /** Starts (or restarts mid-flight) preserving velocity. */
  start() {
    this.x = 0;
    if (this.v > 14) this.v = 14;
    if (this.v < -14) this.v = -14;
  }
  /** Advances dt seconds. Returns true on settle (|1−x| < 0.001 ∧ |v| < 0.02). */
  step(dt) {
    const steps = Math.max(1, Math.min(16, Math.ceil(dt / (1 / 240))));
    const s = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = this.k * (1 - this.x) - this.c * this.v;
      this.v += a * s;
      this.x += this.v * s;
    }
    return Math.abs(1 - this.x) < 1e-3 && Math.abs(this.v) < 0.02;
  }
};
var SPRING_PRESETS = {
  /** ζ = 1.00 — critically damped, no overshoot. */
  smooth: {
    k: 170,
    c: 26
  },
  /** ζ = 0.73 — fast, subtle overshoot. */
  snappy: {
    k: 420,
    c: 30
  },
  /** ζ = 0.40 — playful. */
  bouncy: {
    k: 300,
    c: 14
  }
};

// node_modules/morphicons/dist/dom.js
var tickers = /* @__PURE__ */ new Set();
var rafId = 0;
var last = -1;
function loop(ts) {
  const dt = last < 0 ? 0 : Math.min(Math.max((ts - last) / 1e3, 0), 0.1);
  last = ts;
  for (const tick of [...tickers]) tick(dt);
  if (tickers.size > 0) rafId = requestAnimationFrame(loop);
  else {
    rafId = 0;
    last = -1;
  }
}
function addTicker(tick) {
  tickers.add(tick);
  if (rafId === 0) {
    last = -1;
    rafId = requestAnimationFrame(loop);
  }
}
function removeTicker(tick) {
  tickers.delete(tick);
  if (tickers.size === 0 && rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    last = -1;
  }
}
var samples = /* @__PURE__ */ new WeakMap();
var canon = /* @__PURE__ */ new WeakMap();
var plans = /* @__PURE__ */ new WeakMap();
function sampledOf(icon) {
  if (typeof icon === "string") return resampleIcon(icon);
  let s = samples.get(icon);
  if (!s) {
    s = resampleIcon(icon);
    samples.set(icon, s);
  }
  return s;
}
function canonicalD(icon) {
  if (typeof icon === "string") return icon;
  let d = canon.get(icon);
  if (!d) {
    d = cubicsToPathD(iconToCubics(icon));
    canon.set(icon, d);
  }
  return d;
}
function planBetween(src, dst) {
  if (typeof src === "string" || typeof dst === "string") return buildPlan(sampledOf(src), sampledOf(dst));
  let inner = plans.get(src);
  if (!inner) {
    inner = /* @__PURE__ */ new WeakMap();
    plans.set(src, inner);
  }
  let p = inner.get(dst);
  if (!p) {
    p = buildPlan(sampledOf(src), sampledOf(dst));
    inner.set(dst, p);
  }
  return p;
}
function resolveSpring(s) {
  if (typeof s === "string") return SPRING_PRESETS[s];
  const d = SPRING_PRESETS.snappy;
  return {
    k: s?.stiffness ?? d.k,
    c: s?.damping ?? d.c
  };
}
function createMorph(el, icon, options) {
  const spring = new Spring();
  let reducedMotion = options?.reducedMotion ?? "never";
  let target = icon;
  let rest = true;
  let plan = null;
  let out = null;
  let closed = null;
  let t = 1;
  let flying = false;
  let dead = false;
  el.setAttribute("d", canonicalD(icon));
  const render = (tt) => {
    const p = plan;
    const o = out;
    const cl = closed;
    if (!p || !o || !cl) return;
    t = tt;
    interpPolar(p, tt, o);
    el.setAttribute("d", serialize(o, cl));
  };
  const stop = () => {
    if (!flying) return;
    flying = false;
    removeTicker(tick);
  };
  const tick = (dt) => {
    const settled = spring.step(dt);
    render(spring.x);
    if (settled) {
      stop();
      settle();
    }
  };
  const settle = () => {
    rest = true;
    plan = null;
    out = null;
    closed = null;
    t = 1;
    spring.x = 1;
    spring.v = 0;
    el.setAttribute("d", canonicalD(target));
  };
  const snapshot = () => {
    const p = plan;
    const o = out;
    if (rest || !p || !o) return sampledOf(target);
    return o.map((buf, k) => ({
      pts: Float64Array.from(buf),
      closed: p.items[k].closed
    }));
  };
  const retarget = (icon2) => {
    plan = rest ? planBetween(target, icon2) : buildPlan(snapshot(), sampledOf(icon2));
    out = allocOutputs(plan);
    closed = plan.items.map((it) => it.closed);
    target = icon2;
    rest = false;
  };
  const setNow = (icon2) => {
    stop();
    target = icon2;
    settle();
  };
  const motionOff = () => {
    if (reducedMotion === "always") return true;
    if (reducedMotion !== "user") return false;
    if (typeof matchMedia === "undefined") return false;
    return matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  };
  const seek = (icon2, tt) => {
    if (dead) return;
    const reuse = !rest && plan !== null && icon2 === target;
    stop();
    spring.v = 0;
    if (!reuse) retarget(icon2);
    render(tt);
  };
  return {
    morphTo(icon2, sp) {
      if (dead) return;
      if (icon2 === target && (rest || flying)) return;
      if (motionOff()) {
        setNow(icon2);
        return;
      }
      const { k, c } = resolveSpring(sp);
      spring.config(k, c);
      retarget(icon2);
      spring.start();
      if (!flying) {
        flying = true;
        addTicker(tick);
      }
    },
    set(icon2) {
      if (dead) return;
      setNow(icon2);
    },
    seek,
    get progress() {
      return rest ? 1 : t;
    },
    set progress(v) {
      if (!dead) seek(target, v);
    },
    get reducedMotion() {
      return reducedMotion;
    },
    set reducedMotion(v) {
      reducedMotion = v;
    },
    destroy() {
      stop();
      dead = true;
      plan = null;
      out = null;
      closed = null;
    }
  };
}

// node_modules/lucide/dist/esm/icons/mic-off.mjs
/**
 * @license lucide v1.34.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
var MicOff = [
  ["path", { d: "M12 19v3" }],
  ["path", { d: "M15 9.34V5a3 3 0 0 0-5.68-1.33" }],
  ["path", { d: "M16.95 16.95A7 7 0 0 1 5 12v-2" }],
  ["path", { d: "M18.89 13.23A7 7 0 0 0 19 12v-2" }],
  ["path", { d: "m2 2 20 20" }],
  ["path", { d: "M9 9v3a3 3 0 0 0 5.12 2.12" }]
];

// node_modules/lucide/dist/esm/icons/mic.mjs
/**
 * @license lucide v1.34.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
var Mic = [
  ["path", { d: "M12 19v3" }],
  ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }],
  ["rect", { x: "9", y: "2", width: "6", height: "13", rx: "3" }]
];

// node_modules/lucide/dist/esm/icons/phone.mjs
/**
 * @license lucide v1.34.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
var Phone = [
  [
    "path",
    {
      d: "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"
    }
  ]
];

// node_modules/lucide/dist/esm/icons/settings.mjs
/**
 * @license lucide v1.34.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
var Settings = [
  [
    "path",
    {
      d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"
    }
  ],
  ["circle", { cx: "12", cy: "12", r: "3" }]
];

// node_modules/lucide/dist/esm/icons/x.mjs
/**
 * @license lucide v1.34.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
var X = [
  ["path", { d: "M18 6 6 18" }],
  ["path", { d: "m6 6 12 12" }]
];

// node_modules/lucide/dist/esm/lucide.mjs
/**
 * @license lucide v1.34.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
export {
  Mic,
  MicOff,
  Phone,
  Settings,
  X,
  createMorph
};

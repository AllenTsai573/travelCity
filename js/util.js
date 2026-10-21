// 共用工具：亂數、雜訊、幾何運算

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed) { this.f = mulberry32(seed); }
  next() { return this.f(); }
  range(a, b) { return a + (b - a) * this.f(); }
  int(a, b) { return a + Math.floor(this.f() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this.f() * arr.length)]; }
  chance(p) { return this.f() < p; }
  gauss() { return (this.f() + this.f() + this.f() + this.f() - 2) / 0.8165; }
}

export function hash2(x, y, seed) {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, seed, oct = 5) {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * valueNoise(x * f, y * f, seed + i * 1013);
    n += amp; amp *= 0.5; f *= 2;
  }
  return s / n;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function polyCum(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) {
    c.push(c[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return c;
}

function findIdx(cum, s) {
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= s) lo = m; else hi = m;
  }
  return lo;
}

// 沿折線取點，回傳座標與單位切線
export function pointAt(pts, cum, s) {
  const n = pts.length;
  if (n < 2) return { x: pts[0].x, y: pts[0].y, dx: 1, dy: 0 };
  const total = cum[n - 1];
  if (s <= 0) {
    const L = cum[1] || 1;
    return { x: pts[0].x, y: pts[0].y, dx: (pts[1].x - pts[0].x) / L, dy: (pts[1].y - pts[0].y) / L };
  }
  if (s >= total) {
    const L = (cum[n - 1] - cum[n - 2]) || 1;
    return { x: pts[n - 1].x, y: pts[n - 1].y, dx: (pts[n - 1].x - pts[n - 2].x) / L, dy: (pts[n - 1].y - pts[n - 2].y) / L };
  }
  const i = findIdx(cum, s);
  const L = (cum[i + 1] - cum[i]) || 1;
  const t = (s - cum[i]) / L;
  const a = pts[i], b = pts[i + 1];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: (b.x - a.x) / L, dy: (b.y - a.y) / L };
}

export function cutPoly(pts, cum, s0, s1) {
  const total = cum[cum.length - 1];
  s0 = clamp(s0, 0, total); s1 = clamp(s1, 0, total);
  if (s1 - s0 < 1e-6) {
    const p = pointAt(pts, cum, s0);
    return [{ x: p.x, y: p.y }, { x: p.x + p.dx * 0.01, y: p.y + p.dy * 0.01 }];
  }
  const out = [];
  const p0 = pointAt(pts, cum, s0);
  out.push({ x: p0.x, y: p0.y });
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push({ x: pts[i].x, y: pts[i].y });
  }
  const p1 = pointAt(pts, cum, s1);
  out.push({ x: p1.x, y: p1.y });
  return out;
}

// 平移折線（正值為行進方向右側；畫面座標 y 向下）
export function offsetPoly(pts, off) {
  if (off === 0) return pts.map(p => ({ x: p.x, y: p.y }));
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    let nx = 0, ny = 0, n1x = 0, n1y = 0;
    if (i > 0) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y, L = Math.hypot(dx, dy) || 1;
      n1x = -dy / L; n1y = dx / L; nx += n1x; ny += n1y;
    }
    if (i < n - 1) {
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y, L = Math.hypot(dx, dy) || 1;
      const n2x = -dy / L, n2y = dx / L;
      nx += n2x; ny += n2y;
      if (i === 0) { n1x = n2x; n1y = n2y; }
    }
    const L = Math.hypot(nx, ny) || 1;
    nx /= L; ny /= L;
    const sc = 1 / Math.max(0.5, nx * n1x + ny * n1y);
    out.push({ x: pts[i].x + nx * off * sc, y: pts[i].y + ny * off * sc });
  }
  return out;
}

export function quadPts(p0, p1, p2, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
  }
  return out;
}

export function cubicPts(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return out;
}

// 以三次貝茲曲線近似圓弧連接兩條方向線（t0：P0 處的行進方向，t3：P3 處的行進方向）
// 控制柄由兩方向線交點與轉角決定（90° 時為 0.552R）；近乎直行時用弦長 0.4 倍
export function arcCurve(P0, t0, P3, t3, minSamples = 8, step = 0.75, uTurn = false) {
  const d = Math.hypot(P3.x - P0.x, P3.y - P0.y);
  if (d < 0.05) return [{ x: P0.x, y: P0.y }, { x: P3.x + t3.x * 0.02, y: P3.y + t3.y * 0.02 }];
  const ang = Math.acos(clamp(t0.x * t3.x + t0.y * t3.y, -1, 1));
  let k0 = d * 0.4, k1 = d * 0.4;
  if (uTurn) k0 = k1 = Math.max(d * 0.9, 5.6);
  else if (ang > 0.2) {
    const dx = P3.x - P0.x, dy = P3.y - P0.y;
    const den = t0.x * t3.y - t0.y * t3.x;
    const a = (dx * t3.y - dy * t3.x) / den, b = (t0.x * dy - t0.y * dx) / den;
    if (a > 0.1 && b > 0.1) {
      const f = (4 / 3) * Math.tan(ang / 4) / Math.tan(ang / 2);
      k0 = Math.min(a * f, d); k1 = Math.min(b * f, d);
    }
  }
  const est = d + (k0 + k1) * 0.3;
  return cubicPts(P0, { x: P0.x + t0.x * k0, y: P0.y + t0.y * k0 }, { x: P3.x - t3.x * k1, y: P3.y - t3.y * k1 }, P3,
    clamp(Math.ceil(est / step), minSamples, 48));
}

export function convexHull(pts) {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

export function segSegIntersect(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c.x - a.x, qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: a.x + rx * t, y: a.y + ry * t };
}

export function polyBBox(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export function bboxOverlap(a, b) {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

export function polyIntersections(A, cumA, B, cumB) {
  const res = [];
  for (let i = 0; i < A.length - 1; i++) {
    const a = A[i], b = A[i + 1];
    const ax0 = Math.min(a.x, b.x), ax1 = Math.max(a.x, b.x), ay0 = Math.min(a.y, b.y), ay1 = Math.max(a.y, b.y);
    for (let j = 0; j < B.length - 1; j++) {
      const c = B[j], d = B[j + 1];
      if (Math.max(c.x, d.x) < ax0 || Math.min(c.x, d.x) > ax1 || Math.max(c.y, d.y) < ay0 || Math.min(c.y, d.y) > ay1) continue;
      const r = segSegIntersect(a, b, c, d);
      if (r) res.push({ sA: cumA[i] + r.t * (cumA[i + 1] - cumA[i]), sB: cumB[j] + r.u * (cumB[j + 1] - cumB[j]), x: r.x, y: r.y });
    }
  }
  return res;
}

export function closestOnPoly(pts, cum, p) {
  let best = { s: 0, d: Infinity, x: pts[0].x, y: pts[0].y };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L2, 0, 1);
    const x = a.x + dx * t, y = a.y + dy * t;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best.d) best = { s: cum[i] + t * (cum[i + 1] - cum[i]), d, x, y };
  }
  return best;
}

export function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L2, 0, 1);
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

// 凸多邊形 SAT 重疊判斷
export function convexOverlap(P, Q) {
  for (const poly of [P, Q]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const nx = -(b.y - a.y), ny = b.x - a.x;
      let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
      for (const v of P) { const d = v.x * nx + v.y * ny; if (d < p0) p0 = d; if (d > p1) p1 = d; }
      for (const v of Q) { const d = v.x * nx + v.y * ny; if (d < q0) q0 = d; if (d > q1) q1 = d; }
      if (p1 < q0 || q1 < p0) return false;
    }
  }
  return true;
}

export class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const rk = k[0], rv = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    this.lastKey = rk;
    return rv;
  }
}

export function fmtMoney(n) {
  const s = Math.round(Math.abs(n)).toLocaleString('en-US');
  return (n < 0 ? '-$' : '$') + s;
}

export function fmtTime(min) {
  const day = Math.floor(min / 1440) + 1;
  const m = Math.floor(min % 1440);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return { day, clock: `${hh}:${mm}` };
}

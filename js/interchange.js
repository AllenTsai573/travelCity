// 交流道模板：鑽石型、苜蓿葉、單點式（SPUI）、分岔鑽石（DDI）、渦輪
// 所有幾何皆以「主線沿 +x、橫交道路沿 y」的區域座標設計（靠右行駛）：
//   東行（+x）在 +y 側、西行在 -y 側；北行（-y）在 +x 側、南行（+y）在 -x 側
// 匝道由直線、圓弧與平滑銜接段組成，切線連續（不會出現折角）
import { arcCurve, polyCum, cutPoly, pointAt, polyIntersections } from './util.js';
import { Network, halfWidth } from './network.js';
import { ROAD_TYPES, levelMul } from './config.js';

const norm = (x, y) => { const L = Math.hypot(x, y) || 1; return { x: x / L, y: y / L }; };
const S2 = Math.SQRT1_2;

// 「烏龜」式路徑：從起點與行進方向開始，依序加入直線 / 圓弧 / 平滑銜接
export class Path {
  constructor(x, y, hx, hy) { this.pts = [{ x, y }]; this.h = norm(hx, hy); }
  get p() { return this.pts[this.pts.length - 1]; }
  line(x, y) {
    const p = this.p, d = Math.hypot(x - p.x, y - p.y), n = Math.max(1, Math.ceil(d / 8));
    for (let k = 1; k <= n; k++) this.pts.push({ x: p.x + (x - p.x) * k / n, y: p.y + (y - p.y) * k / n });
    this.h = norm(x - p.x, y - p.y);
    return this;
  }
  // 半徑 r、轉角 deg（正值右轉、負值左轉）的圓弧
  turn(r, deg) {
    const a = deg * Math.PI / 180, p = this.p;
    const rx = -this.h.y, ry = this.h.x, sgn = a > 0 ? 1 : -1;
    const cx = p.x + rx * r * sgn, cy = p.y + ry * r * sgn;
    const a0 = Math.atan2(p.y - cy, p.x - cx);
    const steps = Math.max(2, Math.ceil(Math.abs(deg) / 4));
    for (let k = 1; k <= steps; k++) {
      const t = a0 + a * k / steps;
      this.pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
    const c = Math.cos(a), s = Math.sin(a);
    this.h = { x: this.h.x * c - this.h.y * s, y: this.h.x * s + this.h.y * c };
    return this;
  }
  // 以近似圓弧的平滑曲線接到指定點與方向
  to(x, y, hx, hy) {
    const h3 = norm(hx, hy);
    const arc = arcCurve(this.p, this.h, { x, y }, h3, 8, 3);
    for (const q of arc.slice(1)) this.pts.push(q);
    this.h = h3;
    return this;
  }
}

const rotPts = (pts, k) => pts.map(p => (k === 0 ? { x: p.x, y: p.y } : k === 1 ? { x: -p.y, y: p.x } : k === 2 ? { x: -p.x, y: -p.y } : { x: p.y, y: -p.x }));

// 每個元素：{ label, type, pts（區域座標）, prof: [[比例, 高度代號], ...], role }
// 高度代號：'M' 主線、'C' 橫交道路、'A' / 'B' 渦輪左轉匝道的兩個中間層
export const TEMPLATES = {
  diamond: {
    name: '鑽石型', desc: '最常見的交流道：四條匝道在橫交道路上形成兩處號誌路口', L: 360, Lc: 300,
    main: 'highway', cross: 'avenue', M: 1, C: 0,
    build() {
      const D = 75, out = [];
      for (const k of [0, 2]) {
        const off = new Path(-330, 0, 1, 0).to(-45, D, 1, 0).line(0, D);
        const on = new Path(0, D, 1, 0).line(45, D).to(330, 0, 1, 0);
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(off.pts, k), prof: [[0, 'M'], [1, 'C']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(on.pts, k), prof: [[0, 'C'], [1, 'M']] });
      }
      return { elems: out, signals: [{ x: 0, y: D, lv: 'C' }, { x: 0, y: -D, lv: 'C' }] };
    },
  },
  cloverleaf: {
    name: '苜蓿葉', desc: '左轉走 270° 環道、右轉走外側匝道，完全不需號誌', L: 420, Lc: 420,
    main: 'highway', cross: 'avenue', M: 1, C: 0,
    build() {
      // 環道半徑 55 m；外側匝道走距中心約 212 m 的斜線，確保在環道（最遠約 165 m）之外
      const R = 55, gm = 24, gc = 22, Q = { x: gc + R, y: gm + R }, out = [];
      for (const k of [0, 2]) {
        const loopSE = new Path(18, 0, 1, 0).to(Q.x, gm, 1, 0).turn(R, 270).to(0, 16, 0, -1);
        const loopNE = new Path(0, -16, 0, -1).to(gc, -Q.y, 0, -1).turn(R, 270).to(18, 0, -1, 0);
        const outerSE = new Path(0, 380, 0, -1).to(45, 255, S2, -S2).line(255, 45).to(380, 0, 1, 0);
        const outerNE = new Path(380, 0, -1, 0).to(255, -45, -S2, -S2).line(45, -255).to(0, -380, 0, -1);
        out.push({ label: '左轉環道', type: 'ramp', pts: rotPts(loopSE.pts, k), prof: [[0, 'M'], [1, 'C']] });
        out.push({ label: '左轉環道', type: 'ramp', pts: rotPts(loopNE.pts, k), prof: [[0, 'C'], [1, 'M']] });
        out.push({ label: '右轉匝道', type: 'ramp', pts: rotPts(outerSE.pts, k), prof: [[0, 'C'], [1, 'M']] });
        out.push({ label: '右轉匝道', type: 'ramp', pts: rotPts(outerNE.pts, k), prof: [[0, 'M'], [1, 'C']] });
      }
      return { elems: out, signals: [] };
    },
  },
  spui: {
    name: '單點式 SPUI', desc: '四條匝道在主線正下方匯成單一號誌路口，佔地小、通行量大', L: 360, Lc: 300,
    main: 'highway', cross: 'avenue', M: 1, C: 0,
    build() {
      const out = [];
      const dx = 0.894, dy = 0.447;
      for (const k of [0, 2]) {
        const off = new Path(-330, 0, 1, 0).to(-80, 34, 1, 0).to(0, 0, dx, -dy);
        const on = new Path(0, 0, dx, dy).to(80, 34, 1, 0).to(330, 0, 1, 0);
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(off.pts, k), prof: [[0, 'M'], [1, 'C']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(on.pts, k), prof: [[0, 'C'], [1, 'M']] });
      }
      return { elems: out, signals: [{ x: 0, y: 0, lv: 'C' }] };
    },
  },
  ddi: {
    name: '分岔鑽石 DDI', desc: '橫交道路在兩處號誌交叉換到左側行駛，左轉上匝道不必等號誌', L: 360, Lc: 380,
    main: 'highway', cross: 'avenue', M: 1, C: 0, replaceCross: 175,
    build() {
      const Y1 = 175, Yx = 115, Yr = 55, o = 8.5, out = [];
      // 兩條單向車道：在 y = ±115 處交叉換邊（中段靠左行駛）
      const nb = new Path(0, Y1, 0, -1).to(o, Y1 - 22, 0, -1).line(o, Yx + 30).to(-o, Yx - 30, 0, -1)
        .line(-o, -Yx + 30).to(o, -Yx - 30, 0, -1).line(o, -Y1 + 22).to(0, -Y1, 0, -1);
      out.push({ label: '北行分岔車道', type: 'oneway2', pts: nb.pts, prof: [[0, 'C'], [1, 'C']], role: 'ddi' });
      out.push({ label: '南行分岔車道', type: 'oneway2', pts: rotPts(nb.pts, 2), prof: [[0, 'C'], [1, 'C']], role: 'ddi' });
      for (const k of [0, 2]) {
        // 出口：左轉接到中段（已換到左側的）北行車道；右轉另走斜坡接到分岔點外的南行
        const off = new Path(-330, 0, 1, 0).to(-90, Yr, 1, 0).line(-o, Yr);
        const offPts = off.pts, offCum = polyCum(offPts), offLen = offCum[offCum.length - 1];
        // 右轉匝道在端點前約 150 m 就分出，以單一平順彎道接到分岔點外的南行車道
        const sDiv = offLen - 150, pd = pointAt(offPts, offCum, sDiv);
        const slipOff = new Path(pd.x, pd.y, pd.dx, pd.dy).to(0, Y1 + 95, 0, 1);
        // 入口：由中段（已換到右側的）南行車道左轉駛入；北行右轉另走斜坡併入
        const on = new Path(o, Yr, 1, 0).line(90, Yr).to(330, 0, 1, 0);
        const onPts = on.pts, onCum = polyCum(onPts), onLen = onCum[onCum.length - 1];
        const sJoin = 150, pm = pointAt(onPts, onCum, sJoin);
        const slipOn = new Path(0, Y1 + 95, 0, -1).to(pm.x, pm.y, pm.dx, pm.dy);
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(offPts, k), prof: [[0, 'M'], [sDiv / offLen - 0.12, 'C'], [1, 'C']] });
        out.push({ label: '右轉出口', type: 'ramp', pts: rotPts(slipOff.pts, k), prof: [[0, 'C'], [1, 'C']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(onPts, k), prof: [[0, 'C'], [sJoin / onLen + 0.12, 'C'], [1, 'M']] });
        out.push({ label: '右轉入口', type: 'ramp', pts: rotPts(slipOn.pts, k), prof: [[0, 'C'], [1, 'C']] });
      }
      return { elems: out, signals: [{ x: 0, y: Yx, lv: 'C' }, { x: 0, y: -Yx, lv: 'C' }] };
    },
  },
  turbine: {
    name: '渦輪型', desc: '高速公路對高速公路：四條左轉匝道繞中心旋轉，以兩個中間層立體交叉', L: 580, Lc: 580,
    main: 'highway', cross: 'highway', M: 1, C: 2, needAB: true,
    build() {
      // 左轉匝道：半徑 220 m 的 90° 左彎，在中心西北側約 53 m 處通過，分別跨越主線與橫交道路
      const left = new Path(-300, 0, 1, 0).to(-190, 30, 1, 0).turn(220, -90).to(0, -300, 0, -1);
      // 右轉匝道：外側大半徑匝道，在左轉匝道分岔點之前先分出
      const right = new Path(-460, 0, 1, 0).to(0, 460, 0, 1);
      const out = [];
      for (let k = 0; k < 4; k++) {
        const fromMain = k % 2 === 0;
        const ab = fromMain ? 'A' : 'B';
        out.push({ label: '左轉匝道', type: 'ramp', pts: rotPts(left.pts, k),
          prof: [[0, fromMain ? 'M' : 'C'], [0.3, ab], [0.72, ab], [1, fromMain ? 'C' : 'M']] });
        out.push({ label: '右轉匝道', type: 'ramp', pts: rotPts(right.pts, k), prof: [[0, fromMain ? 'M' : 'C'], [1, fromMain ? 'C' : 'M']] });
      }
      return { elems: out, signals: [] };
    },
  },
};
export const TEMPLATE_ORDER = ['diamond', 'cloverleaf', 'spui', 'ddi', 'turbine'];

// 模板在區域座標中的完整元素（含主線與橫交道路）
export function templateElems(key) {
  const t = TEMPLATES[key];
  const b = t.build();
  const roads = [];
  roads.push({ label: '主線', type: t.main, pts: new Path(-t.L, 0, 1, 0).line(t.L, 0).pts, prof: [[0, 'M'], [1, 'M']], role: 'main' });
  if (t.replaceCross) {
    roads.push({ label: '橫交道路', type: t.cross, pts: new Path(0, t.Lc, 0, -1).line(0, t.replaceCross).pts, prof: [[0, 'C'], [1, 'C']], role: 'cross' });
    roads.push({ label: '橫交道路', type: t.cross, pts: new Path(0, -t.replaceCross, 0, -1).line(0, -t.Lc).pts, prof: [[0, 'C'], [1, 'C']], role: 'cross' });
  } else {
    roads.push({ label: '橫交道路', type: t.cross, pts: new Path(0, t.Lc, 0, -1).line(0, -t.Lc).pts, prof: [[0, 'C'], [1, 'C']], role: 'cross' });
  }
  return { roads, elems: b.elems, signals: b.signals };
}

// 尋找游標附近、高度不同的兩條道路交叉點（可直接在其上加交流道）
export function findCrossing(net, x, y, r = 70) {
  const near = [...net.segs.values()].filter(s => !(x < s.bbox.x0 - r || x > s.bbox.x1 + r || y < s.bbox.y0 - r || y > s.bbox.y1 + r));
  let best = null, bd = r;
  for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
    const a = near[i], b = near[j];
    for (const it of polyIntersections(a.pts, a.cum, b.pts, b.cum)) {
      const d = Math.hypot(it.x - x, it.y - y);
      if (d >= bd) continue;
      const ha = net.segHeightAt(a, it.sA), hb = net.segHeightAt(b, it.sB);
      if (Math.abs(ha - hb) < 0.85) continue;
      bd = d;
      best = { x: it.x, y: it.y, a, b, ua: it.sA, ub: it.sB, ha, hb };
    }
  }
  for (const n of net.nodes.values()) {
    if (n.segs.length !== 4) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) { bd = d; best = { atGrade: true, x: n.x, y: n.y, node: n }; }
  }
  return best;
}

// 由交叉點決定模板座標系：主線為等級較高（同級取較高）的道路
export function frameFromCrossing(net, cr) {
  if (cr.atGrade) return { ok: false, reason: '此為平面路口：請先讓其中一條道路以高架或隧道跨越（立體交叉）', x: cr.x, y: cr.y };
  let m = cr.a, c = cr.b, um = cr.ua, uc = cr.ub, hm = cr.ha, hc = cr.hb;
  if (c.T.rank > m.T.rank || (c.T.rank === m.T.rank && hc > hm)) { [m, c, um, uc, hm, hc] = [c, m, uc, um, hc, hm]; }
  const pm = pointAt(m.pts, m.cum, um), pc = pointAt(c.pts, c.cum, uc);
  const dot = Math.abs(pm.dx * pc.dx + pm.dy * pc.dy);
  const fr = { ok: true, x: cr.x, y: cr.y, ux: pm.dx, uy: pm.dy, M: Math.round(hm), C: Math.round(hc), snap: true, mainSeg: m, crossSeg: c };
  if (dot > 0.42) return { ...fr, ok: false, reason: '兩條道路的交角需接近直角（至少 65°）' };
  return fr;
}

const toWorld = (fr, p) => ({ x: fr.x + p.x * fr.ux - p.y * fr.uy, y: fr.y + p.x * fr.uy + p.y * fr.ux });

function resolveLevels(t, fr) {
  const L = { M: fr.M, C: fr.C };
  if (fr.M === fr.C) return { error: '主線與橫交道路需在不同高度' };
  if (t.needAB) {
    const lo = Math.min(fr.M, fr.C), hi = Math.max(fr.M, fr.C);
    let A = lo - 1, B = hi + 1;
    if (hi - lo >= 3) { A = lo + 1; B = lo + 2; }
    if (A < -2 || B > 3) return { error: '高度層不足：渦輪型需要在主線與橫交道路上下各多一層' };
    L.A = A; L.B = B;
  }
  return L;
}

// 預覽用：轉成世界座標的所有線段與估計成本
export function previewTemplate(key, fr) {
  const t = TEMPLATES[key];
  const { roads, elems } = templateElems(key);
  const lines = [];
  let cost = 0;
  const lv = resolveLevels(t, fr);
  const all = [...(fr.snap ? [] : roads), ...elems];
  for (const e of all) {
    const pts = e.pts.map(p => toWorld(fr, p));
    lines.push({ pts, type: e.type, role: e.role || 'ramp' });
    const cum = polyCum(pts), len = cum[cum.length - 1];
    const l0 = lv[e.prof[0][1]] ?? 0, l1 = lv[e.prof[e.prof.length - 1][1]] ?? 0;
    cost += len * ROAD_TYPES[e.type].cost * (levelMul(l0) + levelMul(l1)) / 2;
  }
  return { lines, cost: Math.round(cost), levelError: lv.error };
}

// 在指定路網上依序建造（dry-run 時用複製的路網）
function buildOn(net, key, fr) {
  const t = TEMPLATES[key];
  const lv = resolveLevels(t, fr);
  if (lv.error) return { ok: false, reason: lv.error };
  const { roads, elems, signals } = templateElems(key);
  let cost = 0;
  // 在既有交叉上建 DDI：先拆掉橫交道路中段
  if (fr.snap && t.replaceCross) {
    const cut = t.replaceCross;
    const pA = toWorld(fr, { x: 0, y: cut }), pB = toWorld(fr, { x: 0, y: -cut });
    for (const p of [pA, pB]) {
      const s = net.segNear(p.x, p.y, 4, fr.C);
      if (!s) return { ok: false, reason: '找不到可改建的橫交道路（範圍內需為直線）' };
      net.splitSegment(s.seg, s.u);
    }
    net.rebuild();
    const mid = [...net.segs.values()].filter(s => {
      const q = pointAt(s.pts, s.cum, s.len / 2);
      const lx = (q.x - fr.x) * fr.ux + (q.y - fr.y) * fr.uy, ly = -(q.x - fr.x) * fr.uy + (q.y - fr.y) * fr.ux;
      return Math.abs(lx) < 15 && Math.abs(ly) < cut - 1 && Math.abs(net.segHeightAt(s, s.len / 2) - fr.C) < 0.3;
    });
    for (const s of mid) net.removeSegment(s);
    net.rebuild();
  }
  const snapPt = (p, level, allowSnap) => {
    if (allowSnap) {
      const n = net.nodeNear(p.x, p.y, 3, level);
      if (n) return { x: n.x, y: n.y, node: n.id };
      const s = net.segNear(p.x, p.y, 3, level);
      if (s && Math.abs(s.h - level) < 0.2) return { x: s.x, y: s.y, seg: s.seg.id, u: s.u };
    }
    return { x: p.x, y: p.y };
  };
  const list = [...(fr.snap ? [] : roads), ...elems];
  for (const e of list) {
    const pts = e.pts.map(p => toWorld(fr, p));
    const cum = polyCum(pts), len = cum[cum.length - 1];
    for (let i = 0; i < e.prof.length - 1; i++) {
      const s0 = e.prof[i][0] * len, s1 = e.prof[i + 1][0] * len;
      const h0 = lv[e.prof[i][1]], h1 = lv[e.prof[i + 1][1]];
      const piece = cutPoly(pts, cum, s0, s1);
      const a = snapPt(piece[0], h0, true), b = snapPt(piece[piece.length - 1], h1, true);
      const plan = net.planRoad(a, b, null, e.type, h0, { pts: piece, hA: h0, hB: h1 });
      if (!plan.ok) return { ok: false, reason: `${e.label}：${plan.reason}`, at: piece[0] };
      net.executeRoad(plan);
      cost += plan.cost;
    }
  }
  for (const sg of signals) {
    const p = toWorld(fr, sg);
    const n = net.nodeNear(p.x, p.y, 12, lv[sg.lv]);
    if (n && n.segs.length >= 3) n.control = 'signal';
  }
  // DDI 的兩處交叉點
  if (key === 'ddi') {
    for (const n of net.nodes.values()) {
      const lx = (n.x - fr.x) * fr.ux + (n.y - fr.y) * fr.uy, ly = -(n.x - fr.x) * fr.uy + (n.y - fr.y) * fr.ux;
      if (Math.abs(lx) < 6 && Math.abs(Math.abs(ly) - 115) < 12 && n.segs.length === 4) n.control = 'signal';
    }
  }
  net.rebuild();
  return { ok: true, cost };
}

function cloneNetwork(game) {
  const terrain = Object.create(game.terrain);
  terrain.clearTreesAlong = () => {};
  terrain.clearTreesCircle = () => {};
  const sim = { terrain, city: null, traffic: null, diff: game.diff, canAfford: () => true, spend() {}, earn() {}, notify() {} };
  const net = new Network(sim);
  sim.net = net;
  net.load(game.net.serialize());
  return net;
}

// 建造交流道：先在複製的路網上試建，全部成功才在真正的路網上建造
export function placeInterchange(game, key, fr) {
  if (!fr.ok) return { ok: false, reason: fr.reason };
  const dry = buildOn(cloneNetwork(game), key, fr);
  if (!dry.ok) return dry;
  if (!game.canAfford(dry.cost)) return { ok: false, reason: `資金不足（約 $${dry.cost.toLocaleString()}）` };
  const real = buildOn(game.net, key, fr);
  return real.ok ? { ok: true, cost: real.cost } : real;
}

// 交流道模板：鑽石型、苜蓿葉、單點式（SPUI）、分岔鑽石（DDI）、渦輪
// 所有幾何皆以「主線沿 +x、橫交道路沿 y」的區域座標設計（靠右行駛）：
//   東行（+x）在 +y 側、西行在 -y 側；北行（-y）在 +x 側、南行（+y）在 -x 側
// 匝道由直線、圓弧與平滑銜接段組成，切線連續（不會出現折角）
import { arcCurve, polyCum, cutPoly, pointAt, polyIntersections, pointInPoly } from './util.js';
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
  // 沿目前方向前進 d
  fwd(d) { return d > 0.01 ? this.line(this.p.x + this.h.x * d, this.p.y + this.h.y * d) : this; }
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

// 每個元素：{ label, type, pts（區域座標）, prof: [[比例, 高度代號], ...], role, ring }
// 高度代號：'M' 主線、'C' 橫交道路，其餘（A、B、R…）由各模板的 levels() 決定

// ---- 共用元件（全部以「東行 → …」的方向設計，再旋轉到其他象限）----
// 星形右轉匝道：與兩條道路相切的大圓弧（往中心內凹），東行 → 南行（T 字型用）
const starPts = Ls => new Path(-Ls, 0, 1, 0).to(0, Ls, 0, 1).pts;
// 苜蓿葉環道（270°），東行 → 北行，位於東南象限：與兩條道路中心線都相切的正圓
const LOOP_R = 62;
export const cloverLoopPts = (R = LOOP_R) => new Path(R, 0, 1, 0).turn(R, 270).pts;

// 外側右轉匝道（東行 → 南行，西南象限），形狀像真實交流道的外側匝道：
// 以半徑 rho 右彎 beta 離開主線 → 直線 → 半徑 r 的急彎 → 直線 → 右彎 beta 併入
export function cornerShape(t, rho, beta, r) {
  const pts = new Path(0, 0, 1, 0).turn(rho, beta).fwd(t).turn(r, 90 - 2 * beta).fwd(t).turn(rho, beta).pts;
  const D = pts[pts.length - 1].x;
  return pts.map(p => ({ x: p.x - D, y: p.y }));
}
// 找出最小的外側匝道：離其他匝道至少 gap（道路以外的部分），且分岔點在其他匝道的分岔 / 匯入點之外
export function fitCornerRamp(inner, { gap = 24, rho = 140, beta = 32, r = 160, lead = 70 } = {}) {
  const off = 16, near = p => Math.abs(p.x) < off || Math.abs(p.y) < off;
  const pts = [];
  let axisMax = 0;
  for (const e of inner) {
    for (const q of [e.pts[0], e.pts[e.pts.length - 1]]) if (Math.abs(q.y) < 3 || Math.abs(q.x) < 3) axisMax = Math.max(axisMax, Math.abs(q.x) + Math.abs(q.y));
    for (const q of e.pts) if (!near(q) && q.x < 0 && q.y > 0) pts.push(q);
  }
  for (let t = 0; t < 800; t += 4) {
    const c = cornerShape(t, rho, beta, r);
    if (-c[0].x < axisMax + lead) continue;
    // 其他匝道都要在外側匝道與中心之間
    const poly = [...c, { x: 0, y: 0 }];
    let ok = pts.every(q => pointInPoly(q, poly));
    for (const p of ok ? c : []) {
      if (near(p)) continue;
      for (const q of pts) if (Math.abs(p.x - q.x) < gap && Math.abs(p.y - q.y) < gap && Math.hypot(p.x - q.x, p.y - q.y) < gap) { ok = false; break; }
      if (!ok) break;
    }
    if (ok) return c;
  }
  return cornerShape(800, rho, beta, r);
}
// 每個象限分別配合（不對稱的模板如喇叭型也適用）；k 為旋轉次數（0 = 東行 → 南行）
function cornerRamps(out, opts, ks = [0, 1, 2, 3], label = '右轉匝道') {
  const inner = [...out];
  for (const k of ks) {
    const c = fitCornerRamp(inner.map(e => ({ pts: rotPts(e.pts, (4 - k) % 4) })), opts);
    out.push({ label, type: 'ramp', pts: rotPts(c, k), prof: k % 2 ? [[0, 'C'], [1, 'M']] : [[0, 'M'], [1, 'C']] });
  }
}
// 渦輪左轉匝道：右側駛出後以大半徑左彎繞過中心，東行 → 北行
const turbineLeftPts = (P = 190, w = 30, r = 220, S = 300) => new Path(-S, 0, 1, 0).to(-P, w, 1, 0).turn(r, -90).to(0, -S, 0, -1).pts;
// 由 M（或 C）出發的匝道在 k 為奇數時起訖互換
const mc = (k, a, b) => (k % 2 ? [b, a] : [a, b]);
// 折線第一次穿越主線（y=0）或橫交道路（x=0）處的比例（略過起訖 40 m）
function crossFrac(pts, axis) {
  const cum = polyCum(pts), len = cum[cum.length - 1];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] < 40 || cum[i] > len - 40) continue;
    const a = axis === 'y' ? pts[i - 1].y : pts[i - 1].x, b = axis === 'y' ? pts[i].y : pts[i].x;
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) return (cum[i - 1] + (cum[i] - cum[i - 1]) * Math.abs(a) / (Math.abs(a - b) || 1)) / len;
  }
  return null;
}
// 環道（逆時針，畫面角度遞減），在指定角度處分段
function ringElems(out, R, anglesDeg, lv) {
  const a = [...anglesDeg].sort((p, q) => p - q);
  for (let i = 0; i < a.length; i++) {
    const from = a[i], to = i === 0 ? a[a.length - 1] - 360 : a[i - 1];
    const pts = [];
    const n = Math.max(3, Math.ceil((from - to) / 4));
    for (let k = 0; k <= n; k++) { const t = (from + (to - from) * k / n) * Math.PI / 180; pts.push({ x: (R.a ?? R) * Math.cos(t), y: (R.b ?? R) * Math.sin(t) }); }
    out.push({ label: '環道', type: 'oneway2', ring: true, pts, prof: [[0, lv], [1, lv]] });
  }
}
// 橢圓環道上的點與逆時針切線（R 可為數字或 { a, b }）
const onRing = (R, deg) => {
  const t = deg * Math.PI / 180, A = R.a ?? R, B = R.b ?? R;
  const h = norm(A * Math.sin(t), -B * Math.cos(t));
  return { x: A * Math.cos(t), y: B * Math.sin(t), hx: h.x, hy: h.y };
};
const levelsLoHi = (M, C, under = 1, over = 1) => {
  const lo = Math.min(M, C), hi = Math.max(M, C);
  const A = lo - under, B = hi + over;
  if (A < -2 || B > 3) return { error: '高度層不足：需要在主線與橫交道路上下各多一層' };
  return { A, B };
};

export const TEMPLATES = {
  // ======== 服務型（高速公路 × 一般道路）========
  diamond: {
    group: '服務型', name: '鑽石型', desc: '四條匝道在橫交道路上形成兩處號誌路口，佔地最小', L: 360, Lc: 300,
    main: 'highway', cross: 'avenue', M: 1, C: 0,
    build() {
      const D = 75, out = [];
      for (const k of [0, 2]) {
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(new Path(-330, 0, 1, 0).to(-45, D, 1, 0).line(0, D).pts, k), prof: [[0, 'M'], [1, 'C']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(new Path(0, D, 1, 0).line(45, D).to(330, 0, 1, 0).pts, k), prof: [[0, 'C'], [1, 'M']] });
      }
      return { elems: out, signals: [{ x: 0, y: D, lv: 'C' }, { x: 0, y: -D, lv: 'C' }] };
    },
  },
  parcloA: {
    group: '服務型', name: '部分苜蓿葉 A', desc: '左轉上高速走環道（位於橫交道路之前），出口匝道在橫交道路上以號誌 T 字路口銜接', L: 440, Lc: 320,
    main: 'highway', cross: 'avenue', M: 1, C: 0,
    build() {
      const D = 165, out = [];
      for (const k of [0, 2]) {
        // 西南象限：南行 → 東行的環道（入口）、東行出口匝道到 T 字路口
        out.push({ label: '左轉入口環道', type: 'ramp', pts: rotPts(rotPts(cloverLoopPts(), 1), k), prof: [[0, 'C'], [1, 'M']] });
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(new Path(-420, 0, 1, 0).to(-150, D, 1, 0).line(0, D).pts, k), prof: [[0, 'M'], [1, 'C']] });
        // 東南象限：北行 → 東行的右轉入口
        out.push({ label: '右轉入口', type: 'ramp', pts: rotPts(new Path(0, 260, 0, -1).to(420, 0, 1, 0).pts, k), prof: [[0, 'C'], [1, 'M']] });
      }
      return { elems: out, signals: [{ x: 0, y: D, lv: 'C' }, { x: 0, y: -D, lv: 'C' }] };
    },
  },
  parcloB: {
    group: '服務型', name: '部分苜蓿葉 B', desc: '出口走髮夾環道（位於橫交道路之後），入口匝道與環道都在橫交道路上以號誌 T 字路口銜接', L: 440, Lc: 320,
    main: 'highway', cross: 'avenue', M: 1, C: 0,
    build() {
      const out = [], D1 = 116, D2 = 165;
      for (const k of [0, 2]) {
        // 東南象限：東行駛過橫交道路後右出，180° 髮夾彎接回橫交道路
        out.push({ label: '出口環道', type: 'ramp', pts: rotPts(new Path(30, 0, 1, 0).to(115, 24, 1, 0).turn(46, 180).line(0, D1).pts, k), prof: [[0, 'M'], [1, 'C']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(new Path(0, D2, 1, 0).line(70, D2).to(400, 0, 1, 0).pts, k), prof: [[0, 'C'], [1, 'M']] });
      }
      return { elems: out, signals: [{ x: 0, y: D1, lv: 'C' }, { x: 0, y: -D1, lv: 'C' }, { x: 0, y: D2, lv: 'C' }, { x: 0, y: -D2, lv: 'C' }] };
    },
  },
  ddi: {
    group: '服務型', name: '分岔鑽石 DDI', desc: '橫交道路在兩處號誌交叉換到左側行駛，左轉上下匝道不必等號誌', L: 360, Lc: 340, replaceCross: 160,
    main: 'highway', cross: 'avenue', M: 1, C: 0,
    build() {
      const Y1 = 160, Yx = 105, Yr = 52, o = 8.5, out = [];
      const nb = new Path(0, Y1, 0, -1).to(o, Y1 - 20, 0, -1).line(o, Yx + 28).to(-o, Yx - 28, 0, -1)
        .line(-o, -Yx + 28).to(o, -Yx - 28, 0, -1).line(o, -Y1 + 20).to(0, -Y1, 0, -1);
      out.push({ label: '北行分岔車道', type: 'oneway2', pts: nb.pts, prof: [[0, 'C'], [1, 'C']], role: 'ddi' });
      out.push({ label: '南行分岔車道', type: 'oneway2', pts: rotPts(nb.pts, 2), prof: [[0, 'C'], [1, 'C']], role: 'ddi' });
      for (const k of [0, 2]) {
        const off = new Path(-330, 0, 1, 0).to(-85, Yr, 1, 0).line(-o, Yr);
        const offPts = off.pts, offCum = polyCum(offPts), offLen = offCum[offCum.length - 1];
        // 右轉：在端點前約 70 m 分出，緊貼著在交叉點外側併入
        const sDiv = offLen - 70, pd = pointAt(offPts, offCum, sDiv);
        const slipOff = new Path(pd.x, pd.y, pd.dx, pd.dy).to(-14, Y1 + 30, 0.17, 0.985).to(0, Y1 + 55, 0, 1);
        const on = new Path(o, Yr, 1, 0).line(85, Yr).to(330, 0, 1, 0);
        const onPts = on.pts, onCum = polyCum(onPts), onLen = onCum[onCum.length - 1];
        const sJoin = 95, pm = pointAt(onPts, onCum, sJoin);
        const slipOn = new Path(0, Y1 + 55, 0, -1).to(14, Y1 + 30, 0.17, -0.985).to(pm.x, pm.y, pm.dx, pm.dy);
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(offPts, k), prof: [[0, 'M'], [sDiv / offLen - 0.1, 'C'], [1, 'C']] });
        out.push({ label: '右轉出口', type: 'ramp', pts: rotPts(slipOff.pts, k), prof: [[0, 'C'], [1, 'C']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(onPts, k), prof: [[0, 'C'], [sJoin / onLen + 0.1, 'C'], [1, 'M']] });
        out.push({ label: '右轉入口', type: 'ramp', pts: rotPts(slipOn.pts, k), prof: [[0, 'C'], [1, 'C']] });
      }
      return { elems: out, signals: [{ x: 0, y: Yx, lv: 'C' }, { x: 0, y: -Yx, lv: 'C' }] };
    },
  },
  spui: {
    group: '服務型', name: '單點式 SPUI', desc: '左轉匯集到主線正下方的單一號誌路口（大半徑轉彎），右轉走自由右轉匝道不必等號誌；佔地小、通行量大', L: 360, Lc: 300,
    main: 'highway', cross: 'avenue', M: 1, C: 0,
    build() {
      // 參考 MoDOT / KYTC 的 SPUI 設計：出口匝道在 x≈-150 分成兩支，左轉進中央號誌，右轉以半徑 60 m 自由併入橫交道路
      const out = [], dx = 0.894, dy = 0.447, X = 150, W = 30, R = 60;
      for (const k of [0, 2]) {
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(new Path(-340, 0, 1, 0).to(-X, W, 1, 0).pts, k), prof: [[0, 'M'], [1, 'C']] });
        out.push({ label: '出口左轉', type: 'ramp', pts: rotPts(new Path(-X, W, 1, 0).to(0, 0, dx, -dy).pts, k), prof: [[0, 'C'], [1, 'C']] });
        out.push({ label: '出口右轉', type: 'ramp', pts: rotPts(new Path(-X, W, 1, 0).line(-R, W).turn(R, 90).pts, k), prof: [[0, 'C'], [1, 'C']] });
        out.push({ label: '入口左轉', type: 'ramp', pts: rotPts(new Path(0, 0, dx, dy).to(X, W, 1, 0).pts, k), prof: [[0, 'C'], [1, 'C']] });
        out.push({ label: '入口右轉', type: 'ramp', pts: rotPts(new Path(0, W + R, 0, -1).turn(R, 90).line(X, W).pts, k), prof: [[0, 'C'], [1, 'C']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(new Path(X, W, 1, 0).to(340, 0, 1, 0).pts, k), prof: [[0, 'C'], [1, 'M']] });
      }
      return { elems: out, signals: [{ x: 0, y: 0, lv: 'C' }] };
    },
  },

  // ======== 系統型（高速公路 × 高速公路）========
  cloverleaf: {
    group: '系統型', name: '苜蓿葉', desc: '左轉走 270° 環道、右轉走外側星形匝道，完全不需號誌（環道間有交織）', L: 430, Lc: 430,
    main: 'highway', cross: 'highway', M: 1, C: 0,
    build() {
      // 四個正圓環道；外側右轉匝道緊貼環道外緣繞過
      const out = [];
      for (let k = 0; k < 4; k++) out.push({ label: '左轉環道', type: 'ramp', pts: rotPts(cloverLoopPts(), k), prof: k % 2 ? [[0, 'C'], [1, 'M']] : [[0, 'M'], [1, 'C']] });
      cornerRamps(out);
      return { elems: out, signals: [] };
    },
  },
  cloverstack: {
    group: '系統型', name: '苜蓿堆疊', desc: '保留兩個環道、另兩個左轉改為高架匝道，消除環道交織', L: 430, Lc: 430,
    main: 'highway', cross: 'highway', M: 1, C: 0, levels: (M, C) => levelsLoHi(M, C),
    build() {
      const out = [];
      for (const k of [0, 2]) out.push({ label: '左轉環道', type: 'ramp', pts: rotPts(cloverLoopPts(), k), prof: [[0, 'M'], [1, 'C']] });
      for (const k of [1, 3]) out.push({ label: '左轉高架匝道', type: 'ramp', pts: rotPts(turbineLeftPts(150, 28, 170, 260), k), prof: [[0, 'C'], [0.32, 'B'], [0.7, 'B'], [1, 'M']] });
      cornerRamps(out);
      return { elems: out, signals: [] };
    },
  },
  turbine: {
    group: '系統型', name: '渦輪型', desc: '四條左轉匝道繞中心旋轉，以主線上下各一層立體交叉', L: 500, Lc: 500,
    main: 'highway', cross: 'highway', M: 1, C: 2, levels: (M, C) => levelsLoHi(M, C),
    build() {
      const out = [], left = turbineLeftPts();
      for (let k = 0; k < 4; k++) {
        const ab = k % 2 ? 'B' : 'A';
        out.push({ label: '左轉匝道', type: 'ramp', pts: rotPts(left, k), prof: k % 2 ? [[0, 'C'], [0.3, ab], [0.72, ab], [1, 'M']] : [[0, 'M'], [0.3, ab], [0.72, ab], [1, 'C']] });
      }
      cornerRamps(out);
      return { elems: out, signals: [] };
    },
  },
  turbine2: {
    group: '系統型', name: '二層渦輪', desc: '只用兩層：左轉匝道跨越一條主線、再穿越另一條主線下方，橋短但佔地大', L: 520, Lc: 520,
    main: 'highway', cross: 'highway', M: 0, C: 1,
    build() {
      return twoLevelTurbine(this.geom || TURBINE2_GEOM);
    },
  },
  turbineStack: {
    group: '系統型', name: '渦輪堆疊混合', desc: '兩個左轉以堆疊式高架在中心交叉，另兩個以渦輪式繞行', L: 500, Lc: 500,
    main: 'highway', cross: 'highway', M: 1, C: 2, levels: (M, C) => levelsLoHi(M, C),
    build() {
      const out = [];
      // 堆疊式：小半徑斜穿中心（東行 → 北行、西行 → 南行），走最高層
      const stack = new Path(-330, 0, 1, 0).to(-90, 26, 1, 0).to(26, -90, 0, -1).to(0, -330, 0, -1).pts;
      for (const k of [0, 2]) out.push({ label: '左轉堆疊匝道', type: 'ramp', pts: rotPts(stack, k), prof: [[0, 'M'], [0.3, 'B'], [0.7, 'B'], [1, 'C']] });
      for (const k of [1, 3]) out.push({ label: '左轉渦輪匝道', type: 'ramp', pts: rotPts(turbineLeftPts(), k), prof: [[0, 'C'], [0.3, 'A'], [0.72, 'A'], [1, 'M']] });
      cornerRamps(out);
      return { elems: out, signals: [] };
    },
  },
  windmill: {
    group: '系統型', name: '風車型', desc: '類似渦輪但左轉彎道更急、更靠近中心，佔地較小、容量較低', L: 420, Lc: 420,
    main: 'highway', cross: 'highway', M: 1, C: 2, levels: (M, C) => levelsLoHi(M, C),
    build() {
      const out = [], left = turbineLeftPts(115, 26, 135, 230);
      for (let k = 0; k < 4; k++) {
        const ab = k % 2 ? 'B' : 'A';
        out.push({ label: '左轉匝道', type: 'ramp', pts: rotPts(left, k), prof: k % 2 ? [[0, 'C'], [0.3, ab], [0.72, ab], [1, 'M']] : [[0, 'M'], [0.3, ab], [0.72, ab], [1, 'C']] });
      }
      cornerRamps(out);
      return { elems: out, signals: [] };
    },
  },
  roundabout2: {
    group: '系統型', name: '二層圓環', desc: '主線直行跨越下方沿主線拉長的橢圓環，橫交道路與四條匝道都接到環道', L: 420, Lc: 320,
    main: 'highway', cross: 'avenue', M: 1, C: 0, replaceCross: 62,
    build() {
      const R = { a: 140, b: 62 }, out = [];
      ringElems(out, R, [30, 90, 150, 210, 270, 330], 'C');
      for (const k of [0, 2]) {
        const e = onRing(R, 150), x = onRing(R, 30);
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(new Path(-400, 0, 1, 0).to(e.x, e.y, e.hx, e.hy).pts, k), prof: [[0, 'M'], [1, 'C']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(new Path(x.x, x.y, x.hx, x.hy).to(400, 0, 1, 0).pts, k), prof: [[0, 'C'], [1, 'M']] });
      }
      return { elems: out, signals: [] };
    },
  },
  roundabout3: {
    group: '系統型', name: '三層圓環', desc: '兩條主線分別從圓環上下直行通過，八條匝道全部接到中間層的圓環', L: 440, Lc: 440,
    main: 'highway', cross: 'highway', M: 0, C: 2,
    levels: (M, C) => (Math.abs(M - C) >= 2 ? { R: Math.round((M + C) / 2) } : { error: '三層圓環：兩條主線需相差至少兩層（圓環在中間層）' }),
    build() {
      // 進入角 125°、駛出角 50°，旋轉四次後八個銜接點互不重疊（間隔 15° / 75°）
      const R = 135, out = [], th = [];
      for (let k = 0; k < 4; k++) th.push(125 + 90 * k, 50 + 90 * k);
      ringElems(out, R, th.map(a => ((a % 360) + 360) % 360), 'R');
      const e = onRing(R, 125), x = onRing(R, 50);
      for (let k = 0; k < 4; k++) {
        const from = k % 2 ? 'C' : 'M';
        out.push({ label: '出口匝道', type: 'ramp', pts: rotPts(new Path(-420, 0, 1, 0).to(e.x, e.y, e.hx, e.hy).pts, k), prof: [[0, from], [1, 'R']] });
        out.push({ label: '入口匝道', type: 'ramp', pts: rotPts(new Path(x.x, x.y, x.hx, x.hy).to(420, 0, 1, 0).pts, k), prof: [[0, 'R'], [1, from]] });
      }
      return { elems: out, signals: [] };
    },
  },

  braided: {
    group: '系統型', name: '編織型', desc: '兩條高速公路的雙向車道在中段交叉換邊，左轉變成角落的短直接匝道（左出左進），右轉匝道在編織區外側繞過', L: 500, Lc: 500,
    main: 'highway', cross: 'highway', M: 0, C: 2, freeOnly: true, customRoads: true,
    levels: (M, C) => {
      if (Math.abs(M - C) < 2) return { error: '編織型需要主線與橫交道路相差至少兩層' };
      // 中段四條車道各占一層；編織段（約 100 m）與左轉匝道（約 110 m）都最多只能爬兩層
      let best = null;
      for (let E = -2; E <= 3; E++) for (let W = -2; W <= 3; W++) for (let N = -2; N <= 3; N++) for (let S = -2; S <= 3; S++) {
        if (new Set([E, W, N, S]).size < 4) continue;
        const moves = [E - M, W - M, N - C, S - C], turns = [E - N, S - E, W - S, N - W];
        if (moves.some(d => Math.abs(d) > 2) || turns.some(d => Math.abs(d) > 2)) continue;
        const cost = moves.reduce((a, d) => a + Math.abs(d), 0) + [E, W, N, S].reduce((a, l) => a + (l < 0 ? 3 : 0) + Math.max(0, l - 2), 0);
        if (!best || cost < best.cost) best = { cost, E, W, N, S };
      }
      return best ? { E: best.E, W: best.W, N: best.N, S: best.S } : { error: '這個高度組合無法排出編織型的四層車道' };
    },
    build() {
      const Dz = 45, Sp = 360, L = 500, out = [];
      // 東行車道：分岔 → 外側（y=+10）→ 在 x≈-185 跨越西行車道換到另一側 → 中段 → 再換回 → 匯合
      const eb = new Path(-Sp, 0, 1, 0).to(-320, 10, 1, 0).line(-240, 10).to(-130, -Dz, 1, 0).line(130, -Dz).to(240, 10, 1, 0).line(320, 10).to(Sp, 0, 1, 0).pts;
      const cum = polyCum(eb), len = cum[cum.length - 1];
      const at = x => { for (let i = 1; i < eb.length; i++) if (eb[i].x >= x) return cum[i] / len; return 1; };
      const prof = (base, zone) => [[0, base], [at(-315), base], [at(-215), zone], [at(215), zone], [at(315), base], [1, base]];
      out.push({ label: '東行車道', type: 'freeway1', pts: eb, prof: prof('M', 'E'), role: 'main' });
      out.push({ label: '西行車道', type: 'freeway1', pts: rotPts(eb, 2), prof: prof('M', 'W'), role: 'main' });
      out.push({ label: '北行車道', type: 'freeway1', pts: rotPts(eb, 3), prof: prof('C', 'N'), role: 'cross' });
      out.push({ label: '南行車道', type: 'freeway1', pts: rotPts(eb, 1), prof: prof('C', 'S'), role: 'cross' });
      // 外段（雙向）
      out.push({ label: '主線', type: 'highway', pts: new Path(-L, 0, 1, 0).line(-Sp, 0).pts, prof: [[0, 'M'], [1, 'M']], role: 'main' });
      out.push({ label: '主線', type: 'highway', pts: new Path(Sp, 0, 1, 0).line(L, 0).pts, prof: [[0, 'M'], [1, 'M']], role: 'main' });
      out.push({ label: '橫交道路', type: 'highway', pts: new Path(0, L, 0, -1).line(0, Sp).pts, prof: [[0, 'C'], [1, 'C']], role: 'cross' });
      out.push({ label: '橫交道路', type: 'highway', pts: new Path(0, -Sp, 0, -1).line(0, -L).pts, prof: [[0, 'C'], [1, 'C']], role: 'cross' });
      // 左轉：中段已換邊，左出後在角落轉 90° 由左側併入
      const left = new Path(-115, -Dz, 1, 0).to(-Dz, -115, 0, -1).pts;
      const lv = [['E', 'N'], ['S', 'E'], ['W', 'S'], ['N', 'W']];
      for (let k = 0; k < 4; k++) out.push({ label: '左轉匝道', type: 'ramp', pts: rotPts(left, k), prof: [[0, lv[k][0]], [1, lv[k][1]]] });
      // 右轉：在分岔前離開雙向段，以大半徑繞過整個編織區，在橫交道路的雙向段併入
      // 出口（x=-450）與入口（y=420）錯開，避免相鄰兩條匝道擠在同一個節點
      const right = new Path(-450, 0, 1, 0).to(-380, 32, 1, 0).to(-32, 380, 0, 1).to(0, 420, 0, 1).pts;
      for (let k = 0; k < 4; k++) { const [a, b] = mc(k, 'M', 'C'); out.push({ label: '右轉匝道', type: 'ramp', pts: rotPts(right, k), prof: [[0, a], [1, b]] }); }
      return { elems: out, signals: [] };
    },
  },

  // ======== T 字型（一條道路在主線終止）========
  trumpet: {
    group: 'T 字型', name: '喇叭型', desc: '支線在主線終止：一個環道加一條穿越主線的匝道，所有進出集中在一段', L: 400, Lc: 380, tee: 90,
    main: 'highway', cross: 'highway', M: 1, C: 0,
    build() {
      const out = [];
      // 支線 → 西行：從主線下方穿過後左彎
      out.push({ label: '左轉匝道', type: 'ramp', pts: new Path(0, 90, 0, -1).to(12, 45, 0, -1).line(12, -40).turn(130, -90).to(-380, 0, -1, 0).pts, prof: [[0, 'C'], [0.45, 'C'], [1, 'M']] });
      // 西行 → 支線：右出後 270° 環道，再從主線下方穿到支線
      out.push({ label: '左轉環道', type: 'ramp', pts: new Path(110, 0, -1, 0).to(-55, -24, -1, 0).turn(45, 270).line(-12, 40).to(0, 90, 0, 1).pts, prof: [[0, 'M'], [0.35, 'M'], [0.68, 'C'], [1, 'C']] });
      // 右轉：星形匝道（東行 → 支線、支線 → 東行）
      out.push({ label: '右轉匝道', type: 'ramp', pts: starPts(300), prof: [[0, 'M'], [1, 'C']] });
      out.push({ label: '右轉匝道', type: 'ramp', pts: rotPts(starPts(300), 3), prof: [[0, 'C'], [1, 'M']] });
      return { elems: out, signals: [] };
    },
  },
  semiT: {
    group: 'T 字型', name: '半定向 T', desc: '兩個左轉都以高架匝道直接轉向跨越主線，無環道、無交織', L: 460, Lc: 420, tee: 260,
    main: 'highway', cross: 'highway', M: 0, C: 0, levels: () => ({ A: 1, B: 2 }),
    build() {
      const out = [];
      // 支線 → 西行：沿支線東側北上跨越主線，再以大半徑左彎併入西行
      const up = new Path(0, 260, 0, -1).to(14, 170, 0, -1).line(14, -20).turn(170, -90).to(-440, 0, -1, 0).pts;
      out.push({ label: '左轉高架匝道', type: 'ramp', pts: up, prof: [[0, 'C'], [0.24, 'A'], [0.62, 'A'], [1, 'M']] });
      // 西行 → 支線：與上一條左右對稱（鏡射後反向），在主線北側中央以不同高度與它交叉
      const down = up.map(p => ({ x: -p.x, y: p.y })).reverse();
      out.push({ label: '左轉高架匝道', type: 'ramp', pts: down, prof: [[0, 'M'], [0.38, 'B'], [0.76, 'B'], [1, 'C']] });
      // 右轉：星形匝道（左轉高架匝道從上方跨越）
      out.push({ label: '右轉匝道', type: 'ramp', pts: starPts(330), prof: [[0, 'M'], [1, 'C']] });
      out.push({ label: '右轉匝道', type: 'ramp', pts: rotPts(starPts(330), 3), prof: [[0, 'C'], [1, 'M']] });
      return { elems: out, signals: [] };
    },
  },
};

// 二層渦輪的幾何參數（由 tests/interchange.test.js 的搜尋找出可行解）
const TURBINE2_GEOM = { P: 230, w: 34, r: 250, S: 380 };
function twoLevelTurbine(gm) {
  const out = [];
  const left = turbineLeftPts(gm.P, gm.w, gm.r, gm.S);
  const len = polyCum(left).at(-1);
  const fm = crossFrac(left, 'y'), fc = crossFrac(left, 'x');
  const d = 28 / len;
  for (let k = 0; k < 4; k++) {
    // 由主線出發：先以「C 層」跨越主線、再以「M 層」穿越橫交道路下方；由橫交道路出發則相反
    const [a, b] = mc(k, 'M', 'C');
    out.push({ label: '左轉匝道', type: 'ramp', pts: rotPts(left, k),
      prof: [[0, a], [fm - d, b], [fm + d, b], [fc - d, a], [fc + d, a], [1, b]] });
  }
  cornerRamps(out);
  return { elems: out, signals: [] };
}
export { twoLevelTurbine, crossFrac, turbineLeftPts };

// 主線與橫交道路的長度依匝道實際範圍決定（最外側匝道再往外延伸約 70 m）
for (const t of Object.values(TEMPLATES)) {
  if (t.customRoads) continue;
  let ex = 0, ey = 0;
  for (const e of t.build().elems) for (const q of e.pts) { ex = Math.max(ex, Math.abs(q.x)); ey = Math.max(ey, t.tee ? q.y : Math.abs(q.y)); }
  t.L = Math.max(300, Math.ceil((ex + 70) / 10) * 10);
  t.Lc = Math.max(300, Math.ceil((ey + 70) / 10) * 10);
}

export const TEMPLATE_ORDER = ['diamond', 'parcloA', 'parcloB', 'ddi', 'spui', 'cloverleaf', 'cloverstack', 'turbine', 'turbine2', 'turbineStack', 'windmill', 'braided', 'roundabout2', 'roundabout3', 'trumpet', 'semiT'];

// 模板在區域座標中的完整元素（含主線與橫交道路）
export function templateElems(key) {
  const t = TEMPLATES[key];
  const b = t.build();
  const roads = [];
  if (t.customRoads) {
    // 模板自行提供主線與橫交道路（例如編織型的分離車道）
    const roleOf = e => e.role === 'main' || e.role === 'cross';
    return { roads: b.elems.filter(roleOf), elems: b.elems.filter(e => !roleOf(e)), signals: b.signals };
  }
  roads.push({ label: '主線', type: t.main, pts: new Path(-t.L, 0, 1, 0).line(t.L, 0).pts, prof: [[0, 'M'], [1, 'M']], role: 'main' });
  if (t.tee) {
    roads.push({ label: '支線', type: t.cross, pts: new Path(0, t.Lc, 0, -1).line(0, t.tee).pts, prof: [[0, 'C'], [1, 'C']], role: 'cross' });
  } else if (t.crossStops) {
    roads.push({ label: '橫交道路', type: t.cross, pts: new Path(0, t.Lc, 0, -1).line(0, t.crossStops).pts, prof: [[0, 'C'], [1, 'C']], role: 'cross' });
    roads.push({ label: '橫交道路', type: t.cross, pts: new Path(0, -t.crossStops, 0, -1).line(0, -t.Lc).pts, prof: [[0, 'C'], [1, 'C']], role: 'cross' });
  } else if (t.replaceCross) {
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
  if (fr.M === fr.C && !t.tee) return { error: '主線與橫交道路需在不同高度' };
  if (t.levels) {
    const extra = t.levels(fr.M, fr.C);
    if (extra.error) return extra;
    Object.assign(L, extra);
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
  return { lines, cost: interchangePrice(cost), levelError: lv.error };
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
  // 中途的半成品會暫時接不上，單行道檢查留到全部建完再做
  const made = net.deferOneWay = [];
  const r = buildPieces(net, list, fr, lv, snapPt);
  net.deferOneWay = null;
  if (!r.ok) return r;
  cost += r.cost;
  for (const sg of signals) {
    const p = toWorld(fr, sg);
    const n = net.nodeNear(p.x, p.y, 12, lv[sg.lv]);
    if (n && n.segs.length >= 3) n.control = 'signal';
  }
  net.rebuild();
  net.checkOneWay(made);
  return { ok: true, cost };
}

function buildPieces(net, list, fr, lv, snapPt) {
  let cost = 0;
  for (const e of list) {
    const pts = e.pts.map(p => toWorld(fr, p));
    const cum = polyCum(pts), len = cum[cum.length - 1];
    for (let i = 0; i < e.prof.length - 1; i++) {
      const s0 = e.prof[i][0] * len, s1 = e.prof[i + 1][0] * len;
      const h0 = lv[e.prof[i][1]], h1 = lv[e.prof[i + 1][1]];
      const piece = cutPoly(pts, cum, s0, s1);
      const a = snapPt(piece[0], h0, true), b = snapPt(piece[piece.length - 1], h1, true);
      const plan = net.planRoad(a, b, null, e.type, h0, { pts: piece, hA: h0, hB: h1, ring: !!e.ring });
      if (!plan.ok) return { ok: false, reason: `${e.label}：${plan.reason}`, at: piece[0] };
      net.executeRoad(plan);
      cost += plan.cost;
    }
  }
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

// 交流道整組優惠價：依道路造價換算到 $45,000～$60,000（越大越貴）
export function interchangePrice(raw) {
  const t = Math.min(1, Math.max(0, (raw - 60000) / 200000));
  return Math.round((45000 + 15000 * t) / 500) * 500;
}

// 建造交流道：先在複製的路網上試建，全部成功才在真正的路網上建造（以整組價格計費）
export function placeInterchange(game, key, fr) {
  if (!fr.ok) return { ok: false, reason: fr.reason };
  if (fr.snap && (TEMPLATES[key].freeOnly || TEMPLATES[key].tee)) return { ok: false, reason: `${TEMPLATES[key].name}只能在空地上建造（會一併建出主線）` };
  const dry = buildOn(cloneNetwork(game), key, fr);
  if (!dry.ok) return dry;
  const price = interchangePrice(dry.cost);
  if (!game.canAfford(price)) return { ok: false, reason: `資金不足（$${price.toLocaleString()}）` };
  const spend = game.spend;
  game.spend = () => {};
  let real;
  try { real = buildOn(game.net, key, fr); } finally { game.spend = spend; }
  if (!real.ok) return real;
  game.spend(price);
  return { ok: true, cost: price, raw: real.cost };
}

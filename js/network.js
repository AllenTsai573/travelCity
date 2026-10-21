// 道路網路：節點、路段、車道、路口車道連接、號誌、建造與拆除
import {
  polyCum, pointAt, cutPoly, offsetPoly, cubicPts, quadPts, polyIntersections, closestOnPoly,
  polyBBox, bboxOverlap, clamp, dist, arcCurve,
} from './util.js';
import { ROAD_TYPES, LANE_W, SLOPE_LEN, levelMul } from './config.js';

let LANE_UID = 1, CONN_UID = 1;
const TURN_BONUS = { S: 3, MR: 2, ML: 2, R: 1, L: 0, U: 0 };

export function halfWidth(type) {
  const t = typeof type === 'string' ? ROAD_TYPES[type] : type;
  return (t.fwd + t.bwd) * LANE_W / 2 + (t.bwd > 0 ? (t.median || 0) / 2 : 0) + 0.8;
}

// 車道相對於 a→b 中心線的側向位移（正值 = a→b 方向的右側）
export function laneOffset(t, dir, idx) {
  if (t.bwd === 0) return (idx - (t.fwd - 1) / 2) * LANE_W;
  const o = (t.median || 0) / 2 + (idx + 0.5) * LANE_W;
  return dir > 0 ? o : -o;
}

function endTangent(lane) {
  const p = pointAt(lane.pts, lane.cum, lane.len);
  return { x: p.dx, y: p.dy };
}
function startTangent(lane) {
  const p = pointAt(lane.pts, lane.cum, 0);
  return { x: p.dx, y: p.dy };
}

// 支路（匝道）在主線的右側或左側：取支路離開節點一段距離（最多 150 m）處的實際路線來判斷
// （車道端點可能還壓在主線路面上，用它判斷會出錯）
function sideOf(node, branchSeg, mainLane, atStart) {
  const atA = branchSeg.a === node.id;
  const d = Math.min(150, branchSeg.len * 0.5);
  const q = pointAt(branchSeg.pts, branchSeg.cum, atA ? d : branchSeg.len - d);
  // 以主線中心線（節點）為基準，而不是偏在一側的車道
  const p = { x: node.x, y: node.y };
  const t = atStart ? startTangent(mainLane) : endTangent(mainLane);
  return (q.x - p.x) * -t.y + (q.y - p.y) * t.x > 0 ? 1 : -1;
}
function mergeSide(inL, outL, node) {
  if (node) return sideOf(node, inL.seg, outL.lanes[0], true) > 0 ? 'MR' : 'ML';
  const o = outL.lanes[0], p = o.pts[0], t = startTangent(o);
  const q = inL.lanes[0].pts[inL.lanes[0].pts.length - 1];
  return (q.x - p.x) * -t.y + (q.y - p.y) * t.x > 0 ? 'MR' : 'ML';
}

// 直行時車道靠內側對齊：車道數減少時由最外側車道併入（四轉三），增加時新車道從外側長出
function alignLanes(n, m) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([i, Math.min(i, m - 1)]);
  for (let j = n; j < m; j++) out.push([n - 1, j]);
  return out;
}

function mapLanes(A, B) {
  const n = A.length, m = B.length, out = new Map();
  const add = (i, j) => out.set(i + ':' + j, [i, j]);
  for (let i = 0; i < n; i++) {
    if (n === 1) { for (const j of B) add(A[0], j); continue; }
    add(A[i], B[m === 1 ? 0 : Math.round(i * (m - 1) / (n - 1))]);
  }
  for (let j = 0; j < m; j++) {
    if (m === 1) { for (const i of A) add(i, B[0]); continue; }
    add(A[n === 1 ? 0 : Math.round(j * (n - 1) / (m - 1))], B[j]);
  }
  return [...out.values()];
}
const range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };

export class Network {
  constructor(game) {
    this.game = game;
    this.nodes = new Map();
    this.segs = new Map();
    this.links = new Map();
    this.nextId = 1;
    this.version = 0;
    this.signalNodes = [];
    this.pendingTransfers = [];
  }
  newId() { return this.nextId++; }

  // ---------- 基本建立 ----------
  addNode(x, y, level = 0, id = null) {
    const n = {
      id: id ?? this.newId(), x, y, level, segs: [], control: 'auto', signal: null, sigScheme: 'each', sigAdaptive: true,
      sigDur: {}, yieldOverride: {}, custom: null, outside: false, conns: [], radius: 0,
    };
    if (id !== null) this.nextId = Math.max(this.nextId, id + 1);
    this.nodes.set(n.id, n);
    return n;
  }

  addSegment(A, B, typeKey, pts, opts = {}) {
    const T = ROAD_TYPES[typeKey];
    pts = pts.map(p => ({ x: p.x, y: p.y }));
    pts[0] = { x: A.x, y: A.y };
    pts[pts.length - 1] = { x: B.x, y: B.y };
    const cum = polyCum(pts);
    const id = opts.id ?? this.newId();
    if (opts.id) this.nextId = Math.max(this.nextId, id + 1);
    const seg = {
      id, a: A.id, b: B.id, type: typeKey, T, pts, cum, len: cum[cum.length - 1], ring: !!opts.ring,
      // 分區格線的起算位移：路段被切開或反向時沿用，格子才不會跑掉
      go: opts.go || 0,
      lanes: [], links: {}, ra: 0, rb: 0, core: null, coreCum: null, bbox: polyBBox(pts, halfWidth(T) + 2),
    };
    for (const dir of [1, -1]) {
      const nl = dir > 0 ? T.fwd : T.bwd;
      const limit = T.speed / 3.6;
      const link = {
        key: id * 2 + (dir > 0 ? 0 : 1), seg, dir, lanes: [], len: seg.len, limit, flow: limit, eff: limit,
        next: new Map(), from: dir > 0 ? A.id : B.id, to: dir > 0 ? B.id : A.id, count: 0,
      };
      for (let i = 0; i < nl; i++) {
        const lane = {
          kind: 'lane', uid: LANE_UID++, seg, dir, idx: i, link, pts: null, cum: null, len: 0, vehs: [], conns: [],
          outLinks: new Set(), dead: false, speed: limit, h0: 0, h1: 0, drawLevel: 0, replacement: null,
        };
        link.lanes.push(lane);
        seg.lanes.push(lane);
      }
      seg.links[dir] = link;
      this.links.set(link.key, link);
    }
    A.segs.push(id);
    B.segs.push(id);
    this.segs.set(id, seg);
    return seg;
  }

  removeSegment(seg, { despawn = true, keepNodes = false } = {}) {
    if (!this.segs.has(seg.id)) return;
    for (const lane of seg.lanes) {
      lane.dead = true;
      if (despawn && lane.vehs.length && this.game.traffic) this.game.traffic.despawnAll([...lane.vehs]);
    }
    for (const dir of [1, -1]) this.links.delete(seg.links[dir].key);
    this.segs.delete(seg.id);
    for (const nid of [seg.a, seg.b]) {
      const n = this.nodes.get(nid);
      if (!n) continue;
      n.segs = n.segs.filter(s => s !== seg.id);
      delete n.yieldOverride[seg.id];
      if (n.custom) n.custom = null;
      if (!keepNodes && n.segs.length === 0 && !n.outside) this.nodes.delete(nid);
    }
  }

  segHeightAt(seg, u) {
    const A = this.nodes.get(seg.a), B = this.nodes.get(seg.b);
    return A.level + (B.level - A.level) * clamp(u / seg.len, 0, 1);
  }

  segDrawLevel(seg) {
    const A = this.nodes.get(seg.a), B = this.nodes.get(seg.b);
    const hi = Math.max(A.level, B.level), lo = Math.min(A.level, B.level);
    if (hi > 0) return hi;
    if (hi < 0) return lo;
    return 0;
  }

  // 路段在節點處朝外的單位方向
  segDirAt(seg, nodeId) {
    const d = Math.min(6, seg.len / 2);
    if (seg.a === nodeId) {
      const p = pointAt(seg.pts, seg.cum, d);
      return { x: p.x - seg.pts[0].x, y: p.y - seg.pts[0].y, len: d };
    }
    const p = pointAt(seg.pts, seg.cum, seg.len - d);
    const e = seg.pts[seg.pts.length - 1];
    return { x: p.x - e.x, y: p.y - e.y, len: d };
  }

  inLinks(node) {
    const r = [];
    for (const sid of node.segs) {
      const s = this.segs.get(sid);
      if (!s) continue;
      const L = s.b === node.id ? s.links[1] : s.links[-1];
      if (L.lanes.length) r.push(L);
    }
    return r;
  }
  outLinks(node) {
    const r = [];
    for (const sid of node.segs) {
      const s = this.segs.get(sid);
      if (!s) continue;
      const L = s.a === node.id ? s.links[1] : s.links[-1];
      if (L.lanes.length) r.push(L);
    }
    return r;
  }

  // ---------- 幾何重建 ----------
  // 路口型態：找出直通主線；其餘道路都以小角度貼著主線者為「匝道路口」
  junctionInfo(node) {
    const segs = node.segs.map(id => this.segs.get(id)).filter(Boolean);
    const info = { ring: segs.some(s => s.ring), pairs: [], others: [], ramp: false, mainDir: null };
    if (segs.length < 3) return info;
    const dirs = segs.map(s => { const d = this.segDirAt(s, node.id); const L = Math.hypot(d.x, d.y) || 1; return { s, x: d.x / L, y: d.y / L }; });
    const cand = [];
    for (let a = 0; a < dirs.length; a++) for (let b = a + 1; b < dirs.length; b++) {
      const dot = dirs[a].x * dirs[b].x + dirs[a].y * dirs[b].y;
      if (dot < -0.906) cand.push({ a: dirs[a], b: dirs[b], st: -dot });
    }
    cand.sort((p, q) => q.st - p.st);
    const used = new Set(), pairs = [];
    for (const c of cand) if (!used.has(c.a) && !used.has(c.b)) { pairs.push([c.a, c.b]); used.add(c.a); used.add(c.b); }
    const others = dirs.filter(d => !used.has(d));
    info.pairs = pairs.map(([a, b]) => [a.s, b.s]);
    info.others = others.map(o => o.s);
    info.ramp = !info.ring && pairs.length === 1 && others.length > 0 &&
      others.every(o => Math.abs(o.x * pairs[0][0].x + o.y * pairs[0][0].y) > 0.766);
    if (pairs.length) info.mainDir = { x: pairs[0][0].x, y: pairs[0][0].y };
    return info;
  }

  // 匝道在節點處的截斷距離：走到匝道完全離開主線路面為止
  rampTrim(node, seg, info) {
    const main = info.pairs[0];
    const mainHW = Math.max(halfWidth(main[0].T), halfWidth(main[1].T));
    const need = mainHW + halfWidth(seg.T) + 0.3;
    const atA = seg.a === node.id;
    const maxT = seg.len * 0.45;
    // 以實際主線路面（而非通過節點的直線）量測匝道是否已離開主線
    const distMain = p => Math.min(...main.map(m => closestOnPoly(m.pts, m.cum, p).d));
    for (let t = 2; t < maxT; t += 1) {
      const p = pointAt(seg.pts, seg.cum, atA ? t : seg.len - t);
      if (distMain(p) >= need) return t;
    }
    return maxT;
  }

  computeRadius(node) {
    // 匝道路口：主線直通，只需很短的銜接區（匝道本身在離開主線路面處才截斷）
    if (node.jinfo && node.jinfo.ramp) {
      // 主線車道數在此改變（例如匝道匯入後三轉四）：需要較長的漸變段
      const [m1, m2] = node.jinfo.pairs[0];
      if (m1.T.fwd !== m2.T.fwd || m1.T.bwd !== m2.T.bwd || m1.T.median !== m2.T.median) return Math.max(halfWidth(m1.T), halfWidth(m2.T)) * 1.4 + 4;
      return 4;
    }
    const segs = node.segs.map(id => this.segs.get(id)).filter(Boolean);
    if (segs.length <= 1) return 0;
    let maxHW = 0;
    for (const s of segs) maxHW = Math.max(maxHW, halfWidth(s.T));
    // 只有場內道路相接（停車場 / 園區車道的交叉口與轉角）：像真的停車場一樣用小轉角，
    // 否則每段車道會被路口吃掉大半（19 m 的車道只剩 4 m，連一台車都放不下，車子一格一格慢慢挪）
    if (segs.every(s => s.T.internal)) {
      if (segs.length === 2) {
        const d1 = this.segDirAt(segs[0], node.id), d2 = this.segDirAt(segs[1], node.id);
        if ((d1.x * d2.x + d1.y * d2.y) / ((Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) || 1) < -0.985) return 0.3;
        return maxHW * 0.8 + 1;
      }
      return maxHW + 0.5;
    }
    if (segs.length === 2) {
      const [s1, s2] = segs;
      const d1 = this.segDirAt(s1, node.id), d2 = this.segDirAt(s2, node.id);
      const c = (d1.x * d2.x + d1.y * d2.y) / ((Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) || 1);
      const sameLanes = s1.T.fwd + s1.T.bwd === s2.T.fwd + s2.T.bwd && s1.T.median === s2.T.median;
      if (sameLanes && c < -0.985) return 0.3;
      // 急彎：銜接區依夾角加長，否則內外車道的端點會交錯，各車道的連接線互相交叉（並排的車會重疊）
      const ang = Math.acos(clamp(c, -1, 1)), bend = (maxHW + 1) / Math.tan(Math.max(ang, 0.2) / 2) + 2;
      // 車道數不同：拉長銜接區，讓路面逐漸收窄 / 加寬
      if (!sameLanes) return clamp(Math.max(maxHW * 1.4 + 4, bend), 0, 60);
      return clamp(Math.max(maxHW * 0.9 + 2.5, bend), 0, 60);
    }
    // 路口範圍依最小夾角決定：斜交路口的重疊區較長，車道需在重疊區外才開始
    let minAng = Math.PI;
    const dirs = segs.map(sg => { const d = this.segDirAt(sg, node.id); const L = Math.hypot(d.x, d.y) || 1; return { x: d.x / L, y: d.y / L }; });
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
      minAng = Math.min(minAng, Math.acos(clamp(dirs[i].x * dirs[j].x + dirs[i].y * dirs[j].y, -1, 1)));
    }
    return clamp((maxHW + 1) / Math.tan(Math.max(minAng, 0.2) / 2) + 2, maxHW + 3, 45);
  }

  updateSegGeom(seg) {
    const A = this.nodes.get(seg.a), B = this.nodes.get(seg.b);
    seg.ra = A.trims && A.trims.has(seg.id) ? A.trims.get(seg.id) : Math.min(A.radius, seg.len * 0.42);
    seg.rb = B.trims && B.trims.has(seg.id) ? B.trims.get(seg.id) : Math.min(B.radius, seg.len * 0.42);
    if (seg.ra + seg.rb > seg.len - 2) { const k = (seg.len - 2) / (seg.ra + seg.rb); seg.ra *= k; seg.rb *= k; }
    seg.core = cutPoly(seg.pts, seg.cum, seg.ra, seg.len - seg.rb);
    seg.coreCum = polyCum(seg.core);
    seg.coreLen = seg.coreCum[seg.coreCum.length - 1];
    seg.drawLevel = this.segDrawLevel(seg);
    seg.bbox = polyBBox(seg.pts, halfWidth(seg.T) + 2);
    for (const lane of seg.lanes) {
      let p = offsetPoly(seg.core, laneOffset(seg.T, lane.dir, lane.idx));
      if (lane.dir < 0) p = p.reverse();
      const oldLen = lane.len;
      lane.pts = p;
      lane.cum = polyCum(p);
      lane.len = Math.max(0.5, lane.cum[lane.cum.length - 1]);
      if (oldLen > 0 && Math.abs(oldLen - lane.len) > 0.01) for (const v of lane.vehs) v.s *= lane.len / oldLen;
      lane.h0 = lane.dir > 0 ? A.level : B.level;
      lane.h1 = lane.dir > 0 ? B.level : A.level;
      lane.drawLevel = seg.drawLevel;
    }
    for (const dir of [1, -1]) seg.links[dir].len = seg.len;
  }

  segUToLaneS(lane, u) {
    const seg = lane.seg;
    let f = clamp((u - seg.ra) / (seg.len - seg.ra - seg.rb || 1), 0, 1);
    if (lane.dir < 0) f = 1 - f;
    return f * lane.len;
  }
  laneSToSegU(lane, s) {
    const seg = lane.seg;
    let f = clamp(s / lane.len, 0, 1);
    if (lane.dir < 0) f = 1 - f;
    return seg.ra + f * (seg.len - seg.ra - seg.rb);
  }

  rebuild() {
    for (const n of this.nodes.values()) n.jinfo = this.junctionInfo(n);
    for (const n of this.nodes.values()) {
      n.radius = this.computeRadius(n);
      n.trims = null;
      if (n.jinfo.ramp) {
        n.trims = new Map();
        for (const o of n.jinfo.others) n.trims.set(o.id, this.rampTrim(n, o, n.jinfo));
      }
    }
    for (const s of this.segs.values()) this.updateSegGeom(s);
    for (const n of this.nodes.values()) { for (const c of n.conns) c.dead = true; n.conns = []; }
    for (const s of this.segs.values()) for (const l of s.lanes) { l.conns = []; l.outLinks.clear(); }
    for (const n of this.nodes.values()) {
      this.genConnections(n);
      this.computeConflicts(n);
      this.ensureSignal(n);
    }
    for (const L of this.links.values()) L.next.clear();
    for (const n of this.nodes.values()) {
      let maxScore = -Infinity;
      for (const c of n.conns) maxScore = Math.max(maxScore, c.score);
      for (const c of n.conns) {
        c.from.conns.push(c);
        c.from.outLinks.add(c.to.link.key);
        const delay = n.control === 'signal' ? 9 : n.control === 'stop' ? 5 : (c.conflicts.length && c.score < maxScore ? 2.5 : 0.2);
        // 死路迴轉：除非沒有其他路線，否則駕駛不會選擇（成本要高於「前方塞住」的繞行加成，
        // 否則停車場出口稍微塞住時，車子會開到旁邊車道的盡頭迴轉再回來）
        const cost = c.len / c.speed + delay + (c.turn === 'U' ? 300 : 0) + (c.pen || 0);
        const L = c.from.link, prev = L.next.get(c.to.link.key);
        if (prev === undefined || cost < prev) L.next.set(c.to.link.key, cost);
      }
    }
    this.signalNodes = [...this.nodes.values()].filter(n => n.control === 'signal' && n.signal);
    this.version++;
    if (this.game.city) this.game.city.afterRebuild();
    if (this.game.traffic) {
      this.game.traffic.onRebuild();
      if (this.pendingTransfers.length) {
        this.game.traffic.applyTransfers(this.pendingTransfers);
        this.pendingTransfers = [];
      }
    }
  }

  approachRank(node, link) {
    const seg = link.seg;
    let r = seg.T.rank + (seg.ring ? 5 : 0);
    const o = node.yieldOverride[seg.id];
    if (o === 'yield') r -= 10;
    else if (o === 'prio') r += 10;
    return r;
  }

  makeConn(node, from, to, turn) {
    const P0 = from.pts[from.pts.length - 1], P3 = to.pts[0];
    const t0 = endTangent(from), t3 = startTangent(to);
    const d = Math.hypot(P3.x - P0.x, P3.y - P0.y);
    const ang = Math.acos(clamp(t0.x * t3.x + t0.y * t3.y, -1, 1));
    const pts = arcCurve(P0, t0, P3, t3, 8, 0.75, turn === 'U');
    const cum = polyCum(pts);
    let vmax = Math.min(from.speed, to.speed);
    if (ang > 0.15 && d > 0.05) {
      const R = d / (2 * Math.sin(ang / 2) + 1e-6);
      vmax = Math.min(vmax, Math.max(4, Math.sqrt(2.4 * R)));
    }
    if (turn === 'U') vmax = 4;
    const c = {
      kind: 'conn', uid: CONN_UID++, node, from, to, pts, cum, len: Math.max(0.01, cum[cum.length - 1]),
      vehs: [], turn, conflicts: [], siblings: [], score: 0, speed: vmax, dead: false, drawLevel: node.level,
    };
    c.score = this.approachRank(node, from.link) * 10 + TURN_BONUS[turn];
    return c;
  }

  genConnections(node) {
    const ins = this.inLinks(node), outs = this.outLinks(node);
    if (!ins.length || !outs.length) return;
    // 自訂車道連接
    if (node.custom) {
      const conns = [];
      let ok = true;
      for (const [fs, fd, fi, ts, td, ti, turn] of node.custom) {
        const S1 = this.segs.get(fs), S2 = this.segs.get(ts);
        const from = S1 && S1.links[fd].lanes[fi], to = S2 && S2.links[td].lanes[ti];
        if (!from || !to || from.link.to !== node.id || to.link.from !== node.id) { ok = false; break; }
        conns.push(this.makeConn(node, from, to, turn || 'S'));
      }
      if (ok) { node.conns = conns; return; }
      node.custom = null;
    }
    const deadEnd = node.segs.length === 1;
    const per = new Map();
    for (const inL of ins) {
      const dIn = endTangent(inL.lanes[0]);
      const cands = [];
      for (const outL of outs) {
        if (outL.seg === inL.seg) {
          if (deadEnd && !node.outside) cands.push({ outL, ang: Math.PI, cls: 'U' });
          continue;
        }
        // 鐵路與道路之間沒有車道連接（平交道上車輛與列車各自直行）
        if (!!outL.seg.T.rail !== !!inL.seg.T.rail) continue;
        const dOut = startTangent(outL.lanes[0]);
        const ang = Math.atan2(dIn.x * dOut.y - dIn.y * dOut.x, dIn.x * dOut.x + dIn.y * dOut.y);
        if (Math.abs(ang) > 2.45) continue; // 超過 140° 的急轉不允許（會畫成打結的迴圈）
        // 環道接環道視為直行（沿圓環行駛），所有環道車道都可繼續繞行
        const ringCont = inL.seg.ring && outL.seg.ring;
        cands.push({ outL, ang, cls: ringCont || Math.abs(ang) < 0.55 ? 'S' : ang > 0 ? 'R' : 'L' });
      }
      per.set(inL, cands);
    }
    // 大型停車場 / 停車樓的單向出入口（service1 接一般道路）：盡量右進右出，左轉進出在尋路時加重成本（pen），
    // 只有沒有別的路時才會左轉（例如停車場在通往地圖邊緣的路上，右轉出去只會離開城市）
    // （左轉進出的車會停在主要道路上等，排隊回堵到出口時整個停車場會卡死）
    for (const [inL, cands] of per) for (const c of cands) {
      const o = c.outL, oneIn = o.seg.type === 'service1' && !inL.seg.T.internal, oneOut = inL.seg.type === 'service1' && !o.seg.T.internal;
      if ((oneIn || oneOut) && c.ang < -0.55) c.pen = 240;
    }
    // 同一進入方向有多個直行 → 角度最小者為直行，其餘依方向判為左/右轉（分流）
    for (const cands of per.values()) {
      const S = cands.filter(c => c.cls === 'S');
      if (S.length > 1) {
        S.sort((a, b) => Math.abs(a.ang) - Math.abs(b.ang));
        for (const c of S.slice(1)) c.cls = c.ang > 0 ? 'R' : 'L';
      }
    }
    // 多個進入方向直行匯入同一出口 → 匯流
    for (const outL of outs) {
      const list = [];
      for (const [inL, cands] of per) for (const c of cands) if (c.outL === outL && c.cls === 'S') list.push({ inL, c });
      if (list.length > 1) {
        list.sort((a, b) => (Math.abs(a.c.ang) - Math.abs(b.c.ang)) + (b.inL.seg.T.rank - a.inL.seg.T.rank) * 0.3);
        for (const { inL, c } of list.slice(1)) c.cls = mergeSide(inL, c.outL);
      }
    }
    // 匝道路口：依匝道「位置」在主線哪一側決定匯入 / 分出車道（不能只看行進方向）
    if (node.jinfo && node.jinfo.ramp) {
      const main = new Set(node.jinfo.pairs[0]);
      // 匝道與主線之間不允許近乎迴轉的連接（例如匝道直接接到對向車道）
      for (const [inL, cands] of per) {
        for (let i = cands.length - 1; i >= 0; i--) {
          const c = cands[i];
          if (main.has(inL.seg) !== main.has(c.outL.seg) && Math.abs(c.ang) > 1.6) cands.splice(i, 1);
        }
      }
      for (const [inL, cands] of per) for (const c of cands) {
        const inMain = main.has(inL.seg), outMain = main.has(c.outL.seg);
        if (!inMain && outMain) c.cls = mergeSide(inL, c.outL, node);
        else if (inMain && !outMain) c.cls = sideOf(node, c.outL.seg, inL.lanes[0], false) > 0 ? 'R' : 'L';
      }
    }
    // 封閉式雙向道路（快速道路 / 高速公路）：其他道路只能接同側車道，
    // 不允許左轉橫越對向車道（不論匝道角度）
    if (node.jinfo && node.jinfo.pairs.length === 1) {
      const main = new Set(node.jinfo.pairs[0]);
      const ms = node.jinfo.pairs[0][0];
      // 場內道路（停車場、園區車道）雖然不能沿線建築，但不是封閉式道路，可以左轉
      if (ms.T.bwd > 0 && ((!ms.T.access && !ms.T.internal) || node.jinfo.ramp)) {
        for (const [inL, cands] of per) {
          for (let i = cands.length - 1; i >= 0; i--) {
            const c = cands[i];
            if (main.has(inL.seg) !== main.has(c.outL.seg) && (c.cls === 'L' || c.cls === 'ML')) cands.splice(i, 1);
          }
        }
      }
    }
    const conns = [];
    for (const [inL, cands] of per) {
      const n = inL.lanes.length;
      const hasS = cands.some(c => c.cls === 'S' || c.cls === 'MR' || c.cls === 'ML');
      const hasL = cands.some(c => c.cls === 'L'), hasR = cands.some(c => c.cls === 'R');
      for (const c of cands) {
        const m = c.outL.lanes.length;
        let inIdx, outIdx;
        if ((cands.length === 1 && c.cls !== 'MR' && c.cls !== 'ML') || c.cls === 'S' || c.cls === 'U') { inIdx = range(0, n); outIdx = range(0, m); }
        else if (c.cls === 'MR') { inIdx = range(0, n); outIdx = range(Math.max(0, m - n), m); }
        else if (c.cls === 'ML') { inIdx = range(0, n); outIdx = range(0, Math.min(n, m)); }
        else if (c.cls === 'R' && inL.seg.ring && !c.outL.seg.ring) {
          // 圓環出口：內外環車道都可駛出
          inIdx = range(0, n); outIdx = range(0, m);
        } else if (c.cls === 'R') {
          inIdx = hasS ? [n - 1] : hasL ? (n >= 2 ? range(Math.floor(n / 2), n) : [0]) : range(0, n);
          outIdx = inIdx.length > 1 ? range(0, m) : [m - 1];
        } else {
          inIdx = hasS ? [0] : hasR ? (n >= 2 ? range(0, Math.ceil(n / 2)) : [0]) : range(0, n);
          outIdx = inIdx.length > 1 ? range(0, m) : [0];
        }
        const straight = c.cls === 'S' || (cands.length === 1 && c.cls !== 'MR' && c.cls !== 'ML' && c.cls !== 'U');
        const pairs = straight && inIdx.length === n && outIdx.length === m ? alignLanes(n, m) : mapLanes(inIdx, outIdx);
        for (const [i, j] of pairs) { const cn = this.makeConn(node, inL.lanes[i], c.outL.lanes[j], c.cls); if (c.pen) cn.pen = c.pen; conns.push(cn); }
      }
    }
    node.conns = conns;
  }

  computeConflicts(node) {
    const cs = node.conns;
    for (const c of cs) { c.conflicts = []; c.siblings = []; }
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i];
      for (let j = i + 1; j < cs.length; j++) {
        const b = cs[j];
        if (a.from === b.from) continue;
        if (a.to === b.to) {
          a.conflicts.push({ c: b, type: 'merge' });
          b.conflicts.push({ c: a, type: 'merge' });
          continue;
        }
        // 交叉：記下交叉點在兩條連接線上的位置（at：自己、other：對方），已經開過交叉點的車不會擋住別人
        const ints = polyIntersections(a.pts, a.cum, b.pts, b.cum);
        if (ints.length) {
          const sa = Math.max(...ints.map(t => t.sA)), sb = Math.max(...ints.map(t => t.sB));
          a.conflicts.push({ c: b, type: 'cross', at: sa, other: sb });
          b.conflicts.push({ c: a, type: 'cross', at: sb, other: sa });
        }
      }
    }
    for (const c of cs) c.siblings = cs.filter(o => o.to === c.to && o !== c);
  }

  ensureSignal(node) {
    if (node.control !== 'signal') { node.signal = null; return; }
    const ins = this.inLinks(node);
    if (ins.length < 2) { node.signal = null; return; }
    const sig = ins.map(l => l.key).sort((a, b) => a - b).join(',') + '|' + node.sigScheme;
    const old = node.signal;
    if (old && old.sig === sig) {
      for (const p of old.phases) p.set = new Set(p.links);
      return;
    }
    let groups;
    if (node.sigScheme === 'pairs') {
      const heading = l => { const t = endTangent(l.lanes[0]); return Math.atan2(t.y, t.x); };
      const left = [...ins];
      groups = [];
      while (left.length) {
        const a = left.shift();
        let best = -1, bd = 0.7;
        for (let k = 0; k < left.length; k++) {
          let d = Math.abs(heading(a) - heading(left[k]));
          if (d > Math.PI) d = 2 * Math.PI - d;
          const off = Math.abs(Math.PI - d);
          if (off < bd) { bd = off; best = k; }
        }
        if (best >= 0) groups.push([a, left.splice(best, 1)[0]]);
        else groups.push([a]);
      }
    } else groups = ins.map(l => [l]);
    const phases = groups.map((g, i) => {
      const links = g.map(l => l.key);
      const dur = node.sigDur[i] || 18;
      return { links, dur, set: new Set(links) };
    });
    node.signal = { sig, phases, cur: 0, state: 'green', t: 0 };
  }

  // ---------- 查詢 ----------
  nodeNear(x, y, r, level = null) {
    let best = null, bd = r;
    for (const n of this.nodes.values()) {
      if (level !== null && n.level !== level) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  segNear(x, y, tol, level = null) {
    let best = null;
    const pt = { x, y };
    for (const s of this.segs.values()) {
      const b = s.bbox;
      if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) continue;
      const c = closestOnPoly(s.pts, s.cum, pt);
      const lim = level === 'any' ? halfWidth(s.T) + tol : tol;
      if (c.d > lim) continue;
      const h = this.segHeightAt(s, c.s);
      if (level !== null && level !== 'any' && Math.abs(h - level) > 0.3) continue;
      const score = c.d - (level === 'any' ? s.drawLevel * 2 : 0);
      if (!best || score < best.score) best = { seg: s, u: c.s, d: c.d, x: c.x, y: c.y, h, score };
    }
    return best;
  }

  // ---------- 編輯操作 ----------
  splitSegment(seg, u) {
    const A = this.nodes.get(seg.a), B = this.nodes.get(seg.b);
    if (u < 1.5) return A;
    if (u > seg.len - 1.5) return B;
    const p = pointAt(seg.pts, seg.cum, u);
    const N = this.addNode(p.x, p.y, Math.round(this.segHeightAt(seg, u)));
    const s1 = this.addSegment(A, N, seg.type, cutPoly(seg.pts, seg.cum, 0, u), { ring: seg.ring, go: seg.go });
    const s2 = this.addSegment(N, B, seg.type, cutPoly(seg.pts, seg.cum, u, seg.len), { ring: seg.ring, go: seg.go + u });
    for (const lane of seg.lanes) {
      for (const v of lane.vehs) {
        const uv = this.laneSToSegU(lane, v.s);
        const tgt = uv < u ? s1 : s2;
        this.pendingTransfers.push({ v, seg: tgt, dir: lane.dir, idx: lane.idx, u: uv < u ? uv : uv - u });
      }
      lane.vehs = [];
      lane.replacement = (lane.dir > 0 ? s1 : s2).links[lane.dir].lanes[lane.idx];
    }
    for (const nid of [seg.a, seg.b]) {
      const n = this.nodes.get(nid);
      const o = n.yieldOverride[seg.id];
      if (o) n.yieldOverride[nid === seg.a ? s1.id : s2.id] = o;
    }
    if (this.game.city) this.game.city.onSegmentSplit(seg, s1, s2, u);
    this.removeSegment(seg, { despawn: false, keepNodes: true });
    return N;
  }

  replaceSegment(seg, typeKey, reverse = false) {
    const A = this.nodes.get(seg.a), B = this.nodes.get(seg.b);
    const pts = reverse ? [...seg.pts].reverse() : seg.pts;
    const ns = reverse ? this.addSegment(B, A, typeKey, pts, { ring: seg.ring, go: -(seg.go + seg.len) }) : this.addSegment(A, B, typeKey, pts, { ring: seg.ring, go: seg.go });
    const T = ROAD_TYPES[typeKey];
    for (const lane of seg.lanes) {
      const nd = reverse ? -lane.dir : lane.dir;
      const nl = ns.links[nd].lanes;
      const rep = nl.length ? nl[Math.min(lane.idx, nl.length - 1)] : null;
      lane.replacement = rep;
      for (const v of lane.vehs) {
        if (!rep) { this.game.traffic && this.game.traffic.despawnAll([v]); continue; }
        let uv = this.laneSToSegU(lane, v.s);
        if (reverse) uv = seg.len - uv;
        this.pendingTransfers.push({ v, seg: ns, dir: nd, idx: rep.idx, u: uv });
      }
      lane.vehs = [];
    }
    if (this.game.city) this.game.city.onSegmentReplaced(seg, ns, reverse, T);
    this.removeSegment(seg, { despawn: false, keepNodes: true });
    return ns;
  }

  // 規劃道路：回傳可行性、成本與交叉點
  // opts.pts：自訂完整折線（交流道模板用）；opts.hA / opts.hB：未吸附端點的高度
  planRoad(a, b, ctrl, typeKey, level, opts = {}) {
    const T = ROAD_TYPES[typeKey];
    const g = this.game, terrain = g.terrain;
    const res = { ok: false, reason: '', cost: 0, a, b, ctrl, typeKey, crossings: [], demolish: [], ring: !!opts.ring };
    const hOf = s => {
      if (s.node) return this.nodes.get(s.node).level;
      if (s.seg) {
        const seg = this.segs.get(s.seg);
        const h = this.segHeightAt(seg, s.u);
        if (Math.abs(h - Math.round(h)) > 0.2) return NaN;
        return Math.round(h);
      }
      return null;
    };
    const hA = hOf(a) ?? opts.hA ?? level, hB = hOf(b) ?? opts.hB ?? level;
    res.hA = hA; res.hB = hB;
    let pts;
    if (opts.pts) {
      pts = opts.pts.map(p => ({ x: p.x, y: p.y }));
      pts[0] = { x: a.x, y: a.y };
      pts[pts.length - 1] = { x: b.x, y: b.y };
    } else if (ctrl) {
      const est = dist(a, ctrl) + dist(ctrl, b);
      pts = quadPts(a, ctrl, b, clamp(Math.ceil(est / 8), 6, 48));
    } else pts = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    const cum = polyCum(pts), len = cum[cum.length - 1];
    res.pts = pts; res.cum = cum; res.len = len;
    const fail = r => { res.reason = r; return res; };
    if (Number.isNaN(hA) || Number.isNaN(hB)) return fail('無法連接在坡道中段');
    if (a.node && b.node && a.node === b.node) return fail('起點與終點相同');
    if (len < 10) return fail('道路太短');
    for (const p of pts) if (!terrain.inBounds(p.x, p.y, 2)) return fail('超出地圖範圍');
    if (Math.abs(hB - hA) * SLOPE_LEN > len) return fail(`坡度太陡（每層需 ${SLOPE_LEN} 公尺）`);
    if (ctrl || opts.pts) {
      // 曲率限制
      for (let i = 1; i < pts.length - 1; i++) {
        const v1x = pts[i].x - pts[i - 1].x, v1y = pts[i].y - pts[i - 1].y;
        const v2x = pts[i + 1].x - pts[i].x, v2y = pts[i + 1].y - pts[i].y;
        const ang = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
        const segL = (Math.hypot(v1x, v1y) + Math.hypot(v2x, v2y)) / 2;
        if (ang > 0.01 && segL / ang < 12) return fail('彎道太急');
      }
    }
    const related = s => {
      for (const sn of [a, b]) {
        if (sn.seg === s.id) return true;
        if (sn.node && (s.a === sn.node || s.b === sn.node)) return true;
      }
      return false;
    };
    const bb = polyBBox(pts, 2);
    const crossings = [];
    for (const s of this.segs.values()) {
      if (!bboxOverlap(bb, s.bbox)) continue;
      const ints = polyIntersections(pts, cum, s.pts, s.cum);
      for (const it of ints) {
        const hNew = hA + (hB - hA) * it.sA / len;
        const hOld = this.segHeightAt(s, it.sB);
        const dh = Math.abs(hNew - hOld);
        if (it.sA < 3 || it.sA > len - 3) {
          if (!related(s) && dh < 0.85) return fail('太靠近其他道路');
          continue;
        }
        if (dh < 0.3) {
          if (Math.abs(hNew - Math.round(hNew)) > 0.3 || Math.abs(hOld - Math.round(hOld)) > 0.3) return fail('無法在坡道上交會');
          crossings.push({ sA: it.sA, x: it.x, y: it.y, h: Math.round(hOld), seg: s.id, u: it.sB });
        } else if (dh < 0.85) return fail('與既有道路高度衝突');
      }
    }
    crossings.sort((p, q) => p.sA - q.sA);
    const merged = [];
    for (const c of crossings) {
      const last = merged[merged.length - 1];
      if (last && c.sA - last.sA < 2) continue;
      merged.push(c);
    }
    // 道路的起點 / 終點只比交叉的道路多出一小截（< 12 m）：直接停在交叉點，
    // 不會留下一段短短的死路、也不會多出一個十字路口（變成 T 字路口）
    if (!opts._trimmed && merged.length) {
      const first = merged[0], last = merged[merged.length - 1];
      let trimS = !a.node && !a.seg && first.sA < 12, trimE = !b.node && !b.seg && len - last.sA < 12;
      if (trimS && trimE && first === last) { if (first.sA < len - last.sA) trimE = false; else trimS = false; }
      if (trimS || trimE) {
        const s0 = trimS ? first.sA : 0, s1 = trimE ? last.sA : len;
        if (s1 - s0 >= 10) {
          const na = trimS ? { x: first.x, y: first.y, seg: first.seg, u: first.u } : a;
          const nb = trimE ? { x: last.x, y: last.y, seg: last.seg, u: last.u } : b;
          return this.planRoad(na, nb, null, typeKey, level, { ...opts, pts: cutPoly(pts, cum, s0, s1), _trimmed: true });
        }
      }
    }
    const stops = [0, ...merged.map(c => c.sA), len];
    for (let i = 0; i < stops.length - 1; i++) if (stops[i + 1] - stops[i] < 6) return fail('交叉點太近');
    for (const c of merged) {
      const s = this.segs.get(c.seg);
      if (c.u > 1.5 && c.u < s.len - 1.5 && (c.u < 6 || c.u > s.len - 6)) return fail('太靠近既有路口');
    }
    res.crossings = merged;
    // 水域與成本
    let cost = 0;
    const hw = halfWidth(T);
    const dem = new Set();
    const steps = Math.max(1, Math.ceil(len / 4));
    for (let i = 0; i <= steps; i++) {
      const s = len * i / steps;
      const p = pointAt(pts, cum, s);
      const h = hA + (hB - hA) * s / len;
      if (Math.abs(h) < 0.5 && terrain.isWater(p.x, p.y)) return fail('地面道路無法跨越水域（請改用高架或隧道）');
      if (i > 0) {
        const lv = Math.round(h);
        cost += (len / steps) * T.cost * (h > 0 && h < 1 || h < 0 && h > -1 ? (levelMul(lv) + 1) / 2 : levelMul(lv));
      }
      if (Math.abs(h) < 0.5 && g.city) for (const bd of g.city.buildingsNear(p.x, p.y, hw + 1)) dem.add(bd);
    }
    res.cost = Math.round(cost + dem.size * 500);
    res.demolish = [...dem];
    if (!g.canAfford(res.cost)) return fail('資金不足');
    res.ok = true;
    return res;
  }

  resolveSnap(sn, h) {
    if (sn.node && this.nodes.has(sn.node)) return this.nodes.get(sn.node);
    const near = this.nodeNear(sn.x, sn.y, 2, h);
    if (near) return near;
    if (sn.seg) {
      const r = this.segNear(sn.x, sn.y, 2, h);
      if (r) return this.splitSegment(r.seg, r.u);
    }
    return this.addNode(sn.x, sn.y, h);
  }

  executeRoad(plan) {
    const g = this.game;
    const nA = this.resolveSnap(plan.a, plan.hA);
    const mids = plan.crossings.map(c => this.resolveSnap({ x: c.x, y: c.y, seg: c.seg }, c.h));
    const nB = this.resolveSnap(plan.b, plan.hB);
    const seq = [{ n: nA, s: 0 }, ...mids.map((n, i) => ({ n, s: plan.crossings[i].sA })), { n: nB, s: plan.len }];
    const made = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const p = seq[i], q = seq[i + 1];
      if (p.n === q.n) continue;
      // 只有形狀相同（中點重合）才視為重複道路；兩端相同但路線不同（例如對向匝道）仍要建造
      const piece = cutPoly(plan.pts, plan.cum, p.s, q.s);
      const pc = polyCum(piece), mid = pointAt(piece, pc, pc[pc.length - 1] / 2);
      const exists = [...this.segs.values()].some(s => ((s.a === p.n.id && s.b === q.n.id) || (s.b === p.n.id && s.a === q.n.id)) &&
        Math.abs(s.len - (q.s - p.s)) < 3 && Math.hypot(pointAt(s.pts, s.cum, s.len / 2).x - mid.x, pointAt(s.pts, s.cum, s.len / 2).y - mid.y) < 3);
      if (exists) continue;
      made.push(this.addSegment(p.n, q.n, plan.typeKey, piece, { ring: plan.ring }));
    }
    if (g.city) for (const b of plan.demolish) g.city.removeBuilding(b);
    if (g.city && g.city.onRoadBuilt) g.city.onRoadBuilt(made);
    for (const s of made) {
      if (s.drawLevel === 0) g.terrain.clearTreesAlong(s.pts, halfWidth(s.T) + 3);
    }
    g.spend(plan.cost);
    this.rebuild();
    // 一次建造多條路（交流道）時，等全部完成再檢查
    if (this.deferOneWay) this.deferOneWay.push(...made); else this.checkOneWay(made);
    return nB;
  }

  // 單行道 / 匝道若在路口接不上（例如方向與主線不符），提示玩家
  checkOneWay(segs) {
    for (const sg of segs) {
      if (!this.segs.has(sg.id) || sg.T.bwd > 0) continue;
      const A = this.nodes.get(sg.a), B = this.nodes.get(sg.b);
      const L = sg.links[1];
      const exitOK = B.segs.length < 2 || L.lanes.some(l => l.conns.length);
      const entryOK = A.segs.length < 2 || A.conns.some(c => c.to.seg === sg);
      if (!exitOK || !entryOK) {
        this.game.notify && this.game.notify(`這條${sg.T.name}${!entryOK ? '無法駛入' : '無法駛出'}：靠右行駛時，匝道 / 單行道要接在主線行進方向的右側`, 'warn');
        return;
      }
    }
  }

  // 圓環
  planRoundabout(x, y, R, nodeId) {
    const g = this.game;
    const res = { ok: false, reason: '', cost: 0, x, y, R, nodeId, cuts: [] };
    const fail = r => { res.reason = r; return res; };
    const node = nodeId ? this.nodes.get(nodeId) : null;
    if (node) { x = node.x; y = node.y; res.x = x; res.y = y; }
    if (node && (node.level !== 0 || node.outside)) return fail('只能在地面路口建造圓環');
    for (let k = 0; k < 32; k++) {
      const a = k / 32 * Math.PI * 2;
      const px = x + Math.cos(a) * R, py = y + Math.sin(a) * R;
      if (!g.terrain.inBounds(px, py, 5)) return fail('超出地圖範圍');
      if (g.terrain.isWater(px, py)) return fail('圓環不可建在水上');
    }
    const incident = new Set(node ? node.segs : []);
    for (const s of this.segs.values()) {
      if (incident.has(s.id)) continue;
      if (s.drawLevel !== 0 && Math.min(this.nodes.get(s.a).level, this.nodes.get(s.b).level) > 0) continue;
      const c = closestOnPoly(s.pts, s.cum, { x, y });
      if (c.d < R + halfWidth(s.T) + 4) return fail('與其他道路重疊');
    }
    if (node) {
      for (const sid of node.segs) {
        const s = this.segs.get(sid);
        let found = -1;
        for (let t = 0; t <= s.len; t += 1) {
          const p = pointAt(s.pts, s.cum, s.a === node.id ? t : s.len - t);
          if (Math.hypot(p.x - x, p.y - y) >= R) { found = t; break; }
        }
        if (found < 0 || found > s.len - 12) return fail('連接道路太短');
        const u = s.a === node.id ? found : s.len - found;
        if (Math.abs(this.segHeightAt(s, u)) > 0.2) return fail('連接道路不在地面');
        res.cuts.push({ seg: sid, u, fromA: s.a === node.id });
      }
    }
    const ring = R < 26 ? 'oneway1' : 'oneway2';
    res.ringType = ring;
    res.cost = Math.round(2 * Math.PI * R * ROAD_TYPES[ring].cost * 1.2 + 2000);
    res.demolish = g.city ? g.city.buildingsNear(x, y, R + halfWidth(ring) + 2) : [];
    if (!g.canAfford(res.cost)) return fail('資金不足');
    res.ok = true;
    return res;
  }

  executeRoundabout(plan) {
    const g = this.game;
    const { x, y, R } = plan;
    const ringNodes = [];
    if (plan.nodeId) {
      const center = this.nodes.get(plan.nodeId);
      for (const cut of plan.cuts) {
        const s = this.segs.get(cut.seg);
        if (!s) continue;
        const N = this.splitSegment(s, cut.u);
        const inner = [...this.segs.values()].find(q => (q.a === center.id && q.b === N.id) || (q.b === center.id && q.a === N.id));
        if (inner) this.removeSegment(inner, { despawn: true, keepNodes: true });
        ringNodes.push(N);
      }
      center.segs = [];
      this.nodes.delete(center.id);
    }
    let angs = ringNodes.map(n => ({ n, a: Math.atan2(n.y - y, n.x - x) }));
    angs.sort((p, q) => p.a - q.a);
    const filled = [];
    const addAt = a => filled.push({ n: this.addNode(x + Math.cos(a) * R, y + Math.sin(a) * R, 0), a });
    if (angs.length === 0) { for (let k = 0; k < 4; k++) addAt(-Math.PI + k * Math.PI / 2 + Math.PI / 4); }
    else {
      for (let i = 0; i < angs.length; i++) {
        const cur = angs[i], nxt = angs[(i + 1) % angs.length];
        filled.push(cur);
        let gap = nxt.a - cur.a;
        if (i === angs.length - 1) gap += Math.PI * 2;
        const k = Math.max(0, Math.ceil(gap / (Math.PI * 0.55)) - 1);
        for (let j = 1; j <= k; j++) addAt(cur.a + gap * j / (k + 1));
      }
    }
    filled.sort((p, q) => p.a - q.a);
    // 逆時針（畫面上角度遞減）行駛
    for (let i = 0; i < filled.length; i++) {
      const from = filled[i], to = filled[(i - 1 + filled.length) % filled.length];
      let a0 = from.a, a1 = to.a;
      if (a1 >= a0) a1 -= Math.PI * 2;
      const steps = Math.max(3, Math.ceil((a0 - a1) / (Math.PI / 24)));
      const pts = [];
      for (let k = 0; k <= steps; k++) {
        const a = a0 + (a1 - a0) * k / steps;
        pts.push({ x: x + Math.cos(a) * R, y: y + Math.sin(a) * R });
      }
      this.addSegment(from.n, to.n, plan.ringType, pts, { ring: true });
    }
    if (g.city) for (const b of plan.demolish) g.city.removeBuilding(b);
    g.terrain.clearTreesCircle(x, y, R + 12);
    g.spend(plan.cost);
    this.rebuild();
  }

  bulldoze(seg) {
    const A = this.nodes.get(seg.a), B = this.nodes.get(seg.b);
    if ((A.outside && A.segs.length === 1) || (B.outside && B.segs.length === 1)) return '無法拆除外部連線';
    if (this.game.city) this.game.city.onSegmentRemoved(seg);
    this.removeSegment(seg);
    this.rebuild();
    return null;
  }

  // ---------- 序列化 ----------
  serialize() {
    const r2 = v => Math.round(v * 100) / 100;
    return {
      nextId: this.nextId,
      nodes: [...this.nodes.values()].map(n => ({
        id: n.id, x: r2(n.x), y: r2(n.y), level: n.level, control: n.control, sigScheme: n.sigScheme,
        sigAdaptive: n.sigAdaptive, sigDur: n.signal ? Object.fromEntries(n.signal.phases.map((p, i) => [i, p.dur])) : n.sigDur,
        yieldOverride: n.yieldOverride, custom: n.custom, outside: n.outside,
      })),
      segs: [...this.segs.values()].map(s => ({ id: s.id, a: s.a, b: s.b, type: s.type, ring: s.ring, go: s.go ? r2(s.go) : undefined, pts: s.pts.map(p => [r2(p.x), r2(p.y)]) })),
    };
  }
  load(data) {
    for (const n of data.nodes) {
      const N = this.addNode(n.x, n.y, n.level, n.id);
      Object.assign(N, {
        control: n.control, sigScheme: n.sigScheme || 'each', sigAdaptive: n.sigAdaptive !== false, sigDur: n.sigDur || {},
        yieldOverride: n.yieldOverride || {}, custom: n.custom || null, outside: !!n.outside,
      });
    }
    for (const s of data.segs) {
      this.addSegment(this.nodes.get(s.a), this.nodes.get(s.b), s.type, s.pts.map(([x, y]) => ({ x, y })), { id: s.id, ring: s.ring, go: s.go || 0 });
    }
    this.nextId = Math.max(this.nextId, data.nextId);
    this.rebuild();
  }
}

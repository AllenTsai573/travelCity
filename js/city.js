// 簡化城市經濟：住宅需要工作與購物、工廠需要工人與原料、商店需要商品與顧客
import { TRIP_SCALE, ZONES, ZONE_TYPES, CELL, SHOP_KINDS, INDUSTRY_KINDS, MILESTONES, ROAD_TYPES, levelMul } from './config.js';
import { pointAt, convexOverlap, pointInPoly, distToSeg, clamp, polyBBox, bboxOverlap } from './util.js';
import { halfWidth } from './network.js';

const ema = (a, x, k) => a + (x - a) * k;

// 需要場內道路的建築：工業園區（主幹道＋大園區的橫向道路）與附停車場的商業（從臨路開進停車場的車道）
// 回傳車道終點與橫向道路離路邊的距離（公尺），與 lotart.js 的配置一致
export function driveway(zone, kind, geo) {
  const d = geo.d;
  if (geo.rows < 5 || geo.cols < 3) return null;
  if (zone === 'I') return { end: d - 6, cross: geo.rows >= 10 ? d * 0.55 : null, through: true };
  if (zone !== 'C') return null;
  if (kind === 'bigbox') return { end: d * 0.45 - 4 };
  if (kind === 'mall' || kind === 'market') return { end: d * 0.32 - 4 };
  if (kind === 'parking') return { end: d - 6, through: true };
  if (kind === 'shops' && geo.rows >= 6) return { end: d - 6, through: true };
  return null;
}
const gauss = (h, mu, sd) => Math.exp(-0.5 * ((h - mu) / sd) ** 2) / (sd * 2.5066);

export class City {
  constructor(game) {
    this.game = game;
    this.buildings = [];
    this.lots = [];        // 已劃設、尚未發展的分區地塊
    this.byId = new Map();
    this.nextId = 1;
    this.outside = [];
    this.scheduled = [];
    this.hourT = 0;
    this.growT = 0;
    this.demand = { R: 0.7, C: 0.3, I: 0.4 };
    this.pop = 0; this.jobsC = 0; this.jobsI = 0;
    this.stats = { trips: 0, fails: 0, through: 0, tripTimeSum: 0, hourTrips: 0, hourFails: 0, hourIncome: 0, hourExpense: 0, lastIncome: 0, lastExpense: 0, lastTrips: 0, lastFails: 0 };
    this.history = [];
    this.accThrough = new Map();
  }

  // ---------- 地塊 ----------
  // 沿路段 seg 在 u 處（臨路邊的中點）、side 側，寬 cols 格、深 rows 格的長方形地塊
  lotGeom(seg, u, side, cols, rows) {
    const p = pointAt(seg.pts, seg.cum, u);
    const nx = -p.dy * side, ny = p.dx * side;
    const off = halfWidth(seg.T) + 1.5;
    const w = cols * CELL, d = rows * CELL;
    const cx = p.x + nx * (off + d / 2), cy = p.y + ny * (off + d / 2);
    const tx = p.dx, ty = p.dy, hw = w / 2, hd = d / 2;
    // 0：臨路左、1：臨路右、2：後方右、3：後方左
    const corners = [
      { x: cx - tx * hw - nx * hd, y: cy - ty * hw - ny * hd },
      { x: cx + tx * hw - nx * hd, y: cy + ty * hw - ny * hd },
      { x: cx + tx * hw + nx * hd, y: cy + ty * hw + ny * hd },
      { x: cx - tx * hw + nx * hd, y: cy - ty * hw + ny * hd },
    ];
    return { x: cx, y: cy, angle: Math.atan2(ty, tx), corners, nx, ny, tx, ty, w, d, cols, rows, rad: Math.hypot(hw, hd) };
  }

  // 由角點與方向重建地塊幾何（園區建築的臨路路段可能已被切開）
  geomFrom(x0, y0, tx, ty, nx, ny, cols, rows) {
    const w = cols * CELL, d = rows * CELL, P = (a, v) => ({ x: x0 + tx * a + nx * v, y: y0 + ty * a + ny * v });
    const c = P(w / 2, d / 2);
    return { x: c.x, y: c.y, angle: Math.atan2(ty, tx), corners: [P(0, 0), P(w, 0), P(w, d), P(0, d)], nx, ny, tx, ty, w, d, cols, rows, rad: Math.hypot(w / 2, d / 2) };
  }

  canPlaceLot(seg, u, side, cols, rows, skip = null) {
    const g = this.game, net = g.net;
    if (!seg.T.access) return '此道路類型不可沿線建築';
    if (net.nodes.get(seg.a).level !== 0 || net.nodes.get(seg.b).level !== 0) return '需沿地面道路建築';
    const w = cols * CELL;
    if (u < seg.ra + w / 2 - 0.5 || u > seg.len - seg.rb - w / 2 + 0.5) return '太靠近路口';
    const geo = this.lotGeom(seg, u, side, cols, rows);
    // 水域與地圖邊界：每格檢查一次
    for (let i = 0; i <= cols; i++) for (let j = 0; j <= rows; j++) {
      const c = geo.corners[0], x = c.x + geo.tx * i * CELL + geo.nx * j * CELL, y = c.y + geo.ty * i * CELL + geo.ny * j * CELL;
      if (!g.terrain.inBounds(x, y, 2)) return '超出地圖範圍';
      if (g.terrain.isWater(x, y)) return '不可建在水上';
    }
    // 稍微內縮，讓相鄰地塊可以共用邊界
    const inset = geo.corners.map(p => ({ x: geo.x + (p.x - geo.x) * (1 - 0.6 / geo.rad), y: geo.y + (p.y - geo.y) * (1 - 0.6 / geo.rad) }));
    for (const b of [...this.buildings, ...this.lots]) {
      if (b === skip || Math.abs(b.x - geo.x) > b.rad + geo.rad || Math.abs(b.y - geo.y) > b.rad + geo.rad) continue;
      if (convexOverlap(b.corners, inset)) return b.built === false ? '與其他分區重疊' : '與其他建築重疊';
    }
    const bb = polyBBox(geo.corners, 0);
    for (const s of net.segs.values()) {
      if (s.drawLevel !== 0) continue;
      const hw = halfWidth(s.T) + 0.5;
      if (!bboxOverlap(bb, s.bbox)) continue;
      for (let t = 0; t <= s.len; t += 3) {
        const p = pointAt(s.pts, s.cum, t);
        if (pointInPoly(p, inset)) return '與道路重疊';
        for (let i = 0; i < 4; i++) if (distToSeg(p, inset[i], inset[(i + 1) % 4]) < hw) return '與道路重疊';
      }
    }
    return null;
  }

  // 路段上第一條分區格線的位置（u），之後每 CELL 公尺一格
  gridStart(seg) {
    const go = seg.go || 0;
    return Math.ceil((seg.ra + go) / CELL - 1e-6) * CELL - go;
  }

  // 一次拖曳的範圍：路段 seg 的 side 側、從 u0 到 u1、深 rows 格，依分區的最大地塊平均切成數塊
  planStroke(zt, seg, side, u0, u1, rows) {
    const Z = ZONE_TYPES[zt];
    // 起點對齊格線
    const g0 = this.gridStart(seg);
    const a = g0 + Math.max(0, Math.ceil((Math.min(u0, u1) - g0) / CELL - 1e-6)) * CELL, b = Math.min(Math.max(u0, u1), seg.len - seg.rb);
    const total = Math.floor((b - a) / CELL + 1e-6);
    // 所有地塊最小 2×2 格
    if (total < 2) return [];
    const n = Math.min(Math.ceil(total / Z.max), Math.floor(total / 2)), depth = clamp(rows, 2, Z.max), res = [];
    let start = a;
    for (let i = 0; i < n; i++) {
      const cols = Math.floor(total / n) + (i < total % n ? 1 : 0);
      const u = start + cols * CELL / 2;
      let r = depth, reason = null;
      for (; r >= 2; r--) { reason = this.canPlaceLot(seg, u, side, cols, r); if (!reason) break; }
      const ok = r >= 2;
      res.push({ zt, seg, u, side, cols, rows: ok ? r : depth, ok, reason, geo: this.lotGeom(seg, u, side, cols, ok ? r : depth) });
      start += cols * CELL;
    }
    return res;
  }

  addLot(zt, seg, u, side, cols, rows) {
    const geo = this.lotGeom(seg, u, side, cols, rows);
    const l = { id: this.nextId++, built: false, zt, zone: ZONE_TYPES[zt].zone, seg: seg.id, u, side, ...geo, born: this.game.time };
    this.lots.push(l);
    this.game.terrain.clearTreesCircle(geo.x, geo.y, geo.rad * 0.6);
    return l;
  }
  removeLot(l) { this.lots = this.lots.filter(x => x !== l); }
  lotAt(x, y) {
    const p = { x, y };
    for (const l of this.lots) if (Math.abs(l.x - x) < l.rad && Math.abs(l.y - y) < l.rad && pointInPoly(p, l.corners)) return l;
    return null;
  }

  // 地塊開始發展成建築（依分區與大小決定建築種類）
  develop(l, level = 1) {
    const net = this.game.net, seg = net.segs.get(l.seg);
    if (!seg) { this.removeLot(l); return null; }
    this.removeLot(l);
    const geo = this.lotGeom(seg, l.u, l.side, l.cols, l.rows);
    const kind = this.pickKind(l.zt, l.cols, l.rows);
    const plan = driveway(l.zone, kind, geo);
    const roads = plan ? this.buildParkRoads(geo, seg, l.u, plan) : null;
    const b = this.addBuilding(l.zt, seg, l.u, l.side, l.cols, l.rows, level, kind, geo);
    if (roads) {
      // 臨路的位置可能因開路而被切開，改記最近的臨路路段
      const c = geo.corners[0], m = { x: c.x + geo.tx * geo.w / 2 - geo.nx * 2, y: c.y + geo.ty * geo.w / 2 - geo.ny * 2 };
      const fr = net.segNear(m.x - geo.nx * (halfWidth(seg.T) - 0.5), m.y - geo.ny * (halfWidth(seg.T) - 0.5), 6, 0);
      b.front = fr ? { seg: fr.seg.id, u: fr.u } : null;
      b.roads = roads.segs; b.seg = roads.access.seg; b.u = roads.access.u;
      if (roads.gate) { b.gate = roads.gate; this.applyGate(b); }
    }
    return b;
  }

  // 場內道路：工業園區的主幹道（深的再加橫向道路）、停車場的車道；員工、貨車與顧客都開進去
  buildParkRoads(geo, seg, u, plan) {
    const g = this.game, net = g.net;
    const P = (a, v) => ({ x: geo.corners[0].x + geo.tx * a + geo.nx * v, y: geo.corners[0].y + geo.ty * a + geo.ny * v });
    const spend = g.spend, can = g.canAfford;
    g.spend = () => {}; g.canAfford = () => true;
    const build = (a, b) => {
      const plan = net.planRoad(a, b, null, 'service', 0);
      if (!plan.ok) return false;
      plan.demolish = [];
      net.executeRoad(plan);
      return true;
    };
    const before = new Set(net.segs.keys());
    let gate = null;
    try {
      const fp = pointAt(seg.pts, seg.cum, u);
      if (!build({ x: fp.x, y: fp.y, seg: seg.id, u }, P(geo.w / 2, plan.end))) return null;
      if (plan.cross) build(P(6, plan.cross), P(geo.w - 6, plan.cross));
      net.rebuild();
      // 地塊後方緊鄰另一條道路：打通，但在後方出口設閘門（只有進出這裡的車可以走，避免被當捷徑）
      const back = P(geo.w / 2, geo.d + 2), sn = plan.through ? net.segNear(back.x, back.y, 14, 0) : null;
      if (sn && !sn.seg.T.internal && sn.seg.id !== seg.id && sn.seg.a !== seg.a && sn.seg.b !== seg.b && sn.seg.a !== seg.b && sn.seg.b !== seg.a &&
          Math.hypot(sn.x - back.x, sn.y - back.y) < halfWidth(sn.seg.T) + 6) {
        if (build(P(geo.w / 2, plan.end), { x: sn.x, y: sn.y, seg: sn.seg.id, u: sn.u })) {
          net.rebuild();
          const gp = P(geo.w / 2, geo.d - 1.5);
          gate = { x: gp.x, y: gp.y, dx: geo.nx, dy: geo.ny };
        }
      }
    } finally { g.spend = spend; g.canAfford = can; }
    const segs = [...net.segs.values()].filter(s => s.type === 'service' && !before.has(s.id)).map(s => s.id);
    const q = P(geo.w / 2, Math.max(8, plan.end - 6)), acc = net.segNear(q.x, q.y, 4, 0);
    if (!segs.length || !acc) return null;
    return { segs, access: { seg: acc.seg.id, u: acc.u }, gate };
  }
  applyGate(b) {
    const net = this.game.net;
    for (const id of b.roads || []) { const s = net.segs.get(id); if (s) s.gate = b.gate ? b.id : null; }
    net.rebuild();
  }
  parkRoadSet() { const set = new Set(); for (const b of this.buildings) if (b.roads) for (const id of b.roads) set.add(id); return set; }
  removeParkRoads(b) {
    const net = this.game.net;
    if (!b.roads || !b.roads.length) return;
    for (const id of b.roads) { const s = net.segs.get(id); if (s) net.removeSegment(s); }
    b.roads = null;
    net.rebuild();
  }

  pickKind(zt, cols, rows) {
    const rng = this.game.rng, zone = ZONE_TYPES[zt].zone;
    if (zone === 'C') {
      const m = Math.min(cols, rows), x = rng.next();
      if (m >= SHOP_KINDS.bigbox.minCells) return rng.pick(['bigbox', 'bigbox', 'mall', 'hotel', 'office', 'market']);
      if (m >= 5) return x < 0.2 ? 'hotel' : x < 0.42 ? 'office' : x < 0.48 ? 'parking' : cols * rows >= 60 && x < 0.75 ? 'market' : 'shops';
      if (m >= 4 && x < 0.2) return 'office';
      if (m >= 3 && x < 0.38) return 'gas';
      return m >= 4 && x < 0.44 ? 'parking' : 'shops';
    }
    if (zone === 'I') return rng.pick(Object.keys(INDUSTRY_KINDS));
    return null;
  }

  addBuilding(zt, seg, u, side, cols, rows, level = 1, kind = null, geo = null) {
    geo = geo || this.lotGeom(seg, u, side, cols, rows);
    const zone = ZONE_TYPES[zt].zone;
    const b = {
      id: this.nextId++, built: true, zone, zt, kind: kind || this.pickKind(zt, cols, rows), seg: seg.id, u, side, level, ...geo,
      streetPark: seg.T.rank <= 1 && !seg.T.internal,
      happy: 0.7, workOK: 0.8, shopOK: 0.8, timeScore: 0.8, pollution: 0, noise: 0,
      workSat: 0.7, goodsSat: 1, custSat: 0.6, matSat: 1, stock: zone === 'R' ? 0 : 8, custLevel: 0, present: 0,
      // 起始累計量隨機，讓各棟建築的出發時間錯開
      acc: { work: this.game.rng.next(), shop: this.game.rng.next(), goods: this.game.rng.next(), mat: this.game.rng.next(), outw: this.game.rng.next() },
      queue: [], spawnCD: 0, highT: 0, lowT: 0,
      abandoned: false, abT: 0, variant: (this.nextId * 7919) % 5, dead: false, born: this.game.time,
    };
    this.buildings.push(b);
    this.byId.set(b.id, b);
    this.game.terrain.clearTreesCircle(geo.x, geo.y, geo.rad * 0.8);
    return b;
  }

  // keepZone：建築消失但分區保留（例如廢棄後拆除），之後可再發展；withRoads：一併拆除園區道路
  removeBuilding(b, keepZone = false, withRoads = keepZone) {
    if (b.dead) return;
    b.dead = true;
    this.buildings = this.buildings.filter(x => x !== b);
    this.byId.delete(b.id);
    if (withRoads) this.removeParkRoads(b);
    if (keepZone) {
      const f = b.front, seg = this.game.net.segs.get(f ? f.seg : b.seg);
      if (seg) this.addLot(b.zt, seg, f ? f.u : b.u, b.side, b.cols, b.rows);
    }
  }

  // 新道路經過的空地塊直接取消分區
  onRoadBuilt(segs) {
    for (const s of segs) {
      if (s.drawLevel !== 0) continue;
      const hw = halfWidth(s.T) + 0.5;
      for (const l of [...this.lots]) {
        if (!bboxOverlap(polyBBox(l.corners, hw), s.bbox)) continue;
        for (let t = 0; t <= s.len; t += 3) {
          const p = pointAt(s.pts, s.cum, t);
          if (pointInPoly(p, l.corners) || [0, 1, 2, 3].some(i => distToSeg(p, l.corners[i], l.corners[(i + 1) % 4]) < hw)) { this.removeLot(l); break; }
        }
      }
    }
  }

  buildingsNear(x, y, r) {
    const res = [], p = { x, y };
    for (const b of this.buildings) {
      if (Math.abs(b.x - x) > r + b.rad || Math.abs(b.y - y) > r + b.rad) continue;
      if (pointInPoly(p, b.corners)) { res.push(b); continue; }
      for (let i = 0; i < 4; i++) if (distToSeg(p, b.corners[i], b.corners[(i + 1) % 4]) < r) { res.push(b); break; }
    }
    return res;
  }

  buildingAt(x, y) {
    const p = { x, y };
    for (const b of this.buildings) if (pointInPoly(p, b.corners)) return b;
    return null;
  }

  // 容量（住戶或工作）依地塊格數、密度與等級；商業 / 工業再乘上種類倍率
  cap(b) {
    const k = b.zone === 'C' ? SHOP_KINDS[b.kind]?.jobs : b.zone === 'I' ? INDUSTRY_KINDS[b.kind]?.jobs : 1;
    return Math.max(2, Math.round(b.cols * b.rows * ZONE_TYPES[b.zt].per[b.level - 1] * (k || 1)));
  }

  // ---------- 道路變更通知 ----------
  onSegmentSplit(old, s1, s2, u) {
    for (const b of this.buildings) if (b.front && b.front.seg === old.id) { if (b.front.u < u) b.front.seg = s1.id; else { b.front.seg = s2.id; b.front.u -= u; } }
    for (const b of [...this.buildings, ...this.lots]) {
      if (b.seg !== old.id) continue;
      if (b.u < u) b.seg = s1.id; else { b.seg = s2.id; b.u -= u; }
    }
  }
  onSegmentReplaced(old, ns, reverse, T) {
    for (const b of [...this.buildings, ...this.lots]) {
      if (b.seg !== old.id) continue;
      if (!T.access) { if (b.built) this.removeBuilding(b); else this.removeLot(b); continue; }
      b.seg = ns.id;
      if (reverse) { b.u = old.len - b.u; b.side = -b.side; }
    }
  }
  onSegmentRemoved(seg) {
    for (const b of [...this.buildings]) if (b.seg === seg.id) this.removeBuilding(b);
    this.lots = this.lots.filter(l => l.seg !== seg.id);
  }
  afterRebuild() {
    const net = this.game.net;
    for (const o of this.outside) {
      const n = net.nodes.get(o.node);
      const s = n && n.segs.length ? net.segs.get(n.segs[0]) : null;
      if (!s) { o.seg = null; continue; }
      o.seg = s.id;
      o.u = s.a === n.id ? 3 : s.len - 3;
    }
    for (const b of [...this.buildings]) if (!net.segs.has(b.seg)) this.removeBuilding(b);
    this.lots = this.lots.filter(l => net.segs.has(l.seg));
  }

  addOutside(node, name) {
    node.outside = true;
    const o = { kind: 'outside', outside: true, node: node.id, seg: null, u: 0, queue: [], spawnCD: 0, name, id: 'o' + node.id };
    this.outside.push(o);
    return o;
  }

  // ---------- 目的地選擇 ----------
  roulette(list, wf) {
    let tot = 0;
    const ws = list.map(x => { const w = Math.max(0, wf(x)); tot += w; return w; });
    if (tot <= 0) return null;
    let r = this.game.rng.next() * tot;
    for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }
  near(a, b, scale) { return 1 / (1 + Math.hypot(a.x - b.x, a.y - b.y) / scale); }
  liveOutside() { return this.outside.filter(o => o.seg !== null); }
  pickJob(b) {
    return this.roulette(this.buildings.filter(x => (x.zone === 'C' || x.zone === 'I') && !x.abandoned),
      x => this.cap(x) * this.near(b, x, 700) * (x.present < this.cap(x) * 0.5 ? 1.5 : 0.4));
  }
  pickShop(b) {
    return this.roulette(this.buildings.filter(x => x.zone === 'C' && !x.abandoned), x => this.cap(x) * (SHOP_KINDS[x.kind]?.shop || 1) * this.near(b, x, x.kind === 'bigbox' || x.kind === 'mall' ? 900 : 450));
  }
  pickGoodsDest(b) {
    return this.roulette(this.buildings.filter(x => x.zone === 'C' && !x.abandoned), x => this.cap(x) * (x.stock < 10 ? 2 : 0.4) * this.near(b, x, 1000));
  }
  pickOutside(b) {
    const os = this.liveOutside();
    if (!os.length) return null;
    const net = this.game.net;
    return this.roulette(os, o => { const n = net.nodes.get(o.node); return 1 / (1 + Math.hypot(n.x - b.x, n.y - b.y) / 800); });
  }

  schedule(t, trip) {
    const arr = this.scheduled;
    let i = arr.length;
    while (i > 0 && arr[i - 1].t > t) i--;
    arr.splice(i, 0, { t, trip });
  }

  pushTrip(origin, trip) {
    if (origin.queue.length > 30) {
      origin.queue.shift();
      this.recordFail(trip);
    }
    origin.queue.push(trip);
  }

  recordFail(trip) {
    this.stats.fails++; this.stats.hourFails++;
    const f = trip.from;
    if (f && f.zone === 'R') {
      if (trip.kind === 'work') f.workOK = ema(f.workOK, 0, 0.15);
      if (trip.kind === 'shop') f.shopOK = ema(f.shopOK, 0, 0.15);
    }
    if (trip.to && trip.to.zone === 'C' && trip.kind === 'goods') trip.to.goodsSat = ema(trip.to.goodsSat, 0, 0.1);
  }

  onTripEnd(trip, ok, age) {
    const g = this.game;
    if (!trip) return;
    if (!ok) { this.recordFail(trip); return; }
    this.stats.trips++; this.stats.hourTrips++;
    this.stats.tripTimeSum += age;
    const from = trip.from, to = trip.to;
    let toll = 0.6;
    switch (trip.kind) {
      case 'work': {
        if (from.zone === 'R') { from.workOK = ema(from.workOK, 1, 0.15); from.timeScore = ema(from.timeScore, clamp(1 - (age - 150) / 600, 0, 1), 0.15); }
        if (!to.dead && to.zone) {
          to.present++;
          const day = Math.floor(g.time / 1440) * 1440;
          let dep = day + 17 * 60 + 20 + g.rng.gauss() * 80;
          if (dep < g.time + 120) dep = g.time + 240 + g.rng.next() * 120;
          this.schedule(dep, { kind: 'home', from: to, to: from, truck: false, worker: true });
        }
        break;
      }
      case 'shop':
        if (from.zone === 'R') from.shopOK = ema(from.shopOK, 1, 0.15);
        if (!to.dead) {
          to.custLevel += 1;
          to.stock = Math.max(0, to.stock - 0.4);
          this.schedule(g.time + 25 + g.rng.next() * 60, { kind: 'home', from: to, to: from, truck: false });
        }
        toll = 1;
        break;
      case 'visit':
        // 住一晚，隔天上午離開
        if (!to.dead) {
          to.custLevel += 1;
          const day = Math.floor(g.time / 1440) * 1440;
          this.schedule(day + 1440 + 9 * 60 + g.rng.next() * 180, { kind: 'home', from: to, to: from, truck: false });
        }
        toll = 2;
        break;
      case 'goods':
        if (!to.dead) to.stock = Math.min(40, to.stock + 6);
        toll = 3;
        break;
      case 'mat':
        if (!to.dead) to.stock = Math.min(40, to.stock + 6);
        toll = 3;
        break;
      case 'through':
        this.stats.through++;
        toll = 4;
        break;
    }
    g.earn(toll * g.diff.tax, true);
  }

  // ---------- 每步更新 ----------
  update(dt) {
    const g = this.game;
    const hour = (g.time % 1440) / 60;
    const pWork = gauss(hour, 7.6, 1.5) + 0.04;
    const pShop = gauss(hour, 14.5, 3.2) + 0.02;
    const pFreight = hour >= 6 && hour < 22 ? 1 / 16 : 0.01;
    // 小鎮階段出行較頻繁，城市變大後逐漸回到正常值（避免開局太冷清）
    const k = dt / 60 * TRIP_SCALE * (1 + 1.5 * clamp(1 - this.pop / 700, 0, 1));
    const rng = g.rng;
    const pop = Math.max(1, this.pop), jobs = this.jobsC + this.jobsI;
    const outsideShare = clamp(1 - pop * 0.5 / Math.max(1, jobs), 0.08, 0.85);
    for (const b of this.buildings) {
      if (b.abandoned) continue;
      const cap = this.cap(b);
      if (b.zone === 'R') {
        b.acc.work += cap * 0.3 * pWork * k;
        b.acc.shop += cap * 0.12 * pShop * k;
        while (b.acc.work >= 1) {
          b.acc.work -= 1;
          const d = this.pickJob(b);
          if (d) this.pushTrip(b, { kind: 'work', from: b, to: d, truck: false });
          else b.workOK = ema(b.workOK, 0.2, 0.1);
        }
        while (b.acc.shop >= 1) {
          b.acc.shop -= 1;
          const d = this.pickShop(b);
          if (d) this.pushTrip(b, { kind: 'shop', from: b, to: d, truck: false });
          else b.shopOK = ema(b.shopOK, 0.2, 0.1);
        }
      } else {
        // 飯店：外地旅客整天陸續入住
        if (b.kind === 'hotel') {
          b.acc.visit = (b.acc.visit || 0) + cap * 0.18 * (gauss(hour, 16, 4) + 0.02) * k;
          while (b.acc.visit >= 1) {
            b.acc.visit -= 1;
            const o = this.pickOutside(b);
            if (o) this.pushTrip(o, { kind: 'visit', from: o, to: b, truck: false });
          }
        }
        // 外地通勤者
        b.acc.outw += cap * 0.25 * pWork * k * outsideShare;
        while (b.acc.outw >= 1) {
          b.acc.outw -= 1;
          const o = this.pickOutside(b);
          if (o) this.pushTrip(o, { kind: 'work', from: o, to: b, truck: false });
        }
      }
      if (b.zone === 'I') {
        b.acc.goods += cap / 5 * (INDUSTRY_KINDS[b.kind]?.goods || 1) * pFreight * k * (0.3 + 0.7 * b.workSat);
        while (b.acc.goods >= 1) {
          b.acc.goods -= 1;
          if (b.stock < 1) continue;
          const d = this.pickGoodsDest(b);
          if (d) { b.stock -= 1; this.pushTrip(b, { kind: 'goods', from: b, to: d, truck: true }); }
        }
        if (b.stock < 12) {
          b.acc.mat += cap / 6 * pFreight * k;
          while (b.acc.mat >= 1) {
            b.acc.mat -= 1;
            const o = this.pickOutside(b);
            if (o) this.pushTrip(o, { kind: 'mat', from: o, to: b, truck: true });
          }
        }
      }
    }
    // 過境交通
    const os = this.liveOutside();
    const growth = Math.min(3, 1 + g.time / 1440 * 0.12);
    const pThrough = (hour >= 5 && hour < 23 ? 1 : 0.25) * 5 * g.diff.through * growth;
    for (const a of os) for (const b of os) {
      if (a === b) continue;
      const key = a.id + '>' + b.id;
      let acc = (this.accThrough.get(key) || 0) + pThrough * k * (0.6 + rng.next() * 0.8);
      while (acc >= 1) { acc -= 1; this.pushTrip(a, { kind: 'through', from: a, to: b, truck: rng.chance(0.25) }); }
      this.accThrough.set(key, acc);
    }
    // 預約回程
    while (this.scheduled.length && this.scheduled[0].t <= g.time) {
      const { trip } = this.scheduled.shift();
      if (trip.from.dead || trip.to.dead) continue;
      if (trip.worker && trip.from.present > 0) trip.from.present--;
      this.pushTrip(trip.from, trip);
    }
    // 生成車輛
    this.spawnFrom(this.buildings, dt, 0.8);
    this.spawnFrom(this.outside, dt, 0.35);

    this.hourT += dt;
    if (this.hourT >= 60) { this.hourT -= 60; this.hourly(); }
    this.growT += dt;
    if (this.growT >= 30) {
      this.growT = 0;
      if ((this.jam || 0) < 0.35) { this.developLots(); if (g.autoGrow) this.autoGrow(); }
    }
  }

  spawnFrom(list, dt, cd) {
    const tr = this.game.traffic;
    for (const o of list) {
      if (!o.queue.length) continue;
      o.spawnCD -= dt;
      if (o.spawnCD > 0) continue;
      const trip = o.queue[0];
      if (trip.to.dead || (trip.to.outside && trip.to.seg === null) || o.seg === null) { o.queue.shift(); this.recordFail(trip); continue; }
      const r = tr.trySpawn(trip);
      if (r === 'ok') { o.queue.shift(); o.spawnCD = cd; }
      else if (r === 'noroute') {
        // 外部連線尚未接通時，外地來的行程直接取消，不算失敗
        o.queue.shift();
        if (!o.outside) this.recordFail(trip);
        o.spawnCD = 0.2;
      }
      else o.spawnCD = 0.4;
    }
  }

  // ---------- 每小時 ----------
  hourly() {
    const g = this.game, net = g.net;
    const hour = Math.floor((g.time % 1440) / 60);
    const workHours = hour >= 9 && hour <= 16;
    const noisy = [...net.segs.values()].filter(s => s.T.rank >= 3 && s.drawLevel >= 0);
    const inds = this.buildings.filter(b => b.zone === 'I' && !b.abandoned);
    let income = 0;
    for (const b of this.buildings) {
      const cap = this.cap(b);
      if (b.zone === 'R') {
        let pol = 0;
        for (const i of inds) {
          const d = Math.max(0, Math.hypot(i.x - b.x, i.y - b.y) - i.rad * 0.7);
          if (d < 220) pol += (1 - d / 220) * 0.35 * i.level * (INDUSTRY_KINDS[i.kind]?.pol ?? 1) * Math.min(2, Math.sqrt(i.cols * i.rows) / 6);
        }
        b.pollution = clamp(pol, 0, 1);
        let nz = 0;
        for (const s of noisy) {
          if (b.x < s.bbox.x0 - 90 || b.x > s.bbox.x1 + 90 || b.y < s.bbox.y0 - 90 || b.y > s.bbox.y1 + 90) continue;
          for (let i = 0; i < s.pts.length - 1; i++) {
            const d = distToSeg(b, s.pts[i], s.pts[i + 1]);
            if (d < 90) nz = Math.max(nz, (1 - d / 90) * (s.drawLevel > 0 ? 0.8 : 0.6));
          }
        }
        b.noise = nz;
        b.happy = 0.35 * b.workOK + 0.15 * b.shopOK + 0.2 * (1 - b.pollution) + 0.1 * (1 - b.noise) + 0.2 * b.timeScore;
        income += cap * 0.8 * b.happy;
      } else {
        if (workHours) b.workSat = ema(b.workSat, clamp(b.present / Math.max(1, cap / 3 * 0.6), 0, 1), 0.25);
        if (b.zone === 'C') {
          b.goodsSat = ema(b.goodsSat, b.stock > 0.5 ? 1 : 0, 0.2);
          b.custSat = ema(b.custSat, clamp(b.custLevel / Math.max(1, cap * 0.2), 0, 1), 0.2);
          b.custLevel *= 0.75;
          b.happy = 0.35 * b.workSat + 0.3 * b.goodsSat + 0.35 * b.custSat;
          income += cap * 1.4 * b.happy;
        } else {
          b.matSat = ema(b.matSat, b.stock > 0.5 ? 1 : 0, 0.2);
          b.happy = 0.5 * b.workSat + 0.5 * b.matSat;
          income += cap * 1.2 * b.happy;
        }
      }
      if (b.abandoned) {
        b.abT += 1;
        if (b.abT > 24) this.removeBuilding(b, true);
        continue;
      }
      if (b.happy > 0.68 && b.level < 3 && this.demand[b.zone] > -0.2) {
        b.highT += 1;
        if (b.highT > 8) { b.level++; b.highT = 0; g.notify(`${ZONES[b.zone].name}建築升級至 ${b.level} 級`, 'minor'); }
      } else b.highT = Math.max(0, b.highT - 0.5);
      if (b.happy < 0.3 && g.time - b.born > 360) {
        b.lowT += 1;
        if (b.lowT > 14) {
          b.lowT = 0;
          if (b.level > 1) b.level--;
          else { b.abandoned = true; g.notify(`有${ZONES[b.zone].name}建築被廢棄了`, 'warn'); }
        }
      } else b.lowT = Math.max(0, b.lowT - 0.5);
    }
    // 財務
    income *= g.diff.tax;
    let maint = 0;
    for (const s of net.segs.values()) {
      const A = net.nodes.get(s.a), B = net.nodes.get(s.b);
      maint += s.len * s.T.cost * (levelMul(A.level) + levelMul(B.level)) / 2 * 0.0012;
    }
    maint += net.signalNodes.length * 4;
    maint *= g.diff.maint;
    g.earn(income);
    g.spend(maint, true);
    const st = this.stats;
    st.lastIncome = st.hourIncome + income; st.lastExpense = maint;
    st.lastTrips = st.hourTrips; st.lastFails = st.hourFails;
    st.hourIncome = 0; st.hourTrips = 0; st.hourFails = 0;
    this.recount();
    this.history.push({ t: g.time, pop: this.pop, money: g.money, speed: g.traffic.metrics.avgSpeedRatio, trips: st.lastTrips, fails: st.lastFails, veh: g.traffic.vehicles.length });
    if (this.history.length > 24 * 14) this.history.shift();
    g.checkMilestone();
  }

  recount() {
    let pop = 0, jc = 0, ji = 0;
    for (const b of this.buildings) {
      if (b.abandoned) continue;
      const c = this.cap(b);
      if (b.zone === 'R') pop += c; else if (b.zone === 'C') jc += c; else ji += c;
    }
    this.pop = pop; this.jobsC = jc; this.jobsI = ji;
    const avgHappy = this.buildings.length ? this.buildings.reduce((s, b) => s + b.happy, 0) / this.buildings.length : 0.7;
    const hb = (avgHappy - 0.5) * 0.6;
    // 交通狀況回饋：壅塞或行程失敗多時，沒有人想搬進來
    const st = this.stats, tm = this.game.traffic.metrics;
    const failRate = st.lastFails / Math.max(10, st.lastTrips + st.lastFails);
    const jam = (tm.moving > 30 ? clamp((0.5 - tm.avgSpeedRatio) * 2.5, 0, 1) : 0) + clamp((failRate - 0.08) * 4, 0, 1);
    this.jam = clamp(jam, 0, 1.5);
    this.demand.R = clamp(((jc + ji) - pop * 0.5 + 30) / (pop * 0.2 + 30) + hb - this.jam, -1, 1);
    this.demand.C = clamp((pop * 0.18 - jc + 10) / (pop * 0.1 + 20) - this.jam * 0.6, -1, 1);
    this.demand.I = clamp((pop * 0.3 - ji + 15) / (pop * 0.1 + 20) + (this.liveOutside().length ? 0 : -0.5) - this.jam * 0.6, -1, 1);
  }

  // ---------- 自動發展 ----------
  // 城市所在的路網連通區（建築最多的那一塊），避免在尚未接通的道路旁長出建築
  mainComponent() {
    const net = this.game.net;
    if (this._comp && this._compVer === net.version) return this._comp;
    const compOf = new Map();
    let best = null, bestScore = -1;
    for (const start of net.nodes.keys()) {
      if (compOf.has(start)) continue;
      const set = new Set([start]), stack = [start];
      compOf.set(start, set);
      while (stack.length) {
        const n = net.nodes.get(stack.pop());
        for (const sid of n.segs) {
          const s = net.segs.get(sid);
          if (!s) continue;
          for (const o of [s.a, s.b]) if (!set.has(o)) { set.add(o); compOf.set(o, set); stack.push(o); }
        }
      }
    }
    for (const set of new Set(compOf.values())) {
      let score = set.size * 0.01;
      for (const b of this.buildings) { const s = net.segs.get(b.seg); if (s && set.has(s.a)) score += 1; }
      if (score > bestScore) { bestScore = score; best = set; }
    }
    this._comp = best || new Set();
    this._compVer = net.version;
    return this._comp;
  }

  // 已劃設的空地塊依需求發展成建築（不論是否開啟自動發展）
  developLots() {
    const g = this.game, net = g.net, rng = g.rng, comp = this.mainComponent();
    for (const z of ['R', 'C', 'I']) {
      const d = this.demand[z];
      if (d <= 0.05) continue;
      const cand = this.lots.filter(l => l.zone === z && net.segs.has(l.seg) && comp.has(net.segs.get(l.seg).a));
      let n = d > 0.6 ? 4 : d > 0.3 ? 3 : 2;
      while (n-- > 0 && cand.length) this.develop(cand.splice(rng.int(0, cand.length - 1), 1)[0]);
    }
    this.recount();
  }

  // 自動發展：需求高而且沒有空地塊時，自動在路旁劃設大小不一的分區
  autoGrow() {
    const g = this.game, net = g.net, rng = g.rng;
    const zones = ['R', 'C', 'I'].filter(z => this.demand[z] > 0.1 && this.lots.filter(l => l.zone === z).length < 3)
      .sort((a, b) => this.demand[b] - this.demand[a]);
    if (!zones.length) return;
    const comp = this.mainComponent();
    const park = this.parkRoadSet();
    const segs = [...net.segs.values()].filter(s => s.T.access && s.drawLevel === 0 && net.nodes.get(s.a).level === 0 && net.nodes.get(s.b).level === 0 && s.len > 30 && comp.has(s.a) && !park.has(s.id));
    if (!segs.length) return;
    for (const zone of zones) {
      const n = this.demand[zone] > 0.6 ? 3 : 2;
      let placed = 0;
      for (let tries = 0; tries < 18 && placed < n; tries++) {
        let seg;
        if (this.buildings.length && rng.chance(0.75)) {
          const nb = rng.pick(this.buildings);
          const near = segs.filter(s => Math.abs((s.bbox.x0 + s.bbox.x1) / 2 - nb.x) < 260 && Math.abs((s.bbox.y0 + s.bbox.y1) / 2 - nb.y) < 260);
          seg = near.length ? rng.pick(near) : rng.pick(segs);
        } else seg = rng.pick(segs);
        const { zt, cols, rows } = this.autoLotSize(zone, seg);
        const g0 = this.gridStart(seg), lo = g0 + cols * CELL / 2, hi = seg.len - seg.rb - cols * CELL / 2;
        if (hi <= lo) continue;
        // 對齊路段上的格線
        const u = lo + Math.floor(rng.next() * (hi - lo) / CELL) * CELL;
        const side = rng.chance(0.5) ? 1 : -1;
        let r = rows;
        while (r >= 2 && this.canPlaceLot(seg, u, side, cols, r)) r--;
        if (r < 2) continue;
        const geo = this.lotGeom(seg, u, side, cols, r);
        if (zone === 'R' && this.buildings.some(b => b.zone === 'I' && Math.hypot(b.x - geo.x, b.y - geo.y) < 160 + b.rad)) continue;
        if (zone === 'I' && this.buildings.some(b => b.zone === 'R' && Math.hypot(b.x - geo.x, b.y - geo.y) < 110 + geo.rad)) continue;
        if (seg.T.rank >= 2 && zone === 'R' && zt === 'R1' && rng.chance(0.5)) continue;
        this.addLot(zt, seg, u, side, cols, r);
        placed++;
      }
    }
  }

  // 自動劃設的地塊大小：城市越大，住宅密度越高、偶爾出現大型商場
  autoLotSize(zone, seg) {
    const rng = this.game.rng, pop = this.pop;
    const R = (a, b) => rng.int(a, b);
    if (zone === 'R') {
      const zt = pop > 2500 && seg.T.rank >= 2 && rng.chance(0.35) ? 'R3' : pop > 900 && rng.chance(0.45) ? 'R2' : 'R1';
      return zt === 'R3' ? { zt, cols: R(4, 8), rows: R(4, 7) } : { zt, cols: R(3, 6), rows: R(3, 5) };
    }
    if (zone === 'C') return pop > 1800 && rng.chance(0.12) ? { zt: 'C', cols: R(15, 18), rows: 15 } : { zt: 'C', cols: R(3, 7), rows: R(3, 5) };
    return { zt: 'I', cols: R(5, 10), rows: R(5, 9) };
  }

  // ---------- 序列化 ----------
  serialize() {
    return {
      nextId: this.nextId,
      buildings: this.buildings.map(b => ({ id: b.id, zone: b.zone, zt: b.zt, kind: b.kind, cols: b.cols, rows: b.rows, seg: b.seg, u: b.u, side: b.side, level: b.level, happy: b.happy, stock: b.stock, abandoned: b.abandoned,
        roads: b.roads || undefined, front: b.front || undefined, gate: b.gate || undefined, c0: b.roads ? [b.corners[0].x, b.corners[0].y, b.tx, b.ty, b.nx, b.ny] : undefined })),
      lots: this.lots.map(l => ({ zt: l.zt, seg: l.seg, u: l.u, side: l.side, cols: l.cols, rows: l.rows })),
      outside: this.outside.map(o => ({ node: o.node, name: o.name })),
      demand: this.demand, stats: this.stats, history: this.history,
    };
  }
  load(d) {
    const net = this.game.net;
    for (const o of d.outside) this.addOutside(net.nodes.get(o.node), o.name);
    for (const s of d.buildings) {
      const seg = net.segs.get(s.seg);
      if (!seg) continue;
      // 舊存檔沒有格數：依舊版固定尺寸換算
      const zt = s.zt || (s.zone === 'R' ? 'R1' : s.zone);
      const old = { R: [3, 3], C: [4, 4], I: [5, 5] }[s.zone];
      const geo = s.c0 ? this.geomFrom(...s.c0, s.cols, s.rows) : null;
      const b = this.addBuilding(zt, seg, s.u, s.side, s.cols || old[0], s.rows || old[1], s.level, s.kind, geo);
      if (s.roads) { b.roads = s.roads; b.front = s.front || null; }
      if (s.gate) { b.gate = s.gate; this.applyGate(b); }
      b.happy = s.happy; b.stock = s.stock; b.abandoned = s.abandoned;
    }
    for (const l of d.lots || []) {
      const seg = net.segs.get(l.seg);
      if (seg) this.addLot(l.zt, seg, l.u, l.side, l.cols, l.rows);
    }
    this.nextId = Math.max(this.nextId, d.nextId);
    Object.assign(this.demand, d.demand);
    Object.assign(this.stats, d.stats);
    this.history = d.history || [];
    this.afterRebuild();
    this.recount();
  }
}

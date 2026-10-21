// 簡化城市經濟：住宅需要工作與購物、工廠需要工人與原料、商店需要商品與顧客
import { zoneMax, HITECH_POP, POLLUTION, TAXI_COLOR, TRIP_SCALE, TRIP_REF, SEP_RI, DEMAND_BUILD, DEMAND_ZONE, ZONES, ZONE_TYPES, CELL, SHOP_KINDS, INDUSTRY_KINDS, MILESTONES, ROAD_TYPES, levelMul } from './config.js';
import { pointAt, convexOverlap, pointInPoly, distToSeg, clamp, polyBBox, bboxOverlap, closestOnPoly } from './util.js';
import { halfWidth } from './network.js';
import { lotArt, lotAisles, lotParkArea, oneWayLot, garageDrive } from './lotart.js';

const ema = (a, x, k) => a + (x - a) * k;
// 有公車可搭時（起訖附近都有同一條路線的站牌），就算有車也改搭公車的居民比例
const BUS_SHARE = 0.5, TAXI_SHARE = 0.06;

// 需要場內道路的建築：工業園區（主幹道＋大園區的橫向道路）與附停車場的商業（從臨路開進停車場的車道）
// 回傳車道終點與橫向道路離路邊的距離（公尺），與 lotart.js 的配置一致
export function driveway(zone, kind, geo) {
  const d = geo.d;
  if (geo.rows < 5 || geo.cols < 3) return null;
  // 工業：至少 8 格寬才開場內道路（太窄的直接臨路進出）
  if (zone === 'I') return geo.cols >= 8 ? { end: d - 6, cross: geo.rows >= 10 ? d * 0.55 : null, through: true } : null;
  // 住宅區的巷道（盡頭迴車，不打通）：低密度兩側是宅地；中 / 高密度兩側是停車格，後面才是建物
  // 公車總站：中央場內車道（兩側是公車停車格）
  // 公車總站、計程車行的中央場內車道；鐵路車站、貨運站直接臨路進出
  if (zone === 'T') return (geo.zt === 'T' || geo.zt === 'TX') && geo.cols >= 6 ? { end: d - 6 } : null;
  // 高密度住宅的地下 / 立體停車場、立體停車場的購物中心：停車場前的單向車道（右進右出）
  const gd = garageDrive(geo.zt, kind, geo.cols, geo.rows);
  if (gd) return { end: gd.cv, lot: { aisles: [gd.ua, gd.ub], oneway: true, front: gd.cv }, garage: true };
  if (zone === 'R' && kind === null && geo.rows >= 6 && geo.cols >= 6 && geo.zt === 'R1') return { end: d - 7 };
  if (zone === 'R' && kind === null && geo.rows >= 6 && geo.cols >= 6 && geo.zt === 'R2') return { end: d - 7 };
  if (zone !== 'C') return null;
  // 大型停車場：主車道開到停車場底部，再接一條橫向車道與其他平行車道（車位都在真的車道旁，車子不會穿過其他車位）
  const pa = lotParkArea(kind, geo.w, d);
  if (pa) {
    const aisles = lotAisles(pa.u0, pa.u1, geo.w / 2), through = kind === 'parking';
    if (!aisles.length) return { end: kind === 'parking' ? d - 6 : pa.v1 - 3, through };
    // 量販店 / 購物中心 / 超市：單向環狀動線，只有一個入口（最左側車道）與一個出口（最右側車道）
    // 入口 → 前方分配車道（往右）→ 各停車車道（往後）→ 後方集散車道（往右）→ 最右側車道（往前）→ 出口
    if (oneWayLot(kind, aisles)) return { end: pa.v1 - 4.8, through, lot: { aisles: [...aisles, geo.w / 2].sort((a, b) => a - b), oneway: true, front: pa.v0 + 3 } };
    return { end: pa.v1 - 4.8, through, lot: { aisles, top: pa.v0 + 2 } };
  }
  if (kind === 'shops' && geo.rows >= 6 && geo.cols >= 5) return { end: d - 6, through: true };
  return null;
}
const gauss = (h, mu, sd) => Math.exp(-0.5 * ((h - mu) / sd) ** 2) / (sd * 2.5066);
// 線段 a-b 是否穿過多邊形的邊
function segHitsPoly(a, b, poly) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true;
  }
  return false;
}

export class City {
  constructor(game) {
    this.game = game;
    this.buildings = [];
    this.lots = [];        // 已劃設、尚未發展的分區地塊
    this.byId = new Map();
    this.nextId = 1;
    this.outside = [];
    this.railOutside = [];   // 外部鐵路連線（只有列車，不產生汽車車流）
    this.scheduled = [];
    this.hourT = 0;
    this.growT = 0;
    this.growStart = 0;   // 這個遊戲時間之後才開始發展（開局先讓路網跑一陣子）
    this.peakPop = 0;     // 曾達到的最高人口：分區解鎖與城市稱號依此（人口減少不會再鎖回去）
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
  // 分區 zt 的最大地塊格數（0 = 尚未解鎖）：依人口解鎖的上限；給了臨路路段 seg 時再受道路種類限制（ROAD_TYPES.lotMax）
  // 車站旁的鐵軌（月台位置）：地塊後方或兩側 30 m 內的地面鐵軌上最近的一點；沒有就是 null
  railNear(geo) {
    const net = this.game.net, c0 = geo.corners[0];
    const P = (u, v) => ({ x: c0.x + geo.tx * u + geo.nx * v, y: c0.y + geo.ty * u + geo.ny * v });
    const pts = [P(geo.w / 2, geo.d), P(geo.w * 0.2, geo.d), P(geo.w * 0.8, geo.d), P(0, geo.d * 0.6), P(geo.w, geo.d * 0.6)];
    let best = null;
    for (const s of net.segs.values()) {
      if (!s.T.rail || s.drawLevel !== 0) continue;
      for (const q of pts) {
        const c = closestOnPoly(s.pts, s.cum, q);
        if (c.d <= 30 && (!best || c.d < best.d)) best = { seg: s.id, u: clamp(c.s, Math.min(s.ra + 2, s.len / 2), Math.max(s.len - s.rb - 2, s.len / 2)), d: c.d };
      }
    }
    return best;
  }
  // 車站的月台（隨路網版本快取）
  platformOf(b) {
    const ver = this.game.net.version;
    if (!b._plat || b._plat.ver !== ver) b._plat = { ver, p: this.railNear(b) };
    return b._plat.p;
  }
  maxCells(zt, seg = null) { return Math.min(zoneMax(zt, this.unlockPop()), (seg && seg.T.lotMax) || Infinity); }
  // 解鎖用的人口：沙盒模式一開始就全部解鎖，其他難度依曾達到的最高人口
  unlockPop() { const d = this.game.diff; return d && d.unlockAll ? Infinity : this.peakPop; }

  planStroke(zt, seg, side, u0, u1, rows) {
    const Z = { max: this.maxCells(zt, seg) };
    if (!Z.max) return [];
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
      const item = { zt, seg, u, side, cols, rows: ok ? r : depth, ok, reason, geo: this.lotGeom(seg, u, side, cols, ok ? r : depth) };
      // 鐵路車站要緊鄰鐵軌
      if (ok && ZONE_TYPES[zt].rail && !this.railNear(item.geo)) { item.ok = false; item.reason = '車站要緊鄰鐵路：地塊後方或側邊 30 m 內要有地面鐵軌'; }
      res.push(item);
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
    const plan = driveway(l.zone, kind, Object.assign({ zt: l.zt }, geo));
    const roads = plan ? this.buildParkRoads(geo, seg, l.u, plan) : null;
    const b = this.addBuilding(l.zt, seg, l.u, l.side, l.cols, l.rows, level, kind, geo);
    if (roads) {
      // 臨路的位置可能因開路而被切開，改記最近的臨路路段
      const c = geo.corners[0], m = { x: c.x + geo.tx * geo.w / 2 - geo.nx * 2, y: c.y + geo.ty * geo.w / 2 - geo.ny * 2 };
      const fr = net.segNear(m.x - geo.nx * (halfWidth(seg.T) - 0.5), m.y - geo.ny * (halfWidth(seg.T) - 0.5), 6, 0);
      b.front = fr ? { seg: fr.seg.id, u: fr.u } : null;
      b.roads = roads.segs; b.seg = roads.access.seg; b.u = roads.access.u;
      b.parkPlan = plan;
      // 場內道路只給進出這棟建築的車使用（巷道、停車場車道不會被當成迴轉道或捷徑）
      this.markGate(b);
      this.connectPark(b);
      // 開了場內道路後配置改變（巷道旁的車位），初始停著的車要依新的車位重新停好
      this.seedParked(b);
    }
    return b;
  }
  // 新建築一開始停著的車：住宅大部分的車停在家；工業區卸貨區停著幾輛貨車（之後送貨出去就從這裡開出）
  seedParked(b) {
    const sl = this.slotsOf(b), rng = this.game.rng;
    // 計程車行 / 招呼站：車位上停著計程車
    b.slotOcc = sl.map(s => (b.zone === 'R' && rng.next() < 0.7 ? s.c : (b.zt === 'TX' || b.zt === 'TS') && rng.next() < 0.85 ? TAXI_COLOR : null));
    b.tOcc = this.truckSlotsOf(b).map(() => ((b.zone === 'I' || b.zt === 'RC') && rng.next() < 0.4 ? '#d8d0c0' : b.zt === 'T' || b.zt === 'RT' ? '#d23c2c' : null));
  }

  // 場內道路：工業園區的主幹道（深的再加橫向道路）、停車場的車道；員工、貨車與顧客都開進去
  buildParkRoads(geo, seg, u, plan) {
    const g = this.game, net = g.net;
    const P = (a, v) => ({ x: geo.corners[0].x + geo.tx * a + geo.nx * v, y: geo.corners[0].y + geo.ty * a + geo.ny * v });
    // 自動開路：不花錢；分段建造單向車道時中途的「無法駛出」提示不顯示給玩家（完成後每條都有出路）
    const spend = g.spend, can = g.canAfford, notify = g.notify;
    g.spend = () => {}; g.canAfford = () => true; g.notify = () => {};
    const build = (a, b, type = 'service') => {
      const plan = net.planRoad(a, b, null, type, 0);
      if (!plan.ok) return false;
      plan.demolish = [];
      net.executeRoad(plan);
      return true;
    };
    const before = new Set(net.segs.keys());
    // 單向停車場：沿起點方向依序建造（a → b 為行車方向）；接到已有的節點 / 路段
    const at = q => { const n = net.nodeNear(q.x, q.y, 2, 0); if (n) return { x: n.x, y: n.y, node: n.id }; const sn = net.segNear(q.x, q.y, 2, 0); return sn ? { x: sn.x, y: sn.y, seg: sn.seg.id, u: sn.u } : q; };
    const road = a => { const f = P(a, -(halfWidth(seg.T) + 1.5)), fs = net.segNear(f.x, f.y, 4, 0); return fs && !fs.seg.T.internal ? { x: fs.x, y: fs.y, seg: fs.seg.id, u: fs.u } : null; };
    try {
      if (plan.lot && plan.lot.oneway) {
        // 入口在臨路車道的上游端、出口在下游端：等著進場的車往上游回堵，不會擋到出口右轉出來的車
        // （臨路車道的行車方向 t 滿足「t 的右側 = 地塊內側」）
        const nearPlusU = -geo.ty * geo.nx + geo.tx * geo.ny > 0;
        const A = nearPlusU ? plan.lot.aisles : [...plan.lot.aisles].reverse(), n = A.length, vf = plan.lot.front, cv = plan.end, r0 = road(A[0]), r1 = road(A[n - 1]);
        // direct：沒有前方分配車道（停車場前的車道），入口直接開到 cv
        const direct = vf >= cv - 1;
        if (!r0 || !r1 || !build(r0, P(A[0], direct ? cv : vf), 'service1')) return null;
        if (!direct) for (let i = 0; i < n - 1; i++) {
          if (i > 0) build(at(P(A[i - 1], vf)), at(P(A[i], vf)), 'service1');
          build(at(P(A[i], vf)), at(P(A[i], cv)), 'service1');
        }
        for (let i = 0; i < n - 1; i++) build(at(P(A[i], cv)), at(P(A[i + 1], cv)), 'service1');
        build(at(P(A[n - 1], cv)), road(A[n - 1]) || r1, 'service1');
        net.rebuild();
      } else {
      const fp = pointAt(seg.pts, seg.cum, u);
      if (!build({ x: fp.x, y: fp.y, seg: seg.id, u }, P(geo.w / 2, plan.end))) return null;
      if (plan.cross) build(P(6, plan.cross), P(geo.w - 6, plan.cross));
      if (plan.lot) {
        // 停車場底部的橫向車道（從主車道盡頭往兩側），再從橫向車道開出各條平行車道
        const cv = plan.end, end = P(geo.w / 2, cv), en = net.nodeNear(end.x, end.y, 2, 0);
        const lo = Math.min(...plan.lot.aisles), hi = Math.max(...plan.lot.aisles);
        if (en && lo < geo.w / 2) build({ x: en.x, y: en.y, node: en.id }, P(lo, cv));
        if (en && hi > geo.w / 2) build({ x: en.x, y: en.y, node: en.id }, P(hi, cv));
        for (const a of plan.lot.aisles) {
          const q = P(a, cv), n = net.nodeNear(q.x, q.y, 2, 0), sn = n ? null : net.segNear(q.x, q.y, 2, 0);
          const from = n ? { x: n.x, y: n.y, node: n.id } : sn ? { x: sn.x, y: sn.y, seg: sn.seg.id, u: sn.u } : null;
          if (!from) continue;
          // 每條平行車道一路接到前面的道路，成為停車場的另一個出入口
          // （只有一個出入口時所有車都擠在同一個路口，停車場裡大排長龍；車道盡頭也不再是死路）；接不上才做成盡頭車道
          const f = P(a, -(halfWidth(seg.T) + 1.5)), fs = net.segNear(f.x, f.y, 4, 0);
          if (!(fs && !fs.seg.T.internal && build(from, { x: fs.x, y: fs.y, seg: fs.seg.id, u: fs.u }))) build(from, P(a, plan.lot.top));
        }
      }
      net.rebuild();
      }
    } finally { g.spend = spend; g.canAfford = can; g.notify = notify; }
    const segs = [...net.segs.values()].filter(s => s.T.internal && !before.has(s.id)).map(s => s.id);
    const L = plan.lot && plan.lot.oneway ? plan.lot.aisles : null;
    const q = L ? P((L[0] + L[L.length - 1]) / 2, plan.end) : P(geo.w / 2, Math.max(8, plan.end - 6)), acc = net.segNear(q.x, q.y, 4, 0);
    if (!segs.length || !acc) return null;
    return { segs, access: { seg: acc.seg.id, u: acc.u } };
  }

  // 把園區 / 停車場的場內道路接到旁邊的道路（後方、側邊）；開局或之後新增的道路都會檢查
  // 每個對外出入口（含正門）都設閘門：只有進出這裡的車能走，不會被當捷徑
  connectPark(b) {
    const plan = b.parkPlan;
    if (!plan || !plan.through || !b.roads || b.dead) return false;
    const g = this.game, net = g.net, link = b.links || (b.links = {});
    const P = (a, v) => ({ x: b.corners[0].x + b.tx * a + b.nx * v, y: b.corners[0].y + b.ty * a + b.ny * v });
    const node = q => { const n = net.nodeNear(q.x, q.y, 3, 0); return n ? { x: n.x, y: n.y, node: n.id } : q; };
    const near = q => {
      const sn = net.segNear(q.x, q.y, 14, 0);
      if (!sn || sn.seg.T.internal || b.roads.includes(sn.seg.id) || (b.front && sn.seg.id === b.front.seg)) return null;
      return Math.hypot(sn.x - q.x, sn.y - q.y) < halfWidth(sn.seg.T) + 6 ? sn : null;
    };
    const spend = g.spend, can = g.canAfford;
    g.spend = () => {}; g.canAfford = () => true;
    const before = new Set(net.segs.keys()), gates = [];
    const build = (a, c) => { const pl = net.planRoad(a, c, null, 'service', 0); if (!pl.ok) return false; pl.demolish = []; net.executeRoad(pl); net.rebuild(); return true; };
    try {
      if (!link.back) {
        const sn = near(P(b.w / 2, b.d + 2));
        if (sn && build(node(P(b.w / 2, plan.end)), { x: sn.x, y: sn.y, seg: sn.seg.id, u: sn.u })) {
          link.back = true;
          const gp = P(b.w / 2, b.d - 1.5); gates.push({ x: gp.x, y: gp.y, dx: b.nx, dy: b.ny });
        }
      }
      if (plan.cross) for (const [key, ue, uo, sg] of [['left', -2, 6, -1], ['right', b.w + 2, b.w - 6, 1]]) {
        if (link[key]) continue;
        const sd = near(P(ue, plan.cross));
        if (sd && build(node(P(uo, plan.cross)), { x: sd.x, y: sd.y, seg: sd.seg.id, u: sd.u })) {
          link[key] = true;
          const gp = P(sg < 0 ? 1.5 : b.w - 1.5, plan.cross); gates.push({ x: gp.x, y: gp.y, dx: b.tx * sg, dy: b.ty * sg });
        }
      }
    } finally { g.spend = spend; g.canAfford = can; }
    if (!gates.length) return false;
    const fresh = [...net.segs.values()].filter(s2 => s2.T.internal && !before.has(s2.id)).map(s2 => s2.id);
    b.roads = [...b.roads.filter(id => net.segs.has(id)), ...fresh];
    b.gates = b.gates || [];
    if (!b.gates.some(gt => gt.front)) { const gp = P(b.w / 2, 1.5); b.gates.push({ x: gp.x, y: gp.y, dx: -b.nx, dy: -b.ny, front: true }); }
    b.gates.push(...gates);
    // 存取點可能被切開，重新找
    const q = P(b.w / 2, Math.max(8, plan.end - 6)), acc = net.segNear(q.x, q.y, 4, 0);
    if (acc) { b.seg = acc.seg.id; b.u = acc.u; }
    this.applyGate(b);
    return true;
  }
  // 建築自己的場內道路一律限制通行（尋路時只有起訖是這棟建築的車能走）
  markGate(b) {
    const net = this.game.net;
    for (const id of b.roads || []) { const s = net.segs.get(id); if (s) s.gate = b.id; }
  }
  applyGate(b) {
    this.markGate(b);
    this.game.net.rebuild();
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
      if (m >= SHOP_KINDS.bigbox.minCells) return rng.pick(['bigbox', 'bigbox', 'mall', 'mallp', 'hotel', 'office', 'market']);
      if (m >= 5) return x < 0.2 ? 'hotel' : x < 0.42 ? 'office' : x < 0.44 ? 'parking' : cols * rows >= 60 && x < 0.75 ? 'market' : 'shops';
      if (m >= 4 && x < 0.2) return 'office';
      if (m >= 3 && x < 0.38) return 'gas';
      return m >= 4 && x < 0.41 ? 'parking' : 'shops';
    }
    // 高科技工廠（半導體、電池）要城市夠大才會出現
    if (zone === 'I') return rng.pick(Object.keys(INDUSTRY_KINDS).filter(k => !INDUSTRY_KINDS[k].hitech || this.unlockPop() >= HITECH_POP));
    return null;
  }

  // 建築的停車位（世界座標、車頭方向），與畫面上 lotArt 的停車位一一對應；貨車車位（卸貨區）另外一組（truckSlotsOf）
  slotsOf(b) {
    const key = b.level + '|' + b.abandoned + '|' + !!b.roads + '|' + !!b.busHub;
    if (!b._slots || b._slots.key !== key) {
      const c0 = b.corners[0], art = lotArt(b);
      const P = (u, v) => ({ x: c0.x + b.tx * u + b.nx * v, y: c0.y + b.ty * u + b.ny * v });
      const toSlot = it => {
        const cu = it.u0 + it.du / 2, cv = it.v0 + it.dv / 2, alongU = it.du > it.dv;
        const s = { ...P(cu, cv), ax: alongU ? b.tx : b.nx, ay: alongU ? b.ty : b.ny, indoor: !!it.indoor, c: it.c };
        // 室內停車場的出口車道：開出來的車從這裡出發
        if (it.out) s.out = { ...P(it.out.u, it.out.v), ax: s.ax, ay: s.ay, indoor: true };
        return s;
      };
      const list = art.slots.map(toSlot), tlist = art.tslots.map(toSlot);
      // 建物的牆（車子開進 / 出車位時不能穿過；樹籬、頂棚不算）
      const walls = art.items.filter(it => it.t === 'rect' && it.h >= 1 && !it.car && !it.deco && !it.canopy).map(it => [P(it.u0, it.v0), P(it.u1, it.v0), P(it.u1, it.v1), P(it.u0, it.v1)]);
      // 每個車位停的車（顏色）與預約（正在開過來）；tOcc / tRes 為貨車車位
      // 建築升級 / 改建後配置會變：位置相同的車位沿用原本停著的車與預約（舊存檔沒有位置，依順序沿用）
      const old = b._slots;
      const carry = (nl, ol, occ, res) => {
        const o = nl.map(() => null), r = nl.map(() => false);
        if (!ol) { nl.forEach((_, i) => { o[i] = (occ && occ[i]) || null; }); return [o, r]; }
        ol.forEach((p, j) => {
          if (!(occ && occ[j]) && !(res && res[j])) return;
          const i = nl.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) < 1);
          if (i >= 0) { o[i] = occ && occ[j] || null; r[i] = !!(res && res[j]); }
        });
        return [o, r];
      };
      [b.slotOcc, b.slotRes] = carry(list, old && old.list, b.slotOcc, b.slotRes);
      [b.tOcc, b.tRes] = carry(tlist, old && old.tlist, b.tOcc, b.tRes);
      b._slots = { key, list, tlist, walls };
    }
    return b._slots.list;
  }
  // 某個位置（車子出發時預約的車位）目前是第幾個車位；配置改變後已不存在就回傳 -1
  slotIndexAt(b, pt, truck = false) {
    const list = this.slotSet(b, truck).list;
    for (let i = 0; i < list.length; i++) if (Math.hypot(list[i].x - pt.x, list[i].y - pt.y) < 1) return i;
    return -1;
  }
  truckSlotsOf(b) { this.slotsOf(b); return b._slots.tlist; }
  // 依車種取得車位清單與佔用 / 預約陣列
  slotSet(b, truck) {
    const list = truck ? this.truckSlotsOf(b) : this.slotsOf(b);
    return { list, occ: truck ? b.tOcc : b.slotOcc, res: truck ? b.tRes : b.slotRes };
  }
  // 車位對應的道路位置：車頭方向上最近、而且直直開過去不會穿過建物的道路
  // （臨路車位接前面的道路、巷道 / 停車場車道旁的車位接場內道路）；車子開到這個位置，再沿曲線開進車位
  // out：開出時用的位置（室內停車場的出口車道），沒有就與停進來的位置相同
  slotRoad(b, i, truck = false, out = false) {
    const net = this.game.net, sl0 = this.slotSet(b, truck).list[i], sl = out && sl0 && sl0.out ? sl0.out : sl0;
    if (!sl) return null;
    out = sl !== sl0;
    if (!b._slotRd || b._slotRd.ver !== net.version || b._slotRd.list !== b._slots.list) {
      // 候選道路：建築自己的場內道路＋地塊附近的一般地面道路（臨路的路段可能被巷道口切成好幾段）
      const ids = new Set([b.seg, b.front && b.front.seg, ...(b.roads || [])].filter(id => id !== null && id !== undefined));
      const bb = { x0: b.x - b.rad - 30, y0: b.y - b.rad - 30, x1: b.x + b.rad + 30, y1: b.y + b.rad + 30 };
      for (const s of net.segs.values()) if (!s.T.internal && s.T.access && s.drawLevel === 0 && bboxOverlap(bb, s.bbox)) ids.add(s.id);
      b._slotRd = { ver: net.version, list: b._slots.list, map: new Map(), ids: [...ids] };
    }
    const m = b._slotRd.map, key = (truck ? 't' + i : i) + (out ? 'o' : '');
    if (m.has(key)) return m.get(key);
    const walls = b._slots.walls;
    let best = null;
    for (const id of b._slotRd.ids) {
      const s = net.segs.get(id);
      if (!s || (s.gate !== undefined && s.gate !== null && s.gate !== b.id)) continue;
      const c = closestOnPoly(s.pts, s.cum, sl);
      if (c.d > 45) continue;
      const L = Math.hypot(c.x - sl.x, c.y - sl.y) || 1, along = Math.abs((c.x - sl.x) * sl.ax + (c.y - sl.y) * sl.ay) / L;
      const blocked = walls.some(w => segHitsPoly(sl, c, w));
      const score = c.d * (along > 0.7 ? 1 : 4) + (blocked ? 1000 : 0);
      if (!best || score < best.score) best = { seg: id, u: clamp(c.s, 1, s.len - 1), score };
    }
    const r = best && { seg: best.seg, u: best.u };
    m.set(key, r);
    return r;
  }
  parkedCount(b, truck = false) { return this.slotSet(b, truck).occ.reduce((a, c) => a + (c ? 1 : 0), 0); }
  // 隨機挑最多 n 輛停著的車（不重複），依序嘗試開走；truck 為貨車（卸貨區）
  pickParked(b, n = 1, truck = false) {
    const { list, occ } = this.slotSet(b, truck), used = [], out = [];
    for (let i = 0; i < list.length; i++) if (occ[i]) used.push(i);
    while (used.length && out.length < n) {
      const i = used.splice(Math.floor(this.game.rng.next() * used.length), 1)[0];
      out.push({ idx: i, slot: list[i], color: occ[i] });
    }
    return out;
  }

  addBuilding(zt, seg, u, side, cols, rows, level = 1, kind = null, geo = null) {
    geo = geo || this.lotGeom(seg, u, side, cols, rows);
    const zone = ZONE_TYPES[zt].zone;
    const b = {
      id: this.nextId++, built: true, zone, zt, kind: kind || this.pickKind(zt, cols, rows), seg: seg.id, u, side, level, ...geo,
      streetPark: seg.T.rank <= 1 && !seg.T.internal,
      happy: 0.7, workOK: 0.8, shopOK: 0.8, timeScore: 0.8, pollution: 0, noise: 0,
      workSat: 0.7, goodsSat: 1, custSat: 0.6, matSat: 1, stock: zone === 'R' ? 0 : zt === 'RC' ? 20 : 8, custLevel: 0, present: 0,
      // 起始累計量隨機，讓各棟建築的出發時間錯開
      acc: { work: this.game.rng.next(), shop: this.game.rng.next(), goods: this.game.rng.next(), mat: this.game.rng.next(), outw: this.game.rng.next() },
      queue: [], spawnCD: 0, highT: 0, lowT: 0,
      abandoned: false, abT: 0, variant: (this.nextId * 7919) % 5, dead: false, born: this.game.time,
    };
    this.buildings.push(b);
    this.byId.set(b.id, b);
    this.seedParked(b);
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

  // 新道路經過的空地塊直接取消分區；旁邊有園區 / 停車場的話，下一步把它們的場內道路接過去
  onRoadBuilt(segs) {
    const net = this.game.net;
    for (const s of segs) if (!s.T.internal && net.nodes.get(s.a)?.level === 0 && net.nodes.get(s.b)?.level === 0) (this._newRoads || (this._newRoads = [])).push(s);
    for (const s of segs) {
      if (net.nodes.get(s.a)?.level !== 0 || net.nodes.get(s.b)?.level !== 0) continue;
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

  addRailOutside(node, name) {
    node.outside = true;
    const o = { node: node.id, name, rail: true };
    this.railOutside.push(o);
    return o;
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
  // 已接到城市路網（與建築最多的連通區相連）的外部連線
  liveOutside() {
    const comp = this.mainComponent();
    return this.outside.filter(o => o.seg !== null && comp.has(o.node));
  }
  // 最近的鐵路貨運站（要有月台；need：要有原料存貨）
  nearCargo(b, need) {
    let best = null, bd = 3000;
    for (const x of this.buildings) {
      if (x.zt !== 'RC' || x.dead || x.abandoned || (need && x.stock < 1) || !this.platformOf(x)) continue;
      const d = Math.hypot(x.x - b.x, x.y - b.y);
      if (d < bd) { bd = d; best = x; }
    }
    return best;
  }
  pickJob(b) {
    return this.roulette(this.buildings.filter(x => (x.zone === 'C' || x.zone === 'I') && !x.abandoned),
      x => this.cap(x) * this.near(b, x, 700) * (x.present < this.cap(x) * 0.5 * TRIP_REF ? 1.5 : 0.4));
  }
  pickShop(b) {
    return this.roulette(this.buildings.filter(x => x.zone === 'C' && !x.abandoned), x => this.cap(x) * (SHOP_KINDS[x.kind]?.shop || 1) * this.near(b, x, x.kind === 'bigbox' || x.kind === 'mall' || x.kind === 'mallp' ? 900 : 450));
  }
  pickGoodsDest(b) {
    return this.roulette(this.buildings.filter(x => x.zone === 'C' && !x.abandoned && x.kind !== 'office'), x => this.cap(x) * (x.stock < 10 ? 2 : 0.4) * this.near(b, x, 1000));
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
    // 等待出發的行程上限：大型建築（大飯店、大樓）同時要出門的人多，可以排得比較長
    if (origin.queue.length > (origin.zone ? Math.max(30, this.cap(origin) * 0.6) : 30)) {
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
    if (trip.kind === 'taxiret') return;   // 計程車開回車行，不算行程
    if (!ok) { this.recordFail(trip); return; }
    this.stats.trips++; this.stats.hourTrips++;
    this.stats.tripTimeSum += age;
    const from = trip.from, to = trip.to;
    let toll = 0.6;
    switch (trip.kind) {
      case 'work': {
        if (from.zone === 'R') { from.workOK = ema(from.workOK, 1, 0.15); from.timeScore = ema(from.timeScore, clamp(1 - (age - 150) / 600, 0, 1), 0.15); }
        if (!to.dead && (to.zone || to.outside)) {
          if (to.zone) to.present++;
          const day = Math.floor(g.time / 1440) * 1440;
          let dep = day + 17 * 60 + 20 + g.rng.gauss() * 80;
          if (dep < g.time + 120) dep = g.time + 240 + g.rng.next() * 120;
          this.schedule(dep, { kind: 'home', from: to, to: from, truck: false, worker: !!to.zone, transit: trip.transit });
        }
        break;
      }
      case 'shop':
        if (from.zone === 'R') from.shopOK = ema(from.shopOK, 1, 0.15);
        if (!to.dead) {
          to.custLevel += 1; this.stats.custHour = (this.stats.custHour || 0) + 1;
          to.stock = Math.max(0, to.stock - 0.4);
          this.schedule(g.time + 40 + g.rng.next() * 90, { kind: 'home', from: to, to: from, truck: false, transit: trip.transit });
        }
        toll = 1;
        break;
      case 'visit':
        // 住一晚，隔天上午離開
        if (!to.dead) {
          to.custLevel += 1; this.stats.custHour = (this.stats.custHour || 0) + 1;
          const day = Math.floor(g.time / 1440) * 1440;
          this.schedule(day + 1440 + 9 * 60 + g.rng.next() * 180, { kind: 'home', from: to, to: from, truck: false });
        }
        toll = 2;
        break;
      case 'goods':
        // 送到鐵路貨運站的是外銷商品（等貨運列車載走）
        if (!to.dead && to.zt === 'RC') to.exports = (to.exports || 0) + 1;
        else if (!to.dead && to.zone) to.stock = Math.min(40, to.stock + 6);
        // 送貨到商店的貨車卸完貨（停在卸貨區 30～60 分鐘）後開回工廠
        if (!to.dead && to.zone === 'C' && from.zone && !from.dead) this.schedule(g.time + 30 + g.rng.next() * 30, { kind: 'return', from: to, to: from, truck: true });
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
    if (this._reconnectAll) {
      this._reconnectAll = false;
      for (const b of [...this.buildings]) if (b.roads) { b.parkPlan = b.parkPlan || driveway(b.zone, b.kind, b); this.connectPark(b); }
    }
    if (this._newRoads && this._newRoads.length) {
      const segs = this._newRoads; this._newRoads = [];
      for (const b of [...this.buildings]) {
        if (b.roads && !b.parkPlan) b.parkPlan = driveway(b.zone, b.kind, b);
        if (!b.parkPlan || !b.parkPlan.through) continue;
        if (segs.some(s => !(s.bbox.x1 < b.x - b.rad - 20 || s.bbox.x0 > b.x + b.rad + 20 || s.bbox.y1 < b.y - b.rad - 20 || s.bbox.y0 > b.y + b.rad + 20))) this.connectPark(b);
      }
    }
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
      if (b.abandoned || b.zone === 'T') continue;   // 公車總站不產生行程（公車由 transit.js 派車）
      const cap = this.cap(b);
      if (b.zone === 'R') {
        b.acc.work += cap * 0.3 * pWork * k;
        b.acc.shop += cap * 0.12 * pShop * k;
        while (b.acc.work >= 1) {
          b.acc.work -= 1;
          // 約兩成居民到外地上班（早上出城、傍晚回來）
          const d = rng.chance(0.2) && this.liveOutside().length ? this.pickOutside(b) : this.pickJob(b);
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
        // 大型商場吸引外地顧客
        if (b.kind === 'bigbox' || b.kind === 'mall' || b.kind === 'mallp' || b.kind === 'market') {
          b.acc.ext = (b.acc.ext || 0) + cap * 0.08 * pShop * k;
          while (b.acc.ext >= 1) {
            b.acc.ext -= 1;
            const o = this.pickOutside(b);
            if (o) this.pushTrip(o, { kind: 'shop', from: o, to: b, truck: false });
          }
        }
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
          // 約三成商品外銷（貨車開往外部連線）
          // 有鐵路貨運站時外銷的商品送到貨運站，由貨運列車載出去
          const ex = rng.chance(0.3), rc = ex ? this.nearCargo(b, false) : null;
          const d = rc || (ex && this.liveOutside().length ? this.pickOutside(b) : this.pickGoodsDest(b));
          if (d) { b.stock -= 1; this.pushTrip(b, { kind: 'goods', from: b, to: d, truck: true }); }
        }
        if (b.stock < 12) {
          b.acc.mat += cap / 6 * pFreight * k;
          while (b.acc.mat >= 1) {
            b.acc.mat -= 1;
            // 原料：有存貨的鐵路貨運站優先（貨運列車從外地運來），否則貨車從外部連線運來
            const rc = this.nearCargo(b, true), o = rc || this.pickOutside(b);
            if (rc) rc.stock -= 1;
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
    if (g.transit) g.transit.update(dt);
    // 生成車輛
    this.spawnFrom(this.buildings, dt, 0.8);
    this.spawnFrom(this.outside, dt, 0.35);

    this.hourT += dt;
    if (this.hourT >= 60) { this.hourT -= 60; this.hourly(); }
    this.growT += dt;
    if (this.growT >= 30) {
      this.growT = 0;
      if ((this.jam || 0) < 0.35 && g.time >= this.growStart) { this.developLots(); if (g.autoGrow) this.autoGrow(); }
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
      // 搭公車：起訖附近都有同一條路線的站牌時，部分居民（BUS_SHARE）就算有車也改搭公車，回程也搭公車
      if (!trip.truck && !trip.transit && !trip.mode && o.zone === 'R' && (trip.kind === 'work' || trip.kind === 'shop') && this.game.transit) {
        const x = this.game.rng.next();
        trip.mode = x < BUS_SHARE ? 'bus' : x < BUS_SHARE + TAXI_SHARE ? 'taxi' : 'car';
        if (trip.mode === 'bus' && this.game.transit.board(trip)) { o.queue.shift(); trip.transit = true; continue; }
        // 叫計程車（回程也搭計程車 / 大眾運輸）
        if (trip.mode === 'taxi' && this.game.transit.callTaxi(trip)) { o.queue.shift(); trip.transit = true; continue; }
      }
      const r = tr.trySpawn(trip);
      if (r === 'ok') { o.queue.shift(); o.spawnCD = cd; }
      else if (r === 'transit') {
        // 家裡的車都開走了：起訖附近有同一條公車路線的站牌就去等公車，否則走路（不產生車；回程也不開車）
        // 沒有公車可搭時叫計程車，都沒有才走路
        o.queue.shift(); trip.transit = true;
        const T = this.game.transit;
        if (!(T && (T.board(trip) || T.callTaxi(trip)))) { if (T) T.stats.walked++; this.onTripEnd(trip, true, 300); }
      }
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
    // 顧客：全市最近約 10 小時的來客數（每小時衰減 0.9），各商店依吸引力（容量 × 購物權重）分到應有的份額；
    // 來客達到份額的六成就算滿意。購物行程集中在下午，以小時計會讓商店每晚都掉到零
    const st = this.stats, shopW = b => this.cap(b) * (SHOP_KINDS[b.kind]?.shop || 1);
    // 走路來的顧客（不產生車輛）：附近 450 m 內住宅的居民，下午最多；加油站則是路過的車進來加油
    const homes = this.buildings.filter(b => b.zone === 'R' && !b.abandoned), pWalk = gauss(hour + 0.5, 14.5, 3.2) + 0.01;
    for (const b of this.buildings) {
      if (b.zone !== 'C' || b.abandoned || b.kind === 'office') continue;
      if (b.kind === 'gas') {
        const s = net.segs.get(b.seg);
        if (s) b.custLevel += ((s.links[1].passAcc || 0) + (s.links[-1].passAcc || 0)) * 0.25;
        continue;
      }
    }
    // 每戶走路購物的人分給 450 m 內的商店（依吸引力與距離），大型店主要靠開車來的顧客
    const shopsC = this.buildings.filter(b => b.zone === 'C' && !b.abandoned && b.kind !== 'office' && b.kind !== 'gas');
    for (const h of homes) {
      const near = [];
      let tw = 0;
      for (const b of shopsC) {
        const d = Math.hypot(h.x - b.x, h.y - b.y);
        if (d >= 450) continue;
        const w = shopW(b) * (1 - d / 450) * (b.kind === 'mall' || b.kind === 'mallp' || b.kind === 'bigbox' ? 0.3 : 1);
        near.push([b, w]); tw += w;
      }
      if (!tw) continue;
      const n = this.cap(h) * 0.02 * pWalk;
      for (const [b, w] of near) b.custLevel += n * w / tw;
      st.custHour = (st.custHour || 0) + n;
    }
    for (const L of net.links.values()) L.passAcc = 0;
    st.custTot = (st.custTot || 0) * 0.9 + (st.custHour || 0); st.custHour = 0;
    const custW = this.buildings.reduce((a, b) => a + (b.zone === 'C' && !b.abandoned && b.kind !== 'office' && b.kind !== 'gas' ? shopW(b) : 0), 0);
    let income = 0;
    for (const b of this.buildings) {
      if (b.zone === 'T') { b.happy = 1; b.workSat = 1; continue; }
      const cap = this.cap(b);
      if (b.zone === 'R') {
        let pol = 0;
        for (const i of POLLUTION ? inds : []) {
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
        if (workHours) b.workSat = ema(b.workSat, clamp(b.present / Math.max(1, cap / 3 * 0.6 * TRIP_REF), 0, 1), 0.25);
        if (b.zone === 'C') {
          b.goodsSat = ema(b.goodsSat, b.stock > 0.5 ? 1 : 0, 0.2);
          if (b.kind === 'office') {
            // 辦公大樓不靠顧客與商品，只看員工
            b.custSat = 1; b.goodsSat = 1; b.happy = b.workSat;
          } else {
            const need = b.kind === 'gas' ? Math.max(0.6, cap * 0.4) : Math.max(0.4, 0.6 * st.custTot * shopW(b) / Math.max(1, custW));
            b.custSat = ema(b.custSat, clamp(b.custLevel / need, 0, 1), 0.2);
            b.happy = 0.35 * b.workSat + 0.3 * b.goodsSat + 0.35 * b.custSat;
          }
          b.custLevel *= 0.9;
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
      // 新蓋的建築有一天的緩衝期，不會一開始還沒有員工 / 顧客就被判定衰退
      if (b.happy < 0.3 && g.time - b.born > 1440) {
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
      if (b.zone === 'R') pop += c; else if (b.zone === 'C') jc += c; else if (b.zone === 'I') ji += c;
    }
    this.pop = pop; this.jobsC = jc; this.jobsI = ji;
    this.peakPop = Math.max(this.peakPop || 0, pop);
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
    // 公車總站不看需求，劃了就蓋
    for (const l of this.lots.filter(l => l.zone === 'T' && net.segs.has(l.seg) && comp.has(net.segs.get(l.seg).a))) this.develop(l);
    for (const z of ['R', 'C', 'I']) {
      const d = this.demand[z];
      if (d <= DEMAND_BUILD) continue;
      const cand = this.lots.filter(l => l.zone === z && net.segs.has(l.seg) && comp.has(net.segs.get(l.seg).a));
      // 需求越高一次蓋越多（剛過分水嶺時一次一棟，不會一下子蓋太多又變成荒廢）
      let n = d > 0.7 ? 3 : d > 0.45 ? 2 : 1;
      while (n-- > 0 && cand.length) this.develop(cand.splice(rng.int(0, cand.length - 1), 1)[0]);
    }
    this.recount();
  }

  // 自動發展：需求高而且沒有空地塊時，自動在路旁劃設大小不一的分區
  autoGrow() {
    const g = this.game, net = g.net, rng = g.rng;
    const zones = ['R', 'C', 'I'].filter(z => this.demand[z] > DEMAND_ZONE && this.lots.filter(l => l.zone === z).length < 3)
      .sort((a, b) => this.demand[b] - this.demand[a]);
    if (!zones.length) return;
    const comp = this.mainComponent();
    const park = this.parkRoadSet();
    const segs = [...net.segs.values()].filter(s => s.T.access && s.drawLevel === 0 && net.nodes.get(s.a).level === 0 && net.nodes.get(s.b).level === 0 && s.len > 30 && comp.has(s.a) && !park.has(s.id));
    if (!segs.length) return;
    for (const zone of zones) {
      const n = this.demand[zone] > 0.7 ? 2 : 1;
      let placed = 0;
      for (let tries = 0; tries < 18 && placed < n; tries++) {
        let seg;
        if (zone === 'I') {
          // 工業區：挑離住宅（建築與空地塊）最遠的那幾條路
          const res = [...this.buildings, ...this.lots].filter(b => b.zone === 'R');
          const far = s => { const x = (s.bbox.x0 + s.bbox.x1) / 2, y = (s.bbox.y0 + s.bbox.y1) / 2; return res.reduce((m, b) => Math.min(m, Math.hypot(b.x - x, b.y - y)), Infinity); };
          const ranked = segs.map(s => [far(s), s]).sort((a, b) => b[0] - a[0]);
          seg = rng.pick(ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.25)))).at(1);
        } else if (this.buildings.length && rng.chance(0.75)) {
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
        // 住宅與工業保持距離（建築與還沒蓋的分區都算）
        const placedAll = [...this.buildings, ...this.lots];
        if (zone === 'R' && placedAll.some(b => b.zone === 'I' && Math.hypot(b.x - geo.x, b.y - geo.y) < SEP_RI + geo.rad + b.rad)) continue;
        if (zone === 'I' && placedAll.some(b => b.zone === 'R' && Math.hypot(b.x - geo.x, b.y - geo.y) < SEP_RI + geo.rad + b.rad)) continue;
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
    // 只用已解鎖的分區與尺寸
    const fit = o => { const m = this.maxCells(o.zt, seg); return { zt: o.zt, cols: Math.min(o.cols, m), rows: Math.min(o.rows, m) }; };
    if (zone === 'R') {
      const zt = this.maxCells('R3') && seg.T.rank >= 2 && rng.chance(0.35) ? 'R3' : this.maxCells('R2') && rng.chance(0.45) ? 'R2' : 'R1';
      return fit(zt === 'R3' ? { zt, cols: R(4, 8), rows: R(4, 7) } : { zt, cols: R(3, 6), rows: R(3, 5) });
    }
    if (zone === 'C') return fit(this.maxCells('C') >= 15 && rng.chance(0.12) ? { zt: 'C', cols: R(15, 18), rows: 15 } : { zt: 'C', cols: R(3, 7), rows: R(3, 5) });
    return fit({ zt: 'I', cols: R(5, 10), rows: R(5, 9) });
  }

  // ---------- 序列化 ----------
  serialize() {
    return {
      nextId: this.nextId,
      buildings: this.buildings.map(b => ({ id: b.id, zone: b.zone, zt: b.zt, kind: b.kind, cols: b.cols, rows: b.rows, seg: b.seg, u: b.u, side: b.side, level: b.level, happy: b.happy, stock: b.stock, abandoned: b.abandoned,
        busHub: b.busHub || undefined, roads: b.roads || undefined, front: b.front || undefined, gates: b.gates || undefined, parkPlan: b.parkPlan || undefined, links: b.links || undefined, slotOcc: b.slotOcc && b.slotOcc.some(Boolean) ? b.slotOcc : undefined, tOcc: b.tOcc && b.tOcc.some(Boolean) ? b.tOcc : undefined, c0: b.roads ? [b.corners[0].x, b.corners[0].y, b.tx, b.ty, b.nx, b.ny] : undefined })),
      lots: this.lots.map(l => ({ zt: l.zt, seg: l.seg, u: l.u, side: l.side, cols: l.cols, rows: l.rows })),
      outside: this.outside.map(o => ({ node: o.node, name: o.name })),
      railOutside: this.railOutside.map(o => ({ node: o.node, name: o.name })),
      demand: this.demand, stats: this.stats, history: this.history, growStart: this.growStart, peakPop: this.peakPop,
    };
  }
  load(d) {
    const net = this.game.net;
    for (const o of d.outside) this.addOutside(net.nodes.get(o.node), o.name);
    for (const o of d.railOutside || []) if (net.nodes.get(o.node)) this.addRailOutside(net.nodes.get(o.node), o.name);
    for (const s of d.buildings) {
      const seg = net.segs.get(s.seg);
      if (!seg) continue;
      // 舊存檔沒有格數：依舊版固定尺寸換算
      const zt = s.zt || (s.zone === 'R' ? 'R1' : s.zone);
      const old = { R: [3, 3], C: [4, 4], I: [5, 5] }[s.zone];
      const geo = s.c0 ? this.geomFrom(...s.c0, s.cols, s.rows) : null;
      const b = this.addBuilding(zt, seg, s.u, s.side, s.cols || old[0], s.rows || old[1], s.level, s.kind, geo);
      if (s.busHub) b.busHub = true;
      if (s.roads) { b.roads = s.roads; b.front = s.front || null; this.markGate(b); }
      if (s.parkPlan) { b.parkPlan = s.parkPlan; b.links = s.links || {}; }
      const gs = s.gates || (s.gate ? [s.gate] : null);
      if (gs) b.gates = gs;
      b.happy = s.happy; b.stock = s.stock; b.abandoned = s.abandoned;
      this.slotsOf(b);
      if (s.slotOcc) b.slotOcc = b.slotOcc.map((_, i) => s.slotOcc[i] || null);
      else if (s.parked !== undefined) b.slotOcc = b.slotOcc.map((_, i) => (i < s.parked ? this.slotsOf(b)[i].c : null));
      if (s.tOcc) b.tOcc = b.tOcc.map((_, i) => s.tOcc[i] || null);
      // 公車總站：存檔時在路上跑的公車不會存，讀檔後全部停回總站重新派車
      if (b.zt === 'T' || b.zt === 'RT') b.tOcc = b.tOcc.map(() => '#d23c2c');
    }
    for (const l of d.lots || []) {
      const seg = net.segs.get(l.seg);
      if (seg) this.addLot(l.zt, seg, l.u, l.side, l.cols, l.rows);
    }
    this.nextId = Math.max(this.nextId, d.nextId);
    // 讀檔後檢查一次：園區 / 停車場旁邊若已有道路就接上（舊存檔沒有這個資料）
    this._reconnectAll = true;
    Object.assign(this.demand, d.demand);
    Object.assign(this.stats, d.stats);
    this.history = d.history || [];
    this.growStart = d.growStart || 0;
    this.peakPop = Math.max(d.peakPop || 0, this.pop || 0);
    this.afterRebuild();
    this.recount();
  }
}

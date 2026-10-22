// 大眾運輸：公車總站（大眾運輸分區）、自動規劃的公車路線與站牌、乘客
// - 站牌：住宅 / 商業 / 工業建築臨路的位置依人口、工作數加權，由大到小挑，彼此至少相距 STOP_GAP
// - 路線：每個總站開 1～4 條；離總站最近的站是轉乘站（每條路線都經過），其餘站牌依相對總站的方位分組，
//   每組從轉乘站開始以最近鄰排成環狀路線
// - 公車：從總站的公車停車格開出，依序繞行各站，每站停靠時上下客；路線取消時開回總站停好
// - 乘客：家裡車子都開走（或選擇搭公車）的居民，若起點與目的地附近（WALK 公尺內）都有站牌、搭同一條路線或在轉乘站換一次車到得了，
//   就走到站牌等車；否則走路
import { pointAt, clamp, closestOnPoly } from './util.js';
import { routeFromPoint, findRoute } from './routing.js';
import { CLOCK } from './config.js';

// 計程車：叫車的居民在 TAXI_RANGE 公尺內有停著計程車的車行 / 招呼站才叫得到
const TAXI_RANGE = 1600;

const LINE_COLORS = ['#d23c2c', '#1f6fb5', '#2a9d3f', '#e08a1e', '#7d3c98', '#0f8b8d'];
const RAIL_COLORS = ['#e8eef2', '#f2e9d6', '#e3f0e6'];
// 鐵路：車站步行範圍較大；列車載客量；貨運列車的班距（遊戲分鐘）
const RAIL_WALK = 800, TRAIN_CAP = 300, FREIGHT_EVERY = 240;
// 時間膨脹：公車繞一圈要好幾個遊戲小時，候車上限以模擬秒計（MAX_WAIT_S）；每條路線最多 MAX_STOPS 站
const STOP_GAP = 240, WALK = 450, RANGE = 1500, PLAN_EVERY = 1440, MAX_WAIT_S = 240, MAX_STOPS = 9, CAPACITY = 60, HEADWAY = 80, MAX_BUSES = 8;
export const BUS_LEN = 12, BUS_W = 2.6;

export class Transit {
  constructor(game) {
    this.game = game;
    this.lines = [];
    this.stops = [];
    this.planT = 0;
    this.nextId = 1;   // 站牌編號一直往上加：重新規劃時位置沒變的站牌沿用原編號（車上乘客記的是站牌編號）
    this._key = '';
    this.stats = { riders: 0, walked: 0 };
  }
  get city() { return this.game.city; }
  get net() { return this.game.net; }
  // 公車總站（含附設公車轉運站的鐵路總站）
  depots() { return this.city.buildings.filter(b => (b.zt === 'T' || (b.zt === 'RT' && b.busHub)) && !b.dead && !b.abandoned && this.city.truckSlotsOf(b).length); }
  railStations() { return this.city.buildings.filter(b => (b.zt === 'RT' || b.zt === 'RS') && !b.dead && !b.abandoned && this.city.platformOf(b)); }
  // 鐵路的連通區：節點 id → 編號（只沿鐵路路段）
  railComp() {
    const net = this.net, comp = new Map();
    let k = 0;
    for (const s0 of net.segs.values()) {
      if (!s0.T.rail || comp.has(s0.a)) continue;
      k++;
      const st = [s0.a];
      comp.set(s0.a, k);
      while (st.length) {
        const n = net.nodes.get(st.pop());
        for (const id of n.segs) { const s = net.segs.get(id); if (!s.T.rail) continue; for (const o of [s.a, s.b]) if (!comp.has(o)) { comp.set(o, k); st.push(o); } }
      }
    }
    return comp;
  }
  // 計程車行與招呼站
  taxiStands() { return this.city.buildings.filter(b => (b.zt === 'TX' || b.zt === 'TS') && !b.dead && !b.abandoned); }

  // 叫計程車：從最近、有停著計程車的車行 / 招呼站派車去接乘客（起訖都要是城市裡的建築）。成功回傳 true
  callTaxi(trip) {
    const a = trip.from, b = trip.to, C = this.city;
    if (!a || !b || a.outside || b.outside || a.dead || b.dead) return false;
    const st = this.taxiStands().filter(s => C.parkedCount(s) > 0).map(s => [s, Math.hypot(s.x - a.x, s.y - a.y)]).filter(e => e[1] < TAXI_RANGE).sort((p, q) => p[1] - q[1]);
    for (const [s] of st.slice(0, 3)) {
      const r = this.game.traffic.trySpawn({ kind: 'taxi', from: s, to: a, truck: false, taxi: trip }, { seg: a.seg, u: a.u, id: s.id });
      if (r === 'ok') { this.stats.taxiCalls = (this.stats.taxiCalls || 0) + 1; return true; }
    }
    return false;
  }
  // 計程車開完一趟：找最近、有空車位的車行 / 招呼站停回去
  taxiHome(from) {
    const C = this.city;
    let best = null, bd = Infinity;
    for (const s of this.taxiStands()) {
      const { occ, res } = C.slotSet(s, false);
      if (!occ.some((o, i) => !o && !res[i])) continue;
      const d = Math.hypot(s.x - from.x, s.y - from.y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  stop(id) { return this.stops.find(t => t.id === id); }
  line(id) { return this.lines.find(l => l.id === id); }
  // 站點位置：鐵路車站給列車的是月台（鐵軌上），給公車的是站前道路
  stopPoint(t, train = false) { return t.type === 'rail' && !train ? { seg: t.bseg, u: t.bu } : { seg: t.seg, u: t.u }; }

  // dt：遊戲分鐘
  update(dt) {
    const ds = this.depots(), key = [...ds, ...this.railStations()].map(b => b.id + (b.busHub ? 'h' : '')).join(',');
    this.planT -= dt;
    if (this.planT <= 0 || key !== this._key) { this._key = key; this.planT = PLAN_EVERY; this.plan(); }
    this.dispatch();
    // 貨運列車：每 FREIGHT_EVERY 分鐘從外部鐵路開一班到每個接得到的貨運站
    this.freightT = (this.freightT ?? 30) - dt;
    if (this.freightT <= 0) { this.freightT = FREIGHT_EVERY; this.sendFreight(); }
    // 等太久的乘客改走路
    const now = this.game.time, maxWait = MAX_WAIT_S * CLOCK;
    for (const t of this.stops) {
      if (!t.queue.length || now - t.queue[0].t < maxWait) continue;
      t.queue = t.queue.filter(p => { if (now - p.t < maxWait) return true; this.walk(p.trip); return false; });
    }
  }

  // 貨運列車：外部鐵路 → 貨運站（卸下原料、裝上外銷商品）→ 開回外部鐵路
  sendFreight() {
    const C = this.city, tr = this.game.traffic, comp = this.railComp();
    for (const rc of C.buildings) {
      if (rc.zt !== 'RC' || rc.dead || rc.abandoned) continue;
      const p = C.platformOf(rc);
      if (!p || tr.vehicles.some(v => v.freight && v.freight.rc === rc.id)) continue;
      const k = comp.get(this.net.segs.get(p.seg).a), o = C.railOutside.find(o => comp.get(o.node) === k);
      if (o) tr.spawnFreight(o, rc);
    }
  }

  // 鐵路路線：每個鐵路總站發車，依序停靠同一條鐵路上的各車站，到底再折返（來回）
  planRail(old, li) {
    const net = this.net, C = this.city, sts = this.railStations(), comp = this.railComp();
    for (const b of sts) {
      const p = C.platformOf(b), o = old.find(t => t.id === 'r' + b.id);
      const t = o || { id: 'r' + b.id, type: 'rail', queue: [] };
      Object.assign(t, { b: b.id, seg: p.seg, u: p.u, x: b.x, y: b.y, bseg: b.seg, bu: b.u, dx: 0, dy: 0, lines: [] });
      this.stops.push(t);
    }
    let no = 0;
    for (const T of sts.filter(b => b.zt === 'RT')) {
      const s0 = this.stop('r' + T.id), k = comp.get(net.segs.get(s0.seg).a);
      const left = this.stops.filter(t => t.type === 'rail' && t !== s0 && comp.get(net.segs.get(t.seg).a) === k), order = [];
      if (!left.length) continue;
      let cur = s0;
      while (left.length) { left.sort((a, b) => Math.hypot(a.x - cur.x, a.y - cur.y) - Math.hypot(b.x - cur.x, b.y - cur.y)); cur = left.shift(); order.push(cur); }
      const seq = [s0, ...order, ...order.slice(0, -1).reverse()];
      li++; no++;
      // 繞一圈的估計時間（模擬秒）：站間直線距離 × 1.2，平均 20 m/s，每站停 12 秒；列車數依班距約 90 秒，最多 3 列
      let loop = 0;
      seq.forEach((t, i) => { const n2 = seq[(i + 1) % seq.length]; loop += Math.hypot(n2.x - t.x, n2.y - t.y) * 1.2 / 20 + 12; });
      const nt = clamp(Math.round(loop / 90), 1, 3);
      const line = { id: li, rail: true, name: `鐵路 ${no} 號線`, color: RAIL_COLORS[(no - 1) % RAIL_COLORS.length], depot: T.id, hub: s0.id, stops: seq.map(t => t.id), buses: nt, headway: loop / nt * CLOCK, nextT: 0 };
      line.legs = [];
      seq.forEach((t, i) => { const n2 = seq[(i + 1) % seq.length], r = routeFromPoint(net, { seg: t.seg, u: t.u, id: 'x' }, { seg: n2.seg, u: n2.u, id: 'x' }); if (r) line.legs.push(r.path); });
      line.path = [...new Set(line.legs.flat())];
      for (const t of new Set(seq)) t.lines.push(line.id);
      this.lines.push(line);
    }
    return li;
  }

  // 重新規劃站牌與路線
  plan() {
    const net = this.net, C = this.city, depots = this.depots(), old = this.stops;
    this.stops = []; this.lines = [];
    let li = this.planRail(old, 0);
    if (depots.length) {
      const cands = [];
      // 可以設站牌的路段：一般地面道路，扣掉兩端路口後至少 34 m；站牌離路口 10～30 m（路段越長越遠，公車停靠時不會擋到路口）
      const usable = s => s.len - s.ra - s.rb, gap = s => clamp((usable(s) - 14) / 2, 10, 30);
      const okSeg = s => s && !s.T.internal && s.T.access && s.drawLevel === 0 && usable(s) >= 34;
      const inSeg = (s, u) => clamp(u, s.ra + gap(s), s.len - s.rb - gap(s));
      // 臨路路段太短（棋盤小街廓、場內道路）：改用 120 m 內最近、夠長的道路
      const segFor = (b, ref) => {
        let s = net.segs.get(ref.seg);
        if (okSeg(s)) return { s, u: ref.u };
        s = net.segs.get(b.seg);
        if (okSeg(s)) return { s, u: b.u };
        let best = null;
        for (const s2 of net.segs.values()) {
          if (!okSeg(s2) || s2.bbox.x0 > b.x + 120 || s2.bbox.x1 < b.x - 120 || s2.bbox.y0 > b.y + 120 || s2.bbox.y1 < b.y - 120) continue;
          const c = closestOnPoly(s2.pts, s2.cum, b);
          if (c.d < 120 && (!best || c.d < best.d)) best = { s: s2, u: c.s, d: c.d };
        }
        return best;
      };
      // 玩家手動放的站牌：排在最前面（權重最大），一定會成為站牌
      for (const m of C.busStops) {
        const sn = net.segNear(m.x, m.y, 12, 0);
        if (!sn || !sn.seg.T.access || sn.seg.T.internal) continue;
        cands.push({ seg: sn.seg.id, u: clamp(sn.u, Math.min(sn.seg.ra + gap(sn.seg), sn.seg.len / 2), Math.max(sn.seg.len - sn.seg.rb - gap(sn.seg), sn.seg.len / 2)), w: 1e9, manual: true });
      }
      for (const b of C.buildings) {
        if (b.abandoned || !(b.zone === 'R' || b.zone === 'C' || b.zone === 'I')) continue;
        const f = segFor(b, b.front || { seg: b.seg, u: b.u });
        if (!f || C.busStops.some(m => Math.hypot(m.x - b.x, m.y - b.y) < STOP_GAP * 0.6)) continue;
        cands.push({ seg: f.s.id, u: inSeg(f.s, f.u), w: C.cap(b) * (b.zone === 'R' ? 1 : 0.8) });
      }
      cands.sort((a, b) => b.w - a.w);
      for (const c of cands) {
        const s = net.segs.get(c.seg), p = pointAt(s.pts, s.cum, c.u);
        if (!depots.some(d => Math.hypot(d.x - p.x, d.y - p.y) < RANGE)) continue;
        // 附近原本就有站牌（同方向）：沿用原來的站牌，站位不動
        const o = old.find(t => Math.hypot(t.x - p.x, t.y - p.y) < STOP_GAP * 0.5 && t.dx * p.dx + t.dy * p.dy > 0.7 && net.segs.has(t.seg) && !this.stops.includes(t) && t.type !== 'rail' && okSeg(net.segs.get(t.seg)) && Math.abs(t.u - inSeg(net.segs.get(t.seg), t.u)) < 0.01);
        const q = o ? { x: o.x, y: o.y } : p;
        if (this.stops.some(t => t.type !== 'rail' && Math.hypot(t.x - q.x, t.y - q.y) < STOP_GAP)) continue;
        if (o) { o.lines = []; o.manual = !!c.manual; this.stops.push(o); }
        else this.stops.push({ id: this.nextId++, seg: c.seg, u: c.u, x: p.x, y: p.y, dx: p.dx, dy: p.dy, lines: [], queue: [], manual: !!c.manual });
        if (this.stops.length >= 80) break;
      }
      for (const d of depots) {
        const buses = C.truckSlotsOf(d).length;
        // 總站到得了的站牌（同一個路網連通區）
        const from = { seg: d.seg, u: d.u, id: d.id };
        const mine = this.stops.filter(t => t.type !== 'rail' && !t.lines.length && Math.hypot(t.x - d.x, t.y - d.y) < RANGE && routeFromPoint(net, from, { seg: t.seg, u: t.u, id: d.id }));
        // 轉乘站：離總站最近的站，每條路線都從這裡出發；附設公車轉運站的鐵路總站就是車站本身（公車與列車在這裡轉乘）
        mine.sort((a, b) => Math.hypot(a.x - d.x, a.y - d.y) - Math.hypot(b.x - d.x, b.y - d.y));
        const hub = d.zt === 'RT' ? this.stop('r' + d.id) : mine.shift();
        // 城市還小的時候：轉乘站加一個站就能開一條來回的路線
        if (!hub || mine.length < 1) continue;
        const nLines = clamp(Math.ceil(mine.length / (MAX_STOPS - 1)), 1, Math.max(1, Math.min(4, Math.floor(mine.length / 2))));
        mine.sort((a, b) => Math.atan2(a.y - d.y, a.x - d.x) - Math.atan2(b.y - d.y, b.x - d.x));
        const per = Math.ceil(mine.length / nLines);
        for (let k = 0; k < nLines; k++) {
          const group = mine.slice(k * per, (k + 1) * per).slice(0, MAX_STOPS - 1);
          if (!group.length) continue;
          const order = [hub], left = [...group];
          let cur = hub;
          while (left.length) { left.sort((a, b) => Math.hypot(a.x - cur.x, a.y - cur.y) - Math.hypot(b.x - cur.x, b.y - cur.y)); cur = left.shift(); order.push(cur); }
          // 依實際行駛方向（公車到站後只能順著原方向開走）把站序調到總行駛時間最短，減少繞回頭與迴轉
          const tour = this.bestTour(order, from, d.id);
          li++;
          // 繞一圈的時間（模擬秒）：實際路線的行駛時間＋每站停 6 秒；發車間隔 = 一圈時間 / 公車數
          // 公車數以發車間隔約 HEADWAY 秒為準，不超過總站公車位平均分給各路線的數量
          const loop = tour.cost + tour.order.length * 6;
          const nb = clamp(Math.round(loop / HEADWAY), 1, Math.max(1, Math.min(MAX_BUSES, Math.floor(buses / nLines))));
          const line = { id: li, name: `${li} 路`, color: LINE_COLORS[(li - 1) % LINE_COLORS.length], depot: d.id, hub: hub.id, stops: tour.order.map(t => t.id), buses: nb, headway: loop / nb * CLOCK, nextT: 0 };
          // 實際行駛路徑（畫路線圖用）：依序的每一段（總站 → 各站 → 回到第一站）
          line.legs = tour.legs;
          line.path = [...new Set(tour.legs.flat())];
          for (const t of order) t.lines.push(line.id);
          this.lines.push(line);
        }
      }
    }
    this.stops = this.stops.filter(t => t.lines.length);
    // 等車的乘客：站牌取消、或原本的路線到不了目的地的，重新找站牌（找不到就走路）
    const again = [];
    for (const t of old) {
      const keep = this.stops.includes(t);
      t.queue = t.queue.filter(p => { const L = keep && this.line(p.line); if (L && L.stops.includes(t.id) && L.stops.includes(p.to)) return true; again.push(p); return false; });
    }
    for (const p of again) if (!this.board(p.trip, p.t)) this.walk(p.trip);
    // 公車：路線不存在的開回總站；還在的接著開往路線上的下一站
    const tr = this.game.traffic;
    for (const v of tr.vehicles) {
      if (!v.bus) continue;
      const L = this.line(v.bus);
      if (!L) { tr.retireBus(v); continue; }
      const i = v.busDest ? L.stops.indexOf(v.busDest.stop) : -1;
      if (i >= 0) { v.stopIdx = i; const pt = this.stopPoint(this.stop(L.stops[i]), v.train); if (v.busDest.seg !== pt.seg) { v.busDest = { ...v.busDest, seg: pt.seg, u: pt.u }; if (v.train) tr.trainRoute(v); else tr.reroute(v); } }
      else if (!v.dwell) { v.stopIdx = -1; tr.nextBusStop(v); }
    }
  }

  // 從某站（以 inKey 這個方向的路段抵達；null 表示從總站出發、兩個方向都可以）開到 to 站的路線（含起點路段），有快取
  legRoute(fromPt, inKey, to, gate, memo) {
    const key = (inKey ?? 'p' + fromPt.seg + ':' + Math.round(fromPt.u)) + '>' + to.id;
    if (memo.has(key)) return memo.get(key);
    const net = this.net, pt = this.stopPoint(to), dest = { seg: pt.seg, u: pt.u, id: gate };
    let r = null;
    if (inKey === null || inKey === undefined) r = routeFromPoint(net, { seg: fromPt.seg, u: fromPt.u, id: gate }, dest);
    else {
      const L = net.links.get(inKey);
      if (L) {
        const ahead = L.dir > 0 ? pt.u - fromPt.u : fromPt.u - pt.u;
        if (pt.seg === L.seg.id && ahead > 4) r = { path: [L.key], cost: ahead / L.eff };
        else {
          const f = findRoute(net, [{ link: L, cost: (L.dir > 0 ? L.seg.len - fromPt.u : fromPt.u) / L.eff }], dest, [gate]);
          if (f) r = f;
        }
      }
      // 順著原方向到不了（例如死路）：允許在站牌掉頭，但加重成本
      if (!r) { const b = routeFromPoint(net, { seg: fromPt.seg, u: fromPt.u, id: gate }, dest); if (b) r = { path: b.path, cost: b.cost + 300 }; }
    }
    memo.set(key, r);
    return r;
  }
  // 一圈的行駛時間與每一段路線：總站 → order[0] → … → 回到 order[0]，每站以抵達的方向接著開
  tourCost(order, from, gate, memo) {
    let cost = 0, pt = from, inKey = null;
    const legs = [];
    for (let i = 0; i <= order.length; i++) {
      const to = order[i % order.length], r = this.legRoute(pt, inKey, to, gate, memo);
      if (!r) return { cost: Infinity, legs };
      cost += r.cost; legs.push(r.path);
      pt = this.stopPoint(to); inKey = r.path[r.path.length - 1];
    }
    return { cost, legs };
  }
  // 站序最佳化（2-opt）：轉乘站固定在第一站，其餘站的順序反轉片段，總行駛時間變短就採用
  bestTour(order, from, gate) {
    const memo = new Map();
    let best = order, bc = this.tourCost(best, from, gate, memo);
    for (let pass = 0; pass < 4; pass++) {
      let improved = false;
      for (let i = 1; i < best.length - 1; i++) for (let j = i + 1; j < best.length; j++) {
        const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)], cc = this.tourCost(cand, from, gate, memo);
        if (cc.cost < bc.cost - 0.5) { best = cand; bc = cc; improved = true; }
      }
      if (!improved) break;
    }
    return { order: best, cost: isFinite(bc.cost) ? bc.cost : 0, legs: bc.legs };
  }

  // 依路線缺少的公車數，從總站派車
  dispatch() {
    const tr = this.game.traffic;
    for (const line of this.lines) {
      const d = this.city.byId.get(line.depot);
      if (!d || d.dead) continue;
      const running = tr.vehicles.filter(v => v.bus === line.id && !v.dead).length;
      if (running >= line.buses || line.nextT > this.game.time || (d._busCD || 0) > this.game.time) continue;
      // 依發車間隔派車，公車才不會擠成一串；列車從總站月台發車
      if ((line.rail ? tr.spawnTrain(d, line) : tr.spawnBus(d, line)) === 'ok') { line.nextT = this.game.time + line.headway; d._busCD = this.game.time + 8; }
      else d._busCD = this.game.time + 2;
    }
  }

  // 居民改搭公車：起點與目的地附近都有站牌，搭同一條路線直達，或在轉乘站換一次車（換車多算 300 m 的不便）。
  // 選走路距離最短的一組；成功回傳 true
  board(trip, t0 = this.game.time) {
    const a = trip.from, b = trip.to;
    if (!a || !b || a.outside || b.outside || !this.stops.length) return false;
    // 鐵路車站的步行範圍較大（RAIL_WALK）
    const R = t => (t.type === 'rail' ? RAIL_WALK : WALK);
    const s1s = this.stops.map(t => [t, Math.hypot(t.x - a.x, t.y - a.y)]).filter(e => e[1] <= R(e[0]));
    const s2s = this.stops.map(t => [t, Math.hypot(t.x - b.x, t.y - b.y)]).filter(e => e[1] <= R(e[0]));
    let best = null;
    for (const [s1, d1] of s1s) for (const [s2, d2] of s2s) {
      if (s2 === s1) continue;
      const ln = s1.lines.find(l => s2.lines.includes(l));
      if (ln) { if (!best || d1 + d2 < best.d) best = { s1, s2, ln, d: d1 + d2 }; continue; }
      // 轉乘：兩條路線屬於同一個總站，在轉乘站換車
      for (const l1 of s1.lines) for (const l2 of s2.lines) {
        const L1 = this.line(l1), L2 = this.line(l2);
        if (!L1 || !L2 || L1.hub !== L2.hub || s1.id === L1.hub || s2.id === L2.hub) continue;
        const d = d1 + d2 + 300;
        if (!best || d < best.d) best = { s1, s2: this.stop(L1.hub), ln: l1, d, next: { line: l2, to: s2.id } };
      }
    }
    if (!best) return false;
    best.s1.queue.push({ trip, to: best.s2.id, line: best.ln, t: t0, next: best.next });
    return true;
  }
  // 沒有公車可搭：走路（行程照樣完成）
  walk(trip) { this.stats.walked++; this.city.onTripEnd(trip, true, 300); }

  // 這一站有沒有人要上下車（沒有的話公車不停）
  needStop(v, stop) {
    const L = this.line(v.bus);
    if (!L) return true;
    return v.pax.some(p => p.to === stop.id || !L.stops.includes(p.to)) || stop.queue.some(p => p.line === v.bus && p.to !== stop.id);
  }

  // 公車到站：下車的乘客完成行程，等車的乘客上車；回傳停靠秒數
  exchange(v, stop) {
    let n = 0;
    // 下車：到站的乘客，以及重新規劃後這條路線不再經過目的地的乘客（從這裡走過去）
    const L = this.line(v.bus), gone = p => p.to === stop.id || !L || !L.stops.includes(p.to);
    const off = v.pax.filter(gone);
    v.pax = v.pax.filter(p => !gone(p));
    for (const p of off) {
      n++;
      // 轉乘：在這站排下一條路線
      if (p.next) { stop.queue.push({ trip: p.trip, to: p.next.to, line: p.next.line, t: p.t }); this.stats.transfers = (this.stats.transfers || 0) + 1; continue; }
      this.stats.riders++; if (v.train) this.stats.railRiders = (this.stats.railRiders || 0) + 1;
      this.city.onTripEnd(p.trip, true, Math.max(60, (this.game.time - p.t) / CLOCK));
    }
    const keep = [];
    for (const p of stop.queue) {
      // 剛在這站下車要轉乘的乘客不會又上同一輛車（路線不同）
      if (p.line === v.bus && p.to !== stop.id && v.pax.length < (v.train ? TRAIN_CAP : CAPACITY)) { v.pax.push(p); n++; } else keep.push(p);
    }
    stop.queue = keep;
    return v.train ? clamp(8 + n * 0.05, 8, 15) : clamp(4 + n * 0.25, 4, 10);
  }
}

// 大眾運輸：公車總站（大眾運輸分區）、自動規劃的公車路線與站牌、乘客
// - 站牌：住宅 / 商業 / 工業建築臨路的位置依人口、工作數加權，由大到小挑，彼此至少相距 STOP_GAP
// - 路線：每個總站依公車數開 1～3 條；站牌依相對總站的方位分組，每組從離總站最近的站開始以最近鄰排成環狀路線
// - 公車：從總站的公車停車格開出，依序繞行各站，每站停靠時上下客；路線取消時開回總站停好
// - 乘客：家裡車子都開走的居民，若起點與目的地附近（WALK 公尺內）都有同一條路線的站牌，就走到站牌等車；否則走路
import { pointAt, clamp } from './util.js';
import { routeFromPoint } from './routing.js';
import { CLOCK } from './config.js';

const LINE_COLORS = ['#d23c2c', '#1f6fb5', '#2a9d3f', '#e08a1e', '#7d3c98', '#0f8b8d'];
// 時間膨脹：公車繞一圈要好幾個遊戲小時，候車上限以模擬秒計（MAX_WAIT_S）；每條路線最多 MAX_STOPS 站
const STOP_GAP = 280, WALK = 350, RANGE = 1500, PLAN_EVERY = 360, MAX_WAIT_S = 240, MAX_STOPS = 7, CAPACITY = 60, HEADWAY = 50;
export const BUS_LEN = 12, BUS_W = 2.6;

export class Transit {
  constructor(game) {
    this.game = game;
    this.lines = [];
    this.stops = [];
    this.planT = 0;
    this._key = '';
    this.stats = { riders: 0, walked: 0 };
  }
  get city() { return this.game.city; }
  get net() { return this.game.net; }
  depots() { return this.city.buildings.filter(b => b.zone === 'T' && !b.dead && !b.abandoned && this.city.truckSlotsOf(b).length); }
  stop(id) { return this.stops.find(t => t.id === id); }
  line(id) { return this.lines.find(l => l.id === id); }
  stopPoint(t) { return { seg: t.seg, u: t.u }; }

  // dt：遊戲分鐘
  update(dt) {
    const ds = this.depots(), key = ds.map(b => b.id).join(',');
    this.planT -= dt;
    if (this.planT <= 0 || key !== this._key) { this._key = key; this.planT = PLAN_EVERY; this.plan(); }
    this.dispatch();
    // 等太久的乘客改走路
    const now = this.game.time, maxWait = MAX_WAIT_S * CLOCK;
    for (const t of this.stops) {
      if (!t.queue.length || now - t.queue[0].t < maxWait) continue;
      t.queue = t.queue.filter(p => { if (now - p.t < maxWait) return true; this.walk(p.trip); return false; });
    }
  }

  // 重新規劃站牌與路線
  plan() {
    const net = this.net, C = this.city, depots = this.depots(), old = this.stops;
    this.stops = []; this.lines = [];
    if (depots.length) {
      const cands = [];
      for (const b of C.buildings) {
        if (b.abandoned || !(b.zone === 'R' || b.zone === 'C' || b.zone === 'I')) continue;
        const ref = b.front || { seg: b.seg, u: b.u }, s = net.segs.get(ref.seg);
        if (!s || s.T.internal || !s.T.access || s.drawLevel !== 0) continue;
        if (s.len - s.ra - s.rb < 24) continue;
        cands.push({ seg: s.id, u: clamp(ref.u, s.ra + 10, s.len - s.rb - 10), w: C.cap(b) * (b.zone === 'R' ? 1 : 0.8) });
      }
      cands.sort((a, b) => b.w - a.w);
      let id = 0;
      for (const c of cands) {
        const s = net.segs.get(c.seg), p = pointAt(s.pts, s.cum, c.u);
        if (!depots.some(d => Math.hypot(d.x - p.x, d.y - p.y) < RANGE)) continue;
        if (this.stops.some(t => Math.hypot(t.x - p.x, t.y - p.y) < STOP_GAP)) continue;
        this.stops.push({ id: ++id, seg: c.seg, u: c.u, x: p.x, y: p.y, dx: p.dx, dy: p.dy, lines: [], queue: [] });
        if (this.stops.length >= 80) break;
      }
      let li = 0;
      for (const d of depots) {
        const buses = C.truckSlotsOf(d).length;
        // 總站到得了的站牌（同一個路網連通區）
        const from = { seg: d.seg, u: d.u, id: d.id };
        const mine = this.stops.filter(t => !t.lines.length && Math.hypot(t.x - d.x, t.y - d.y) < RANGE && routeFromPoint(net, from, { seg: t.seg, u: t.u, id: d.id }));
        if (mine.length < 2) continue;
        const nLines = clamp(Math.ceil(mine.length / MAX_STOPS), 1, Math.min(4, Math.floor(mine.length / 2)));
        mine.sort((a, b) => Math.atan2(a.y - d.y, a.x - d.x) - Math.atan2(b.y - d.y, b.x - d.x));
        const per = Math.ceil(mine.length / nLines);
        for (let k = 0; k < nLines; k++) {
          const group = mine.slice(k * per, (k + 1) * per).slice(0, MAX_STOPS);
          if (group.length < 2) continue;
          const order = [], left = [...group];
          let cur = { x: d.x, y: d.y };
          while (left.length) { left.sort((a, b) => Math.hypot(a.x - cur.x, a.y - cur.y) - Math.hypot(b.x - cur.x, b.y - cur.y)); cur = left.shift(); order.push(cur); }
          li++;
          // 繞一圈的估計時間（模擬秒）：站間直線距離 × 1.3，平均 9 m/s，每站停 6 秒；發車間隔 = 一圈時間 / 公車數
          // 公車數以發車間隔約 HEADWAY 秒為準，不超過總站公車位平均分給各路線的數量
          let loop = 0;
          order.forEach((t, i) => { const n2 = order[(i + 1) % order.length]; loop += Math.hypot(n2.x - t.x, n2.y - t.y) * 1.3 / 9 + 6; });
          const nb = clamp(Math.round(loop / HEADWAY), 1, Math.max(1, Math.floor(buses / nLines)));
          const line = { id: li, name: `${li} 路`, color: LINE_COLORS[(li - 1) % LINE_COLORS.length], depot: d.id, stops: order.map(t => t.id), buses: nb, headway: loop / nb * CLOCK, nextT: 0 };
          // 實際行駛路徑（畫路線圖用）：總站 → 各站 → 回到第一站
          const keys = new Set();
          [from, ...order, order[0]].forEach((p, i, arr) => {
            if (!i) return;
            const q = arr[i - 1], r = routeFromPoint(net, { seg: q.seg, u: q.u, id: d.id }, { seg: p.seg, u: p.u, id: d.id });
            if (r) for (const k of r.path) keys.add(k);
          });
          line.path = [...keys];
          for (const t of order) t.lines.push(line.id);
          this.lines.push(line);
        }
      }
      this.stops = this.stops.filter(t => t.lines.length);
    }
    // 舊站牌上等車的乘客：新站牌在附近而且同一條路線到得了目的地就移過去，否則改走路
    for (const t of old) for (const p of t.queue) if (!this.board(p.trip, p.t)) this.walk(p.trip);
    // 路線不存在的公車開回總站
    for (const v of this.game.traffic.vehicles) if (v.bus && !this.line(v.bus)) this.game.traffic.retireBus(v);
  }

  // 依路線缺少的公車數，從總站派車
  dispatch() {
    const tr = this.game.traffic;
    for (const line of this.lines) {
      const d = this.city.byId.get(line.depot);
      if (!d || d.dead) continue;
      const running = tr.vehicles.filter(v => v.bus === line.id && !v.dead).length;
      if (running >= line.buses || line.nextT > this.game.time || (d._busCD || 0) > this.game.time) continue;
      // 依發車間隔派車，公車才不會擠成一串
      if (tr.spawnBus(d, line) === 'ok') { line.nextT = this.game.time + line.headway; d._busCD = this.game.time + 8; }
      else d._busCD = this.game.time + 2;
    }
  }

  // 居民改搭公車：起點與目的地附近都有同一條路線的站牌（走路距離最短的一組）。成功回傳 true
  board(trip, t0 = this.game.time) {
    const a = trip.from, b = trip.to;
    if (!a || !b || a.outside || b.outside || !this.stops.length) return false;
    let best = null;
    for (const s1 of this.stops) {
      const d1 = Math.hypot(s1.x - a.x, s1.y - a.y);
      if (d1 > WALK) continue;
      for (const s2 of this.stops) {
        if (s2 === s1) continue;
        const d2 = Math.hypot(s2.x - b.x, s2.y - b.y);
        if (d2 > WALK) continue;
        const ln = s1.lines.find(l => s2.lines.includes(l));
        if (ln && (!best || d1 + d2 < best.d)) best = { s1, s2, ln, d: d1 + d2 };
      }
    }
    if (!best) return false;
    best.s1.queue.push({ trip, to: best.s2.id, line: best.ln, t: t0 });
    return true;
  }
  // 沒有公車可搭：走路（行程照樣完成）
  walk(trip) { this.stats.walked++; this.city.onTripEnd(trip, true, 300); }

  // 公車到站：下車的乘客完成行程，等車的乘客上車；回傳停靠秒數
  exchange(v, stop) {
    let n = 0;
    const off = v.pax.filter(p => p.to === stop.id);
    v.pax = v.pax.filter(p => p.to !== stop.id);
    for (const p of off) { n++; this.stats.riders++; this.city.onTripEnd(p.trip, true, Math.max(60, (this.game.time - p.t) / CLOCK)); }
    const keep = [];
    for (const p of stop.queue) {
      if (p.line === v.bus && v.pax.length < CAPACITY) { v.pax.push(p); n++; } else keep.push(p);
    }
    stop.queue = keep;
    return clamp(4 + n * 0.25, 4, 10);
  }
}

// 簡化城市經濟：住宅需要工作與購物、工廠需要工人與原料、商店需要商品與顧客
import { ZONES, MILESTONES, ROAD_TYPES, levelMul } from './config.js';
import { pointAt, convexOverlap, pointInPoly, distToSeg, clamp, polyBBox, bboxOverlap } from './util.js';
import { halfWidth } from './network.js';

const ema = (a, x, k) => a + (x - a) * k;
const gauss = (h, mu, sd) => Math.exp(-0.5 * ((h - mu) / sd) ** 2) / (sd * 2.5066);

export class City {
  constructor(game) {
    this.game = game;
    this.buildings = [];
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

  // ---------- 建築位置 ----------
  lotGeom(zone, seg, u, side) {
    const Z = ZONES[zone];
    const p = pointAt(seg.pts, seg.cum, u);
    const nx = -p.dy * side, ny = p.dx * side;
    const off = halfWidth(seg.T) + 2;
    const cx = p.x + nx * (off + Z.d / 2), cy = p.y + ny * (off + Z.d / 2);
    const tx = p.dx, ty = p.dy, hw = Z.w / 2, hd = Z.d / 2;
    const corners = [
      { x: cx - tx * hw - nx * hd, y: cy - ty * hw - ny * hd },
      { x: cx + tx * hw - nx * hd, y: cy + ty * hw - ny * hd },
      { x: cx + tx * hw + nx * hd, y: cy + ty * hw + ny * hd },
      { x: cx - tx * hw + nx * hd, y: cy - ty * hw + ny * hd },
    ];
    return { x: cx, y: cy, angle: Math.atan2(ty, tx), corners, nx, ny, w: Z.w, d: Z.d };
  }

  canPlace(zone, seg, u, side) {
    const g = this.game, net = g.net, Z = ZONES[zone];
    if (!seg.T.access) return '此道路類型不可沿線建築';
    if (net.nodes.get(seg.a).level !== 0 || net.nodes.get(seg.b).level !== 0) return '需沿地面道路建築';
    if (u < seg.ra + Z.w / 2 + 1 || u > seg.len - seg.rb - Z.w / 2 - 1) return '太靠近路口';
    const geo = this.lotGeom(zone, seg, u, side);
    for (const c of [...geo.corners, geo]) {
      if (!g.terrain.inBounds(c.x, c.y, 2)) return '超出地圖範圍';
      if (g.terrain.isWater(c.x, c.y)) return '不可建在水上';
    }
    const bb = polyBBox(geo.corners, 0);
    for (const b of this.buildings) {
      if (Math.abs(b.x - geo.x) > 45 || Math.abs(b.y - geo.y) > 45) continue;
      if (convexOverlap(b.corners, geo.corners)) return '與其他建築重疊';
    }
    for (const s of net.segs.values()) {
      if (s.drawLevel !== 0) continue;
      const hw = halfWidth(s.T) + 0.5;
      if (!bboxOverlap(bb, s.bbox)) continue;
      for (let t = 0; t <= s.len; t += 3) {
        const p = pointAt(s.pts, s.cum, t);
        if (pointInPoly(p, geo.corners)) return '與道路重疊';
        for (let i = 0; i < 4; i++) if (distToSeg(p, geo.corners[i], geo.corners[(i + 1) % 4]) < hw) return '與道路重疊';
      }
    }
    return null;
  }

  addBuilding(zone, seg, u, side, level = 1) {
    const geo = this.lotGeom(zone, seg, u, side);
    const b = {
      id: this.nextId++, zone, seg: seg.id, u, side, level, ...geo,
      happy: 0.7, workOK: 0.8, shopOK: 0.8, timeScore: 0.8, pollution: 0, noise: 0,
      workSat: 0.7, goodsSat: 1, custSat: 0.6, matSat: 1, stock: zone === 'R' ? 0 : 8, custLevel: 0, present: 0,
      // 起始累計量隨機，讓各棟建築的出發時間錯開
      acc: { work: this.game.rng.next(), shop: this.game.rng.next(), goods: this.game.rng.next(), mat: this.game.rng.next(), outw: this.game.rng.next() },
      queue: [], spawnCD: 0, highT: 0, lowT: 0,
      abandoned: false, abT: 0, variant: (this.nextId * 7919) % 5, dead: false, born: this.game.time,
    };
    this.buildings.push(b);
    this.byId.set(b.id, b);
    this.game.terrain.clearTreesCircle(geo.x, geo.y, Math.max(geo.w, geo.d) * 0.75);
    return b;
  }

  removeBuilding(b) {
    if (b.dead) return;
    b.dead = true;
    this.buildings = this.buildings.filter(x => x !== b);
    this.byId.delete(b.id);
  }

  buildingsNear(x, y, r) {
    const res = [], p = { x, y };
    for (const b of this.buildings) {
      if (Math.abs(b.x - x) > r + 30 || Math.abs(b.y - y) > r + 30) continue;
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

  cap(b) { return ZONES[b.zone].cap[b.level]; }

  // ---------- 道路變更通知 ----------
  onSegmentSplit(old, s1, s2, u) {
    for (const b of this.buildings) {
      if (b.seg !== old.id) continue;
      if (b.u < u) b.seg = s1.id; else { b.seg = s2.id; b.u -= u; }
    }
  }
  onSegmentReplaced(old, ns, reverse, T) {
    for (const b of [...this.buildings]) {
      if (b.seg !== old.id) continue;
      if (!T.access) { this.removeBuilding(b); continue; }
      b.seg = ns.id;
      if (reverse) { b.u = old.len - b.u; b.side = -b.side; }
    }
  }
  onSegmentRemoved(seg) {
    for (const b of [...this.buildings]) if (b.seg === seg.id) this.removeBuilding(b);
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
    return this.roulette(this.buildings.filter(x => x.zone === 'C' && !x.abandoned), x => this.cap(x) * this.near(b, x, 450));
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
    const k = dt / 60;
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
        // 外地通勤者
        b.acc.outw += cap * 0.25 * pWork * k * outsideShare;
        while (b.acc.outw >= 1) {
          b.acc.outw -= 1;
          const o = this.pickOutside(b);
          if (o) this.pushTrip(o, { kind: 'work', from: o, to: b, truck: false });
        }
      }
      if (b.zone === 'I') {
        b.acc.goods += cap / 5 * pFreight * k * (0.3 + 0.7 * b.workSat);
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
    if (this.growT >= 30) { this.growT = 0; if (g.autoGrow && (this.jam || 0) < 0.35) this.autoGrow(); }
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
          const d = Math.hypot(i.x - b.x, i.y - b.y);
          if (d < 220) pol += (1 - d / 220) * 0.35 * i.level;
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
        if (b.abT > 24) this.removeBuilding(b);
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

  autoGrow() {
    const g = this.game, net = g.net, rng = g.rng;
    const zones = ['R', 'C', 'I'].filter(z => this.demand[z] > 0.12).sort((a, b) => this.demand[b] - this.demand[a]);
    if (!zones.length) return;
    const comp = this.mainComponent();
    const segs = [...net.segs.values()].filter(s => s.T.access && s.drawLevel === 0 && net.nodes.get(s.a).level === 0 && net.nodes.get(s.b).level === 0 && s.len > 30 && comp.has(s.a));
    if (!segs.length) return;
    for (const zone of zones) {
      const n = this.demand[zone] > 0.6 ? 2 : 1;
      let placed = 0;
      for (let tries = 0; tries < 18 && placed < n; tries++) {
        let seg;
        if (this.buildings.length && rng.chance(0.75)) {
          const nb = rng.pick(this.buildings);
          const near = segs.filter(s => Math.abs((s.bbox.x0 + s.bbox.x1) / 2 - nb.x) < 260 && Math.abs((s.bbox.y0 + s.bbox.y1) / 2 - nb.y) < 260);
          seg = near.length ? rng.pick(near) : rng.pick(segs);
        } else seg = rng.pick(segs);
        const Z = ZONES[zone];
        const lo = seg.ra + Z.w / 2 + 1, hi = seg.len - seg.rb - Z.w / 2 - 1;
        if (hi <= lo) continue;
        const u = lo + rng.next() * (hi - lo);
        const side = rng.chance(0.5) ? 1 : -1;
        if (this.canPlace(zone, seg, u, side)) continue;
        const geo = this.lotGeom(zone, seg, u, side);
        if (zone === 'R' && this.buildings.some(b => b.zone === 'I' && Math.hypot(b.x - geo.x, b.y - geo.y) < 160)) continue;
        if (zone === 'I' && this.buildings.some(b => b.zone === 'R' && Math.hypot(b.x - geo.x, b.y - geo.y) < 110)) continue;
        if (seg.T.rank >= 2 && zone === 'R' && rng.chance(0.5)) continue;
        this.addBuilding(zone, seg, u, side);
        placed++;
      }
    }
    this.recount();
  }

  // ---------- 序列化 ----------
  serialize() {
    return {
      nextId: this.nextId,
      buildings: this.buildings.map(b => ({ id: b.id, zone: b.zone, seg: b.seg, u: b.u, side: b.side, level: b.level, happy: b.happy, stock: b.stock, abandoned: b.abandoned })),
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
      const b = this.addBuilding(s.zone, seg, s.u, s.side, s.level);
      b.happy = s.happy; b.stock = s.stock; b.abandoned = s.abandoned;
    }
    this.nextId = Math.max(this.nextId, d.nextId);
    Object.assign(this.demand, d.demand);
    Object.assign(this.stats, d.stats);
    this.history = d.history || [];
    this.afterRebuild();
    this.recount();
  }
}

// 微觀交通模擬：每輛車都是獨立代理人
// - IDM 跟車模型、MOBIL 式變換車道
// - 路口依號誌 / 讓路 / 全向停車與衝突點判斷能否進入
// - 依即時壅塞重新規劃路線
import { LANE_W, VEHICLE_COLORS } from './config.js';
import { findRoute, routeFromPoint } from './routing.js';
import { clamp, pointAt, closestOnPoly } from './util.js';

const FREE = { gap: Infinity, lv: 0 };
const MAX_VEHICLES = 3000;

export class Traffic {
  constructor(game) {
    this.game = game;
    this.vehicles = [];
    this.fx = [];   // 抵達後靠邊停車、淡出的車（只用於繪圖）
    this.nextId = 1;
    this.active = new Set();
    this.rerouteBudget = 40;
    this.flowT = 0;
    this.metrics = { avgSpeedRatio: 1, moving: 0, waiting: 0 };
  }
  get net() { return this.game.net; }
  get patience() { return 150 * this.game.diff.patience; }

  createVehicle(truck) {
    const r = this.game.rng;
    return {
      id: this.nextId++, truck, len: truck ? 9 : 4.6, w: truck ? 2.5 : 1.9,
      a: truck ? 0.9 : 1.5 + r.range(-0.2, 0.4), b: truck ? 2.2 : 2.6, T: truck ? 1.6 : 1.15 + r.range(0, 0.35),
      v0f: truck ? 0.9 : r.range(0.92, 1.1), color: truck ? '#d8d0c0' : r.pick(VEHICLE_COLORS),
      track: null, s: 0, v: 0, acc: 0, lat: 0, route: [], ri: 0, nextConn: null, committed: false,
      trip: null, waitT: 0, age: 0, lcCool: 0, lcT: r.next() * 0.5, rerouteT: 15 + r.next() * 25,
      needRoute: false, stopDone: false, stopT: 0, idx: 0, v0eff: 10, braking: false, triedReroute: false,
      lost: false, dead: false, blocked: false,
    };
  }

  // ---------- 軌道（車道 / 連接）上的排序清單 ----------
  insertSorted(track, v) {
    const arr = track.vehs;
    let i = 0;
    while (i < arr.length && arr[i].s >= v.s) i++;
    arr.splice(i, 0, v);
    for (let k = i; k < arr.length; k++) arr[k].idx = k;
    this.active.add(track);
  }
  removeFromTrack(v) {
    const tr = v.track;
    if (!tr) return;
    const arr = tr.vehs;
    let i = v.idx;
    if (arr[i] !== v) i = arr.indexOf(v);
    if (i >= 0) {
      arr.splice(i, 1);
      for (let k = i; k < arr.length; k++) arr[k].idx = k;
    }
  }
  place(v, track, s) {
    v.track = track;
    v.s = s;
    this.insertSorted(track, v);
  }
  moveTo(v, track, s) {
    v.prevTrack = v.track;
    this.removeFromTrack(v);
    this.place(v, track, s);
  }
  resolveLane(lane) {
    let g = 0;
    while (lane && lane.dead && g++ < 10) lane = lane.replacement;
    return lane && !lane.dead ? lane : null;
  }

  spaceAt(lane, s, len) {
    for (const w of lane.vehs) {
      if (w.s > s - len - 4 && w.s - w.len < s + 4) return false;
      if (w.s < s && w.v > 4 && s - len - w.s < w.v * 1.6) return false;
    }
    return true;
  }

  // ---------- 生成 / 結束 ----------
  // 路段上離某點（停車位）最近的位置；太遠就不用
  projU(segId, pt) {
    const seg = this.net.segs.get(segId);
    if (!seg || !pt) return null;
    const c = closestOnPoly(seg.pts, seg.cum, pt);
    return c.d < 45 ? clamp(c.s, 1, seg.len - 1) : null;
  }
  // 這輛車實際要停的位置：預約的車位在道路上的對應點（沒有預約就用建築的出入口）
  destOf(v) {
    const to = v.trip.to;
    if (!v.slotPt || to.outside) return to;
    const ver = this.net.version;
    if (!v._dest || v._dest.ver !== ver || v._dest.seg !== to.seg) {
      const u = this.projU(to.seg, v.slotPt);
      v._dest = { ver, seg: to.seg, u: u ?? to.u, id: to.id };
    }
    return v._dest;
  }

  trySpawn(trip) {
    if (this.vehicles.length >= MAX_VEHICLES) return 'wait';
    const net = this.net, city = this.game.city, from = trip.from, to = trip.to;
    if (!net.segs.get(from.seg) || !net.segs.get(to.seg)) return 'noroute';
    // 從建築出發：挑一輛停著的車，從它的車位對應的路邊出發
    let fromPt = from, leave = null;
    if (city && from.zone && !from.dead && !trip.truck) {
      leave = city.pickParked(from);
      const u = leave ? this.projU(from.seg, leave.slot) : null;
      if (u !== null) fromPt = { seg: from.seg, u, id: from.id }; else leave = null;
    }
    // 目的地是建築：先預約一個空車位，開到車位對應的路邊
    let slotIdx = null, slotPt = null;
    if (city && to.zone && !to.dead && !trip.truck) {
      const list = city.slotsOf(to);
      for (let i = 0; i < list.length; i++) if (!to.slotOcc[i] && !to.slotRes[i]) { slotIdx = i; break; }
      if (slotIdx !== null) {
        // 隨機挑一個空位
        const free = list.map((_, i) => i).filter(i => !to.slotOcc[i] && !to.slotRes[i]);
        slotIdx = free[Math.floor(this.game.rng.next() * free.length)];
        slotPt = list[slotIdx];
      }
    }
    const du = slotPt ? this.projU(to.seg, slotPt) : null;
    const destPt = du !== null ? { seg: to.seg, u: du, id: to.id } : to;
    const r = routeFromPoint(net, fromPt, destPt);
    if (!r) return 'noroute';
    const link = net.links.get(r.path[0]);
    const len = trip.truck ? 9 : 4.6;
    for (let i = link.lanes.length - 1; i >= 0; i--) {
      const lane = link.lanes[i];
      const s = clamp(net.segUToLaneS(lane, fromPt.u), 0, lane.len - 0.5);
      if (this.spaceAt(lane, s, len)) {
        const v = this.createVehicle(trip.truck);
        v.route = r.path; v.ri = 0; v.trip = trip;
        v.v = from.outside ? Math.min(lane.speed * 0.7, 14) : 0;
        v.fadeIn = from.outside ? 1 : 0;   // 沒有停車位的建築：車由路邊慢慢出現
        if (du !== null) { v.slotIdx = slotIdx; v.slotPt = slotPt; to.slotRes[slotIdx] = true; }
        this.place(v, lane, s);
        this.vehicles.push(v);
        // 從停車位開出來，到路邊才加入車流（車子就是原本停著的那輛）
        if (leave) {
          from.slotOcc[leave.idx] = null;
          v.color = leave.color;
          const p = pointAt(lane.pts, lane.cum, clamp(s - v.len / 2, 0, lane.len));
          const f = this.parkPath(p, leave.slot, v, false);
          this.fx.push(f);
          v.hold = f.dur;
        } else if (from.zone && !from.dead && this.fx.length < 300) {
          // 沒有停著的車（停在建物裡 / 地下室）：從建物入口開出來
          const p = pointAt(lane.pts, lane.cum, clamp(s - v.len / 2, 0, lane.len));
          const gx = from.x - p.x, gy = from.y - p.y, L = Math.hypot(gx, gy) || 1, k = Math.min(10, L * 0.5);
          const f = this.parkPath(p, { x: p.x + gx / L * k, y: p.y + gy / L * k, ax: gx / L, ay: gy / L, indoor: true }, v, false);
          this.fx.push(f);
          v.hold = f.dur;
        }
        return 'ok';
      }
      if (!from.outside) break;
    }
    return 'wait';
  }

  finish(v, ok) {
    if (v.dead) return;
    // 抵達建築：開進預約好的車位停好（沒有車位就開進建物 / 地下停車場）
    const to = v.trip && v.trip.to;
    const hasSlot = v.slotIdx !== undefined && v.slotIdx !== null && to && to.slotRes;
    if (ok && to && to.zone && !to.dead && v.track && v.track.pts) {
      const p = pointAt(v.track.pts, v.track.cum, clamp(v.s - v.len / 2, 0, v.track.len));
      if (hasSlot) this.fx.push(this.parkPath(p, v.slotPt, v, true, to, v.slotIdx));
      else if (this.fx.length < 300) {
        const gx = to.x - p.x, gy = to.y - p.y, L = Math.hypot(gx, gy) || 1, k = Math.min(10, L * 0.5);
        this.fx.push(this.parkPath(p, { x: p.x + gx / L * k, y: p.y + gy / L * k, ax: gx / L, ay: gy / L, indoor: true }, v, true));
      }
    } else if (hasSlot) to.slotRes[v.slotIdx] = false;
    this.removeFromTrack(v);
    v.dead = true;
    v.track = null;
    if (this.game.city) this.game.city.onTripEnd(v.trip, ok, v.age);
  }
  despawnAll(list) { for (const v of list) this.finish(v, false); }

  // ---------- 網路重建後 ----------
  onRebuild() {
    const net = this.net;
    for (const v of this.vehicles) {
      if (v.dead) continue;
      v.nextConn = null;
      for (let i = v.ri; i < v.route.length; i++) {
        const L = net.links.get(v.route[i]);
        if (!L || (i + 1 < v.route.length && !L.next.has(v.route[i + 1]))) { v.needRoute = true; break; }
      }
    }
    for (const tr of [...this.active]) if (tr.dead) this.active.delete(tr);
  }

  applyTransfers(list) {
    const net = this.net;
    for (const t of list) {
      const v = t.v;
      if (v.dead) continue;
      const lane = t.seg.links[t.dir].lanes[t.idx];
      v.track = null;
      if (!lane || lane.dead || !net.segs.has(t.seg.id)) { v.dead = true; this.game.city && this.game.city.onTripEnd(v.trip, false, v.age); continue; }
      this.place(v, lane, clamp(net.segUToLaneS(lane, t.u), 0, lane.len - 0.1));
      v.nextConn = null; v.committed = false;
      this.reroute(v);
    }
  }

  // ---------- 路徑 ----------
  destS(v) { return this.net.segUToLaneS(v.track, this.destOf(v).u); }

  reroute(v) {
    v.needRoute = false;
    const lane = v.track;
    if (!lane || lane.kind !== 'lane') { v.needRoute = true; return false; }
    const net = this.net, L = lane.link, dest = this.destOf(v);
    // 目的地就在目前車道前方（含即將抵達）：維持原路線，不要重新規劃成繞一圈回來
    if (dest.seg === L.seg.id && net.segUToLaneS(lane, dest.u) >= v.s - 0.5) {
      v.route = [L.key]; v.ri = 0; v.nextConn = null; v.lost = false;
      return true;
    }
    const distEnd = lane.len - v.s;
    let r = null;
    if (distEnd < 25 || v.waitT > 6) {
      const starts = [];
      for (const c of lane.conns) {
        const to = this.resolveLane(c.to);
        if (!to) continue;
        const tl = to.link;
        // 目前沒有空間可進入的方向加重成本（例如圓環出口塞住時改為繼續繞行）
        const blockedPenalty = this.hasSpace(c, v) ? 0 : 60;
        starts.push({ link: tl, cost: c.len / c.speed + tl.len / tl.eff + blockedPenalty });
        if (tl.seg.id === dest.seg) {
          const along = tl.dir > 0 ? dest.u : tl.seg.len - dest.u;
          const cost = c.len / c.speed + along / tl.eff;
          if (!r || cost < r.cost) r = { path: [tl.key], cost };
        }
      }
      const r2 = findRoute(net, starts, dest, [v.trip.from.id, v.trip.to.id]);
      if (r2 && (!r || r2.cost < r.cost)) r = r2;
      if (r) r = { path: [L.key, ...r.path], cost: r.cost };
    } else {
      r = findRoute(net, [{ link: L, cost: distEnd / L.eff }], dest, [v.trip.from.id, v.trip.to.id]);
    }
    if (!r) { v.lost = true; v.route = [L.key]; v.ri = 0; return false; }
    v.lost = false;
    v.route = r.path; v.ri = 0; v.nextConn = null;
    return true;
  }

  // 從某車道出發、不變換車道能沿路線走多遠（最多看 4 個路段）
  // d：可到達的後續路段數；dist：這些路段的總長（在此之前必須換到正確車道）
  laneReach(v, lane, offset = 0) {
    let set = [lane], d = 0, dist = 0;
    for (let k = 1; k <= 4; k++) {
      const nk = v.route[v.ri + offset + k];
      if (nk === undefined) return { d: 9, dist };
      const next = [];
      for (const l of set) for (const c of l.conns) if (!c.dead && c.to.link.key === nk && !next.includes(c.to)) next.push(c.to);
      if (!next.length) return { d, dist };
      d++; dist += next[0].len + 5; set = next;
    }
    return { d, dist };
  }

  chooseConn(v) {
    const lane = v.track;
    const nc = v.nextConn;
    if (nc && !nc.dead && nc.from === lane) return nc;
    const nk = v.route[v.ri + 1];
    if (nk === undefined) { v.nextConn = null; return null; }
    let best = null, bs = Infinity;
    for (const c of lane.conns) {
      if (c.dead || c.to.link.key !== nk) continue;
      // 優先選能沿路線走得最遠的車道（提早靠到正確車道）
      const r = this.laneReach(v, c.to, 1);
      const sc = c.to.vehs.length * 2 + ((c.to.idx * 7 + v.id) % 3) * 0.1 - Math.min(r.d, 4) * 100;
      if (sc < bs) { bs = sc; best = c; }
    }
    v.nextConn = best;
    return best;
  }

  // ---------- 號誌 ----------
  sigState(node, c) {
    const sig = node.signal;
    const inP = sig.phases[sig.cur].set.has(c.from.link.key);
    if (sig.state === 'green') return inP ? 'G' : 'R';
    if (sig.state === 'yellow') return inP ? 'Y' : 'R';
    return inP ? 'AR' : 'R';
  }

  phaseDemand(ph) {
    for (const key of ph.links) {
      const L = this.net.links.get(key);
      if (!L) continue;
      for (const lane of L.lanes) {
        const w = lane.vehs[0];
        if (w && lane.len - w.s < 60) return true;
      }
    }
    return false;
  }

  updateSignals(dt) {
    for (const n of this.net.signalNodes) {
      const sig = n.signal;
      if (!sig) continue;
      sig.t += dt;
      const ph = sig.phases[sig.cur];
      if (sig.state === 'green') {
        let end = sig.t >= ph.dur;
        if (n.sigAdaptive && sig.t >= 6) {
          const here = this.phaseDemand(ph);
          const other = sig.phases.some((p, i) => i !== sig.cur && this.phaseDemand(p));
          if (!here && other) end = true;
          else if (end && !other && sig.t < ph.dur * 3) end = false;
        }
        if (end) { sig.state = 'yellow'; sig.t = 0; }
      } else if (sig.state === 'yellow') {
        if (sig.t >= 3) { sig.state = 'allred'; sig.t = 0; }
      } else if (sig.t >= 1.5) {
        let nx = (sig.cur + 1) % sig.phases.length;
        if (n.sigAdaptive) {
          for (let k = 0; k < sig.phases.length; k++) {
            const i = (sig.cur + 1 + k) % sig.phases.length;
            if (this.phaseDemand(sig.phases[i])) { nx = i; break; }
          }
        }
        sig.cur = nx; sig.state = 'green'; sig.t = 0;
      }
    }
  }

  // ---------- 路口通行判斷 ----------
  hasSpace(c, v) {
    const to = this.resolveLane(c.to);
    if (!to) return false;
    // 進入圓環：保持環道淨空，需留約兩車的空間，且環道上游車流停滯時不進入，避免整圈卡死
    const enterRing = to.seg.ring && !c.from.seg.ring;
    if (enterRing) {
      for (const sib of c.siblings) {
        const w = sib.from.vehs[0];
        if (w && sib.from.seg.ring && w.v < 2 && sib.from.len - w.s < 15) return false;
      }
    }
    let free = to.len;
    if (to.vehs.length) {
      const last = to.vehs[to.vehs.length - 1];
      if (last.v > 4 && !enterRing) return true;
      free = last.s - last.len;
    }
    if (enterRing) {
      for (const w of c.vehs) if (w !== v) free -= w.len + 2;
      for (const sib of c.siblings) for (const w of sib.vehs) free -= w.len + 2;
      return free > Math.min(v.len * 2 + 8, to.len * 0.85);
    }
    // 只計入慢速 / 停止中的車：正常行駛中的車很快就會通過，不必排隊等候
    // （否則很短的出口車道會讓整條車道只能一台一台通過路口）
    const slow = w => w !== v && w.v < 4;
    for (const w of c.vehs) if (slow(w)) free -= w.len + 2;
    for (const sib of c.siblings) {
      for (const w of sib.vehs) if (slow(w)) free -= w.len + 2;
      const w = sib.from.vehs[0];
      if (w && slow(w) && w.committed && w.nextConn === sib) free -= w.len + 2;
    }
    return free > Math.min(v.len + 2.5, to.len * 0.6);
  }

  canEnter(v, c, dist) {
    const node = c.node;
    if (node.control === 'signal' && node.signal) {
      const st = this.sigState(node, c);
      if (st === 'R') return false;
      if (st !== 'G') {
        const leftAtLine = c.turn === 'L' && dist < 4;
        const canStop = dist > v.v * v.v / (2 * 4) + 0.5;
        if (st === 'AR' ? !leftAtLine : (canStop && !leftAtLine)) return false;
      }
    } else if (node.control === 'stop') {
      if (!v.stopDone) {
        if (dist < 4 && v.v < 0.6) { v.stopDone = true; v.stopT = this.game.time; }
        else return false;
      }
      for (const cf of c.conflicts) {
        const w = cf.c.from.vehs[0];
        if (w && w !== v && w.stopDone && w.nextConn === cf.c && w.stopT < v.stopT) return false;
      }
    }
    if (!this.hasSpace(c, v)) return false;
    // 等越久越願意接受較短的車距（駕駛不耐煩）
    const gapT = 4.5 - 2.3 * clamp(v.waitT / 30, 0, 1);
    for (const cf of c.conflicts) {
      const oc = cf.c;
      if (cf.type === 'cross' && oc.vehs.length) return false;
      const w = oc.from.vehs[0];
      if (!w || w === v || w.nextConn !== oc) continue;
      const wd = oc.from.len - w.s;
      const tArr = wd / Math.max(w.v, 2.5);
      if (w.committed) {
        if (cf.type === 'cross' && (tArr < Math.max(2.2, gapT * 0.75) || wd < 8)) return false;
        continue;
      }
      if (node.control === 'stop') continue;
      if (oc.score <= c.score) continue;
      if (node.control === 'signal' && node.signal && this.sigState(node, oc) !== 'G') continue;
      if (w.v < 2 && w.blocked) continue;
      if (w.v < 0.5 && wd < 6 && w.waitT > 4) continue;
      if (wd < 90 && tArr < gapT) return false;
    }
    return true;
  }

  // ---------- 跟車 ----------
  idm(v, v0, gap, dv) {
    const free = 1 - Math.pow(v.v / v0, 4);
    if (gap === Infinity) return v.a * free;
    const sStar = 2 + Math.max(0, v.v * v.T + v.v * dv / (2 * Math.sqrt(v.a * v.b)));
    const g = Math.max(gap, 0.1);
    return v.a * (free - (sStar / g) * (sStar / g));
  }

  leaderOnLaneStart(c, d) {
    let gap = Infinity, lv = 0;
    const to = this.resolveLane(c.to);
    if (to && to.vehs.length) {
      const w = to.vehs[to.vehs.length - 1];
      gap = d + w.s - w.len; lv = w.v;
    }
    for (const sib of c.siblings) {
      for (const w of sib.vehs) {
        const rw = sib.len - w.s;
        if (rw < d - 0.1) {
          const g = d - rw - w.len;
          if (g < gap) { gap = g; lv = w.v; }
        }
      }
    }
    return gap > 250 ? FREE : { gap, lv };
  }

  leader(v) {
    const tr = v.track;
    if (v.idx > 0) {
      const L = tr.vehs[v.idx - 1];
      return { gap: L.s - L.len - v.s, lv: L.v };
    }
    const dist = tr.len - v.s;
    if (tr.kind === 'lane') {
      if (v.ri >= v.route.length - 1) return FREE;
      const c = this.chooseConn(v);
      if (!c) return { gap: dist - 0.3, lv: 0 };
      if (!v.committed) {
        if (dist < Math.max(35, v.v * v.v / 4 + 12)) {
          if (!this.canEnter(v, c, dist)) { v.blocked = true; return { gap: dist - 0.3, lv: 0 }; }
          v.blocked = false;
          if (dist < v.v * v.v / 6 + 4) v.committed = true;
        }
      }
      if (c.vehs.length) {
        const w = c.vehs[c.vehs.length - 1];
        return { gap: dist + w.s - w.len, lv: w.v };
      }
      return this.leaderOnLaneStart(c, dist + c.len);
    }
    return this.leaderOnLaneStart(tr, dist);
  }

  computeAccel(v) {
    const tr = v.track;
    let v0 = tr.speed * v.v0f;
    if (tr.kind === 'lane') {
      const distEnd = tr.len - v.s;
      if (v.ri >= v.route.length - 1) {
        const dS = this.destS(v) - v.s;
        v0 = Math.min(v0, Math.sqrt(20 + 3 * Math.max(0, dS)));
      } else {
        const c = this.chooseConn(v);
        if (c) v0 = Math.min(v0, Math.sqrt(c.speed * c.speed + 3.6 * Math.max(0, distEnd)));
      }
    }
    v0 = Math.max(v0, 1);
    v.v0eff = v0;
    const ld = this.leader(v);
    return clamp(this.idm(v, v0, ld.gap, v.v - ld.lv), -9, v.a);
  }

  // ---------- 變換車道 ----------
  neighbors(lane, s) {
    const arr = lane.vehs;
    let i = 0;
    while (i < arr.length && arr[i].s > s) i++;
    return { lead: i > 0 ? arr[i - 1] : null, follow: i < arr.length ? arr[i] : null };
  }

  tryLaneChange(v) {
    const lane = v.track;
    if (lane.kind !== 'lane' || v.lcCool > 0 || v.committed) return;
    const lanes = lane.link.lanes;
    if (lanes.length < 2) return;
    const atDest = v.ri >= v.route.length - 1;
    const distEnd = lane.len - v.s;
    // 預先看後面幾個路段：哪些車道能一路走下去（例如前方匝道只能從最外側車道駛出）
    const reach = atDest ? null : lanes.map(l => this.laneReach(v, l));
    const bestD = reach ? Math.max(...reach.map(r => Math.min(r.d, 4))) : 0;
    const cur = reach ? reach[lane.idx] : null;
    const valid = l => atDest || Math.min(reach[l.idx].d, 4) >= Math.min(cur.d, 4);
    let mand = 0, distEff = distEnd;
    if (!atDest && Math.min(cur.d, 4) < bestD) {
      distEff = distEnd + cur.dist;
      if (distEff < 600) {
        let bd = Infinity;
        for (const l of lanes) if (Math.min(reach[l.idx].d, 4) === bestD && Math.abs(l.idx - lane.idx) < bd) { bd = Math.abs(l.idx - lane.idx); mand = Math.sign(l.idx - lane.idx); }
      }
    }
    if (!mand && (distEnd < 40 || v.s < 5)) return;
    const opts = mand ? [mand] : [-1, 1];
    for (const d of opts) {
      const tl = lanes[lane.idx + d];
      if (!tl) continue;
      if (!mand && !valid(tl) && distEnd < 160) continue;
      const s2 = v.s / lane.len * tl.len;
      if (s2 < v.len + 1 || s2 > tl.len - 1) continue;
      const { lead, follow } = this.neighbors(tl, s2);
      const gapF = lead ? lead.s - lead.len - s2 : Infinity;
      const gapB = follow ? s2 - v.len - follow.s : Infinity;
      const urg = mand ? clamp(1 - distEff / 180, 0, 1) : 0;
      const minGap = mand ? 1 + (1 - urg) * 2 : 2.5;
      if (gapF < minGap || gapB < minGap) continue;
      if (follow) {
        const fAcc = this.idm(follow, follow.v0eff, gapB, follow.v - v.v);
        if (fAcc < -(mand ? 3 + urg * 4 : 2.5)) continue;
      }
      if (!mand) {
        const accNew = this.idm(v, v.v0eff, gapF, lead ? v.v - lead.v : 0);
        const keepRight = d > 0 ? 0.15 : -0.1;
        if (accNew - v.acc + keepRight < 0.45) continue;
      }
      this.removeFromTrack(v);
      v.s = s2;
      v.track = tl;
      this.insertSorted(tl, v);
      v.lat = -d * LANE_W;
      v.nextConn = null;
      v.lcCool = mand ? 1.2 : 4;
      return;
    }
  }

  // ---------- 移動 ----------
  advance(v) {
    let guard = 0;
    while (!v.dead && v.s > v.track.len && guard++ < 8) {
      const tr = v.track;
      if (tr.kind === 'lane') {
        if (v.ri >= v.route.length - 1) {
          this.finish(v, !v.lost && tr.link.seg.id === v.trip.to.seg);
          return;
        }
        let c = this.chooseConn(v);
        if (c && !v.committed) { if (this.canEnter(v, c, 0)) v.committed = true; else c = null; }
        if (!c) { v.s = tr.len - 0.05; v.v = 0; return; }
        this.moveTo(v, c, v.s - tr.len);
        v.committed = false; v.stopDone = false; v.nextConn = null; v.blocked = false;
      } else {
        const to = this.resolveLane(tr.to);
        if (!to) { this.finish(v, false); return; }
        this.moveTo(v, to, v.s - tr.len);
        v.ri++;
        if (v.route[v.ri] !== to.link.key) this.reroute(v);
      }
    }
  }

  // 停車 / 出車的路徑：三次貝茲曲線，起點沿車道方向、終點沿車位方向（車頭朝前開進 / 開出），約 4.5 m/s
  parkPath(p, sl, v, arrive, b = null, idx = null) {
    const dx = sl.x - p.x, dy = sl.y - p.y, dist = Math.hypot(dx, dy) || 1;
    let ax = sl.ax, ay = sl.ay;
    if ((arrive ? 1 : -1) * (ax * dx + ay * dy) < 0) { ax = -ax; ay = -ay; }
    const k0 = Math.min(5, dist * 0.45), k1 = Math.min(5, dist * 0.45);
    const pts = arrive
      ? [{ x: p.x, y: p.y }, { x: p.x + p.dx * k0, y: p.y + p.dy * k0 }, { x: sl.x - ax * k1, y: sl.y - ay * k1 }, { x: sl.x, y: sl.y }]
      : [{ x: sl.x, y: sl.y }, { x: sl.x + ax * k1, y: sl.y + ay * k1 }, { x: p.x - p.dx * k0, y: p.y - p.dy * k0 }, { x: p.x, y: p.y }];
    // 開出時車子已在車道上等，限制在 5 秒內以免擋到後面的車
    const dur = clamp(dist * 1.25 / 3, 2.5, arrive ? 15 : 5);
    return { pts, dur, t: 0, color: v.color, len: v.len, w: v.w, truck: v.truck, arrive, b, idx, indoor: !!sl.indoor };
  }

  step(dt) {
    this.updateSignals(dt);
    if (this.fx.length) {
      for (const f of this.fx) {
        f.t += dt;
        if (f.t >= f.dur && !f.done) {
          f.done = true;
          // 停好了：車位記下這輛車（顏色），取消預約
          if (f.b && f.arrive && f.idx !== null && f.b.slotOcc) { f.b.slotRes[f.idx] = false; if (!f.b.dead) f.b.slotOcc[f.idx] = f.color; }
        }
      }
      this.fx = this.fx.filter(f => !f.done);
    }
    const vs = this.vehicles;
    for (const v of vs) if (!v.dead) v.acc = this.computeAccel(v);
    for (const v of vs) {
      if (v.dead) continue;
      // 還在從停車位開出來：先停在路邊等
      if (v.hold > 0) { v.hold -= dt; v.v = 0; if (v.hold <= 0) v.fadeIn = 1; continue; }
      if (v.fadeIn < 1) v.fadeIn = Math.min(1, v.fadeIn + dt / 0.8);
      v.lcT -= dt;
      if (v.lcT <= 0) { v.lcT = 0.4 + (v.id % 7) * 0.03; this.tryLaneChange(v); }
    }
    let anyDead = false;
    for (const v of vs) {
      if (v.dead) { anyDead = true; continue; }
      v.v = Math.max(0, v.v + v.acc * dt);
      v.s += v.v * dt;
      v.braking = v.acc < -1.2;
      if (v.lat) { v.lat *= Math.exp(-dt * 2.2); if (Math.abs(v.lat) < 0.02) v.lat = 0; }
      v.lcCool -= dt;
      v.age += dt;
      if (v.v < 0.5) v.waitT += dt; else { v.waitT = 0; v.triedReroute = false; }
      this.advance(v);
      if (v.dead) { anyDead = true; continue; }
      const tr = v.track;
      if (tr.kind === 'lane' && v.ri >= v.route.length - 1 && tr.link.seg.id === v.trip.to.seg && v.s >= this.destS(v)) {
        this.finish(v, true); anyDead = true; continue;
      }
      v.rerouteT -= dt;
      if (tr.kind === 'lane') {
        if (v.needRoute) this.reroute(v);
        else if ((v.rerouteT <= 0 || (v.waitT > 12 && !v.triedReroute) || (tr.seg.ring && v.waitT > 2.5 && !v.triedReroute)) && this.rerouteBudget > 0) {
          // 在圓環上出口塞住時，不停在環道上，改為繼續繞行
          this.rerouteBudget--;
          if (v.waitT > 2.5) v.triedReroute = true;
          v.rerouteT = 20 + (v.id % 23);
          this.reroute(v);
        }
      }
      if (v.waitT > this.patience) { this.finish(v, false); anyDead = true; }
    }
    this.rerouteBudget = Math.min(this.rerouteBudget + 20, 60);
    if (anyDead) this.vehicles = vs.filter(v => !v.dead);
    for (const tr of this.active) {
      const arr = tr.vehs;
      if (!arr.length) { this.active.delete(tr); continue; }
      for (let i = 1; i < arr.length; i++) {
        const x = arr[i];
        let j = i - 1;
        while (j >= 0 && arr[j].s < x.s) { arr[j + 1] = arr[j]; j--; }
        arr[j + 1] = x;
      }
      for (let i = 0; i < arr.length; i++) arr[i].idx = i;
    }
    this.flowT += dt;
    if (this.flowT >= 1) { this.flowT = 0; this.updateFlow(); }
  }

  updateFlow() {
    let sumR = 0, n = 0, waiting = 0;
    for (const L of this.net.links.values()) {
      let sum = 0, k = 0;
      for (const lane of L.lanes) for (const w of lane.vehs) { sum += w.v; k++; if (w.v < 1) waiting++; }
      L.count = k;
      const target = k ? Math.min(L.limit, sum / k) : L.limit;
      L.flow += (target - L.flow) * (k ? 0.2 : 0.05);
      const density = k * 7 / Math.max(10, L.len * L.lanes.length);
      L.eff = Math.max(1, Math.min(L.limit, L.flow) * (1 - 0.5 * Math.min(1, density)));
      if (k) { sumR += (sum / k / L.limit) * k; n += k; }
    }
    const m = this.metrics;
    m.avgSpeedRatio = n ? clamp(sumR / n, 0, 1) : 1;
    m.moving = n;
    m.waiting = waiting;
  }
}

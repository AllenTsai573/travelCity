// 微觀交通模擬：每輛車都是獨立代理人
// - IDM 跟車模型、MOBIL 式變換車道
// - 路口依號誌 / 讓路 / 全向停車與衝突點判斷能否進入
// - 依即時壅塞重新規劃路線
import { LANE_W, VEHICLE_COLORS, CLOCK } from './config.js';
import { findRoute, routeFromPoint } from './routing.js';
import { clamp, pointAt } from './util.js';
import { laneOffset } from './network.js';
import { BUS_LEN, BUS_W } from './transit.js';

const FREE = { gap: Infinity, lv: 0 };

// 停車 / 出車動畫在進度 k（0~1）時的位置與車頭方向
// 曲線參數用三次 Hermite 緩動：起點斜率 f.ea、終點斜率 f.eb（都是 0 時為 smoothstep）；
// 停進車位時 ea > 0（接續車子原本的速度，一路減速停好），開出車位時 eb > 0（加速，到路上時接上車流）
export function fxAt(f, k) {
  const a = f.ea || 0, b = f.eb || 0, e = a * k + (3 - 2 * a - b) * k * k + (a + b - 2) * k * k * k, m = 1 - e;
  const [p0, p1, p2, p3] = f.pts;
  const x = m * m * m * p0.x + 3 * m * m * e * p1.x + 3 * m * e * e * p2.x + e * e * e * p3.x;
  const y = m * m * m * p0.y + 3 * m * m * e * p1.y + 3 * m * e * e * p2.y + e * e * e * p3.y;
  const t = Math.min(0.995, Math.max(0.005, e)), n = 1 - t;
  const dx = 3 * n * n * (p1.x - p0.x) + 6 * n * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
  const dy = 3 * n * n * (p1.y - p0.y) + 6 * n * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
  const L = Math.hypot(dx, dy) || 1;
  return { x, y, dx: dx / L, dy: dy / L };
}
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
      id: this.nextId++, truck, len: truck ? 7.5 : 4.6, w: truck ? 2.5 : 1.9,
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

  // back：車尾後方要淨空的距離；headway：後方來車至少要幾秒後才會到
  spaceAt(lane, s, len, back = 4, headway = 1.6) {
    for (const w of lane.vehs) {
      if (w.s > s - len - back && w.s - w.len < s + 4) return false;
      if (w.s < s && w.v > 4 && s - len - w.s < w.v * headway) return false;
    }
    return true;
  }
  // 同一處車位（地下停車場入口、相鄰的車位）一次只讓一台車進出
  slotBusy(b, pt) {
    // 室內車位（地下 / 立體停車場入口）：入口內並排的車道各自進出，只擋同一條車道
    const R = pt.indoor ? 2.4 : 3.4;
    for (const f of this.fx) {
      if (f.done || f.b !== b) continue;
      const q = f.arrive ? f.pts[3] : f.pts[0];
      if (Math.hypot(q.x - pt.x, q.y - pt.y) < R) return true;
    }
    return false;
  }

  // ---------- 生成 / 結束 ----------
  // 這輛車實際要停的位置：預約的車位在道路上的對應點（沒有預約就用建築的出入口）
  destOf(v) {
    if (v.bus || v.taxi || v.freight) return v.busDest;   // 公車：下一個站牌；計程車：接客 / 下客的地點
    const to = v.trip.to;
    if (!v.slotPt || to.outside) return to;
    const city = this.game.city, ver = this.net.version, list = city.slotSet(to, v.truck).list;
    if (!v._dest || v._dest.ver !== ver || v._dest.list !== list) {
      // 依預約車位的位置找（建築升級後車位編號可能改變）
      const i = city.slotIndexAt(to, v.slotPt, v.truck);
      v.slotIdx = i >= 0 ? i : null;
      const rd = i >= 0 ? city.slotRoad(to, i, v.truck) : null;
      v._dest = rd ? { ver, list, seg: rd.seg, u: rd.u, id: to.id } : { ver, list, seg: to.seg, u: to.u, id: to.id };
      if (!rd) v.slotPt = null;
    }
    return v._dest;
  }

  // busDest：公車的第一站（公車行程不預約目的地車位）
  trySpawn(trip, busDest = null) {
    if (this.vehicles.length >= MAX_VEHICLES) return 'wait';
    const net = this.net, city = this.game.city, from = trip.from, to = trip.to, truck = !!trip.truck;
    if (!net.segs.get(from.seg) || !net.segs.get(to.seg)) return 'noroute';
    // 從建築出發：挑一輛停著的車（貨車停在卸貨區），從它的車位對應的路邊出發；那裡的路邊被擋住時換另一輛（最多試 4 輛）
    const leaves = [];
    if (city && from.zone && !from.dead) {
      const parked = city.pickParked(from, 4, truck);
      for (const lv of parked) {
        // 室內停車場：從出口車道開出來
        const sp = lv.slot.out || lv.slot;
        if (this.slotBusy(from, sp)) continue;
        const rd = city.slotRoad(from, lv.idx, truck, true);
        if (rd) leaves.push({ ...lv, slot: sp, pt: { seg: rd.seg, u: rd.u, id: from.id } });
      }
      // 有停著的車但旁邊正有車在進出：等一下，不要從建物憑空開出一輛
      if (!leaves.length && parked.length) return 'wait';
      // 住家的車都開走了（或去程就是搭大眾運輸）：這趟不開車
      if (!truck && !leaves.length && (trip.transit || (from.zone === 'R' && city.slotsOf(from).length))) return 'transit';
    }
    if (trip.transit && !truck) return 'transit';
    if (!leaves.length) leaves.push(null);
    // 目的地是建築：先預約一個空車位（貨車預約卸貨區），開到車位對應的路邊
    let slotIdx = null, slotPt = null;
    if (city && to.zone && !to.dead && !busDest) {
      const { list, occ, res } = city.slotSet(to, truck), free = [];
      for (let i = 0; i < list.length; i++) if (!occ[i] && !res[i]) free.push(i);
      if (free.length) { slotIdx = free[Math.floor(this.game.rng.next() * free.length)]; slotPt = list[slotIdx]; }
    }
    const rd = slotPt ? city.slotRoad(to, slotIdx, truck) : null;
    const destPt = busDest || (rd ? { seg: rd.seg, u: rd.u, id: to.id } : to);
    const len = trip.bus ? BUS_LEN : truck ? 7.5 : 4.6;
    let routed = false;
    for (const leave of leaves) {
      const fromPt = leave ? leave.pt : from;
      const r = routeFromPoint(net, fromPt, destPt);
      if (!r) continue;
      routed = true;
      const link = net.links.get(r.path[0]);
      for (let i = link.lanes.length - 1; i >= 0; i--) {
        const lane = link.lanes[i];
        // 從車位開出：在車位稍前方加入車流（轉出時不會掃到後方的車位），後方要留出轉出的空間、來車 3.5 秒內不會到；
        // 要橫越的車道（例如往對向車道）也要淨空
        const s = clamp(net.segUToLaneS(lane, fromPt.u) + (leave ? len / 2 + 2 : 0), 0, lane.len - 0.5);
        const ok = leave ? this.spaceAt(lane, s, len, 9, 3.5) && this.sideClear(lane, s, leave.slot, len) : this.spaceAt(lane, s, len);
        if (ok) {
          const v = this.createVehicle(truck);
          v.route = r.path; v.ri = 0; v.trip = trip;
          if (trip.bus) Object.assign(v, { bus: trip.bus, color: trip.color, len: BUS_LEN, w: BUS_W, a: 1, b: 2, T: 1.6, v0f: 0.85, stopIdx: 0, pax: [], busDest, dwell: 0 });
          // 計程車：先開到乘客出發的建築前接客（stage 0），再開到目的地（stage 1）
          if (trip.taxi) Object.assign(v, { taxi: { pax: trip.taxi, stage: 0, t0: this.game.time }, busDest, dwell: 0 });
          v.v = from.outside ? Math.min(lane.speed * 0.7, 14) : 0;
          v.fadeIn = from.outside ? 1 : 0;   // 沒有停車位的建築：車由路邊慢慢出現
          if (rd) { v.slotIdx = slotIdx; v.slotPt = slotPt; city.slotSet(to, truck).res[slotIdx] = true; }
          this.place(v, lane, s);
          this.vehicles.push(v);
          // 從停車位開出來，到路邊才加入車流（車子就是原本停著的那輛）
          if (leave) {
            city.slotSet(from, truck).occ[leave.idx] = null;
            if (!trip.bus) v.color = leave.color;
            const p = pointAt(lane.pts, lane.cum, clamp(s - v.len / 2, 0, lane.len));
            const f = this.parkPath(p, leave.slot, v, false, from, leave.idx);
            this.fx.push(f);
            v.hold = f.dur; v.holdV = f.vOut;
          } else if (from.zone && !from.dead && this.fx.length < 300) {
            // 沒有停著的車（停在建物裡 / 地下室）：從建物入口開出來
            const p = pointAt(lane.pts, lane.cum, clamp(s - v.len / 2, 0, lane.len));
            const gx = from.x - p.x, gy = from.y - p.y, L = Math.hypot(gx, gy) || 1, k = Math.min(10, L * 0.5);
            const f = this.parkPath(p, { x: p.x + gx / L * k, y: p.y + gy / L * k, ax: gx / L, ay: gy / L, indoor: true }, v, false);
            this.fx.push(f);
            v.hold = f.dur; v.holdV = f.vOut;
          }
          return 'ok';
        }
        if (!from.outside) break;
      }
    }
    return routed ? 'wait' : 'noroute';
  }

  finish(v, ok) {
    if (v.dead) return;
    // 正在轉進車位時被移除（例如道路被拆）：直接結束
    if (v.leaving > 0) { this.endTrip(v, v.finishOk); return; }
    // 抵達建築：開進預約好的車位停好（沒有車位就開進建物 / 地下停車場）
    const to = v.trip && v.trip.to;
    if (v.slotPt && to && to.zone) this.destOf(v);   // 確認預約的車位還在（建築升級後依位置對應）
    const res = to && (v.truck ? to.tRes : to.slotRes);
    const hasSlot = v.slotIdx !== undefined && v.slotIdx !== null && res;
    let f = null;
    if (ok && to && to.zone && !to.dead && v.track && v.track.pts) {
      const p = pointAt(v.track.pts, v.track.cum, clamp(v.s - v.len / 2, 0, v.track.len));
      if (hasSlot) this.fx.push(f = this.parkPath(p, v.slotPt, v, true, to, v.slotIdx));
      else if (this.fx.length < 300) {
        const gx = to.x - p.x, gy = to.y - p.y, L = Math.hypot(gx, gy) || 1, k = Math.min(10, L * 0.5);
        this.fx.push(f = this.parkPath(p, { x: p.x + gx / L * k, y: p.y + gy / L * k, ax: gx / L, ay: gy / L, indoor: true }, v, true));
      }
    } else if (hasSlot) res[v.slotIdx] = false;
    // 轉進車位時車身還壓在車道上：先留在車道上（不畫出來）擋住後面的車，直到沿曲線開離車道（橫向超過 3.2 m）
    if (f && v.track.kind === 'lane') {
      const [p0, p1] = f.pts, dx = p1.x - p0.x, dy = p1.y - p0.y, L = Math.hypot(dx, dy) || 1;
      let kk = 1;
      for (let k = 0.05; k <= 1; k += 0.05) {
        const q = fxAt(f, k);
        if (Math.abs((q.x - p0.x) * dy - (q.y - p0.y) * dx) / L > 3.2) { kk = k; break; }
      }
      v.leaving = f.dur * kk + 0.2; v.finishOk = ok; v.v = 0; v.acc = 0;
      v.s = Math.min(v.s, v.track.len - 0.05);
      return;
    }
    this.endTrip(v, ok);
  }
  endTrip(v, ok) {
    // 公車被移除（塞太久、道路被拆）：車上乘客改走路，公車回到總站的停車格（不會就此少一輛）
    // 列車被移除（軌道被拆、卡太久）：乘客改走路，列車直接離開
    if (v.train) {
      for (const p of v.pax || []) this.game.transit.walk(p.trip);
      this.removeFromTrack(v); v.dead = true; v.track = null; v.leaving = 0;
      return;
    }
    if (v.bus) {
      for (const p of v.pax || []) this.game.transit.walk(p.trip);
      const d = v.trip.from, st = this.game.city.slotSet(d, true), i = st.list.findIndex((_, k) => !st.occ[k] && !st.res[k]);
      if (!d.dead && i >= 0) st.occ[i] = v.color;
      this.removeFromTrack(v); v.dead = true; v.track = null; v.leaving = 0;
      return;
    }
    // 計程車被移除：乘客改走路，計程車回到出發的車行 / 招呼站（不會就此少一台）
    if (v.taxi) {
      this.game.transit.walk(v.taxi.pax);
      const d = v.trip.from, st = this.game.city.slotSet(d, false), i = d.zone ? st.list.findIndex((_, k) => !st.occ[k] && !st.res[k]) : -1;
      if (!d.dead && i >= 0) st.occ[i] = v.color;
      this.removeFromTrack(v); v.dead = true; v.track = null; v.leaving = 0;
      return;
    }
    this.removeFromTrack(v);
    v.dead = true;
    v.track = null;
    v.leaving = 0;
    if (this.game.city) this.game.city.onTripEnd(v.trip, ok, v.age);
  }

  // 計程車：接到客人後開往目的地；送到後乘客的行程完成，計程車開回最近有空位的車行 / 招呼站停好
  nextTaxiStage(v) {
    const t = v.taxi, p = t.pax, city = this.game.city;
    v.dwell = 0; v.waitT = 0;
    if (t.stage === 0 && !p.to.dead) {
      t.stage = 1;
      v.trip = { ...v.trip, from: p.from, to: p.to };
      v.busDest = { seg: p.to.seg, u: p.to.u, id: p.to.id };
      this.reroute(v);
      return;
    }
    // 下客：乘客的行程完成（行程時間從叫車開始算）
    if (t.stage === 1) { this.game.transit.stats.taxi = (this.game.transit.stats.taxi || 0) + 1; city.onTripEnd(p, true, Math.max(60, (this.game.time - t.t0) / CLOCK)); }
    else this.game.transit.walk(p);
    v.taxi = null; v.busDest = null; v._dest = null;
    const home = this.game.transit.taxiHome(p.to.dead ? p.from : p.to);
    v.trip = { kind: 'taxiret', from: p.to, to: home || p.to, truck: false };
    v.slotPt = null; v.slotIdx = null;
    if (home) { const st = city.slotSet(home, false), i = st.list.findIndex((_, k) => !st.occ[k] && !st.res[k]); if (i >= 0) { v.slotIdx = i; v.slotPt = st.list[i]; st.res[i] = true; } }
    this.reroute(v);
  }

  // 從公車總站派一輛停著的公車，開往路線的第一站
  spawnBus(d, line) {
    const transit = this.game.transit, st = transit.stop(line.stops[0]);
    if (!st || !this.game.city.parkedCount(d, true)) return 'wait';
    const pt = transit.stopPoint(st);
    return this.trySpawn({ kind: 'bus', from: d, to: d, truck: true, bus: line.id, color: line.color }, { seg: pt.seg, u: pt.u, id: d.id, stop: st.id });
  }

  // 列車：從鐵路總站的月台發車（先在總站上下客），三節車廂
  spawnTrain(d, line) {
    const net = this.net, transit = this.game.transit, st = transit.stop(line.stops[0]), nx = transit.stop(line.stops[1]);
    if (!st || !nx) return 'wait';
    const r = routeFromPoint(net, { seg: st.seg, u: st.u, id: 'x' }, { seg: nx.seg, u: nx.u, id: 'x' });
    if (!r) return 'noroute';
    const L = net.links.get(r.path[0]), lane = L && L.lanes[0];
    if (!lane) return 'noroute';
    const s = clamp(net.segUToLaneS(lane, st.u), 0, lane.len - 0.5);
    if (!this.spaceAt(lane, s, 70, 70)) return 'wait';
    const v = this.createVehicle(true);
    Object.assign(v, { train: true, cars: 3, bus: line.id, len: 66, w: 3.1, a: 0.7, b: 1.1, T: 2, v0f: 1, color: line.color, pax: [], stopIdx: 0, dwell: 0,
      busDest: { seg: st.seg, u: st.u, id: d.id, stop: st.id } });
    v.trip = { kind: 'train', from: d, to: d, truck: true };
    v.route = [L.key]; v.ri = 0;
    this.place(v, lane, s);
    this.vehicles.push(v);
    return 'ok';
  }
  // 列車重新規劃：從目前位置往兩個方向找到下一站的路線；要往回開時換到另一條軌道（在車站折返）
  trainRoute(v) {
    const net = this.net, lane = v.track;
    if (!lane || lane.kind !== 'lane') { this.reroute(v); return; }
    const u = net.laneSToSegU(lane, v.s), dest = v.busDest;
    const r = routeFromPoint(net, { seg: lane.seg.id, u, id: 'x' }, { seg: dest.seg, u: dest.u, id: 'x' });
    if (!r) { v.lost = true; v.route = [lane.link.key]; v.ri = 0; return; }
    const L = net.links.get(r.path[0]);
    if (L && L !== lane.link && L.lanes.length) {
      const nl = L.lanes[0];
      this.removeFromTrack(v); v.prevTrack = null;
      this.place(v, nl, clamp(net.segUToLaneS(nl, u), 0, nl.len - 0.5)); v.v = 0;
    }
    v.route = r.path; v.ri = 0; v.nextConn = null; v.committed = false; v.lost = false;
  }
  // 貨運列車：從外部鐵路開進來，目的地是貨運站的月台
  spawnFreight(o, rc) {
    const net = this.net, n = net.nodes.get(o.node), s = n && net.segs.get(n.segs[0]), pt = this.game.city.platformOf(rc);
    if (!s || !pt) return false;
    const dir = s.a === n.id ? 1 : -1, L = s.links[dir], lane = L.lanes[0];
    if (!lane) return false;
    const u0 = dir > 0 ? 6 : s.len - 6, r = routeFromPoint(net, { seg: s.id, u: u0, id: 'x' }, { seg: pt.seg, u: pt.u, id: 'x' });
    if (!r || r.path[0] !== L.key) return false;
    const sl = net.segUToLaneS(lane, u0);
    if (!this.spaceAt(lane, sl, 100, 100)) return false;
    const v = this.createVehicle(true);
    Object.assign(v, { train: true, cars: 6, len: 100, w: 3.1, a: 0.5, b: 1, T: 2.2, v0f: 0.9, color: '#3f5f7a', dwell: 0,
      freight: { rc: rc.id, stage: 0, out: { seg: s.id, u: dir > 0 ? 2 : s.len - 2 } }, busDest: { seg: pt.seg, u: pt.u } });
    v.trip = { kind: 'freight', from: rc, to: rc, truck: true };
    v.route = r.path; v.ri = 0;
    this.place(v, lane, sl);
    this.vehicles.push(v);
    return true;
  }
  nextFreightStage(v) {
    const f = v.freight;
    v.dwell = 0;
    if (f.stage === 0) {
      // 卸下原料（貨運站存貨增加）、裝上外銷商品，開回外部鐵路
      const rc = this.game.city.byId.get(f.rc);
      if (rc && !rc.dead) { rc.stock = Math.min(200, (rc.stock || 0) + 40); rc.shipped = (rc.shipped || 0) + (rc.exports || 0); rc.exports = 0; }
      this.game.transit.stats.freight = (this.game.transit.stats.freight || 0) + 1;
      f.stage = 1; v.busDest = f.out;
      this.trainRoute(v);
      return;
    }
    this.removeFromTrack(v); v.dead = true; v.track = null;
  }
  nextBusStop(v) {
    const transit = this.game.transit, line = transit.line(v.bus);
    if (!line) { this.retireBus(v); return; }
    v.stopIdx = (v.stopIdx + 1) % line.stops.length;
    const st = transit.stop(line.stops[v.stopIdx]);
    if (!st) { this.retireBus(v); return; }
    const pt = transit.stopPoint(st, !!v.train);
    v.busDest = { seg: pt.seg, u: pt.u, id: v.trip.from.id, stop: st.id };
    v.dwell = 0; v.waitT = 0;
    if (v.train) this.trainRoute(v); else this.reroute(v);
  }
  // 路線取消：公車載著的乘客改走路，公車開回總站的停車格
  retireBus(v) {
    // 列車：路線取消就直接離開（回到總站的車庫）
    if (v.train) { this.endTrip(v, true); return; }
    const d = v.trip.from, city = this.game.city;
    for (const p of v.pax || []) this.game.transit.walk(p.trip);
    v.bus = null; v.pax = []; v.busDest = null; v._dest = null;
    v.trip = { kind: 'return', from: d, to: d, truck: true };
    const st = city.slotSet(d, true), i = st.list.findIndex((_, k) => !st.occ[k] && !st.res[k]);
    if (i >= 0) { v.slotIdx = i; v.slotPt = st.list[i]; st.res[i] = true; }
    this.reroute(v);
  }

  // 停進 / 開出路邊車位時要橫越的其他車道是否淨空：檢查自己的車道與車位那一側路邊之間的車道，
  // 旁邊有車或 3 秒內會開到就不行
  sideClear(lane, s, slotPt, len) {
    const net = this.net, seg = lane.seg, u = net.laneSToSegU(lane, s), p = pointAt(seg.pts, seg.cum, u);
    const side = Math.sign((slotPt.x - p.x) * -p.dy + (slotPt.y - p.y) * p.dx);
    const my = laneOffset(seg.T, lane.dir, lane.idx);
    for (const L of seg.lanes) {
      if (L === lane || (laneOffset(seg.T, L.dir, L.idx) - my) * side <= 0) continue;
      const s2 = net.segUToLaneS(L, u);
      for (const w of L.vehs) {
        if (w.s > s2 - len - 3 && w.s - w.len < s2 + len + 3) return false;
        if (w.s < s2 && s2 - w.s < Math.max(8, w.v * 3)) return false;
      }
      // 這條車道的起點就在附近：從後方路口正要開進來的車也算
      if (s2 < 45) for (const c of net.nodes.get(L.link.from)?.conns || []) {
        if (c.to !== L) continue;
        for (const w of c.vehs) if (c.len - w.s + s2 < Math.max(10, w.v * 3)) return false;
        for (const w of c.from.vehs) if (c.from.len - w.s + c.len + s2 < Math.max(10, w.v * 3) && w.nextConn === c) return false;
      }
    }
    // 車位靠近路口（例如停車場車道的交叉口）：路口裡正在轉彎的車離開後才進出
    // （停在路口裡的車多半是在等我們，不算，否則雙方互等）
    for (const nid of [seg.a, seg.b]) {
      const n = net.nodes.get(nid);
      if (!n || Math.hypot(n.x - p.x, n.y - p.y) > n.radius + 16) continue;
      for (const c of n.conns) for (const w of c.vehs) {
        if (w.v < 1) continue;
        const q = pointAt(c.pts, c.cum, clamp(w.s - w.len / 2, 0, c.len));
        if (Math.hypot(q.x - p.x, q.y - p.y) < len + 6) return false;
      }
    }
    return true;
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

  // 從目前車速以最大加速度加速到 vmax，開 D 公尺要幾秒
  tReach(w, D, vmax) {
    if (D <= 0) return 0;
    const a = w.a || 1.5, v0 = Math.min(w.v, vmax), t1 = (vmax - v0) / a, d1 = (v0 + vmax) / 2 * t1;
    return D <= d1 ? (-v0 + Math.sqrt(v0 * v0 + 2 * a * D)) / a : t1 + (D - d1) / vmax;
  }
  // 路口內交叉連接線上的車 w 會不會和我（在連接線起點前 dist 公尺）在交叉點相撞
  crossBlocks(v, c, dist, cf, w) {
    const Z = 2.5;
    const wIn = cf.other - Z - w.s, wOut = cf.other + Z + w.len - w.s;
    if (wOut <= 0) return false;                       // 已經開過交叉點
    const vmW = Math.max(cf.c.speed, 3);
    const tWOut = w.v < 0.5 && wIn <= 0 ? Infinity : this.tReach(w, wOut, vmW);
    const tMeIn = this.tReach(v, dist + cf.at - Z, Math.max(c.speed, 3));
    if (tWOut + 1.5 < tMeIn) return false;            // 對方會先開過去
    // 對方停在交叉點前方夠遠處（被前車擋住），我能在它起步開到交叉點之前開過去
    if (wIn <= 6 || w.v >= 0.5) return true;
    const tMeOut = this.tReach(v, dist + cf.at + Z + v.len, Math.max(c.speed, 3));
    return !(tMeOut + 2.5 < this.tReach(w, wIn, vmW));
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
    // 等越久越願意接受較短的車距（駕駛不耐煩）；從停車場 / 園區開出來的車接受較短的車距、也更快不耐煩
    const gapT = c.from.seg.T.internal ? 3.2 - 1.6 * clamp(v.waitT / 15, 0, 1) : 4.5 - 2.3 * clamp(v.waitT / 30, 0, 1);
    for (const cf of c.conflicts) {
      const oc = cf.c;
      // 交叉方向的連接線上還有車沒完全開過交叉點：依時間窗判斷，對方開過去之後我才到、
      // 或我開過去之後對方才到（各留安全間隔）就可以走，不必等對方整台車開過交叉點
      if (cf.type === 'cross' && oc.vehs.some(w => this.crossBlocks(v, c, dist, cf, w))) return false;
      const w = oc.from.vehs[0];
      if (!w || w === v || w.nextConn !== oc) continue;
      const wd = oc.from.len - w.s;
      const tArr = wd / Math.max(w.v, 2.5);
      // 平交道：列車接近時（約 14 秒內會到）車輛一律停下等列車通過
      if (w.train && !v.train && wd < 350 && tArr < 14) return false;
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

  // 從同一條車道分出去的其他連接上、車尾還在共用起點附近的車（剛轉進去 / 剛分岔的前車）
  // s0：自己在這段共用起點之後的位置（還在車道上時為負值）
  forkLeader(lane, own, s0, best) {
    for (const c of lane.conns) {
      if (c === own || !c.vehs.length) continue;
      const w = c.vehs[c.vehs.length - 1], rear = w.s - w.len;
      if (rear > 6 || w.s <= s0) continue;
      const gap = rear - s0;
      if (gap < best.gap) best = { gap, lv: w.v };
    }
    return best;
  }

  leader(v) {
    const tr = v.track;
    if (v.idx > 0) {
      const L = tr.vehs[v.idx - 1];
      const r = { gap: L.s - L.len - v.s, lv: L.v };
      return tr.kind === 'conn' && v.s < 6 ? this.forkLeader(tr.from, tr, v.s, r) : r;
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
      let r;
      if (c.vehs.length) {
        const w = c.vehs[c.vehs.length - 1];
        r = { gap: dist + w.s - w.len, lv: w.v };
      } else r = this.leaderOnLaneStart(c, dist + c.len);
      return dist < 30 ? this.forkLeader(tr, c, -dist, r) : r;
    }
    const r = this.leaderOnLaneStart(tr, dist);
    return v.s < 6 ? this.forkLeader(tr.from, tr, v.s, r) : r;
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
    let acc = this.idm(v, v0, ld.gap, v.v - ld.lv);
    // 禮讓：旁邊車道要切進來的車（必須換車道才能轉彎、卡在排隊車流旁）就在前方時，留一個車位給它
    const w = v.yieldTo;
    if (w) {
      const ok = v.yieldT > 0 && !w.dead && tr.kind === 'lane' && w.track.kind === 'lane' && w.track.link === tr.link && Math.abs(w.track.idx - tr.idx) === 1;
      const s2 = ok ? w.s / w.track.len * tr.len : 0;
      if (ok && s2 > v.s && s2 - v.s < 30) acc = Math.min(acc, this.idm(v, v0, s2 - w.len - 1 - v.s, v.v - w.v));
      else v.yieldTo = null;
    }
    return clamp(acc, -9, v.a);
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
    // 快到路邊的車位：先換到最外側車道，轉進去時才不用橫越同向車道（有足夠車距才換，不硬切）
    // 公車快到站牌時也先靠到最外側車道，停靠時不擋住其他車道
    const curb = v.bus && !v.train;
    if (atDest && lane.idx < lanes.length - 1 && (curb || (v.slotPt && v.trip.to.zone))) {
      const dS = this.destS(v) - v.s, p = pointAt(lane.pts, lane.cum, clamp(v.s, 0, lane.len));
      // distEff 設很大：不急迫，只在車距足夠（≥ 3 m、後車不必急煞）時才換；快到站時（公車）越來越急
      if (dS > 0 && dS < 250 && (curb || (v.slotPt.x - p.x) * -p.dy + (v.slotPt.y - p.y) * p.dx > 0)) { mand = 1; distEff = curb ? Math.max(30, dS) : 999; }
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
      // 必須換車道而且快到路口：請目標車道的後車禮讓（computeAccel 的 yieldTo），下一次再試就有空隙
      const ask = () => { if (mand && urg > 0.3 && follow && !follow.committed && (!follow.yieldTo || follow.yieldTo === v)) { follow.yieldTo = v; follow.yieldT = 8; } };
      if (gapF < minGap || gapB < minGap) { if (gapB < minGap) ask(); continue; }
      if (follow) {
        const fAcc = this.idm(follow, follow.v0eff, gapB, follow.v - v.v);
        if (fAcc < -(mand ? 3 + urg * 4 : 2.5)) { ask(); continue; }
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
      if (follow && follow.yieldTo === v) follow.yieldTo = null;
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
          // 公車 / 列車開過頭（站牌不在這條車道上）：重新規劃到站牌的路線
          if (v.bus || v.train) { v.s = tr.len - 0.05; v.v = 0; if (v.train) this.trainRoute(v); else this.reroute(v); return; }
          this.finish(v, !v.lost && tr.link.seg.id === this.destOf(v).seg);
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

  // 停車 / 出車的路徑：三次貝茲曲線，起點沿車道方向、終點沿車位方向（車頭朝前開進 / 開出），約 5.5 m/s
  parkPath(p, sl, v, arrive, b = null, idx = null) {
    const dx = sl.x - p.x, dy = sl.y - p.y, dist = Math.hypot(dx, dy) || 1;
    let ax = sl.ax, ay = sl.ay;
    if ((arrive ? 1 : -1) * (ax * dx + ay * dy) < 0) { ax = -ax; ay = -ay; }
    // 控制點依車位與路邊點的前後距離（e）與橫向距離（D）縮放：轉進 / 轉出時不會先衝過頭再折回，掃到旁邊的車位
    const e = (arrive ? 1 : -1) * (dx * p.dx + dy * p.dy), D = Math.abs(dx * p.dy - dy * p.dx);
    const k0 = clamp(e * 0.9, 0.6, 5), k1 = clamp(D * 0.7, 1, 5);
    const pts = arrive
      ? [{ x: p.x, y: p.y }, { x: p.x + p.dx * k0, y: p.y + p.dy * k0 }, { x: sl.x - ax * k1, y: sl.y - ay * k1 }, { x: sl.x, y: sl.y }]
      : [{ x: sl.x, y: sl.y }, { x: sl.x + ax * k1, y: sl.y + ay * k1 }, { x: p.x - p.dx * k0, y: p.y - p.dy * k0 }, { x: p.x, y: p.y }];
    // 開出時車子已在車道上等，限制在 3 秒內以免擋到後面的車
    const dur = clamp(dist * 1.2 / 5.5, 1.2, arrive ? 7 : 3);
    // 速度銜接（不會開到車位前突然停住、再從靜止起步）：停進時起點速度 = 車子當下的速度；
    // 開出時終點速度約 4 m/s，車子之後以這個速度加入車流（vOut）
    const vIn = arrive ? Math.min(v.v, 8) : 0, vOut = arrive ? 0 : Math.min(4, dist * 1.8 / dur);
    const ea = clamp(vIn * dur / (3 * k0), 0, 3), eb = clamp(vOut * dur / (3 * k0), 0, 3);
    return { pts, dur, t: 0, ea, eb, vOut: eb * 3 * k0 / dur, color: v.color, len: v.len, w: v.w, truck: v.truck, arrive, b, idx, indoor: !!sl.indoor };
  }

  step(dt) {
    this.updateSignals(dt);
    if (this.fx.length) {
      for (const f of this.fx) {
        f.t += dt;
        if (f.t >= f.dur && !f.done) {
          f.done = true;
          // 停好了：車位記下這輛車（顏色），取消預約
          if (f.b && f.arrive && f.idx !== null && f.b.slotOcc) { const st = this.game.city.slotSet(f.b, f.truck); st.res[f.idx] = false; if (!f.b.dead) st.occ[f.idx] = f.color; }
        }
      }
      this.fx = this.fx.filter(f => !f.done);
    }
    const vs = this.vehicles;
    for (const v of vs) if (!v.dead) v.acc = v.leaving > 0 || v.hold > 0 ? 0 : this.computeAccel(v);
    for (const v of vs) {
      if (v.dead || v.leaving > 0) continue;
      // 還在從停車位開出來：先停在路邊等
      if (v.hold > 0) { v.hold -= dt; v.v = 0; if (v.hold <= 0) { v.fadeIn = 1; v.v = v.holdV || 0; } continue; }
      if (v.fadeIn < 1) v.fadeIn = Math.min(1, v.fadeIn + dt / 0.8);
      v.lcT -= dt;
      if (v.lcT <= 0) { v.lcT = 0.4 + (v.id % 7) * 0.03; this.tryLaneChange(v); }
    }
    let anyDead = false;
    for (const v of vs) {
      if (v.dead) { anyDead = true; continue; }
      // 正在轉進車位：時間到才真正離開車道
      if (v.leaving > 0) { v.leaving -= dt; v.v = 0; if (v.leaving <= 0) { this.endTrip(v, v.finishOk); anyDead = true; } continue; }
      // 正在從車位開出來：停在路邊不動
      if (v.hold > 0) { v.v = 0; v.age += dt; continue; }
      v.v = Math.max(0, v.v + v.acc * dt);
      v.s += v.v * dt;
      v.braking = v.acc < -1.2;
      if (v.lat) { v.lat *= Math.exp(-dt * 2.2); if (Math.abs(v.lat) < 0.02) v.lat = 0; }
      v.lcCool -= dt;
      if (v.yieldTo) v.yieldT -= dt;
      v.age += dt;
      if (v.v < 0.5) v.waitT += dt; else { v.waitT = 0; v.triedReroute = false; }
      this.advance(v);
      if (v.dead) { anyDead = true; continue; }
      const tr = v.track;
      if (v.bus && tr.kind === 'lane' && v.ri >= v.route.length - 1 && tr.link.seg.id === v.busDest.seg && v.s >= this.destS(v)) {
        // 公車到站：停在站牌前上下客，時間到開往下一站；沒有人要上下車就不停（直接開往下一站，不擋住後面的車）
        if (!v.dwell) {
          const st = this.game.transit.stop(v.busDest.stop);
          if (st && !v.train && !this.game.transit.needStop(v, st)) { this.nextBusStop(v); continue; }
          v.dwell = st ? this.game.transit.exchange(v, st) : 1;
        }
        v.s = this.destS(v); v.v = 0; v.dwell -= dt;
        if (v.dwell <= 0) this.nextBusStop(v);
        continue;
      }
      if (v.freight && tr.kind === 'lane' && v.ri >= v.route.length - 1 && tr.link.seg.id === v.busDest.seg && v.s >= this.destS(v)) {
        // 貨運列車：在貨運站停 15 秒裝卸，開到外部鐵路後離開地圖
        if (!v.dwell) v.dwell = v.freight.stage === 0 ? 15 : 0.01;
        v.s = this.destS(v); v.v = 0; v.dwell -= dt;
        if (v.dwell <= 0) this.nextFreightStage(v);
        continue;
      }
      if (v.taxi && tr.kind === 'lane' && v.ri >= v.route.length - 1 && tr.link.seg.id === v.busDest.seg && v.s >= this.destS(v)) {
        // 計程車接客 / 下客：在建築前停 3 秒
        if (!v.dwell) v.dwell = 3;
        v.s = this.destS(v); v.v = 0; v.dwell -= dt;
        if (v.dwell <= 0) this.nextTaxiStage(v);
        continue;
      }
      if (tr.kind === 'lane' && v.ri >= v.route.length - 1 && tr.link.seg.id === this.destOf(v).seg && v.s >= this.destS(v)) {
        // 車位在路的另一側：停在原地等要橫越的車道淨空（最多 6 秒，免得停車場裡互等）
        const ahead = v.idx > 0 ? tr.vehs[v.idx - 1] : null;
        if (v.slotPt && (v.parkWait || 0) < 6 && (!this.sideClear(tr, v.s, v.slotPt, v.len) || this.slotBusy(v.trip.to, v.slotPt) || (ahead && ahead.s - ahead.len - v.s < 6))) { v.parkWait = (v.parkWait || 0) + dt; v.s = this.destS(v); v.v = 0; continue; }
        this.finish(v, true); anyDead = true; continue;
      }
      v.rerouteT -= dt;
      if (tr.kind === 'lane') {
        if (v.needRoute) this.reroute(v);
        else if ((v.rerouteT <= 0 || (v.waitT > 12 && !v.triedReroute) || (v.waitT > 5 && !v.triedReroute && tr.len - v.s < 25 && !this.chooseConn(v)) || (tr.seg.ring && v.waitT > 2.5 && !v.triedReroute)) && this.rerouteBudget > 0) {
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
      // 每秒經過的車數（約為 Σ車速 / 路段長），加油站的過路客用（city.hourly 讀取後歸零）
      L.passAcc = (L.passAcc || 0) + sum / Math.max(10, L.len);
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

// 車輛重疊檢查：模擬一段時間，每隔一段時間把畫面上所有的車（路上、停車 / 出車動畫中、停著的）
// 當成矩形兩兩檢查是否重疊，依情況分類統計。node tests/overlap.js [遊戲小時] [種子]
import { makeGame, step, connectOutside } from './harness.js';
import { pointAt } from '../js/util.js';

// 回傳 { 類別: 次數 }，以及最多 examples 筆範例
export function scanOverlaps(g, maxEx = 40) {
  const boxes = [];
  const add = (x, y, dx, dy, len, w, kind, lv, ref) => boxes.push({ x, y, dx, dy, hl: len / 2 - 0.25, hw: w / 2 - 0.15, kind, lv, ref });
  for (const v of g.traffic.vehicles) {
    if (v.dead || v.hold > 0 || v.leaving > 0) continue;
    // 與畫面相同（render.vehPose）：車身中心在車頭後方半個車長，跨過交界時畫在前一段 / 下一段軌道上
    let tr = v.track, s = v.s - v.len / 2;
    if (s > tr.len) { const nx = tr.kind === 'lane' ? (v.committed ? v.nextConn : null) : tr.to; if (nx && !nx.dead && nx.pts) { s -= tr.len; tr = nx; } }
    else if (s < 0 && v.prevTrack && !v.prevTrack.dead && v.prevTrack.pts) { tr = v.prevTrack; s = Math.max(0, tr.len + s); }
    const p = pointAt(tr.pts, tr.cum, Math.max(0, Math.min(tr.len, s)));
    const x = p.x - p.dy * (v.lat || 0), y = p.y + p.dx * (v.lat || 0);
    add(x, y, p.dx, p.dy, v.len, v.w, tr.kind === 'lane' ? '路上' : '路口', tr.drawLevel || 0, v);
  }
  for (const f of g.traffic.fx) {
    const k = Math.min(1, f.t / f.dur), e = k * k * (3 - 2 * k), m = 1 - e, [p0, p1, p2, p3] = f.pts;
    const x = m * m * m * p0.x + 3 * m * m * e * p1.x + 3 * m * e * e * p2.x + e * e * e * p3.x;
    const y = m * m * m * p0.y + 3 * m * m * e * p1.y + 3 * m * e * e * p2.y + e * e * e * p3.y;
    const t = Math.min(0.995, Math.max(0.005, e)), n = 1 - t;
    let dx = 3 * n * n * (p1.x - p0.x) + 6 * n * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
    let dy = 3 * n * n * (p1.y - p0.y) + 6 * n * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
    const L = Math.hypot(dx, dy) || 1;
    if (f.indoor && (f.arrive ? k > 0.65 : k < 0.35)) continue;   // 已淡出 / 還沒淡入
    add(x, y, dx / L, dy / L, f.len, f.w, f.arrive ? '停車中' : '出車中', 0, f);
  }
  for (const b of g.city.buildings) {
    for (const truck of [false, true]) {
      if (truck && !g.city.truckSlotsOf) continue;
      const list = truck ? g.city.truckSlotsOf(b) : g.city.slotsOf(b), occ = truck ? b.tOcc : b.slotOcc;
      list.forEach((sl, i) => { if (occ[i] && !sl.indoor) add(sl.x, sl.y, sl.ax, sl.ay, truck ? 7.5 : 4.6, truck ? 2.5 : 1.85, '停著', 0, b); });
    }
  }
  // 分離軸檢查兩個有方向的矩形
  const sep = (a, b) => {
    for (const [ax, ay] of [[a.dx, a.dy], [-a.dy, a.dx], [b.dx, b.dy], [-b.dy, b.dx]]) {
      const ra = a.hl * Math.abs(a.dx * ax + a.dy * ay) + a.hw * Math.abs(-a.dy * ax + a.dx * ay);
      const rb = b.hl * Math.abs(b.dx * ax + b.dy * ay) + b.hw * Math.abs(-b.dy * ax + b.dx * ay);
      if (Math.abs((b.x - a.x) * ax + (b.y - a.y) * ay) > ra + rb) return true;
    }
    return false;
  };
  const grid = new Map(), out = {}, ex = [];
  for (const b of boxes) { const k = Math.floor(b.x / 12) + ',' + Math.floor(b.y / 12); (grid.get(k) || grid.set(k, []).get(k)).push(b); }
  for (const a of boxes) {
    const gx = Math.floor(a.x / 12), gy = Math.floor(a.y / 12);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const b of grid.get((gx + i) + ',' + (gy + j)) || []) {
      if (b === a || a.lv !== b.lv || boxes.indexOf(b) < boxes.indexOf(a)) continue;
      if (a.kind === '停著' && b.kind === '停著') continue;
      if (sep(a, b)) continue;
      const key = [a.kind, b.kind].sort().join(' × ');
      out[key] = (out[key] || 0) + 1;
      if (ex.length < maxEx) ex.push({ key, a, b });
    }
  }
  return { out, ex };
}

if (process.argv[1] && process.argv[1].endsWith('overlap.js')) {
  const hours = +(process.argv[2] || 24), seed = +(process.argv[3] || 12345);
  const g = makeGame(seed, 'temperate', 'easy', true, 2400);
  connectOutside(g);
  // 同一對車重疊好幾秒只算一次（統計「發生幾次」而不是「持續多久」）
  const ids = new WeakMap(), id = o => (ids.has(o) ? ids.get(o) : (ids.set(o, ids.size + 1), ids.size));
  const tot = {}, seen = new Set();
  let scans = 0, inst = 0;
  for (let t = 0; t < hours * 60 / 1.5 / 0.1; t += 5) {
    step(g, 5);
    if (g.time % 1440 < 360) continue;
    const { ex } = scanOverlaps(g, 1e9);
    scans++;
    inst += ex.length;
    for (const e of ex) {
      const k = e.key + '|' + [id(e.a.ref), id(e.b.ref)].sort().join('-');
      if (seen.has(k)) continue;
      seen.add(k);
      tot[e.key] = (tot[e.key] || 0) + 1;
    }
  }
  const n = Object.values(tot).reduce((a, b) => a + b, 0);
  console.log(`${scans} 次檢查（每 0.5 模擬秒一次），${g.city.stats.trips} 趟行程；重疊 ${n} 次、累計 ${(inst * 0.5).toFixed(0)} 秒：`, JSON.stringify(tot));
}

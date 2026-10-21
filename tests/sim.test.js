// 無頭模擬測試：node tests/sim.test.js
import { Network } from '../js/network.js';
import { Traffic } from '../js/traffic.js';
import { City } from '../js/city.js';
import { makeGame, step, connectOutside } from './harness.js';
import { routeFromPoint } from '../js/routing.js';
import { lotArt } from '../js/lotart.js';
import { pointAt } from '../js/util.js';

let failed = 0;
function assert(c, m) { if (!c) { console.error('FAIL -', m); failed++; } else console.log('ok   -', m); }

const g = makeGame(12345, 'temperate', 'easy', true, 2400);
assert(g.net.segs.size > 5, `初始道路 (${g.net.segs.size})`);
assert(g.city.buildings.length >= 8, `初始建築 (${g.city.buildings.length})`);
assert(g.city.outside.length >= 2, `外部連線 (${g.city.outside.length})`);
assert(connectOutside(g).every(Boolean), '外部連線全部接通');

const big = [...g.net.nodes.values()].filter(n => n.segs.length >= 3 && n.segs.length <= 4);
assert(big.length >= 2, `路口 (${big.length})`);
big[0].control = 'signal';
big[1].control = 'stop';
g.net.rebuild();
assert(big[0].signal && big[0].signal.phases.length >= 2, '號誌時相建立');

let maxVeh = 0, intruders = 0;
const t0 = Date.now();
for (let h = 0; h < 20; h++) {
  for (let k = 0; k < 12; k++) {
    step(g, 100);
    // 場內道路（巷道、停車場車道）只有起訖是該建築的車能走，不會被當成迴轉道或捷徑
    for (const v of g.traffic.vehicles) {
      const gt = v.track.kind === 'lane' ? v.track.seg.gate : null;
      if (gt !== null && gt !== undefined && gt !== v.trip.from.id && gt !== v.trip.to.id) intruders++;
    }
  }
  maxVeh = Math.max(maxVeh, g.traffic.vehicles.length);
  for (const v of g.traffic.vehicles) {
    if (v.dead) throw new Error('dead vehicle in list');
    if (!v.track.vehs.includes(v)) throw new Error('vehicle not on its track ' + v.id);
    if (v.s < -1 || v.s > v.track.len + 1) throw new Error(`bad s ${v.s} / ${v.track.len}`);
    if (Number.isNaN(v.v) || Number.isNaN(v.s)) throw new Error('NaN');
  }
}
assert(intruders === 0, `沒有車開進別人的場內道路（${intruders} 次）`);
// 停車位：每個室外車位都接到一條道路，從車位直直開到路上不會穿過建物；
// 也不會穿過其他車位（大型停車場的每條車道都是真的場內道路）
{
  const cross = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
  const hits = (a, b, poly) => poly.some((p, i) => cross(a, b, p, poly[(i + 1) % poly.length]));
  let n = 0, noRoad = 0, thruB = 0, thruC = 0;
  const bad = [];
  for (const b of g.city.buildings) {
    const art = lotArt(b), c0 = b.corners[0];
    const P = (u, v) => ({ x: c0.x + b.tx * u + b.nx * v, y: c0.y + b.ty * u + b.ny * v });
    const box = it => (it.du !== undefined ? [P(it.u0, it.v0), P(it.u0 + it.du, it.v0), P(it.u0 + it.du, it.v0 + it.dv), P(it.u0, it.v0 + it.dv)] : [P(it.u0, it.v0), P(it.u1, it.v0), P(it.u1, it.v1), P(it.u0, it.v1)]);
    const walls = art.items.filter(it => it.t === 'rect' && it.h >= 1 && !it.car && !it.deco && !it.canopy).map(box);
    const others = [...art.slots, ...art.tslots].filter(it => !it.indoor);
    for (const truck of [false, true]) g.city.slotSet(b, truck).list.forEach((sl, i) => {
      if (sl.indoor) return;
      n++;
      const rd = g.city.slotRoad(b, i, truck);
      if (!rd) { noRoad++; return; }
      const s = g.net.segs.get(rd.seg), p = pointAt(s.pts, s.cum, rd.u), me = (truck ? art.tslots : art.slots)[i];
      if (walls.some(w => hits(sl, p, w))) { thruB++; bad.push(`${b.zt}${b.kind ? ':' + b.kind : ''}${truck ? '貨車' : ''}`); }
      if (others.some(it => it !== me && hits(sl, p, box(it)))) { thruC++; bad.push(`${b.zt}${b.kind ? ':' + b.kind : ''}${truck ? '貨車' : ''}（車位）`); }
    });
  }
  assert(n > 100 && noRoad === 0, `每個室外車位（含卸貨區）都接到道路（${n} 個，${noRoad} 個沒有）`);
  const docks = g.city.buildings.filter(b => b.zone === 'I').reduce((a, b) => a + g.city.parkedCount(b, true), 0);
  assert(docks > 0, `工業區卸貨區有貨車停著（${docks} 輛）`);
  assert(thruB === 0 && thruC === 0, `從車位開到路上不穿過建物 / 其他車位（穿過建物 ${thruB}、車位 ${thruC}）${[...new Set(bad)].slice(0, 6).join('、')}`);
}
// 停車：住宅一開始有車停在家，車輛出發後停車數減少、回來後增加
{
  const hs = g.city.buildings.filter(b => b.zone === 'R' && g.city.slotsOf(b).length);
  const tot = hs.reduce((a, b) => a + g.city.parkedCount(b), 0);
  assert(hs.length && tot > 0 && hs.every(b => b.slotRes.every((r, i) => !(r && b.slotOcc[i]))), `停車位：${tot} 輛停在 ${hs.length} 戶，沒有車位同時被佔用又被預約`);
}
const st = g.city.stats;
console.log(`     20 遊戲小時耗時 ${Date.now() - t0} ms，最多 ${maxVeh} 輛車；成功 ${st.trips}、失敗 ${st.fails}、過境 ${st.through}；人口 ${g.city.pop}`);
assert(st.trips > 300, '大量行程完成');
assert(st.fails < st.trips * 0.2, '失敗率低於 20%');
assert(st.through > 0, '過境車流');

// 圓環
const rbNode = [...g.net.nodes.values()].find(n => n.segs.length === 4 && n.control === 'auto' && n.level === 0 &&
  g.net.planRoundabout(n.x, n.y, 20, n.id).ok);
if (rbNode) {
  g.net.executeRoundabout(g.net.planRoundabout(rbNode.x, rbNode.y, 20, rbNode.id));
  assert(g.net.nodes.has(rbNode.id) === false, '圓環取代路口');
  step(g, 1200);
  assert([...g.net.segs.values()].some(s => s.ring), '圓環路段存在');
}

// 升級、反轉、拆除
const inner = [...g.net.segs.values()].find(s => s.type === 'street' && !s.ring && !g.net.nodes.get(s.a).outside && !g.net.nodes.get(s.b).outside);
const up = g.net.replaceSegment(inner, 'avenue'); g.net.rebuild();
assert(g.net.segs.has(up.id) && !g.net.segs.has(inner.id), '道路升級');
step(g, 300);
assert(g.net.bulldoze(up) === null, '拆除道路');
step(g, 300);
const outsideSeg = [...g.net.segs.values()].find(s => g.net.nodes.get(s.a).outside || g.net.nodes.get(s.b).outside);
assert(g.net.bulldoze(outsideSeg) !== null, '外部連線不可拆除');

// 高架跨越：與地面道路交叉但不相連
const s = [...g.net.segs.values()].find(x => x.type === 'avenue' && x.len > 80 && !x.ring);
const mid = { x: (s.pts[0].x + s.pts[s.pts.length - 1].x) / 2, y: (s.pts[0].y + s.pts[s.pts.length - 1].y) / 2 };
const dx = s.pts[s.pts.length - 1].y - s.pts[0].y, dy = -(s.pts[s.pts.length - 1].x - s.pts[0].x), L = Math.hypot(dx, dy);
const a = { x: mid.x + dx / L * 70, y: mid.y + dy / L * 70 }, b = { x: mid.x - dx / L * 70, y: mid.y - dy / L * 70 };
const nodesBefore = g.net.nodes.size;
const pOver = g.net.planRoad(a, b, null, 'highway', 1);
if (pOver.ok) {
  g.net.executeRoad(pOver);
  assert(g.net.nodes.size === nodesBefore + 2, '高架橋跨越不產生路口');
} else console.log('     (略過高架測試：' + pOver.reason + ')');
const pBad = g.net.planRoad(a, b, null, 'street', 0);
assert(!pBad.ok || pBad.crossings.length >= 1, '地面道路與高架衝突時拒絕 / 或與既有道路正常相交：' + (pBad.reason || 'ok'));

// 存讀檔
const data = JSON.parse(JSON.stringify({ net: g.net.serialize(), city: g.city.serialize() }));
const g2 = makeGame(12345, 'temperate', 'easy', false);
g2.net.load(data.net); g2.city.load(data.city);
assert(g2.net.segs.size === g.net.segs.size, '存讀檔：道路');
assert(g2.city.buildings.length === g.city.buildings.length, '存讀檔：建築');
step(g2, 600);
assert(g2.traffic.vehicles.length > 0, '讀檔後車流恢復');

// 苜蓿葉交流道：12 種行向都要能完成，左轉走環道、右轉走外側匝道
{
  const gc = makeGame(1, 'desert', 'sandbox'); gc.autoGrow = false;
  const net = gc.net;
  const S = p => { const n = net.nodeNear(p.x, p.y, 3); if (n) return { x: n.x, y: n.y, node: n.id }; const sg = net.segNear(p.x, p.y, 3, 'any'); if (sg) return { x: sg.x, y: sg.y, seg: sg.seg.id, u: sg.u }; return { x: p.x, y: p.y }; };
  const C = { x: 700, y: 1200 };
  const W = (x, y) => ({ x: C.x - y, y: C.y + x });
  let built = true;
  const B = (a, b, t, lv, c) => { const p = net.planRoad(S(W(...a)), S(W(...b)), c ? W(...c) : null, t, lv); if (p.ok) net.executeRoad(p); else built = false; };
  B([-430, 0], [430, 0], 'highway', 1); B([0, -360], [0, 360], 'avenue', 0);
  for (const k of [1, -1]) {
    const P = (x, y) => [x * k, y * k];
    B(P(30, 0), P(90, 30), 'ramp', 1, P(65, 3)); B(P(90, 30), P(150, 90), 'ramp', 1, P(150, 30)); B(P(150, 90), P(90, 150), 'ramp', 0, P(150, 150));
    B(P(90, 150), P(30, 90), 'ramp', 0, P(30, 150)); B(P(30, 90), P(0, 40), 'ramp', 0, P(30, 55));
    B(P(0, 330), P(210, 130), 'ramp', 0, P(10, 220)); B(P(210, 130), P(340, 0), 'ramp', 1, P(290, 50));
    B(P(0, -40), P(30, -90), 'ramp', 0, P(30, -55)); B(P(30, -90), P(90, -150), 'ramp', 0, P(30, -150)); B(P(90, -150), P(150, -90), 'ramp', 1, P(150, -150));
    B(P(150, -90), P(90, -30), 'ramp', 1, P(150, -30)); B(P(90, -30), P(60, 0), 'ramp', 1, P(70, -3));
    B(P(310, 0), P(210, -130), 'ramp', 0, P(290, -50)); B(P(210, -130), P(0, -330), 'ramp', 0, P(10, -220));
  }
  assert(built, '苜蓿葉交流道建造');
  const ep = (lx, ly, name) => { const p = W(lx, ly); const sg = net.segNear(p.x, p.y, 3, 'any'); return { name, seg: sg.seg.id, u: sg.u, outside: true, queue: [], spawnCD: 0 }; };
  const E = [ep(415, 0, 'FW+'), ep(-415, 0, 'FW-'), ep(0, 350, 'AV+'), ep(0, -350, 'AV-')];
  for (const a of E) for (const b of E) if (a !== b) for (let i = 0; i < 3; i++) a.queue.push({ kind: 'through', from: a, to: b, truck: false, od: a.name + '>' + b.name });
  let ok = 0, fail = 0, slow = 0;
  gc.city.onTripEnd = (t, s, age) => { s ? ok++ : fail++; if (age > 150) slow++; };
  for (let i = 0; i < 6000; i++) { gc.time += 0.05; gc.traffic.step(0.1); gc.city.spawnFrom(E, 0.1, 2); }
  assert(ok === 36 && fail === 0, `苜蓿葉交流道 12 種行向全部完成（${ok}/36）`);
  assert(slow === 0, '苜蓿葉交流道沒有異常繞路');
}

// 分區格子：一次拖曳依最大地塊切塊、深度上限、免費、有需求才發展、15×15 以上的商業可出現大型量販店、存讀檔
{
  // 找一段遠離市區、不跨水域的空地鋪一條直路（兩側各留 200 m 空間）
  let gz, net, c, S, y = 0, x0 = 0, p = null, seed = 0;
  const dry = (g, xx, yy) => { for (let x = xx; x <= xx + 800; x += 20) for (let d = -200; d <= 200; d += 20) if (g.terrain.isWater(x, yy + d)) return false; return true; };
  for (seed = 1; seed < 30 && !p; seed++) {
    gz = makeGame(seed, 'temperate', 'normal'); gz.autoGrow = false;
    net = gz.net; c = gz.city; S = gz.terrain.size / 2;
    for (const yy of [S + 500, S - 500, S + 800, S - 800]) for (const xx of [S - 1000, S - 400, S + 200]) {
      if (p || !dry(gz, xx, yy)) continue;
      const q = net.planRoad({ x: xx, y: yy }, { x: xx + 800, y: yy }, null, 'avenue', 0);
      if (q.ok && !q.crossings.length) { p = q; y = yy; x0 = xx; }
    }
  }
  net.executeRoad(p); net.rebuild();
  const seg = [...net.segs.values()].find(s => s.type === 'avenue' && Math.abs(s.pts[0].y - y) < 1 && s.len > 600);
  const money = gz.money;
  const r1 = c.planStroke('R1', seg, 1, seg.ra, seg.ra + 30 * 6, 20);
  assert(r1.length === 3 && r1.every(l => l.cols === 10 && l.rows <= 12), `低密度住宅：30 格切成 3 塊 10 格、深度不超過 12（${r1.map(l => l.cols + '×' + l.rows).join(' ')}）`);
  assert(c.planStroke('R1', seg, 1, seg.ra, seg.ra + 6, 5).length === 0 && c.planStroke('C', seg, 1, seg.ra, seg.ra + 12, 1).every(l => l.rows >= 2), '所有地塊最小 2×2 格');
  const r3 = c.planStroke('R3', seg, 1, seg.ra, seg.ra + 30 * 6, 30);
  assert(r3.length === 2 && r3.every(l => l.rows <= 24), `高密度住宅：最大 24×24（${r3.map(l => l.cols + '×' + l.rows).join(' ')}）`);
  for (const l of c.planStroke('C', seg, -1, seg.ra, seg.ra + 18 * 6, 16)) if (l.ok) c.addLot(l.zt, seg, l.u, l.side, l.cols, l.rows);
  for (const l of r1) if (l.ok) c.addLot(l.zt, seg, l.u, l.side, l.cols, l.rows);
  assert(gz.money === money, '劃設分區不用錢');
  assert(c.lots.length === 4, `空地塊（${c.lots.length}）`);
  const big = c.lots.find(l => l.zone === 'C');
  const kBig = new Set(), kSmall = new Set();
  for (let i = 0; i < 60; i++) { kBig.add(c.pickKind('C', 18, 16)); kSmall.add(c.pickKind('C', 14, 20)); }
  assert(big && (kBig.has('bigbox') || kBig.has('mall')), `15×15 以上的商業區可出現大型店（${[...kBig].join('、')}）`);
  assert(!kSmall.has('bigbox') && !kSmall.has('mall'), `小於 15×15 的商業區不會出現大型店（${[...kSmall].join('、')}）`);
  const ik = new Set(); for (let i = 0; i < 40; i++) ik.add(c.pickKind('I', 20, 20));
  assert(ik.size >= 3, `工業區功能隨機（${[...ik].join('、')}）`);
  const dz = JSON.parse(JSON.stringify({ net: net.serialize(), city: c.serialize() }));
  const g3 = makeGame(seed - 1, 'temperate', 'normal', false);
  g3.net.load(dz.net); g3.city.load(dz.city);
  assert(g3.city.lots.length === c.lots.length, '存讀檔：分區地塊');
  c.demand.R = 0.8; c.demand.C = 0.8;
  const before = c.buildings.length;
  c._comp = new Set(net.nodes.keys()); c._compVer = net.version;
  c.developLots();
  assert(c.buildings.length > before && c.lots.length < 4, `有需求時空地塊會發展成建築（${c.buildings.length - before} 棟）`);
  // 有停車場的商業：從路邊開一條場內道路進停車場
  {
    const xs = seg.pts[0].x + seg.ra + 300, sP = net.segNear(xs + 40, y, 3, 0).seg, uP = xs - sP.pts[0].x;
    const pp = c.planStroke('C', sP, -1, uP, uP + 12 * 6, 10).find(l => l.ok);
    const keep = c.pickKind; c.pickKind = () => 'parking';
    const pb = pp && c.develop(c.addLot('C', pp.seg, pp.u, pp.side, pp.cols, pp.rows));
    c.pickKind = keep;
    assert(pb && pb.roads && net.segs.get(pb.seg).type === 'service', '停車場有場內道路，顧客開進停車場');
  }
  // 工業園區：開出真正的廠區道路，進出點在園區內
  // 前面的商業地塊可能開了車道把路段切開，重新找出這個位置的路段
  const xs = seg.pts[0].x + seg.ra + 150, sI = net.segNear(xs + 40, y, 3, 0).seg, uI = xs - sI.pts[0].x;
  const ip = c.planStroke('I', sI, -1, uI, uI + 16 * 6, 16).find(l => l.ok);
  const ib = ip && c.develop(c.addLot('I', ip.seg, ip.u, ip.side, ip.cols, ip.rows));
  assert(ib && ib.roads && ib.roads.length >= 2 && ib.roads.includes(ib.seg), `工業園區內有道路（${ib && ib.roads ? ib.roads.length : 0} 段），出入點在園區內`);
  const dz2 = JSON.parse(JSON.stringify({ net: net.serialize(), city: c.serialize() }));
  const g4 = makeGame(seed - 1, 'temperate', 'normal', false);
  g4.net.load(dz2.net); g4.city.load(dz2.city);
  const ib2 = g4.city.buildings.find(b => b.zone === 'I' && b.cols === ib.cols && b.rows === ib.rows && Math.hypot(b.x - ib.x, b.y - ib.y) < 20);
  assert(ib2 && ib2.roads && Math.hypot(ib2.x - ib.x, ib2.y - ib.y) < 0.5, '存讀檔：園區道路與建築位置' + (ib2 ? ` ${!!ib2.roads} ${Math.round(ib2.x - ib.x)},${Math.round(ib2.y - ib.y)}` : ' 找不到建築'));
  c.removeBuilding(ib, false, true);
  assert(ib.roads === null && !net.segs.has(ib.seg), '拆除工業建築時一併拆除園區道路');
  const hb = c.buildings.find(b => b.zt === 'R1' && b.cols === 10 && b.rows === 12);
  assert(!hb || c.cap(hb) >= 20, `10×12 低密度住宅的住戶數（${hb && c.cap(hb)}）`);
}

// 兩條平行道路之間的停車場：場內道路打通到後方道路，但設閘門，一般車流不能當捷徑
{
  const gg = makeGame(1, 'temperate', 'normal'); gg.autoGrow = false;
  const net = gg.net, c = gg.city, S = gg.terrain.size / 2;
  let y = null;
  for (const yy of [S + 600, S - 600, S + 900, S - 900]) {
    const p1 = net.planRoad({ x: S - 400, y: yy }, { x: S + 400, y: yy }, null, 'street', 0);
    const p2 = net.planRoad({ x: S - 400, y: yy + 72 }, { x: S + 400, y: yy + 72 }, null, 'street', 0);
    if (p1.ok && p2.ok && !p1.crossings.length && !p2.crossings.length) { net.executeRoad(p1); net.executeRoad(p2); y = yy; break; }
  }
  net.executeRoad(net.planRoad({ x: S - 400, y }, { x: S - 400, y: y + 72 }, null, 'street', 0));
  net.rebuild();
  const seg = net.segNear(S, y, 3, 0).seg, u = S - seg.pts[0].x;
  const pl = c.planStroke('C', seg, 1, u - 36, u + 36, 11).find(l => l.ok);
  c.pickKind = () => 'parking';
  const pb = c.develop(c.addLot('C', pl.seg, pl.u, pl.side, pl.cols, pl.rows));
  const ref = sn => ({ id: 'x' + sn.seg.id, seg: sn.seg.id, u: sn.u });
  const A = ref(net.segNear(S + 300, y, 3, 0)), B = ref(net.segNear(S + 300, y + 72, 3, 0));
  assert(pb.gates && pb.gates.length >= 2, `停車場打通到後方道路，前後都設閘門（${pb.gates ? pb.gates.length : 0} 個）`);
  assert(!routeFromPoint(net, A, B).path.some(k => net.links.get(k).seg.T.internal), '一般車流不會穿過有閘門的停車場');
  assert(routeFromPoint(net, pb, B).path.some(k => net.links.get(k).seg.T.internal), '停車場的車可以從後方閘門出去');
  // 停車場蓋好之後才在後方開路：下一步會自動打通並加上閘門
  {
    const s2 = net.segNear(S - 250, y, 3, 0).seg, u2 = S - 250 - s2.pts[0].x;
    const pl2 = c.planStroke('C', s2, -1, u2 - 30, u2 + 30, 10).find(l => l.ok);
    const pb2 = c.develop(c.addLot('C', pl2.seg, pl2.u, pl2.side, pl2.cols, pl2.rows));
    const before = (pb2.gates || []).length;
    const back = pl2.rows * 6 + 4.3 + 1.5 + 1.5 + 4.3;
    const yb = y - back;
    const pr = net.planRoad({ x: S - 330, y: yb }, { x: S - 170, y: yb }, null, 'street', 0);
    if (pr.ok) { net.executeRoad(pr); net.rebuild(); c.update(0.1); }
    assert(pr.ok && before === 0 && pb2.gates && pb2.gates.length >= 2, `之後新增的後方道路會接上停車場並設閘門（${pr.ok ? (pb2.gates || []).length + ' 個閘門' : pr.reason}）`);
  }
  c.pickKind = () => 'parking';
  const segGo = net.segs.get(pl.seg.id) ? null : [...net.segs.values()].find(s => s.type === 'street' && Math.abs(s.pts[0].y - y) < 1 && s.go);
  assert(segGo && Math.abs(((c.gridStart(segGo) + segGo.go) / 6) - Math.round((c.gridStart(segGo) + segGo.go) / 6)) < 1e-6, '路段被切開後分區格線仍然對齊');
}

for (const b of ['desert', 'snow', 'tropical']) {
  const gb = makeGame(777, b, 'normal');
  assert(gb.net.segs.size > 3 && gb.city.buildings.length > 3, `生態系 ${b}（${gb.city.outside.length} 個外部連線）`);
}
// 大眾運輸：在小鎮劃一塊公車總站，公車要開出來、繞站並載到乘客
{
  const gt = makeGame(12345, 'temperate', 'easy', true);
  connectOutside(gt);
  const C = gt.city, net = gt.net, c0 = gt.terrain.size / 2;
  const segs = [...net.segs.values()].filter(s => s.T.access && !s.T.internal && s.len > 120).sort((a, b) => Math.hypot(a.pts[0].x - c0, a.pts[0].y - c0) - Math.hypot(b.pts[0].x - c0, b.pts[0].y - c0));
  for (const s of segs) {
    for (const side of [1, -1]) { const g0 = C.gridStart(s); const p = C.planStroke('T', s, side, g0, g0 + 60, 8).find(p => p.ok && p.rows >= 5); if (p) { C.addLot('T', s, p.u, side, p.cols, p.rows); break; } }
    if (C.lots.some(l => l.zone === 'T')) break;
  }
  step(gt, 400);
  const dep = C.buildings.find(b => b.zone === 'T');
  assert(dep && C.truckSlotsOf(dep).length >= 2, `公車總站蓋好並有公車停車格（${dep ? C.truckSlotsOf(dep).length : 0} 格）`);
  let maxRun = 0;
  for (let h = 0; h < 36; h++) { step(gt, 150); maxRun = Math.max(maxRun, gt.traffic.vehicles.filter(v => v.bus).length); }
  assert(gt.transit.lines.length >= 1 && gt.transit.lines.every(l => l.stops.length >= 2), `自動規劃公車路線（${gt.transit.lines.map(l => l.name + ' ' + l.stops.length + ' 站').join('、')}）`);
  assert(maxRun >= 1 && gt.transit.stats.riders > 0, `公車開出並載到乘客（最多 ${maxRun} 輛，累計 ${gt.transit.stats.riders} 人）`);
}

// 依人口解鎖：開局只有低密度、商業、工業（最大 12×12），人口越多解鎖越多
{
  const { zoneMax } = await import('../js/config.js');
  const gu = makeGame(4321, 'temperate', 'normal', true);
  const C = gu.city;
  C.peakPop = 0;
  const s = [...gu.net.segs.values()].filter(x => x.T.access && !x.T.internal && x.len > 200).sort((a, b) => b.len - a.len)[0];
  const g0 = C.gridStart(s);
  const plan = (zt, n) => C.planStroke(zt, s, 1, g0, g0 + n * 6, n).filter(p => p.ok);
  const c0 = plan('C', 30), r2 = plan('R2', 10), t0 = plan('T', 10);
  assert(c0.length && c0.every(p => p.cols <= 12 && p.rows <= 12) && !r2.length && !t0.length, `開局：商業最大 12 格（${c0.map(p => p.cols + '×' + p.rows).join('、')}），中密度與公車總站未解鎖`);
  C.peakPop = 2600;
  assert(C.maxCells('C') === 18 && C.maxCells('R2') === 18 && C.maxCells('R3') === 0 && C.maxCells('T') === 16 && C.maxCells('I') === 12, '人口 2500：商業與中密度 18 格、公車總站 16 格，高密度未解鎖');
  C.peakPop = 5200;
  assert(zoneMax('C', 5200) === 30 && C.maxCells('R3') === 24 && C.maxCells('I') === 32, '人口 5000：商業 30 格、高密度 24 格、工業 32 格');
  C.peakPop = 100; C.recount();
  const kinds = new Set(); for (let i = 0; i < 200; i++) kinds.add(C.pickKind('I', 10, 10));
  C.peakPop = 3100;
  const kinds2 = new Set(); for (let i = 0; i < 400; i++) kinds2.add(C.pickKind('I', 10, 10));
  assert(!kinds.has('semi') && !kinds.has('battery') && kinds2.has('semi') && kinds2.has('battery'), `高科技工廠人口 3000 才出現（${[...kinds2].join('、')}）`);
}

// 空白地圖開局：只有外部連線，沒有分區與建築
{
  const gb = makeGame(4321, 'temperate', 'sandbox', false);
  const { generateWorld } = await import('../js/worldgen.js');
  generateWorld(gb, { blank: true });
  assert(gb.city.outside.length >= 2 && !gb.city.lots.length && !gb.city.buildings.length, `空白地圖開局（${gb.city.outside.length} 個外部連線、${gb.city.lots.length} 塊分區）`);
}

if (failed) { console.error(`${failed} 項失敗`); process.exit(1); }
console.log('全部通過');

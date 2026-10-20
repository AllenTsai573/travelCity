// 無頭模擬測試：node tests/sim.test.js
import { Network } from '../js/network.js';
import { Traffic } from '../js/traffic.js';
import { City } from '../js/city.js';
import { makeGame, step, connectOutside } from './harness.js';

let failed = 0;
function assert(c, m) { if (!c) { console.error('FAIL -', m); failed++; } else console.log('ok   -', m); }

const g = makeGame(12345, 'temperate', 'easy');
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

let maxVeh = 0;
const t0 = Date.now();
for (let h = 0; h < 20; h++) {
  step(g, 1200);
  maxVeh = Math.max(maxVeh, g.traffic.vehicles.length);
  for (const v of g.traffic.vehicles) {
    if (v.dead) throw new Error('dead vehicle in list');
    if (!v.track.vehs.includes(v)) throw new Error('vehicle not on its track ' + v.id);
    if (v.s < -1 || v.s > v.track.len + 1) throw new Error(`bad s ${v.s} / ${v.track.len}`);
    if (Number.isNaN(v.v) || Number.isNaN(v.s)) throw new Error('NaN');
  }
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
assert(!pBad.ok, '地面道路與高架衝突時拒絕 / 或與既有道路正常相交：' + (pBad.reason || 'ok'));

// 存讀檔
const data = JSON.parse(JSON.stringify({ net: g.net.serialize(), city: g.city.serialize() }));
const g2 = makeGame(12345, 'temperate', 'easy', false);
g2.net.load(data.net); g2.city.load(data.city);
assert(g2.net.segs.size === g.net.segs.size, '存讀檔：道路');
assert(g2.city.buildings.length === g.city.buildings.length, '存讀檔：建築');
step(g2, 600);
assert(g2.traffic.vehicles.length > 0, '讀檔後車流恢復');

for (const b of ['desert', 'snow', 'tropical']) {
  const gb = makeGame(777, b, 'normal');
  assert(gb.net.segs.size > 3 && gb.city.buildings.length > 3, `生態系 ${b}（${gb.city.outside.length} 個外部連線）`);
}
if (failed) { console.error(`${failed} 項失敗`); process.exit(1); }
console.log('全部通過');

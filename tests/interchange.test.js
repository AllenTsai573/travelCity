// 交流道模板測試：node tests/interchange.test.js
// 在空曠處以自由放置建造每種交流道，並讓 12 種行向的車流全部通過
import { makeGame } from './harness.js';
import { TEMPLATES, TEMPLATE_ORDER, placeInterchange } from '../js/interchange.js';
import { Terrain } from '../js/terrain.js';

let failed = 0;
function assert(c, m) { if (!c) { console.error('FAIL -', m); failed++; } else console.log('ok   -', m); }

// 找一塊夠大的乾地（遠離市中心）
function findSite(half) {
  for (let seed = 1; seed < 200; seed++) {
    const t = new Terrain(seed, 'desert', 2400);
    for (const c of [{ x: 640, y: 640 }, { x: 1760, y: 640 }, { x: 640, y: 1760 }, { x: 1760, y: 1760 }]) {
      let wet = false;
      for (let dx = -half; dx <= half && !wet; dx += 20) for (let dy = -half; dy <= half && !wet; dy += 20) if (t.isWater(c.x + dx, c.y + dy)) wet = true;
      if (!wet) return { seed, c };
    }
  }
  return null;
}

const only = process.argv[2];
for (const key of TEMPLATE_ORDER) {
  if (only && key !== only) continue;
  const t = TEMPLATES[key];
  const site = findSite(Math.max(t.L, t.Lc) + 20);
  if (!site) { assert(false, `${t.name}：找不到建地`); continue; }
  const g = makeGame(site.seed, 'desert', 'sandbox'); g.autoGrow = false;
  const fr = { ok: true, x: site.c.x, y: site.c.y, ux: 1, uy: 0, M: t.M, C: t.C, snap: false };
  const t0 = Date.now();
  const r = placeInterchange(g, key, fr);
  assert(r.ok, `${t.name}：建造（${r.ok ? '$' + r.cost.toLocaleString() : r.reason}${r.at ? ' @' + Math.round(r.at.x - fr.x) + ',' + Math.round(r.at.y - fr.y) : ''}）${Date.now() - t0}ms`);
  if (!r.ok) continue;
  const net = g.net;
  const ep = (lx, ly, name, lv) => { const s = net.segNear(fr.x + lx, fr.y + ly, 4, lv); return s && { name, seg: s.seg.id, u: s.u, outside: true, queue: [], spawnCD: 0 }; };
  const E = [ep(t.L - 12, 0, 'M+', t.M), ep(-t.L + 12, 0, 'M-', t.M), ep(0, t.Lc - 12, 'C+', t.C), ep(0, -t.Lc + 12, 'C-', t.C)];
  if (E.some(e => !e)) { assert(false, `${t.name}：找不到端點`); continue; }
  for (const a of E) for (const b of E) if (a !== b) for (let i = 0; i < 3; i++) a.queue.push({ kind: 'through', from: a, to: b, truck: false, od: a.name + '>' + b.name });
  const res = {};
  g.city.onTripEnd = (tp, ok, age) => { const x = res[tp.od] = res[tp.od] || { ok: 0, fail: 0, max: 0 }; ok ? x.ok++ : x.fail++; x.max = Math.max(x.max, age); };
  const rampSegs = [...net.segs.values()].filter(sg => sg.type === 'ramp' || sg.type === 'oneway2').length;
  let uTurns = 0;
  for (let i = 0; i < 9000; i++) {
    g.time += 0.05; g.traffic.step(0.1); g.city.spawnFrom(E, 0.1, 2.5);
    for (const v of g.traffic.vehicles) if (v.track.kind === 'conn' && v.track.turn === 'U' && !v._u) { v._u = true; uTurns++; }
  }
  console.log(`     匝道路段 ${rampSegs}，迴轉 ${uTurns} 次`);
  assert(uTurns === 0, `${t.name}：沒有車輛靠死路迴轉繞行`);
  const bad = Object.entries(res).filter(([, x]) => x.ok < 3);
  const slow = Object.entries(res).filter(([, x]) => x.max > 200).map(([k, x]) => k + ':' + Math.round(x.max) + 's');
  const okN = Object.values(res).reduce((s, x) => s + x.ok, 0);
  assert(okN === 36, `${t.name}：12 種行向完成 ${okN}/36${bad.length ? '（未完成：' + bad.map(([k, x]) => k + ' ' + x.ok + '/3').join(', ') + '）' : ''}`);
  assert(!slow.length, `${t.name}：無異常繞路${slow.length ? '（' + slow.join(', ') + '）' : ''}`);
}
if (failed) { console.error(`${failed} 項失敗`); process.exit(1); }
console.log('全部通過');

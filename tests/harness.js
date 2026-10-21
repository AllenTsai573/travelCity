// 測試用：不依賴 DOM 的遊戲物件
import { SIM_DT, CLOCK, MAP_SIZE, DIFFICULTY } from '../js/config.js';
import { RNG } from '../js/util.js';
import { Terrain } from '../js/terrain.js';
import { Network } from '../js/network.js';
import { Traffic } from '../js/traffic.js';
import { City } from '../js/city.js';
import { generateWorld, snapAt } from '../js/worldgen.js';

export function makeGame(seed, biome, diff, gen = true, size = MAP_SIZE) {
  const g = {
    seed, biomeKey: biome, diffKey: diff, diff: DIFFICULTY[diff], rng: new RNG(seed * 7 + 13),
    time: 360, money: DIFFICULTY[diff].money, milestone: 0, autoGrow: true, msgs: [],
    canAfford(c) { return this.diff.unlockAll || this.money >= c; },
    spend(c) { if (!this.diff.unlockAll) this.money -= c; },
    earn(x, toll) { if (this.diff.unlockAll) return; this.money += x; if (toll) this.city.stats.hourIncome += x; },
    notify(m) { this.msgs.push(m); },
    checkMilestone() {},
  };
  g.terrain = new Terrain(seed, biome, size);
  g.net = new Network(g);
  g.city = new City(g);
  g.traffic = new Traffic(g);
  if (gen) generateWorld(g);
  return g;
}

export function step(g, n) {
  for (let i = 0; i < n; i++) {
    g.time += SIM_DT * CLOCK;
    g.traffic.step(SIM_DT);
    g.city.update(SIM_DT * CLOCK);
  }
}

// 以大道把每個外部連線接到市中心
export function connectOutside(g, type = 'avenue') {
  const c = g.terrain.size / 2, res = [];
  // 已經與市中心相連的（例如開局就接好的高速公路）不用再接
  const centerNode = g.net.nodeNear(c, c, 400) || [...g.net.nodes.values()].reduce((a, n) => (!a || Math.hypot(n.x - c, n.y - c) < Math.hypot(a.x - c, a.y - c) ? n : a), null);
  const reach = new Set([centerNode.id]), st = [centerNode.id];
  while (st.length) { const n = g.net.nodes.get(st.pop()); for (const sid of n.segs) { const s = g.net.segs.get(sid); for (const o of [s.a, s.b]) if (!reach.has(o)) { reach.add(o); st.push(o); } } }
  for (const o of g.city.outside) {
    if (reach.has(o.node)) { res.push(true); continue; }
    const n = g.net.nodes.get(o.node);
    const s0 = g.net.segs.get(n.segs[0]);
    const inner = g.net.nodes.get(s0.a === n.id ? s0.b : s0.a);
    let built = false;
    for (const lv of [0, 1]) {
      const mid = { x: (inner.x + c) / 2, y: (inner.y + c) / 2 };
      const p1 = g.net.planRoad({ x: inner.x, y: inner.y, node: inner.id }, { x: mid.x, y: mid.y }, null, type, lv);
      if (!p1.ok) continue;
      const m = g.net.executeRoad(p1);
      // 接到市中心；不行就接到最近的、已與市中心相連的路口
      // 只接一般道路的路口：場內道路（巷道、停車場車道）只給進出該建築的車使用，接上去也無法通行
      const pub = n => n && n.level === 0 && n.segs.some(id => !g.net.segs.get(id).T.internal);
      const targets = [snapAt(g.net, { x: c, y: c }), ...[...reach].map(id => g.net.nodes.get(id)).filter(pub)
        .sort((p, q) => Math.hypot(p.x - m.x, p.y - m.y) - Math.hypot(q.x - m.x, q.y - m.y)).slice(0, 6).map(n => ({ x: n.x, y: n.y, node: n.id }))];
      const p2 = targets.map(t => g.net.planRoad({ x: m.x, y: m.y, node: m.id }, t, null, type, lv)).find(p => p.ok);
      if (!p2) continue;
      g.net.executeRoad(p2);
      built = true; break;
    }
    res.push(built);
  }
  return res;
}

// 初始世界：外部連線（地圖邊緣）與市中心的小聚落
import { RNG } from './util.js';

export function snapAt(net, p) {
  const n = net.nodeNear(p.x, p.y, 3);
  if (n) return { x: n.x, y: n.y, node: n.id };
  const s = net.segNear(p.x, p.y, 2, 0);
  if (s) return { x: s.x, y: s.y, seg: s.seg.id, u: s.u };
  return { x: p.x, y: p.y };
}

export function generateWorld(g) {
  const net = g.net, T = g.terrain, S = T.size, c = S / 2;
  const rng = new RNG(g.seed + 77);
  const savedMoney = g.money;
  g.money = 1e12;

  // 外部連線
  const sides = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) { const j = rng.int(0, i); [sides[i], sides[j]] = [sides[j], sides[i]]; }
  const names = ['北方', '東方', '南方', '西方'];
  const want = g.diffKey === 'hard' ? 4 : 3;
  let made = 0;
  for (const side of sides) {
    if (made >= want) break;
    for (let tries = 0; tries < 80; tries++) {
      const t = rng.range(0.2, 0.8) * S;
      const P = [{ x: t, y: 4 }, { x: S - 4, y: t }, { x: t, y: S - 4 }, { x: 4, y: t }][side];
      const D = [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }][side];
      let ok = true;
      for (let k = 0; k <= 175 && ok; k += 5) if (T.isWater(P.x + D.x * k, P.y + D.y * k)) ok = false;
      if (!ok) continue;
      const type = made < 2 ? 'highway' : 'avenue';
      const O = net.addNode(P.x, P.y, 0);
      const I = net.addNode(P.x + D.x * 160, P.y + D.y * 160, 0);
      net.addSegment(O, I, type, [O, I]);
      g.city.addOutside(O, names[side] + (type === 'highway' ? '高速公路' : '聯外道路'));
      T.clearTreesAlong([O, I], 16);
      made++;
      break;
    }
  }
  net.rebuild();

  // 市中心小鎮
  const ang = rng.range(-0.35, 0.35);
  const u = { x: Math.cos(ang), y: Math.sin(ang) }, v = { x: -Math.sin(ang), y: Math.cos(ang) };
  const P = (a, b) => ({ x: c + u.x * a + v.x * b, y: c + u.y * a + v.y * b });
  const road = (p, q, type) => {
    const plan = net.planRoad(snapAt(net, p), snapAt(net, q), null, type, 0);
    if (plan.ok) net.executeRoad(plan);
  };
  road(P(-240, 0), P(240, 0), 'avenue');
  road(P(0, -170), P(0, 170), 'street');
  road(P(-150, 95), P(140, 95), 'street');
  road(P(-130, -95), P(140, -95), 'street');
  road(P(140, -95), P(140, 95), 'street');
  road(P(-150, 95), P(-150, 170), 'dirt');

  // 初始建築
  const city = g.city;
  const segs = () => [...net.segs.values()].filter(s => s.T.access && s.drawLevel === 0 && s.len > 30 && Math.hypot((s.bbox.x0 + s.bbox.x1) / 2 - c, (s.bbox.y0 + s.bbox.y1) / 2 - c) < 400);
  const place = (zone, count) => {
    let n = 0;
    for (let tries = 0; tries < 300 && n < count; tries++) {
      const list = segs();
      if (!list.length) return;
      const s = rng.pick(list);
      const uu = rng.range(0, s.len), side = rng.chance(0.5) ? 1 : -1;
      if (city.canPlace(zone, s, uu, side)) continue;
      const geo = city.lotGeom(zone, s, uu, side);
      if (zone === 'I' && city.buildings.some(b => b.zone === 'R' && Math.hypot(b.x - geo.x, b.y - geo.y) < 110)) continue;
      if (zone === 'R' && city.buildings.some(b => b.zone === 'I' && Math.hypot(b.x - geo.x, b.y - geo.y) < 140)) continue;
      city.addBuilding(zone, s, uu, side);
      n++;
    }
  };
  place('I', 1);
  place('C', 3);
  place('R', 12);
  city.recount();
  g.money = savedMoney;
}

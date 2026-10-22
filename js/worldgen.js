// 初始世界：外部連線（地圖邊緣）與市中心的小聚落
import { RNG } from './util.js';
import { CELL, SEP_RI } from './config.js';

export function snapAt(net, p) {
  const n = net.nodeNear(p.x, p.y, 3);
  if (n) return { x: n.x, y: n.y, node: n.id };
  const s = net.segNear(p.x, p.y, 2, 0);
  if (s) return { x: s.x, y: s.y, seg: s.seg.id, u: s.u };
  return { x: p.x, y: p.y };
}

// opts.empty：初始分區只劃好、先不蓋建築（遊戲開局用；測試沿用直接蓋好的小鎮）
// opts.blank：空白地圖，只有外部連線（沒有小鎮與分區）
export function generateWorld(g, opts = {}) {
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
      // 外部連線只有高速公路（沒有一般的聯外道路）
      const type = 'highway';
      const O = net.addNode(P.x, P.y, 0);
      const I = net.addNode(P.x + D.x * 160, P.y + D.y * 160, 0);
      net.addSegment(O, I, type, [O, I]);
      g.city.addOutside(O, names[side] + (type === 'highway' ? '高速公路' : '聯外道路'));
      T.clearTreesAlong([O, I], 16);
      made++;
      break;
    }
  }
  // 外部鐵路：從還沒有道路的一側（沒有就隨便一側）進入地圖
  const railSides = [...sides.filter(sd => !g.city.outside.some(o => o.name.startsWith(names[sd]))), ...sides];
  let railIn = null;
  for (const side of railSides) {
    for (let tries = 0; tries < 60 && !railIn; tries++) {
      const t = rng.range(0.25, 0.75) * S;
      const P = [{ x: t, y: 4 }, { x: S - 4, y: t }, { x: t, y: S - 4 }, { x: 4, y: t }][side];
      const D = [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }][side];
      let ok = true;
      for (let k = 0; k <= 200 && ok; k += 5) if (T.isWater(P.x + D.x * k, P.y + D.y * k)) ok = false;
      if (!ok || g.city.outside.some(o => { const n = net.nodes.get(o.node); return Math.hypot(n.x - P.x, n.y - P.y) < 300; })) continue;
      const O = net.addNode(P.x, P.y, 0), I = net.addNode(P.x + D.x * 180, P.y + D.y * 180, 0);
      net.addSegment(O, I, 'rail', [O, I]);
      g.city.addRailOutside(O, names[side] + '鐵路');
      T.clearTreesAlong([O, I], 12);
      railIn = I;
    }
    if (railIn) break;
  }
  net.rebuild();
  if (opts.blank) { g.money = savedMoney; return; }

  // 市中心小鎮：棋盤狀街道。中央大道十字交叉、外圈一圈大道，其餘為街道；
  // 街廓 240 × 180 m，夠深的一側可以劃到 24 格（144 m）的高密度分區
  const ang = rng.range(-0.35, 0.35);
  const u = { x: Math.cos(ang), y: Math.sin(ang) }, v = { x: -Math.sin(ang), y: Math.cos(ang) };
  const P = (a, b) => ({ x: c + u.x * a + v.x * b, y: c + u.y * a + v.y * b });
  const road = (p, q, type) => {
    const plan = net.planRoad(snapAt(net, p), snapAt(net, q), null, type, 0);
    if (plan.ok) net.executeRoad(plan);
    return plan.ok;
  };
  // 一條街分成數段（每個街廓一段）鋪，碰到水域時只有那一段失敗，其餘仍然相連
  const street = (pts, type) => { for (let i = 0; i + 1 < pts.length; i++) road(pts[i], pts[i + 1], type); };
  const xs = [-720, -480, -240, 0, 240, 480, 720], ys = [-540, -360, -180, 0, 180, 360, 540];
  const avX = new Set([0, -480, 480]), avY = new Set([0, -360, 360]);
  for (const a of xs) street(ys.map(b => P(a, b)), avX.has(a) ? 'avenue' : 'street');
  for (const b of ys) street(xs.map(a => P(a, b)), avY.has(b) ? 'avenue' : 'street');
  net.rebuild();

  // 外部鐵路延伸到小鎮外圍（停在街道外面，不跟街道平面相交），玩家可以在旁邊蓋車站
  if (railIn) {
    const dx = c - railIn.x, dy = c - railIn.y, L = Math.hypot(dx, dy);
    for (const stop of [950, 1100, 1300]) {
      if (L <= stop + 50) break;
      const q = { x: railIn.x + dx / L * (L - stop), y: railIn.y + dy / L * (L - stop) };
      const plan = net.planRoad({ x: railIn.x, y: railIn.y, node: railIn.id }, q, null, 'rail', 0);
      if (plan.ok && !plan.crossings.length) { net.executeRoad(plan); break; }
    }
    net.rebuild();
  }

  // 小鎮最大的連通區
  const comp = new Map();
  let best = null;
  for (const id of net.nodes.keys()) {
    if (comp.has(id)) continue;
    const set = [id], st = [id];
    comp.set(id, set);
    while (st.length) { const n = net.nodes.get(st.pop()); for (const sid of n.segs) { const sg = net.segs.get(sid); for (const o of [sg.a, sg.b]) if (!comp.has(o)) { comp.set(o, set); set.push(o); st.push(o); } } }
    if (!best || set.length > best.length) best = set;
  }
  const town = best.map(id => net.nodes.get(id)).filter(n => n.level === 0 && !n.outside);

  // 接上一條外部高速公路：接到小鎮的大道（優先接大道的端點，高速公路車流直接延續到大道上，不會灌進小街造成塞車）；
  // 直線過不去就試著繞（兩段都可行才鋪）
  const aveCount = n => n.segs.filter(id => net.segs.get(id).type === 'avenue').length;
  // 高速公路接進小鎮的那條市區道路（從接點沿高速公路方向一路直走）改為林蔭大道（3+3）：
  // 與高速公路車道數相同，車流進市區時不會因為少一條車道而回堵
  const boulevardFrom = (e, prev) => {
    const ids = [];
    let n = e, dx = e.x - prev.x, dy = e.y - prev.y, L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    for (let k = 0; k < 40; k++) {
      // 第一段：接點上的大道（沒有大道才用其他道路）中最順著高速公路方向的；之後沿同一直線往前
      let best = null, bd = k ? 0.85 : -Infinity;
      for (const id of n.segs) {
        const sg = net.segs.get(id);
        if (ids.includes(id) || sg.type === 'highway' || sg.T.internal || !sg.T.access) continue;
        const o = net.nodes.get(sg.a === n.id ? sg.b : sg.a), ox = o.x - n.x, oy = o.y - n.y, ol = Math.hypot(ox, oy) || 1;
        const dot = (ox * dx + oy * dy) / ol + (!k && sg.type === 'avenue' ? 10 : 0);
        if (dot > bd) { bd = dot; best = { id, o, ox: ox / ol, oy: oy / ol }; }
      }
      if (!best) break;
      ids.push(best.id); n = best.o; dx = best.ox; dy = best.oy;
    }
    for (const id of ids) { const sg = net.segs.get(id); if (sg) net.replaceSegment(sg, 'boulevard'); }
    net.rebuild();
  };
  for (const o of g.city.outside) {
    const on = net.nodes.get(o.node), s0 = on && net.segs.get(on.segs[0]);
    if (!s0 || s0.type !== 'highway') continue;
    const inner = net.nodes.get(s0.a === on.id ? s0.b : s0.a);
    const near = list => list.sort((p, q) => Math.hypot(p.x - inner.x, p.y - inner.y) - Math.hypot(q.x - inner.x, q.y - inner.y));
    const ends = near(town.filter(n => aveCount(n) === 1)), mids = near(town.filter(n => aveCount(n) >= 2));
    const cands = [...ends.slice(0, 3), ...mids.slice(0, 3), ...near(town.filter(n => !aveCount(n))).slice(0, 2)];
    let ok = false;
    for (const e of cands) {
      const to = { x: e.x, y: e.y, node: e.id }, from = { x: inner.x, y: inner.y, node: inner.id };
      const direct = net.planRoad(from, to, null, 'highway', 0);
      if (direct.ok) { net.executeRoad(direct); ok = true; boulevardFrom(e, inner); break; }
      for (const off of [300, -300, 600, -600]) {
        const mx = (inner.x + e.x) / 2, my = (inner.y + e.y) / 2, L = Math.hypot(e.x - inner.x, e.y - inner.y) || 1;
        const w = { x: mx - (e.y - inner.y) / L * off, y: my + (e.x - inner.x) / L * off };
        const p1 = net.planRoad(from, w, null, 'highway', 0), p2 = net.planRoad(w, to, null, 'highway', 0);
        if (!p1.ok || !p2.ok) continue;
        const mid = net.executeRoad(p1);
        const p3 = net.planRoad({ x: mid.x, y: mid.y, node: mid.id }, to, null, 'highway', 0);
        if (p3.ok) { net.executeRoad(p3); ok = true; boulevardFrom(e, mid); }
        break;
      }
      if (ok) break;
    }
    if (ok) break;
  }
  net.rebuild();

  // 初始建築：較大的分區
  const city = g.city;
  const segs = () => [...net.segs.values()].filter(s => s.T.access && !s.T.internal && s.drawLevel === 0 && s.len > 40 && Math.hypot((s.bbox.x0 + s.bbox.x1) / 2 - c, (s.bbox.y0 + s.bbox.y1) / 2 - c) < 800);
  const place = (zt, count, size) => {
    let n = 0;
    for (let tries = 0; tries < 900 && n < count; tries++) {
      const list = segs();
      if (!list.length) return;
      const s = rng.pick(list);
      const { cols, rows } = size();
      const lo = city.gridStart(s) + cols * CELL / 2, hi = s.len - s.rb - cols * CELL / 2;
      if (hi <= lo) continue;
      const uu = lo + Math.floor(rng.next() * (hi - lo) / CELL) * CELL, side = rng.chance(0.5) ? 1 : -1;
      let r = rows;
      while (r >= 2 && city.canPlaceLot(s, uu, side, cols, r)) r--;
      if (r < Math.max(2, rows - 4)) continue;
      const geo = city.lotGeom(s, uu, side, cols, r);
      // 工業放在小鎮外圍，住宅與工業保持距離
      if (zt === 'I' && Math.hypot(geo.x - c, geo.y - c) < 450) continue;
      // 住宅與工業保持距離（建築或還沒蓋的分區都算）
      const placed = [...city.buildings, ...city.lots];
      if (zt === 'I' && placed.some(b => b.zone === 'R' && Math.hypot(b.x - geo.x, b.y - geo.y) < SEP_RI + geo.rad + b.rad)) continue;
      if (zt !== 'I' && zt !== 'C' && placed.some(b => b.zone === 'I' && Math.hypot(b.x - geo.x, b.y - geo.y) < SEP_RI + geo.rad + b.rad)) continue;
      const lot = city.addLot(zt, s, uu, side, cols, r);
      if (!opts.empty) city.develop(lot);
      n++;
    }
  };
  // 開局人口 0：只有低密度住宅、商業、工業，最大 12×12（中 / 高密度、大型商場要人口夠多才解鎖）
  place('I', 2, () => ({ cols: rng.int(10, 12), rows: rng.int(10, 12) }));
  place('C', 1, () => ({ cols: 12, rows: rng.int(10, 12) }));
  place('C', 4, () => ({ cols: rng.int(5, 8), rows: rng.int(5, 7) }));
  place('R1', 16, () => ({ cols: rng.int(4, 6) * 2, rows: rng.int(6, 10) }));
  city.recount();
  g.money = savedMoney;
}

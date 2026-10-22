// 完整城市路網開局：整張地圖先鋪好交通骨架（參考日本都市：高架的都市高速公路、林蔭大道的十字主軸、
// 外環大道、200 m 的棋盤街廓、東西向鐵路與車站），住宅 / 商業 / 工業交給自動發展
// - 高速公路（高架第 1 層）：一條東西向、一條南北向，交會處是渦輪型系統交流道；與林蔭大道 / 大道交會處有
//   服務型交流道（單點式 SPUI、鑽石型），地圖邊緣降回地面接外部連線
// - 地面道路都從高架下方穿過，只在交流道與高速公路相接
// - 依地形調整：高速公路、交流道、鐵路的位置在候選範圍內挑水域最少的；地面道路中段遇到水域改以高架橋跨越
// - 幹道與街道依交流道實際的位置排列：林蔭大道 / 大道就是交流道的橫交道路，街道每 200 m 一條（離幹道太近的省略）
// - 鐵路東西向橫貫地圖（兩端是外部鐵路），只在幹道與少數街道設平交道，鐵路兩側各有一條站前道路；分區只劃車站
import { placeInterchange } from './interchange.js';
import { SLOPE_LEN } from './config.js';
import { halfWidth } from './network.js';
import { polyBBox } from './util.js';

// 交流道佔地（沿主線、橫向的半寬，公尺）：範圍內不鋪其他地面道路
const FOOT = { turbine: [540, 540], windmill: [460, 460], spui: [330, 320], diamond: [330, 320] };
// 交流道主線、橫交道路的半長（模板的 L、Lc）
const HALF = { turbine: [500, 500], windmill: [420, 420], spui: [360, 300], diamond: [360, 300] };

export function generateCity(g) {
  const net = g.net;
  // 大量鋪路時每鋪一段就完整重算路網（車道、路口連接、衝突點）太慢（數百次 × 數十毫秒）：
  // 鋪路期間只更新規劃需要的外框，全部鋪完再完整重算一次；鋪路途中的單行道提示也先不顯示
  // 開局就有的鐵路車站不受人口解鎖限制
  const rebuild = net.rebuild, notify = g.notify, unlock = g.city.unlockPop;
  g.city.unlockPop = () => Infinity;
  net.rebuild = function () { for (const s of this.segs.values()) if (s._bbPts !== s.pts) { s.bbox = polyBBox(s.pts, halfWidth(s.T) + 2); s._bbPts = s.pts; } };
  g.notify = () => {};
  try { return buildCity(g, () => { net.rebuild = rebuild; net.rebuild(); }); } finally { net.rebuild = rebuild; g.notify = notify; g.city.unlockPop = unlock; net.rebuild(); }
}

function buildCity(g, fullRebuild) {
  const net = g.net, city = g.city, T = g.terrain, S = T.size;
  const savedMoney = g.money;
  g.money = 1e12;
  const log = { fail: 0, ok: 0, bridges: 0, ix: [] };
  const dbg = (...a) => { if (g.debugGen) console.log(...a); };
  const E = S - 4;   // 地圖邊緣（外部連線的位置）
  const C = S / 2;

  // ---------- 水域 ----------
  const wetLine = (x0, y0, x1, y1) => {
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L / 15));
    let w = 0;
    for (let i = 0; i <= n; i++) if (T.isWater(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) w++;
    return w / (n + 1);
  };
  // 交流道佔地範圍內的水域比例（主線方向 ux, uy）
  const wetFoot = (key, x, y, ux, uy) => {
    const [a, b] = FOOT[key];
    let w = 0, n = 0;
    for (let s = -a; s <= a; s += 30) for (let t = -b; t <= b; t += 30) { n++; if (T.isWater(x + ux * s - uy * t, y + uy * s + ux * t)) w++; }
    return w / n;
  };

  // ---------- 鋪路 ----------
  // 某高度上的接點：節點或路段（高度要相同），沒有就是空地上的點
  const snapL = (p, h) => {
    const n = net.nodeNear(p.x, p.y, 3, h);
    if (n) return { x: n.x, y: n.y, node: n.id };
    const s = net.segNear(p.x, p.y, 2.5, h);
    if (s && Math.abs(s.h - h) < 0.2) return { x: s.x, y: s.y, seg: s.seg.id, u: s.u };
    return { x: p.x, y: p.y };
  };
  const build = (p, q, type, hA = 0, hB = hA) => {
    const plan = net.planRoad(snapL(p, hA), snapL(q, hB), null, type, hA, { hA, hB });
    if (!plan.ok) return plan;
    return { ok: true, node: net.executeRoad(plan) };
  };
  // 交流道佔地（不鋪地面道路的範圍）
  const foots = [];
  const inFoot = (x, y) => foots.some(f => {
    const dx = x - f.x, dy = y - f.y, s = dx * f.ux + dy * f.uy, t = -dx * f.uy + dy * f.ux;
    return Math.abs(s) < f.a && Math.abs(t) < f.b && !(f.cross && Math.abs(s) < 4);   // 橫交道路本身可以接
  });
  const pieceInFoot = (p, q) => { for (let i = 1; i < 10; i++) if (inFoot(p.x + (q.x - p.x) * i / 10, p.y + (q.y - p.y) * i / 10)) return true; return false; };
  // 地面道路：中段碰到水域就改成高架橋（兩端各 SLOPE_LEN 的坡道要在陸地上）
  const ground = (p, q, type) => {
    if (pieceInFoot(p, q)) { if (type === 'rail') dbg('鐵路在交流道範圍', Math.round(p.x), Math.round(q.x)); return false; }
    if (T.isWater(p.x, p.y) || T.isWater(q.x, q.y)) { log.fail++; if (type === 'rail') dbg('鐵路端點在水上', Math.round(p.x), Math.round(q.x)); return false; }
    const r = build(p, q, type);
    if (r.ok) { log.ok++; return true; }
    const L = Math.hypot(q.x - p.x, q.y - p.y), ramp = SLOPE_LEN + 2;
    if (!/水域/.test(r.reason) || L < ramp * 2 + 10) { log.fail++; dbg('地面', type, Math.round(p.x), Math.round(p.y), '→', Math.round(q.x), Math.round(q.y), r.reason); return false; }
    const dx = (q.x - p.x) / L, dy = (q.y - p.y) / L, p1 = { x: p.x + dx * ramp, y: p.y + dy * ramp }, q1 = { x: q.x - dx * ramp, y: q.y - dy * ramp };
    const ok = [[p, p1, 0, 1], [p1, q1, 1, 1], [q1, q, 1, 0]].every(([a, b, ha, hb]) => net.planRoad(snapL(a, ha), snapL(b, hb), null, type, ha, { hA: ha, hB: hb }).ok);
    if (!ok) dbg('橋規劃', type, Math.round(p.x), Math.round(p.y), '→', Math.round(q.x), Math.round(q.y), [[p, p1, 0, 1], [p1, q1, 1, 1], [q1, q, 1, 0]].map(([a, b, ha, hb]) => net.planRoad(snapL(a, ha), snapL(b, hb), null, type, ha, { hA: ha, hB: hb }).reason || 'ok').join(' / '));
    if (!ok || !build(p, p1, type, 0, 1).ok || !build(p1, q1, type, 1, 1).ok || !build(q1, q, type, 1, 0).ok) { log.fail++; dbg('橋', type, Math.round(p.x), Math.round(p.y), '→', Math.round(q.x), Math.round(q.y)); return false; }
    log.bridges++;
    return true;
  };
  // 落在水上的點跳過：前後兩個陸地上的點直接以一段（中間架橋）相連
  const line = pts => { const d = pts.filter(([p]) => !T.isWater(p.x, p.y)); for (let i = 0; i + 1 < d.length; i++) ground(d[i][0], d[i + 1][0], d[i][1]); };
  // 一條直線道路：在 stops（沿線的座標）之間一段一段鋪；type 可以是函式（依區段決定道路種類）
  const NS = (x, ys, type) => line(ys.map(y => [{ x, y }, type]));
  const EW = (y, xs, type) => line(xs.map(x => [{ x, y }, type]));
  const between = (list, a, b) => list.filter(v => v >= a - 1e-6 && v <= b + 1e-6);
  const uniq = list => [...new Set(list.map(v => Math.round(v)))].sort((p, q) => p - q);

  // ---------- 高速公路與交流道 ----------
  // 交流道：在候選位置（依水域由少到多）中找第一個能建的
  const interchange = (key, cands, ux, uy, M, Cc) => {
    // 依偏好順序：先試完全沒有水域的位置，再試只有一點點的
    const all = cands.map(([x, y]) => ({ x, y, w: wetFoot(key, x, y, ux, uy) }));
    const list = [...all.filter(c => c.w < 0.005), ...all.filter(c => c.w >= 0.005 && c.w < 0.25).sort((p, q) => p.w - q.w)].slice(0, 6);
    for (const c of list) {
      const fr = { ok: true, x: c.x, y: c.y, ux, uy, M, C: Cc, snap: false };
      const r = placeInterchange(g, key, fr);
      if (r.ok) {
        log.ix.push(key);
        foots.push({ x: c.x, y: c.y, ux, uy, a: FOOT[key][0], b: FOOT[key][1], cross: key !== 'turbine' });
        return { ...fr, key };
      }
      dbg('交流道', key, Math.round(c.x), Math.round(c.y), r.reason);
    }
    log.ix.push(key + '✗');
    return null;
  };
  const along = (fr, d) => ({ x: fr.x + fr.ux * d, y: fr.y + fr.uy * d });
  const across = (fr, d) => ({ x: fr.x - fr.uy * d, y: fr.y + fr.ux * d });
  const steps = (a, b, st) => { const out = []; for (let v = a; v <= b + 1e-6; v += st) out.push(v); return out; };

  // 東西向高速公路 y = YA、南北向 x = XB：在候選範圍內挑渦輪型交流道佔地與兩條主線水域都少的
  // 一條高速公路上有沒有乾的服務型交流道位置（vertical：南北向；lo～hi 為沿線範圍）
  const dryAlong = (key, fixed, lo, hi, vertical) => {
    let n = 0;
    for (let t = lo; t <= hi; t += 80) if (wetFoot(key, vertical ? fixed : t, vertical ? t : fixed, vertical ? 0 : 1, vertical ? 1 : 0) < 0.01) n++;
    return n;
  };
  let best = null;
  for (const ya of steps(S * 0.14, S * 0.34, 50)) for (const xb of steps(S * 0.55, S * 0.86, 50)) {
    if (xb + FOOT.turbine[1] > S - 60 || ya - FOOT.turbine[0] < 60) continue;
    const edgeWet = [[4, ya], [E, ya], [xb, 4], [xb, E]].some(([x, y]) => wetLine(x, y, x + (x < 10 ? 160 : x > E - 1 ? -160 : 0), y + (y < 10 ? 160 : y > E - 1 ? -160 : 0)) > 0);
    const w = wetFoot('turbine', xb, ya, 1, 0) * 8 + wetLine(0, ya, S, ya) + wetLine(xb, 0, xb, S) + (edgeWet ? 3 : 0)
      + (dryAlong('spui', ya, 1300, xb - 950, false) ? 0 : 2) + (dryAlong('spui', xb, ya + 950, S - 1300, true) ? 0 : 2)
      + (dryAlong('diamond', ya, 420, xb - 1750, false) ? 0 : 1) + (dryAlong('diamond', xb, ya + 1750, E - 420, true) ? 0 : 1)
      // 一樣好的位置裡偏好東西向在北側約 22%、南北向在東側約 78%（市中心留給林蔭大道與街廓）
      + (Math.abs(ya - S * 0.22) + Math.abs(xb - S * 0.78)) * 0.0002;
    if (!best || w < best.w) best = { ya, xb, w };
  }
  let YA = best.ya, XB = best.xb;
  // 系統交流道：渦輪型，水域太多放不下時改用佔地較小的風車型
  const sysC = [[XB, YA], [XB + 60, YA], [XB - 60, YA], [XB, YA + 60], [XB, YA - 60]];
  const turbine = interchange('turbine', sysC, 1, 0, 1, 2) || interchange('windmill', sysC, 1, 0, 1, 2);
  if (turbine) { XB = turbine.x; YA = turbine.y; }
  // 東西向高速公路上：SPUI 在市中心附近（與渦輪至少隔 950 m）、鑽石型在西側
  const ax = [];
  for (let x = 420; x <= XB - 950; x += 40) ax.push(x);
  const nearC = (list, c) => list.sort((p, q) => Math.abs(p - c) - Math.abs(q - c));
  const sA = interchange('spui', nearC(ax.filter(x => x >= 800), C).map(x => [x, YA]), 1, 0, 1, 0) || interchange('diamond', nearC(ax.filter(x => x >= 800), C).map(x => [x, YA]), 1, 0, 1, 0);
  const dA = interchange('diamond', nearC(ax.filter(x => x <= (sA ? sA.x : C) - 800 && x >= 420), 800).map(x => [x, YA]), 1, 0, 1, 0);
  // 南北向高速公路上：SPUI 在市中心附近、鑽石型在南側
  const by = [];
  for (let y = YA + 950; y <= E - 420; y += 40) by.push(y);
  const sB = interchange('spui', nearC(by.filter(y => y <= S - 1200), C).map(y => [XB, y]), 0, 1, 1, 0) || interchange('diamond', nearC(by.filter(y => y <= S - 1200), C).map(y => [XB, y]), 0, 1, 1, 0);
  const dB = interchange('diamond', nearC(by.filter(y => y >= (sB ? sB.y : C) + 800), S - 600).map(y => [XB, y]), 0, 1, 1, 0);

  // 主線：錨點 [點, 高度]，相鄰錨點之間鋪直線（交流道失敗時主線直接跨過去）
  const freeway = anchors => {
    anchors.sort((p, q) => p[2] - q[2]);
    // 地圖邊緣爬升的錨點（第 4 個元素為 true）：交流道的端點已經很靠近邊緣（200 m 內）時省略
    const e0 = anchors[0][2], e1 = anchors[anchors.length - 1][2];
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (!anchors[i][3]) continue;
      const nearEdge = anchors.some(a => !a[3] && a[2] !== e0 && a[2] !== e1 && (a[2] - e0 < 200 || e1 - a[2] < 200) && Math.abs(a[2] - anchors[i][2]) < 260);
      if (nearEdge) anchors.splice(i, 1);
    }
    for (let i = 0; i + 1 < anchors.length; i++) {
      const [a, ha] = anchors[i], [b, hb] = anchors[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 5) continue;
      const r = build(a, b, 'highway', ha, hb);
      if (!r.ok) { log.fail++; dbg('高速', Math.round(a.x), Math.round(a.y), ha, '→', Math.round(b.x), Math.round(b.y), hb, r.reason); }
    }
  };
  const ends = (fr, h, ax) => (fr ? [-1, 1].map(s => { const L = HALF[fr.key][0], p = along(fr, s * L); return [p, h, ax(p)]; }) : []);
  freeway([[{ x: 4, y: YA }, 0, 4], [{ x: 150, y: YA }, 1, 150, true], ...ends(dA, 1, p => p.x), ...ends(sA, 1, p => p.x), ...ends(turbine, 1, p => p.x), [{ x: S - 150, y: YA }, 1, S - 150, true], [{ x: E, y: YA }, 0, E]]);
  // 南北向：渦輪的橫交道路在第 2 層（沒有渦輪時在交會處升到第 2 層跨過東西向）
  const tB = turbine ? [-1, 1].map(s => { const p = across(turbine, s * HALF[turbine.key][1]); return [p, 2, p.y]; }) : [[{ x: XB, y: YA - 150 }, 2, YA - 150], [{ x: XB, y: YA + 150 }, 2, YA + 150]];
  freeway([[{ x: XB, y: 4 }, 0, 4], [{ x: XB, y: 150 }, 1, 150, true], ...tB, ...ends(sB, 1, p => p.y), ...ends(dB, 1, p => p.y), [{ x: XB, y: S - 150 }, 1, S - 150, true], [{ x: XB, y: E }, 0, E]]);
  const outNode = (p, name) => { const n = net.nodeNear(p.x, p.y, 3, 0); if (n && n.segs.length === 1) { city.addOutside(n, name); return true; } return false; };
  outNode({ x: 4, y: YA }, '西方高速公路'); outNode({ x: E, y: YA }, '東方高速公路'); outNode({ x: XB, y: 4 }, '北方高速公路'); outNode({ x: XB, y: E }, '南方高速公路');
  net.rebuild();

  // ---------- 幹道的位置 ----------
  const XM = sA ? sA.x : C, YM = sB ? sB.y : C;               // 林蔭大道十字主軸（SPUI 的橫交道路）
  const XD = dA ? dA.x : 800, YD = dB ? dB.y : S - 600;        // 大道（鑽石型的橫交道路）
  const XW = 300, XE = S - 200, YN = Math.max(300, YA - 420), YS = S - 200;   // 外環
  // 鐵路：主軸與南側大道之間、水域最少的一條東西線（避開南北向高速公路的交流道）
  let ry = null;
  for (let y = YM + 400; y <= YD - 400; y += 20) {
    const w = wetLine(0, y, S, y) + (foots.some(f => Math.abs(f.y - y) < f.a + 20 && Math.abs(f.x - XB) < 5) ? 5 : 0) + (T.isWater(4, y) || T.isWater(E, y) ? 3 : 0);
    if (ry === null || w < ry.w) ry = { y, w };
  }
  const RY = ry ? ry.y : (YM + YD) / 2, RW = 75;   // 站前道路離鐵路 75 m：車站地塊（深 8～10 格）的後方緊鄰鐵軌
  // 街道的位置：每 200 m 一條，離幹道 / 高速公路太近（< 120 m）的省略；鐵路兩側各一條站前道路
  const gridX = uniq(steps(XW, XE, 200).filter(x => ![XW, XD, XM, XE, XB].some(a => Math.abs(a - x) < 120)));
  const yMajor = [YN, YM, YD, YS, RY - RW, RY + RW];
  const gridY = uniq(steps(YA + 200, YS, 200).filter(y => ![...yMajor, YA].some(a => Math.abs(a - y) < 110)));
  const allX = uniq([XW, XD, XM, XE, ...gridX]), allY = uniq([YN, YA + 200 > YM ? YM : YA + 200, YM, YD, YS, RY - RW, RY + RW, ...gridY].filter(y => y > YA + 150 || y === YN));
  const northY = uniq([YN, ...steps(YN + 200, YA - 150, 200)]);   // 高速公路以北

  // ---------- 幹道 ----------
  const ysAll = uniq([...northY, ...allY]);
  // 南北向：主軸林蔭大道（往南到地圖邊緣當聯外道路）、鑽石型的大道、外環
  NS(XM, uniq([YN, ...ysAll.filter(y => y > YN), E]), 'boulevard');
  NS(XD, ysAll, 'avenue');
  NS(XW, ysAll, 'avenue');
  NS(XE, ysAll.filter(y => !inFoot(XE, y)), 'avenue');
  // 東西向：主軸林蔭大道（往西到地圖邊緣當聯外道路）、鑽石型的大道、外環
  const xsAll = uniq([...allX]);
  EW(YM, uniq([4, ...xsAll]), 'boulevard');
  EW(YD, xsAll, 'avenue');
  EW(YS, xsAll, 'avenue');
  EW(YN, xsAll.filter(x => x < XB - 600), 'avenue');
  outNode({ x: 4, y: YM }, '西方聯外道路');
  outNode({ x: XM, y: E }, '南方聯外道路');
  net.rebuild();

  // ---------- 街道 ----------
  // 南北向街道：鐵路處只有每隔兩條跨過（平交道），其餘停在站前道路
  gridX.forEach((x, i) => {
    const ys = ysAll.filter(y => !(y > RY - RW + 10 && y < RY + RW - 10));
    if (i % 3 === 1) NS(x, ysAll, 'street');
    else { NS(x, ys.filter(y => y <= RY - RW), 'street'); NS(x, ys.filter(y => y >= RY + RW), 'street'); }
  });
  for (const y of [...gridY, ...northY.filter(y => y !== YN), RY - RW, RY + RW]) EW(y, xsAll, 'street');
  net.rebuild();

  // ---------- 鐵路 ----------
  const railXs = uniq([4, ...xsAll.filter(x => x > 4 && x < E), E]);
  line(railXs.map(x => [{ x, y: RY }, 'rail']));
  const rn = p => net.nodeNear(p.x, p.y, 3, 0);
  if (rn({ x: 4, y: RY })) city.addRailOutside(rn({ x: 4, y: RY }), '西方鐵路');
  if (rn({ x: E, y: RY })) city.addRailOutside(rn({ x: E, y: RY }), '東方鐵路');
  net.rebuild();

  // 只有一端相接的地面道路（停在交流道範圍、水域邊的短截）拆掉，一路拆到路口為止
  for (let changed = true, guard = 0; changed && guard < 20; guard++) {
    changed = false;
    for (const n of [...net.nodes.values()]) {
      if (n.segs.length !== 1 || n.outside || n.level !== 0) continue;
      const sg = net.segs.get(n.segs[0]);
      if (!sg || sg.T.rail || sg.type === 'highway' || sg.type === 'ramp') continue;
      net.removeSegment(sg);
      changed = true;
    }
  }
  fullRebuild();
  // 車站：鐵路旁的道路上依序找可以劃設的位置（planStroke 會檢查要緊鄰鐵軌）
  const station = (zt, cols, rows, x, y) => {
    const mid = s => ({ x: (s.bbox.x0 + s.bbox.x1) / 2, y: (s.bbox.y0 + s.bbox.y1) / 2 });
    const segs = [...net.segs.values()].filter(s => s.T.access && !s.T.internal && s.drawLevel === 0 && Math.hypot(mid(s).x - x, mid(s).y - y) < 320)
      .sort((a, b) => Math.hypot(mid(a).x - x, mid(a).y - y) - Math.hypot(mid(b).x - x, mid(b).y - y));
    for (const s of segs) for (const side of [1, -1]) {
      // 臨路道路限制地塊大小（市區道路最大 12 格）
      const c = Math.min(cols, city.maxCells(zt, s)), g0 = city.gridStart(s, side), end = s.len - city.endTrim(s, true, side);
      for (let u0 = g0; u0 + c * 6 <= end + 1e-6; u0 += 6) for (let r = rows; r >= 4; r--) {
        const p = city.planStroke(zt, s, side, u0, u0 + c * 6, r).find(p => p.ok && p.cols >= Math.min(c, 9));
        if (p && !city.lots.some(l => Math.hypot(l.x - p.geo.x, l.y - p.geo.y) < 150)) return city.addLot(zt, s, p.u, side, p.cols, p.rows);
      }
    }
    if (g.debugGen) for (const s of segs.slice(0, 4)) for (const side of [1, -1]) { const g0 = city.gridStart(s, side); dbg('  候選', s.id, s.T.name, Math.round(s.len), side, city.planStroke(zt, s, side, g0, g0 + cols * 6, rows).map(p => p.cols + 'x' + p.rows + (p.ok ? 'ok' : p.reason)).join(' ')); }
    dbg('車站', zt, x, y, '找不到位置');
    return null;
  };
  const made = [station('RT', 16, 10, XM + 100, RY), station('RS', 8, 8, XD, RY), station('RS', 8, 8, (XM + XB) / 2, RY), station('RS', 8, 8, XE - 200, RY), station('RC', 16, 10, XB + 350, RY)].filter(Boolean);
  city.recount();
  g.money = savedMoney;
  return { ...log, stations: made.map(l => l.zt).join(','), segs: net.segs.size, outside: city.outside.length, YA, XB, RY };
}

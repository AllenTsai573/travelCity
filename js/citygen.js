// 完整城市路網開局：整張地圖先鋪好交通骨架（參考日本都市：高架的都市高速公路、林蔭大道的十字主軸、
// 外環大道、200 m 的棋盤街廓、東西向鐵路與車站），住宅 / 商業 / 工業交給自動發展
// - 高速公路（高架第 1 層）：一條東西向、一條南北向，交會處是渦輪型系統交流道；與林蔭大道 / 大道交會處有
//   服務型交流道（單點式 SPUI、鑽石型），地圖邊緣降回地面接外部連線
// - 地面道路都從高架下方穿過，只在交流道與高速公路相接
// - 依地形調整：高速公路、交流道、鐵路的位置在候選範圍內挑水域最少的；地面道路中段遇到水域改以高架橋跨越
// - 幹道與街道依交流道實際的位置排列：林蔭大道 / 大道就是交流道的橫交道路，街道每 200 m 一條（離幹道太近的省略）
// - 鐵路全線高架（第 1 層，跨過南北向高速公路處升到第 2 層），不與道路平面交叉：客運線東西向橫貫地圖（兩端是外部鐵路），
//   每個客運車站有從主線分出來的進站月台軌；貨運線另外一條（分軌，不與客運線相連）從地圖邊緣接到貨運站。
//   鐵路兩側各有一條站前道路；分區只劃車站
import { placeInterchange } from './interchange.js';
import { SLOPE_LEN, ROAD_TYPES } from './config.js';
import { halfWidth } from './network.js';
import { polyBBox, pointAt } from './util.js';

// 交流道佔地（沿主線、橫向的半寬，公尺）：範圍內不鋪其他地面道路
// 服務型交流道的匝道在主線兩側 80 m 內、沿主線 270 m 內；平行主線的街道離主線 140 m 以上、橫交的街道離中心 290 m 以上
const FOOT = { turbine: [540, 540], windmill: [460, 460], spui: [290, 140], diamond: [290, 140] };
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
  // 道路的類別：鐵路、高速公路 / 匝道、一般道路；不同類別不能在同一高度相交（不然高架橋會在高速公路上做出平面路口）
  const cls = t => (ROAD_TYPES[t].rail ? 'rail' : t === 'highway' || t === 'ramp' ? 'fw' : 'road');
  const mixes = (plan, type) => {
    const k = cls(type), other = id => { const s = net.segs.get(id); return s && cls(s.type) !== k; };
    if (plan.crossings.some(c => other(c.seg))) return true;
    return [plan.a, plan.b].some(e => (e.seg && other(e.seg)) || (e.node && net.nodes.get(e.node).segs.some(other)));
  };
  const build = (p, q, type, hA = 0, hB = hA) => {
    const plan = net.planRoad(snapL(p, hA), snapL(q, hB), null, type, hA, { hA, hB });
    if (!plan.ok) return plan;
    if (mixes(plan, type)) return { ok: false, reason: '不同類別的道路不平面交叉' };
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
    const ok = [[p, p1, 0, 1], [p1, q1, 1, 1], [q1, q, 1, 0]].every(([a, b, ha, hb]) => { const pl = net.planRoad(snapL(a, ha), snapL(b, hb), null, type, ha, { hA: ha, hB: hb }); return pl.ok && !mixes(pl, type); });
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
      const before = net.segs.size;
      const r = placeInterchange(g, key, fr);
      if (!r.ok && net.segs.size !== before) dbg('交流道失敗但留下路段', key, Math.round(c.x), Math.round(c.y), before, '→', net.segs.size, r.reason);
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
      const [a, ha, , , fa] = anchors[i], [b, hb, , , fb] = anchors[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 5 || (fa && fa === fb)) continue;
      const r = build(a, b, 'highway', ha, hb);
      if (!r.ok) { log.fail++; dbg('高速', Math.round(a.x), Math.round(a.y), ha, '→', Math.round(b.x), Math.round(b.y), hb, r.reason); }
    }
  };
  // 交流道主線（cross：橫交道路）實際的兩個端點：沿軸線、在該高度、離中心最遠的高速公路節點（模板的主線會比 L 短一些）
  const axisEnds = (fr, cross, h) => {
    const ax = cross ? { x: -fr.uy, y: fr.ux } : { x: fr.ux, y: fr.uy }, out = [null, null];
    for (const n of net.nodes.values()) {
      if (n.level !== h || !n.segs.some(id => net.segs.get(id).type === 'highway')) continue;
      const dx = n.x - fr.x, dy = n.y - fr.y, a = dx * ax.x + dy * ax.y, lat = -dx * ax.y + dy * ax.x;
      if (Math.abs(lat) > 2 || Math.abs(a) > HALF[fr.key][cross ? 1 : 0] + 20) continue;
      const k = a < 0 ? 0 : 1;
      if (!out[k] || Math.abs(a) > Math.abs(out[k].a)) out[k] = { a, p: { x: n.x, y: n.y } };
    }
    return out.filter(Boolean).map(e => e.p);
  };
  // 錨點的第 5 個元素是所屬的交流道：同一座交流道的兩端之間是它自己的主線，不再重鋪
  const ends = (fr, h, ax) => (fr ? axisEnds(fr, false, h).map(p => [p, h, ax(p), false, fr]) : []);
  freeway([[{ x: 4, y: YA }, 0, 4], [{ x: 150, y: YA }, 1, 150, true], ...ends(dA, 1, p => p.x), ...ends(sA, 1, p => p.x), ...ends(turbine, 1, p => p.x), [{ x: S - 150, y: YA }, 1, S - 150, true], [{ x: E, y: YA }, 0, E]]);
  // 南北向：渦輪的橫交道路在第 2 層（沒有渦輪時在交會處升到第 2 層跨過東西向）
  const tB = turbine ? axisEnds(turbine, true, 2).map(p => [p, 2, p.y, false, turbine]) : [[{ x: XB, y: YA - 150 }, 2, YA - 150], [{ x: XB, y: YA + 150 }, 2, YA + 150]];
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
    // 鐵路與兩側站前道路（±80 m）都要在南北向高速公路的交流道範圍外
    const w = wetLine(0, y, S, y) + (foots.some(f => Math.abs(f.y - y) < f.a + 110 && Math.abs(f.x - XB) < 5) ? 5 : 0) + (T.isWater(4, y) || T.isWater(E, y) ? 3 : 0);
    if (ry === null || w < ry.w) ry = { y, w };
  }
  // 站前道路離客運線 80 m；客運月台軌在南側 14 m、貨運線在北側 32 m，車站地塊的後方緊鄰鐵軌
  // 站前道路（市區道路，路緣到中心 5.8 m）離客運線 RW：深 8 格（48 m）的車站地塊後緣剛好貼著月台軌（中心 SID、半寬約 5 m）
  const RY = ry ? ry.y : (YM + YD) / 2, SID = 14, RW = SID + 5.6 + 48 + 5.8, FY = RY - 32;

  // ---------- 鐵路（先鋪，之後的道路都從高架下方穿過） ----------
  // 一條東西向高架鐵路：地圖邊緣是地面（外部鐵路），進來 150 m 爬到第 1 層；跨過南北向高速公路處升到第 2 層
  const railLine = (y, x0, x1) => {
    const lv = x => (x <= 10 || x >= E - 1 ? 0 : 1);
    const pts = [[x0, lv(x0)], [x1, lv(x1)]];
    if (x0 <= 10) pts.push([150, 1]);
    if (x1 >= E - 1) pts.push([S - 150, 1]);
    if (XB > x0 + 300 && XB < x1 - 300) pts.push([XB - 260, 1], [XB - 160, 2], [XB + 160, 2], [XB + 260, 1]);
    pts.sort((p, q) => p[0] - q[0]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const r = build({ x: pts[i][0], y }, { x: pts[i + 1][0], y }, 'rail', pts[i][1], pts[i + 1][1]);
      if (!r.ok) { log.fail++; dbg('鐵路', pts[i][0], y, r.reason); }
    }
  };
  railLine(RY, 4, E);
  const rn = p => net.nodeNear(p.x, p.y, 3, 0);
  if (rn({ x: 4, y: RY })) city.addRailOutside(rn({ x: 4, y: RY }), '西方鐵路');
  if (rn({ x: E, y: RY })) city.addRailOutside(rn({ x: E, y: RY }), '東方鐵路');
  // 客運車站的進站月台軌：主線分出（約 11° 的道岔）、在南側 SID 公尺處平行 150 m、再接回主線
  const platforms = [];
  const siding = x0 => {
    const half = 75, lead = 70;
    if (x0 - half - lead < 300 || x0 + half + lead > S - 300 || Math.abs(x0 - XB) < 480 || platforms.some(p => Math.abs(p - x0) < 420)) return false;
    const A = { x: x0 - half - lead, y: RY }, B = { x: x0 - half, y: RY + SID }, Cc = { x: x0 + half, y: RY + SID }, D = { x: x0 + half + lead, y: RY };
    const plans = [[A, B], [B, Cc], [Cc, D]];
    for (const [p, q] of plans) { const r = build(p, q, 'rail', 1, 1); if (!r.ok) { dbg('月台軌', Math.round(x0), r.reason); return false; } }
    platforms.push(x0);
    return true;
  };
  // 月台軌（第一個給鐵路總站）：主軸旁、西側大道旁、東側，放不下的位置略過
  for (const x0 of [XM + 100, XD, (XM + XB) / 2, XE - 250, (XD + XM) / 2, XM + 600, XM - 600, XB + 550, XW + 400]) if (platforms.length < 4) siding(x0);
  // 貨運線（分軌）：從東邊地圖邊緣接到貨運站，盡頭是貨運站的裝卸線
  const XC = XB + 350 <= E - 300 ? XB + 350 : Math.min(XB - 450, E - 600);
  railLine(FY, XC - 130, E);
  if (rn({ x: E, y: FY })) city.addRailOutside(rn({ x: E, y: FY }), '東方貨運鐵路');
  net.rebuild();
  // 街道的位置：每 200 m 一條，離幹道 / 高速公路太近（< 120 m）的省略；鐵路兩側各一條站前道路
  const gridX = uniq(steps(XW, XE, 200).filter(x => ![XW, XD, XM, XE, XB].some(a => Math.abs(a - x) < 120)));
  const yMajor = [YN, YM, YD, YS, RY - RW, RY + RW];
  // 整個外環內每 200 m 一條（高速公路以北也是），離幹道、高速公路、鐵路站前道路太近的省略
  const gridY = uniq(steps(YN + 200, YS, 200).filter(y => ![...yMajor, YA].some(a => Math.abs(a - y) < 110) && !(y > RY - RW && y < RY + RW)));
  const allX = uniq([XW, XD, XM, XE, ...gridX]), allY = uniq([YN, YM, YD, YS, RY - RW, RY + RW, ...gridY]);
  const northY = [];

  // ---------- 幹道 ----------
  const ysAll = uniq([...northY, ...allY]);
  // 南北向：主軸林蔭大道、鑽石型的大道、外環（聯外只有高速公路，林蔭大道停在外環）
  NS(XM, ysAll, 'boulevard');
  NS(XD, ysAll, 'avenue');
  NS(XW, ysAll, 'avenue');
  NS(XE, ysAll.filter(y => !inFoot(XE, y)), 'avenue');
  // 東西向：主軸林蔭大道、鑽石型的大道、外環
  const xsAll = uniq([...allX]);
  EW(YM, xsAll, 'boulevard');
  EW(YD, xsAll, 'avenue');
  EW(YS, xsAll, 'avenue');
  EW(YN, xsAll.filter(x => x < XB - 600), 'avenue');
  net.rebuild();

  // ---------- 街道 ----------
  // 南北向街道（鐵路高架，全部從下方穿過）
  for (const x of gridX) NS(x, ysAll, 'street');
  for (const y of [...gridY, RY - RW, RY + RW]) EW(y, xsAll, 'street');
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
    const segs = [...net.segs.values()].filter(s => s.T.access && !s.T.internal && s.drawLevel === 0 && Math.abs(mid(s).y - y) < 30 && Math.abs(mid(s).x - x) < 300)
      .sort((a, b) => Math.abs(mid(a).x - x) - Math.abs(mid(b).x - x));
    const cands = [];
    for (const s of segs) for (const side of [1, -1]) {
      // 臨路道路限制地塊大小（市區道路最大 12 格）
      const c = Math.min(cols, city.maxCells(zt, s)), g0 = city.gridStart(s, side), end = s.len - city.endTrim(s, true, side);
      for (let u0 = g0; u0 + c * 6 <= end + 1e-6; u0 += 6) {
        const pm = pointAt(s.pts, s.cum, u0 + c * 3);
        cands.push({ s, side, c, u0, d: Math.abs(pm.x - x) });
      }
    }
    // 地塊中心離目標（月台軌中央）越近越好
    cands.sort((p, q) => p.d - q.d);
    for (const { s, side, c, u0 } of cands.slice(0, 80)) for (let r = rows; r >= 4; r--) {
      const p = city.planStroke(zt, s, side, u0, u0 + c * 6, r).find(p => p.ok && p.cols >= Math.min(c, 9));
      if (p && !city.lots.some(l => Math.hypot(l.x - p.geo.x, l.y - p.geo.y) < 150)) return city.addLot(zt, s, p.u, side, p.cols, p.rows);
    }
    if (g.debugGen) for (const s of segs.slice(0, 4)) for (const side of [1, -1]) { const g0 = city.gridStart(s, side); dbg('  候選', s.id, s.T.name, Math.round(s.len), side, city.planStroke(zt, s, side, g0, g0 + cols * 6, rows).map(p => p.cols + 'x' + p.rows + (p.ok ? 'ok' : p.reason)).join(' ')); }
    dbg('車站', zt, x, y, '找不到位置');
    return null;
  };
  // 客運車站在南側站前道路、背對月台軌；貨運站在北側站前道路、背對貨運線
  const made = [];
  for (const [zt, cols, rows] of [['RT', 16, 8], ['RS', 8, 8], ['RS', 8, 8], ['RS', 8, 8]]) {
    const x0 = platforms[made.length];
    if (x0 === undefined) break;
    const l = station(zt, cols, rows, x0, RY + RW);
    if (l) made.push(l);
  }
  // 貨運站在北側：後緣貼著貨運線（中心 FY、半寬約 5 m）
  const rc = station('RC', 16, Math.floor((RW - 5.8 - (RY - FY) - 5.6) / 6), XC, RY - RW);
  if (rc) made.push(rc);
  city.recount();
  g.money = savedMoney;
  return { ...log, stations: made.map(l => l.zt).join(','), segs: net.segs.size, outside: city.outside.length, YA, XB, RY };
}

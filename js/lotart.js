// 地塊上的建築圖形（歐洲風格；以地塊區域座標 u：沿路方向 0~w、v：離路方向 0~d 產生，渲染時再轉成世界座標）
import { CELL } from './config.js';

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const CARS = ['#e8e8e8', '#2b2b2b', '#c0392b', '#2e6fb7', '#8e9aa6', '#f1c40f', '#1e8449', '#7f8c8d'];
// 紅陶瓦、石板瓦（巴黎式折線屋頂）、灰泥牆、粉彩與鮮豔立面（北歐港口 / 義大利漁村）、紅磚
const TILE = ['#b5523b', '#c0643f', '#a9472f', '#9c4a36', '#c97a52', '#b86a4b', '#a65a3e', '#8a4a38', '#d08a5a', '#7c5a48'];
const SLATE = ['#6a737d', '#78808a', '#646b74', '#7f868f', '#5a6068', '#6f9a8d'];
const STUCCO = ['#f1e6d2', '#ecdcc0', '#e8d3b0', '#f4efe6', '#e5c9a8', '#efe0c9', '#e3d6c6', '#e9e4da', '#f3ead8', '#dccbb4'];
const PASTEL = ['#e8cfb8', '#d9c7a0', '#cfd8cf', '#e6d2c8', '#d6dbe0', '#ecd9a8', '#e0c2b0', '#f0e2c4', '#bcd4e6', '#a9c9a4', '#e9b8a8', '#d8c6e0'];
const BOLD = ['#e0a040', '#c8553d', '#4f7cac', '#7aa874', '#d98fa0', '#f2d06b', '#9b8bb4', '#e8a86b', '#5f9ea0', '#b5654a', '#f0c27a', '#8fb8c9'];
const BRICK = ['#a8573f', '#9a5a46', '#b0644a', '#8e4f3c', '#b87358'];
const AWN = ['#8c2f2f', '#2f5d3a', '#24476b', '#b5823a', '#5a3d6b', '#3d6b6b', '#c0392b', '#e0b040'];
const UMB = ['#f2efe6', '#c0392b', '#2f5d3a', '#e8c547', '#24476b'];
const BOX = ['#b5523b', '#2e6fb7', '#1e8449', '#d8a13a', '#8e9aa6', '#7d3c98', '#c0392b'];

// 回傳 { base, items, slots }：items 依序繪製
// rect：{ u0, v0, u1, v1, c（屋頂色）, h（高度）, wall, roof（gable 雙坡 / hip 四坡 / mansard 折線 / saw 鋸齒，沒有就是平屋頂）, ridge（屋脊方向 u / v）,
//         win（窗）, door, shop（一樓店面遮陽棚色）, chimney（煙囪在屋脊上的位置 0~1）, solar, sky（天窗）, glass, units（屋頂設備）, deco（樹籬等裝飾，不算建物） }
// circle：{ u, v, r, c, h, tree, umb（陽傘）, stack（煙囪冒煙） }、line：{ pts, c, w, dash }
// 停車位都在室外、車頭朝向一條道路（臨路或場內道路），車子從道路直直開進去，不會穿過建物或其他車位
export function lotArt(b) {
  const r = rng(b.id * 97 + b.cols * 13 + b.rows), w = b.cols * CELL, d = b.rows * CELL, lv = b.level, items = [];
  const rect = (u0, v0, u1, v1, c, h = 0, extra = {}) => items.push({ t: 'rect', u0, v0, u1, v1, c, h, ...extra });
  const tree = (u, v, s = 1) => items.push({ t: 'circle', u, v, r: (2 + r() * 1.4) * s, c: pick(r, ['#4f8a3c', '#5d9a47', '#467d36', '#3f7a35', '#6a9a4a']), h: 4 + r() * 3, tree: true });
  const hedge = (u0, v0, u1, v1) => { if (u1 - u0 > 0.8 && v1 - v0 > 0.4) rect(u0, v0, u1, v1, '#4c7a39', 1.3, { wall: '#43703a', deco: true }); };
  const road = (pts, wd = 5) => items.push({ t: 'line', pts, c: '#5b5f64', w: wd });
  const line = (pts, c, wd, dash) => items.push({ t: 'line', pts, c, w: wd, dash });
  const car = (u0, v0, du, dv, extra = {}) => items.push({ t: 'rect', u0, v0, du, dv, c: pick(r, CARS), h: 0.4, car: true, slot: r(), ...extra });
  const tileOrSlate = (p = 0.8) => (r() < p ? pick(r, TILE) : pick(r, SLATE));
  const facadeCol = () => { const x = r(); return pick(r, x < 0.35 ? STUCCO : x < 0.7 ? PASTEL : BOLD); };
  // 臨路的一排垂直停車格（直接從道路進出），u0~u1、深 5.6 m
  const frontBays = (u0, u1, v0 = 0.4) => {
    if (u1 - u0 < 3) return;
    rect(u0, v0, u1, v0 + 5.6, '#878a8f');
    for (let u = u0 + 0.6; u + 2.6 <= u1 - 0.4; u += 2.7) {
      line([{ u, v: v0 + 0.2 }, { u, v: v0 + 5.2 }], 'rgba(255,255,255,0.85)', 0.2);
      car(u + 0.45, v0 + 0.5, 1.8, 4.3);
    }
  };
  // 場內道路（巷道）兩側的垂直停車格：lu 為巷道中心，v0~v1
  const laneBays = (lu, v0, v1) => {
    for (const sd of [-1, 1]) {
      const e0 = lu + sd * 4.3, e1 = lu + sd * 9.3, lo = Math.min(e0, e1);
      if (lo < 0.5 || Math.max(e0, e1) > w - 0.5) continue;
      rect(lo, v0, lo + 5, v1, '#878a8f');
      for (let v = v0 + 0.3; v + 2.6 <= v1; v += 2.6) {
        line([{ u: e0, v }, { u: e1, v }], 'rgba(255,255,255,0.85)', 0.2);
        car(lo + 0.4, v + 0.4, 4.2, 1.8);
      }
    }
  };
  // 停車場：沿車道兩側畫停車格（每格 2.6 m × 5 m），車道間距 17 m；real 表示主車道由路網畫出；spineOnly 只沿主車道
  const parking = (u0, v0, u1, v1, spine, real, occ, fromBack = false, spineOnly = false) => {
    rect(u0, v0, u1, v1, '#7f8287');
    const aisles = [spine];
    if (!spineOnly) {
      for (let a = spine - 17; a - 8 >= u0; a -= 17) aisles.push(a);
      for (let a = spine + 17; a + 8 <= u1; a += 17) aisles.push(a);
    }
    const top = fromBack ? v0 + 1 : v0 + 1, bot = v1 - 7;
    for (const a of aisles) {
      // 主車道若是實際的場內道路，寬度是 8.6 m；其餘通道 6 m
      const ah = a === spine && real ? 4.3 : 3;
      if (a !== spine || !real) rect(a - 3, v0, a + 3, v1 - 1, '#878a8f');
      for (const sd of [-1, 1]) {
        const e0 = a + sd * ah, e1 = a + sd * (ah + 5);
        if (Math.min(e0, e1) < u0 || Math.max(e0, e1) > u1) continue;
        for (let v = top; v + 2.6 <= bot; v += 2.6) {
          line([{ u: e0, v }, { u: e1, v }], 'rgba(255,255,255,0.9)', 0.25);
          // 停車格：slot 決定這一格在多少使用率時會停車（由繪圖時依實際人數決定）
          car(Math.min(e0, e1) + 0.4, v + 0.4, 4.2, 1.8);
        }
        line([{ u: e1, v: top }, { u: e1, v: bot }], 'rgba(255,255,255,0.9)', 0.25);
      }
    }
    // 底部橫向通道把各車道連起來
    if (aisles.length > 1) rect(u0 + 1, v1 - 6.5, u1 - 1, v1 - 0.5, '#878a8f');
  };
  // 地下停車場入口坡道（臨路、靠地塊右側），以及看不見的室內車位（只用於商業大樓）
  const garageRamp = (n, uc = w - 3.25) => {
    const u0 = uc - 2.75, u1 = uc + 2.75;
    rect(u0, 0, u1, 9, '#5b5f64');
    rect(u0 + 0.6, 5.5, u1 - 0.6, 9, '#2b2e33');
    for (let i = 0; i < n; i++) items.push({ t: 'rect', u0: u0 + 1.8, v0: 6, du: 1.8, dv: 3, c: pick(r, CARS), h: 0.4, car: true, slot: 0.5 + r() * 0.5, indoor: true });
  };
  // 一排沿 axis 方向（u 或 v）排列的立面：每段 9~18 m，顏色、高度略有不同（歐洲街廓每棟都不一樣）
  const facade = (axis, a0, a1, c0, c1, H0, mans, rc) => {
    let a = a0;
    while (a < a1 - 0.5) {
      let L = Math.min(a1 - a, 9 + r() * 9);
      if (a1 - a - L < 6) L = a1 - a;
      if (L >= 3) {
        const h = H0 + (r() - 0.5) * 4, roofC = r() < 0.8 ? rc : (mans ? pick(r, SLATE) : pick(r, TILE));
        const ex = { roof: mans ? 'mansard' : 'gable', ridge: axis, wall: facadeCol(), win: true, chimney: !mans && r() < 0.5 ? 0.15 + r() * 0.7 : undefined };
        if (axis === 'u') rect(a, c0, a + L, c1, roofC, h, ex); else rect(c0, a, c1, a + L, roofC, h, ex);
      }
      a += L;
    }
  };
  // 周邊式街廓：建物沿範圍四周圍成一圈，中間是中庭花園；太小的就是一棟實心建物
  const perimeterBlock = (U0, V0, U1, V1) => {
    const W = U1 - U0, D = V1 - V0, wd = Math.min(12, Math.max(8, Math.min(W, D) * 0.3));
    if (W < 3 || D < 3) return;
    const mans = r() < 0.4, rc = mans ? pick(r, SLATE) : pick(r, TILE), H0 = 11 + lv * 3 + r() * 3;
    if (Math.min(W, D) < wd * 2 + 6) { facade(W >= D ? 'u' : 'v', W >= D ? U0 : V0, W >= D ? U1 : V1, W >= D ? V0 : U0, W >= D ? V1 : U1, H0, mans, rc); return; }
    facade('u', U0, U1, V0, V0 + wd, H0, mans, rc);
    facade('u', U0, U1, V1 - wd, V1, H0, mans, rc);
    facade('v', V0 + wd, V1 - wd, U0, U0 + wd, H0, mans, rc);
    facade('v', V0 + wd, V1 - wd, U1 - wd, U1, H0, mans, rc);
    rect(U0 + wd, V0 + wd, U1 - wd, V1 - wd, '#9fbf86');
    const iw = W - wd * 2, id = D - wd * 2, n = Math.max(1, Math.round(iw * id / 120));
    for (let i = 0; i < n; i++) tree(U0 + wd + 2.5 + r() * (iw - 5), V0 + wd + 2.5 + r() * (id - 5), 0.9);
  };
  // 把 a~b 平均切成長度不超過 max 的幾段
  const split = (a, b, max = 48) => { const k = Math.max(1, Math.ceil((b - a) / max - 1e-6)), L = (b - a) / k, out = []; for (let i = 0; i < k; i++) out.push([a + L * i, a + L * (i + 1)]); return out; };
  // 一排連棟住宅（u0~u1、v0~v1）：同一片屋頂（偶爾換色），每戶 5.5~7.5 m 寬、立面不同顏色；三成是山牆朝街的荷蘭式
  // pads：每戶門前一個停車位（淺的地塊用）
  const terrace = (u0, u1, v0, v1, pads = false) => {
    const rc = tileOrSlate(0.85), dutch = r() < 0.3;
    let u = u0;
    while (u < u1 - 0.5) {
      let uw = Math.min(u1 - u, 5.5 + r() * 2);
      if (u1 - u - uw < 4) uw = u1 - u;
      if (uw >= 3) {
        rect(u, v0, u + uw, v1, r() < 0.8 ? rc : tileOrSlate(), 8 + lv * 2 + (r() - 0.5) * 1.5, { roof: 'gable', ridge: dutch ? 'v' : 'u', wall: facadeCol(), win: true, door: true, chimney: !dutch && r() < 0.3 ? r() : undefined });
        if (pads && uw >= 3.2) { rect(u + uw / 2 - 1.4, 0.3, u + uw / 2 + 1.4, v0 - 0.4, '#bdb8ae'); car(u + uw / 2 - 0.95, 0.6, 1.9, Math.min(4.6, v0 - 1.2)); }
      }
      u += uw;
    }
  };
  // 工業區的露天堆場：一排排貨櫃（部分疊兩層），取代空地
  const yard = (u0, v0, u1, v1) => {
    rect(u0, v0, u1, v1, '#a7a191');
    let n = 0;
    for (let v = v0 + 2; v + 2.4 <= v1 - 2; v += 3.4) for (let u = u0 + 2; u + 6 <= u1 - 2; u += 6.6) {
      if (n > 0 && r() < 0.3) continue;
      n++;
      rect(u, v, u + 6, v + 2.4, pick(r, BOX), r() < 0.35 ? 5.2 : 2.6, { box: true });
    }
    if (!n) rect(u0 + 1, v0 + 1, u1 - 1, v1 - 1, '#cfcac0', 3 + lv, { wall: '#d9d6cf' });
  };
  let base = '#a6c98f';
  const fill = [0.78, 0.9, 1][lv - 1];

  if (b.zt === 'R1') {
    base = '#a3c98c';
    // 每戶一塊 12 m 寬的宅地：前院樹籬、前院並排兩個室外停車位（直接從道路 / 巷道開進去）
    // home(o, t, n, W, D)：o 為宅地臨路邊的起點，t 沿臨路方向，n 往宅地內，W 寬、D 深（都在 u/v 座標，方向只會是 ±u / ±v）
    let homes = 0;
    const home = (ou, ov, tu, tv, nu, nv, W, D) => {
      const P = (a, c) => ({ u: ou + tu * a + nu * c, v: ov + tv * a + nv * c });
      const R = (a0, c0, a1, c1, col, h, extra) => { const p = P(a0, c0), q = P(a1, c1); rect(Math.min(p.u, q.u), Math.min(p.v, q.v), Math.max(p.u, q.u), Math.max(p.v, q.v), col, h, extra); };
      const C = (a0, c0, a1, c1) => { const p = P(a0, c0), q = P(a1, c1); car(Math.min(p.u, q.u), Math.min(p.v, q.v), Math.abs(q.u - p.u), Math.abs(q.v - p.v)); };
      // 臨路方向與垂直方向在 u/v 座標中的名稱（屋脊大多與街道平行）
      const alongT = tu ? 'u' : 'v', alongN = tu ? 'v' : 'u';
      if (homes > 0 && r() > fill + 0.1) { const c = P(W / 2, D / 2); tree(c.u, c.v); if (r() < 0.6) { const c2 = P(W * 0.25, D * 0.3); tree(c2.u, c2.v, 0.8); } return; }
      homes++;
      const setback = 5.8, pw = 5.4, hw = Math.min(W - 2.2, 6.5 + r() * 2), hd = Math.min(D - 7, 7 + r() * 2.5);
      const left = r() < 0.5, ha = left ? W - 1 - hw : 1, pa = left ? 0.6 : W - 0.6 - pw;
      const roofC = tileOrSlate(0.85), wall = r() < 0.15 ? pick(r, BRICK) : facadeCol(), hh = 5 + lv * 0.7 + r();
      R(ha, setback, ha + hw, setback + hd, roofC, hh, {
        roof: r() < 0.45 ? 'hip' : 'gable', ridge: r() < 0.75 ? alongT : alongN, wall, win: true, door: true,
        chimney: r() < 0.6 ? 0.15 + r() * 0.7 : undefined, solar: r() < 0.25,
      });
      // L 型：後方加一翼（屋脊與主屋垂直）
      if (r() < 0.35 && setback + hd + 4.5 <= D - 1) {
        const wa = left ? ha : ha + hw * 0.45;
        R(wa, setback + hd - 0.5, wa + hw * 0.55, setback + hd + 4, roofC, hh * 0.9, { roof: 'gable', ridge: alongN, wall, win: true });
      }
      // 前院並排兩個停車位（不再有車庫，也不會前後擋住）
      R(pa, 0, pa + pw, setback - 0.4, '#bdb8ae');
      C(pa + 0.35, 0.4, pa + 2.35, 5.0); C(pa + 3.05, 0.4, pa + 5.05, 5.0);
      // 前院樹籬（停車位處留開口）
      if (r() < 0.75) { R(0.3, 0.2, pa - 0.3, 1, '#4c7a39', 1.3, { wall: '#43703a', deco: true }); R(pa + pw + 0.3, 0.2, W - 0.3, 1, '#4c7a39', 1.3, { wall: '#43703a', deco: true }); }
      if (r() < 0.8) { const c = P(ha + hw / 2, Math.min(D - 2, setback + hd + 2.5)); tree(c.u, c.v, 0.8); }
    };
    const lane = b.rows >= 6 && b.cols >= 6;
    if (!lane) {
      // 一排面向道路的宅地
      const D = Math.min(d, 24);
      for (let i = 0; i + 2 <= b.cols; i += 2) home(i * CELL, 0, 1, 0, 0, 1, 12, D);
    } else {
      // 中央巷道（盡頭迴車），巷道兩側的宅地面向巷道
      // 巷道是實際的場內道路（寬 8.6 m）時由路網畫出，只畫盡頭的迴車圓
      const lu = w / 2, le = b.roads ? 4.6 : 2.5;
      if (!b.roads) road([{ u: lu, v: 0 }, { u: lu, v: d - 7 }], 5);
      items.push({ t: 'circle', u: lu, v: d - 7, r: le + 3, c: b.roads ? '#878a8f' : '#5b5f64', h: 0 });
      // 巷口兩側先放面向主要道路的宅地
      for (let a = lu - le - 12; a >= 0; a -= 12) home(a, 0, 1, 0, 0, 1, 12, 12);
      for (let a = lu + le; a + 12 <= w; a += 12) home(a, 0, 1, 0, 0, 1, 12, 12);
      for (let v = 12; v + 12 <= d - 2; v += 12) {
        if (lu - le >= 12) home(lu - le, v + 12, 0, -1, -1, 0, 12, Math.min(lu - le, 22));
        if (w - lu - le >= 12) home(lu + le, v, 0, 1, 1, 0, 12, Math.min(w - lu - le, 22));
      }
    }
  } else if (b.zt === 'R2') {
    base = '#a9c48f';
    // 連棟住宅：一排排沿街，排與排之間是後院（樹籬分隔）
    // 停車：有巷道時沿巷道兩側；夠深（≥ 17 m）的臨路一排停車格；淺的地塊每戶門前一個車位
    const lu = w / 2, lane = !!b.roads;
    const parts = lane ? [[1.5, lu - 10], [lu + 10, w - 1.5]] : [[1.5, w - 1.5]];
    if (lane) {
      laneBays(lu, 2, d - 15);
      items.push({ t: 'circle', u: lu, v: d - 7, r: 7.6, c: '#878a8f', h: 0 });
    }
    const front = d >= 17;
    if (front) for (const [a, e] of parts) frontBays(a - 0.5, e + 0.5);
    let nb = 0;
    for (let v = front ? 7.5 : 5.8; v + 5 <= d; v += 18) {
      const v1 = Math.min(v + 9.5, d - 1.5);
      for (const [a, e] of parts) {
        if (e - a < 3) continue;
        // 每 24 m 一棟
        for (const [s0, s1] of split(a, e, 24)) {
          if (nb > 0 && r() > fill + 0.15) { tree((s0 + s1) / 2, v + 4.5); continue; }
          nb++;
          terrace(s0, s1, v, v1, !front && v < 6);
        }
        // 後院：樹籬分隔與樹
        if (v1 + 6 <= d) {
          hedge(a, v1 + 5.5, e, v1 + 6.2);
          for (let u = a + 4; u < e - 2; u += 12) if (r() < 0.5) tree(u, v1 + 3, 0.8);
        }
      }
    }
  } else if (b.zt === 'R3') {
    base = '#c9c3b5';
    // 周邊式街廓：大地塊切成邊長最多 48 m 的街廓，各自圍出中庭
    // 停車：有巷道時巷道兩側是停車格（巷道左右各一組街廓）；沒有時臨路一排停車格，建物退縮在後面
    const lu = w / 2;
    if (b.roads) {
      laneBays(lu, 2, d - 15);
      items.push({ t: 'circle', u: lu, v: d - 7, r: 7.6, c: '#878a8f', h: 0 });
      for (const [a, e] of [[0, lu - 9.8], [lu + 9.8, w]]) for (const [U0, U1] of split(a, e)) for (const [V0, V1] of split(0, d)) perimeterBlock(U0, V0, U1, V1);
    } else {
      const v0 = b.rows >= 3 ? 7 : 0;
      if (v0) frontBays(0.5, w - 0.5);
      for (const [U0, U1] of split(0, w)) for (const [V0, V1] of split(v0, d)) perimeterBlock(U0, V0, U1, V1);
    }
  } else if (b.zone === 'C') {
    base = '#c7c3b8';
    const real = !!b.roads, k = b.kind;
    if (k === 'bigbox') {
      // 大型量販店：前方大停車場（車道從臨路開進來）、後方大倉庫
      const bv = d * 0.45;
      parking(3, 2, w - 3, bv - 1, w / 2, real, 0.35 + lv * 0.15);
      rect(w * 0.12, bv + 1, w * 0.88, d - 4, pick(r, ['#d9d6cf', '#cfd3d6', '#d8d0c0']), 7 + lv, { wall: '#e4e1da', stripe: pick(r, ['#c8102e', '#005daa', '#e4002b', '#f2a900', '#2a9d3f']), units: 4, sky: true });
    } else if (k === 'mall' || k === 'market') {
      const pv = d * 0.32;
      parking(3, 2, w - 3, pv - 1, w / 2, real, 0.3 + lv * 0.15);
      if (k === 'mall') {
        rect(w * 0.15, pv + 2, w * 0.85, d - 4, '#e3ddd2', 8 + lv * 2, { wall: pick(r, ['#ece6da', '#e6d8c6', '#dfe3e6']), units: 5, sky: true });
        rect(w * 0.45, pv + 2, w * 0.55, d - 4, '#bcd6ee', 8.5 + lv * 2, { glass: true });
      } else rect(w * 0.1, pv + 2, w * 0.9, d - 3, pick(r, ['#93b9df', '#e4c9a8', '#c9d8b6', '#e8b9b0', '#d8c6e0']), 5 + lv, { wall: '#e8e2d4', awning: true, units: 3 });
    } else if (k === 'parking') {
      // 收費停車場：入口旁的收費亭與 P 字招牌，四角植栽
      parking(2, 2, w - 2, d - 2, w / 2, real, 0.4 + lv * 0.15);
      rect(w / 2 + 5, 1.2, w / 2 + 8, 4.2, '#e8e2d4', 3, { units: 0 });
      items.push({ t: 'sign', u: w / 2 - 7, v: 2.2, text: 'P', c: '#1d6fb8', h: 5 });
      tree(1.5, 1.5, 0.7); tree(w - 1.5, 1.5, 0.7); tree(1.5, d - 1.5, 0.7); tree(w - 1.5, d - 1.5, 0.7);
    } else if (k === 'hotel') {
      // 大飯店：折線屋頂的 U 型主樓（夠寬才有兩側翼），前庭落客車道與花壇，臨路停車格與地下停車場，後方花園與泳池
      const s = Math.min(w, d), fv = Math.max(d * 0.26, 8.5), md = Math.min(16, d * 0.3);
      const hh = 15 + lv * 3 + Math.min(9, s * 0.1), rc = pick(r, SLATE), wall = pick(r, ['#efe6d6', '#f1ead9', '#e9dcc4', '#e8d5c4', '#dfe3e6']);
      garageRamp(Math.round(b.cols * b.rows * 0.4));
      frontBays(0.5, w * 0.3 - 3.2); frontBays(w * 0.7 + 3.2, w - 6.5);
      rect(w * 0.1, fv, w * 0.9, fv + md, rc, hh, { roof: 'mansard', ridge: 'u', wall, win: true, units: 2 });
      const ww = Math.min(12, w * 0.2 - 3);
      if (ww >= 6 && fv > 12) for (const u0 of [w * 0.1, w * 0.9 - ww]) rect(u0, 7, u0 + ww, fv, rc, hh - 3, { roof: 'mansard', ridge: 'v', wall, win: true });
      rect(w * 0.42, fv - 2, w * 0.58, fv, '#d7c9a7', 4);
      rect(w * 0.3, d * 0.72, w * 0.6, d * 0.72 + Math.min(8, s * 0.18), '#5fc4e8', 0);
      road([{ u: w * 0.3, v: 0 }, { u: w * 0.3, v: fv - 3 }, { u: w * 0.7, v: fv - 3 }, { u: w * 0.7, v: 0 }], 4.5);
      rect(w * 0.36, 1, w * 0.64, fv - 5.5, '#7fb069');
      hedge(w * 0.36, 1, w * 0.64, 1.7);
      for (let i = 0; i < 6; i++) tree(4 + r() * (w - 8), d * 0.66 + r() * (d * 0.32), 0.9);
    } else if (k === 'office') {
      // 辦公大樓：臨路停車格、側邊地下停車場入口；石材基座＋玻璃帷幕主樓，前廣場
      const tw = (w - 10) * 0.8, td = (d - 12) * 0.75, th = 16 + lv * 9 + Math.min(18, Math.min(w, d) * 0.25) + r() * 5;
      garageRamp(Math.round(b.cols * b.rows * 0.5));
      frontBays(0.5, w - 6.5);
      rect(3, 6.4, w - 7, 8.4, '#d9d6cf');
      rect(w / 2 - tw / 2 - 2, d / 2 - td / 2 + 1, w / 2 + tw / 2 + 2, d / 2 + td / 2 + 5, pick(r, ['#b9b4aa', '#c4bfb3', '#a9a59c']), 6, { wall: pick(r, ['#d8d2c4', '#cfc6b4', '#e0dbd0']), win: true });
      rect(w / 2 - tw / 2, d / 2 - td / 2 + 3, w / 2 + tw / 2, d / 2 + td / 2 + 3, pick(r, ['#7fa7c9', '#8fb7d6', '#9bb0c4', '#6f93b3', '#8aa6a0', '#a2a9b8']), th, { glass: true, units: 2 });
      tree(w - 3, d - 3, 0.8);
    } else if (k === 'gas') {
      // 加油站：前方頂棚與加油島、後方便利商店，兩個出入口
      base = '#b9b6ae';
      road([{ u: 3, v: 0 }, { u: 3, v: d * 0.55 }, { u: w - 3, v: d * 0.55 }, { u: w - 3, v: 0 }], 4.5);
      rect(w * 0.18, d * 0.12, w * 0.82, d * 0.45, '#f1f1ef', 4.5, { canopy: pick(r, ['#d62828', '#1d6fb8', '#2a9d3f', '#f2a900']) });
      for (let i = 0; i < 3; i++) {
        const iu = w * (0.28 + i * 0.2);
        rect(iu - 0.8, d * 0.25, iu + 0.8, d * 0.32, '#5b5f64', 1.2);
        // 加油位：加油島左側，車頭朝路（直接從道路開進來）
        car(iu - 3.05, d * 0.2, 1.9, Math.min(4.4, d * 0.2));
      }
      rect(w * 0.25, d * 0.66, w * 0.75, d - 2, '#e8e2d4', 3.5, { wall: '#e8e2d4', awning: true });
    } else {
      // 商店街：連續立面的街屋（一樓店面＋遮陽棚，樓上住家）
      // 停車：有場內道路時在後方停車場（車位都在車道兩側，車子沿車道開進去）；
      // 沒有時停車格在店面前方（直接從道路進出），部分做成加油站那樣的前庭：左進右出的車道＋靠店面的停車格
      const forecourt = !real && b.rows >= 4 && b.cols >= 6 && r() < 0.4;
      let sv = 2.4;
      if (forecourt) {
        rect(1, 0.3, w - 1, 14, '#8a8d91');
        line([{ u: 4, v: 1.2 }, { u: 4, v: 5 }], 'rgba(255,255,255,0.85)', 0.3);
        line([{ u: w - 4, v: 5 }, { u: w - 4, v: 1.2 }], 'rgba(255,255,255,0.85)', 0.3);
        for (let u = 2; u + 2.6 <= w - 2; u += 2.7) { line([{ u, v: 8.8 }, { u, v: 13.8 }], 'rgba(255,255,255,0.85)', 0.2); car(u + 0.45, 9.2, 1.8, 4.3); }
        sv = 14.6;
      } else if (!real) {
        frontBays(1, w - 1);
        sv = 7.2;
      }
      const back = real ? Math.min(b.rows, 2) * CELL - 1 : Math.min(d - 1, sv + Math.max(5, Math.min(12, d - sv - 1)));
      const gap = real, rc = pick(r, TILE);
      let u = 1, nShop = 0;
      while (u < w - 4) {
        let sw = Math.min(w - 1 - u, 7 + r() * 9);
        if (gap && u < w / 2 + 4 && u + sw > w / 2 - 4) { if (u < w / 2 - 6) sw = w / 2 - 4 - u; else { u = w / 2 + 4; continue; } }
        if (nShop++ === 0 || r() < fill + 0.15) {
          const mans = r() < 0.3;
          rect(u, sv, u + sw, back, mans ? pick(r, SLATE) : r() < 0.6 ? rc : pick(r, TILE), 7 + lv * 2.5 + r() * 2,
            { roof: mans ? 'mansard' : 'gable', ridge: 'u', wall: facadeCol(), win: true, shop: pick(r, AWN), chimney: !mans && r() < 0.4 ? r() : undefined });
          // 人行道咖啡座（店面前沒有停車格時）
          if (real && r() < 0.4 && sw > 5) for (let k2 = 0; k2 * 2.6 + 2.4 < sw - 1; k2++) items.push({ t: 'circle', u: u + 1.6 + k2 * 2.6, v: 1.2, r: 0.95, c: pick(r, UMB), h: 2.2, umb: true, deco: true });
        } else tree(u + sw / 2, (sv + back) / 2, 0.9);
        u += sw;
      }
      if (real && d - back > 12) {
        // 後方停車場：只沿實際車道兩側，其餘是植栽
        parking(w / 2 - 10, back + 2, w / 2 + 10, d - 2, w / 2, true, 0.3 + lv * 0.12, true, true);
        for (let v = back + 5; v < d - 3; v += 9) { if (w / 2 - 14 > 2) tree(w / 2 - 14, v, 0.9); if (w / 2 + 14 < w - 2) tree(w / 2 + 14, v, 0.9); }
      } else if (!real && d - back > 4) for (let uu = 5; uu < w - 3; uu += 10) tree(uu, (back + d) / 2, 0.8);
    }
  } else {
    base = '#bab4a7';
    // 工業區：從路邊進入的主幹道，大地塊再加一條橫向道路，建築依功能不同
    // 窄的工業地塊（不到 8 格、沒有場內道路）：前院貨車位與員工停車位＋後方一棟廠房
    const compact = !b.roads && b.cols < 8;
    const spine = w / 2, cross = !compact && b.rows >= 10 ? d * 0.55 : null;
    // 主幹道兩側 3 m 寬的裝卸區（建物從主幹道 8.5 m 外開始），貨車停在畫好的車位上
    // 每側要有 17 m 以上才放裝卸區；窄的園區建物直接靠著主幹道
    const strip = !compact && spine - 3 >= 17, gapS = strip ? 8.5 : 5;
    for (const sd of strip ? [-1, 1] : []) {
      const u0 = sd < 0 ? spine - 7.9 : spine + 5.5;
      if (u0 < 1 || u0 + 2.4 > w - 1) continue;
      rect(u0 - 0.2, 4, u0 + 2.6, d - 5, '#9c978b');
      for (let v = 6; v + 7.5 < d - 6; v += 10) {
        if (cross && v + 7.5 > cross - 5 && v < cross + 5) continue;
        line([{ u: u0 - 0.2, v: v - 1 }, { u: u0 + 2.6, v: v - 1 }], 'rgba(255,255,255,0.7)', 0.2);
        car(u0, v, 2.4, 7.2, { c: pick(r, ['#d8d8d8', '#e0b24f', '#2e6fb7', '#c0392b']), h: 0.8, truck: true });
      }
    }
    // 有實際的廠區道路時由路網繪製，這裡只畫裝飾用的
    if (!b.roads && !compact) {
      road([{ u: spine, v: 0 }, { u: spine, v: d - 4 }], 7);
      if (cross) road([{ u: 4, v: cross }, { u: w - 4, v: cross }], 7);
    }
    const blocks = [];
    if (compact) {
      const fy = Math.min(9, Math.max(5, d * 0.3));
      rect(2, 0.5, w - 2, fy, '#9c978b');
      let u = 3;
      for (; u + 2.6 <= w - 3 && u < 3 + 3 * 3.2; u += 3.2) car(u, 1, 2.4, Math.min(7.2, fy - 1.4), { c: pick(r, ['#d8d8d8', '#e0b24f', '#2e6fb7', '#c0392b']), h: 0.8, truck: true });
      // 員工停車位
      if (fy >= 5.7) for (u += 0.6; u + 2.2 <= w - 2.5; u += 2.7) { line([{ u: u - 0.4, v: 0.8 }, { u: u - 0.4, v: 5.6 }], 'rgba(255,255,255,0.7)', 0.2); car(u, 1, 1.8, 4.3); }
      blocks.push([2.5, fy + 1, w - 2.5, d - 2]);
    } else if (d >= 30) {
      // 臨路的員工停車場（避開主幹道路口；地塊夠深才有）
      frontBays(1, spine - 9.5, 0.6); frontBays(spine + 9.5, w - 1, 0.6);
    }
    const top = compact ? 0 : d >= 30 ? 8 : 3;
    for (const [u0, u1] of compact ? [] : [[3, spine - gapS], [spine + gapS, w - 3]]) {
      if (u1 - u0 < 4) continue;
      if (cross) { blocks.push([u0, top, u1, cross - 5.5], [u0, cross + 5.5, u1, d - 3]); } else blocks.push([u0, top, u1, d - 3]);
    }
    const k = b.kind;
    let built = 0;
    for (const [u0, v0, u1, v1] of blocks) {
      if (v1 - v0 < 4) continue;
      // 至少蓋一棟主建物，其餘依等級改為貨櫃堆場（不會留下空地）
      if (built++ > 0 && r() > fill + 0.2) { yard(u0, v0, u1, v1); continue; }
      if (k === 'chemical') {
        // 儲槽區：四周防溢堤、中間管線，儲槽為浮頂式圓柱
        line([{ u: u0 + 0.4, v: v0 + 0.4 }, { u: u1 - 0.4, v: v0 + 0.4 }, { u: u1 - 0.4, v: v1 - 0.4 }, { u: u0 + 0.4, v: v1 - 0.4 }, { u: u0 + 0.4, v: v0 + 0.4 }], '#d4d0c6', 0.9);
        line([{ u: u0 + 1.5, v: (v0 + v1) / 2 }, { u: u1 - 1.5, v: (v0 + v1) / 2 }], '#8a9096', 0.6);
        const n = Math.max(1, Math.floor(Math.min(u1 - u0, v1 - v0) / 12));
        const rr = Math.min(u1 - u0, v1 - v0) / (2 * n) * 0.8, tc = pick(r, ['#dfe3e6', '#e8e4da', '#d5dde3']);
        for (let i = 0; i < n; i++) for (let j = 0; j < Math.max(1, Math.floor((v1 - v0) / (rr * 2.4))); j++) items.push({ t: 'circle', u: u0 + rr * 1.2 + i * rr * 2.4, v: v0 + rr * 1.2 + j * rr * 2.4, r: rr, c: tc, h: 5 + lv * 1.5 });
      } else if (k === 'logistics') {
        rect(u0, v0, u1, v1, pick(r, ['#cfcac0', '#c4c9cc', '#d3ccbc']), 5 + lv, { wall: pick(r, ['#d9d6cf', '#c9d3dc', '#d8cbb5', '#b9c4b4', '#d6c4b0']), sky: true, docks: true });
      } else if (k === 'food') {
        // 食品廠：廠房＋一排筒倉
        const mv = v0 + (v1 - v0) * 0.62;
        rect(u0, v0, u1, mv - 1, '#d8d2c2', 4 + lv, { wall: pick(r, ['#e6e1d6', '#e8dcc4', '#dfe6e0']), win: true, sky: true });
        const sr = Math.min(2.8, (v1 - mv) / 2 - 0.5);
        if (sr > 1.2) for (let u = u0 + sr + 1; u + sr <= u1 - 1; u += sr * 2 + 0.8) items.push({ t: 'circle', u, v: (mv + v1) / 2, r: sr, c: '#e6e6e2', h: 12 + lv * 2 });
      } else if (k === 'tech') {
        // 科技園區：低矮玻璃建築、綠屋頂
        rect(u0 + 2, v0 + 2, u1 - 2, v1 - 2, '#8fae6a', 4 + lv * 2, { wall: pick(r, ['#a9c0d2', '#b8c8c0', '#c2c9d6']), glass: true });
        tree(u0 + 1, v0 + 1, 0.8); tree(u1 - 1, v1 - 1, 0.8);
      } else {
        // 製造工廠：紅磚廠房、鋸齒屋頂（北向採光窗）、磚造煙囪
        rect(u0, v0, u1, v1, '#9b958c', 6 + lv * 1.5, { roof: 'saw', wall: pick(r, BRICK), win: true });
        items.push({ t: 'circle', u: u1 - 3, v: v0 + 3, r: 1.4, c: '#8e4f3c', h: 18, stack: true });
      }
    }
  }
  // 小客車停車位：依 slot 值排序，前 b.parked 個有車（貨車車位另外依使用率顯示）
  const slots = items.filter(it => it.slot !== undefined && !it.truck).sort((p, q) => p.slot - q.slot);
  slots.forEach((it, i) => { it.rank = i; });
  return { base, items, slots };
}

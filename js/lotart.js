// 地塊上的建築圖形（日式風格；以地塊區域座標 u：沿路方向 0~w、v：離路方向 0~d 產生，渲染時再轉成世界座標）
import { CELL } from './config.js';

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const shadeHex = (hex, f) => '#' + [1, 3, 5].map(i => Math.round(Math.min(255, parseInt(hex.slice(i, i + 2), 16) * f)).toString(16).padStart(2, '0')).join('');
const CARS = ['#e8e8e8', '#2b2b2b', '#c0392b', '#2e6fb7', '#8e9aa6', '#f1c40f', '#1e8449', '#7f8c8d'];
// 日式：黑灰 / 銀灰的日本瓦、藍灰釉瓦、褐色瓦；彩色鋼板屋頂；白、米、淺灰的外牆（窯業系外牆板）、木色與深色的現代住宅；
// 公寓 / 大樓的磁磚外牆
const KAWARA = ['#4a4f57', '#3f444c', '#565c64', '#5d636b', '#4c5d73', '#465566', '#6a5446', '#7a5a44', '#505860', '#62686f'];
const METAL = ['#6f7a83', '#5e7a62', '#8a4b3a', '#3f6a8a', '#7d8a8f', '#9a4f3e', '#4f5a62', '#6b5a4a'];
const JWALL = ['#f2efe8', '#ebe6db', '#e2ddd2', '#f5f2ec', '#e8e0d0', '#d9d4ca', '#ece4d6', '#cfc9be', '#e6dccb', '#f0ebe0', '#ddd6c8', '#e9e2d2'];
const JWOOD = ['#8a6a4a', '#7a5c40', '#9c7a56', '#6e5440'];
const JDARK = ['#4f4c48', '#5a5752', '#45484c', '#6b6862'];
const TILEWALL = ['#f1ede4', '#e7e1d4', '#d9d3c6', '#e9dfd0', '#cfc8bb', '#e3d6c3', '#c9c4bb', '#d8cdbd', '#bfb5a6', '#e0dcd5'];
const METALWALL = ['#c9d0d6', '#b8c4cc', '#d6d3cc', '#a9b6c0', '#d2d6d0', '#bcc6c2'];
const AWN = ['#8c2f2f', '#2f5d3a', '#24476b', '#b5823a', '#5a3d6b', '#3d6b6b', '#c0392b', '#e0b040'];
// 商店街的直立看板（文字為一般店種）
const KANBAN = [['#c0392b', '#fff'], ['#f4f1e8', '#b03a2e'], ['#f2c230', '#2b2b2b'], ['#24476b', '#fff'], ['#2f5d3a', '#fff'], ['#1f1f1f', '#f2c230']];
const KANJI = ['ラーメン', '居酒屋', '薬局', '書店', '喫茶', '寿司', '花屋', 'そば', '酒', '本', '洋品店', '焼肉', '歯科', '不動産', '珈琲', '定食'];
const BOX = ['#b5523b', '#2e6fb7', '#1e8449', '#d8a13a', '#8e9aa6', '#7d3c98', '#c0392b'];

// 大型停車場除了中央主車道以外的其他車道位置（每 19 m 一條；每條車道兩側各一排停車格），city.driveway 依此開出真的場內道路
export function lotAisles(u0, u1, spine) {
  const out = [];
  for (let a = spine - 19; a - 9.3 >= u0; a -= 19) out.push(a);
  for (let a = spine + 19; a + 9.3 <= u1; a += 19) out.push(a);
  return out;
}
// 地下 / 立體停車場前的單向車道：從入口（ua 或 ub）開進來、沿停車場入口前方（離路邊 cv 公尺）、從另一端開出去
// 停車場的室內車位都在這條車道旁，等著進場的車不會停在外面的道路上；city.driveway 依此開路
// deck：立體停車場（gu0~gu1、深到 gv1）；否則是地下停車場坡道
export function garageDrive(zt, kind, cols, rows) {
  const w = cols * CELL, d = rows * CELL;
  if (kind === 'mallp') { const gu1 = w * 0.44; return { deck: true, gu0: 3, gu1, gv1: d * 0.46, ua: 6, ub: gu1 - 3, cv: 9 }; }
  if (zt === 'R3' && kind == null && cols >= 6 && rows >= 5) {
    if (w >= 40 && d >= 30 && cols % 2 === 0) return { deck: true, gu0: w - 21, gu1: w - 1.5, gv1: Math.min(d - 1.5, 46), ua: w - 20, ub: w - 3, cv: 7 };
    return { deck: false, ua: w - 16, ub: w - 3, cv: 7 };
  }
  return null;
}
// 量販店 / 購物中心 / 超市的停車場是單向環狀動線（一進一出），city.driveway 依此開路
export function oneWayLot(kind, aisles) { return (kind === 'bigbox' || kind === 'mall' || kind === 'market') && aisles.length >= 1; }
// 大型商業的停車場範圍（與 lotArt 的配置一致）：{ u0, v0, u1, v1 }
export function lotParkArea(kind, w, d) {
  if (kind === 'bigbox') return { u0: 3, v0: 2, u1: w - 7.6, v1: d * 0.45 - 1 };
  if (kind === 'mall' || kind === 'market') return { u0: 3, v0: 2, u1: w - 7.6, v1: d * 0.32 - 1 };
  if (kind === 'parking') return { u0: 2, v0: 2, u1: w - 2, v1: d - 2 };
  return null;
}

// 回傳 { base, items, slots, tslots }：items 依序繪製；slots 為小客車車位、tslots 為貨車車位（卸貨區）
// rect：{ u0, v0, u1, v1, c（屋頂色）, h（高度）, wall, roof（gable 雙坡 / hip 四坡 / mansard 折線 / saw 鋸齒，沒有就是平屋頂）, ridge（屋脊方向 u / v）,
//         win（窗）, door, shop（一樓店面遮陽棚色）, chimney（煙囪在屋脊上的位置 0~1）, solar, sky（天窗）, glass, units（屋頂設備）, deco（樹籬等裝飾，不算建物） }
// circle：{ u, v, r, c, h, tree, umb（陽傘）, stack（煙囪冒煙） }、line：{ pts, c, w, dash }
// 停車位都在室外、車頭朝向一條道路（臨路或場內道路），車子從道路直直開進去，不會穿過建物或其他車位
export function lotArt(b) {
  const r = rng(b.id * 97 + b.cols * 13 + b.rows), w = b.cols * CELL, d = b.rows * CELL, lv = b.level, items = [];
  const rect = (u0, v0, u1, v1, c, h = 0, extra = {}) => items.push({ t: 'rect', u0, v0, u1, v1, c, h, ...extra });
  // 樹：一成是櫻花，其餘是較深的綠（松、樟等常綠樹）
  const tree = (u, v, s = 1) => items.push({ t: 'circle', u, v, r: (2 + r() * 1.4) * s, c: r() < 0.1 ? pick(r, ['#f2b8c8', '#efc3d0', '#f4cad6']) : pick(r, ['#3f7a3a', '#4f8a3c', '#35683a', '#2f5d3a', '#5d8f47']), h: 4 + r() * 3, tree: true });
  const hedge = (u0, v0, u1, v1) => { if (u1 - u0 > 0.8 && v1 - v0 > 0.4) rect(u0, v0, u1, v1, '#4c7a39', 1.3, { wall: '#43703a', deco: true }); };
  // 水泥磚圍牆（日本住宅常見的低牆）
  const blockWall = (u0, v0, u1, v1) => { if (u1 - u0 > 0.8 || v1 - v0 > 0.8) rect(u0, v0, u1, v1, '#c3bfb5', 1.4, { wall: '#b9b5ab', deco: true }); };
  const road = (pts, wd = 5) => items.push({ t: 'line', pts, c: '#5b5f64', w: wd });
  const line = (pts, c, wd, dash) => items.push({ t: 'line', pts, c, w: wd, dash });
  const car = (u0, v0, du, dv, extra = {}) => items.push({ t: 'rect', u0, v0, du, dv, c: pick(r, CARS), h: 0.4, car: true, slot: r(), ...extra });
  const roofCol = (p = 0.7) => (r() < p ? pick(r, KAWARA) : pick(r, METAL));
  const facadeCol = () => { const x = r(); return pick(r, x < 0.72 ? JWALL : x < 0.88 ? JWOOD : JDARK); };
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
  // 卸貨區：臨路一個貨車車位（車頭朝路，直接開進 / 開出；黃框標示），u0~u0+3.4
  const loadingBay = (u0, v0 = 0.4) => {
    rect(u0, v0, u0 + 3.4, v0 + 8.2, '#878a8f');
    line([{ u: u0 + 0.2, v: v0 + 0.2 }, { u: u0 + 3.2, v: v0 + 0.2 }, { u: u0 + 3.2, v: v0 + 8 }, { u: u0 + 0.2, v: v0 + 8 }, { u: u0 + 0.2, v: v0 + 0.2 }], '#e8c547', 0.25);
    car(u0 + 0.45, v0 + 0.5, 2.5, 7.2, { c: '#d8d0c0', h: 0.8, truck: true });
  };
  // 停車場：沿車道兩側畫停車格（每格 2.6 m × 5 m）；spineOnly 只沿主車道
  // real：有場內道路——每條車道（間距 19 m）與底部的橫向車道都是真的道路（由路網畫出），車子沿車道開到車位旁才轉進去
  // top0：停車格從哪裡開始（單向停車場前方有分配車道，停車格往後退）
  const parking = (u0, v0, u1, v1, spine, real, occ, fromBack = false, spineOnly = false, top0 = null) => {
    rect(u0, v0, u1, v1, '#7f8287');
    const aisles = [spine];
    if (!spineOnly && real) aisles.push(...lotAisles(u0, u1, spine));
    else if (!spineOnly) {
      for (let a = spine - 17; a - 8 >= u0; a -= 17) aisles.push(a);
      for (let a = spine + 17; a + 8 <= u1; a += 17) aisles.push(a);
    }
    const top = top0 ?? v0 + 1, bot = v1 - (real && aisles.length > 1 ? 9.5 : 7);
    for (const a of aisles) {
      // 實際的場內道路寬 8.6 m；裝飾用的通道 6 m
      const ah = real ? 4.3 : 3;
      if (!real) rect(a - 3, v0, a + 3, v1 - 1, '#878a8f');
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
    // 底部橫向通道把各車道連起來（有場內道路時是真的道路）
    if (aisles.length > 1 && !real) rect(u0 + 1, v1 - 6.5, u1 - 1, v1 - 0.5, '#878a8f');
  };
  // 地下停車場入口坡道（臨路、靠地塊右側），以及看不見的室內車位（只用於商業大樓）
  // 坡道內左右兩條車道（進 / 出可以同時），室內車位輪流分在兩條車道
  const garageRamp = (n, uc = w - 3.25, v0 = 0) => {
    const u0 = uc - 2.75, u1 = uc + 2.75;
    rect(u0, v0, u1, v0 + 9, '#5b5f64');
    rect(u0 + 0.6, v0 + 5.5, u1 - 0.6, v0 + 9, '#2b2e33');
    // 臨路的坡道：室內車位在坡道裡；接場內車道的坡道：入口車道（靠車道入口那側）與出口車道分開，
    // 車子從入口車道開進去、從出口車道開出來（out），進出的車不會互擋
    if (!v0) { for (let i = 0; i < n; i++) items.push({ t: 'rect', u0: uc - 0.9 + (i % 2 ? 1.35 : -1.35), v0: 6, du: 1.8, dv: 3, c: pick(r, CARS), h: 0.4, car: true, slot: 0.5 + r() * 0.5, indoor: true }); return; }
    const ui = uc - 1.35 * inDir, uo = uc + 1.35 * inDir;
    for (let i = 0; i < n; i++) items.push({ t: 'rect', u0: ui - 0.9, v0: v0 + 0.3, du: 1.8, dv: 3, c: pick(r, CARS), h: 0.4, car: true, slot: 0.5 + r() * 0.5, indoor: true, out: { u: uo, v: v0 + 1.8 } });
  };
  // 立體停車場（u0~u1、v0~v1，入口在臨路的 v0 側中央）：清水模的多層停車樓，每層開口；車子在入口開進去（室內車位，看不到）
  // 寬的停車樓有兩個入口；每個入口兩條車道，室內車位輪流分在各車道（多台車可以同時進出）
  // sv：室內車位（入口車道）的位置，在停車樓前緣 v0 之前
  const deckGarage = (u0, v0, u1, v1, n, H, sv) => {
    rect(u0, v0, u1, v1, '#a9a69f', H, { wall: '#c9c6bf', win: true, balc: 'rgba(60,62,66,0.55)', balc0: 0, units: 0, deck: true });
    // 入口與出口分開：靠車道入口那側的是入口（兩條車道），另一側是出口；只有一個開口時左右兩條車道分別進出
    const ents = u1 - u0 >= 30 ? [u0 + (u1 - u0) * 0.27, u0 + (u1 - u0) * 0.73] : [(u0 + u1) / 2];
    for (const uc of ents) rect(uc - 3.4, sv - 0.2, uc + 3.4, v0, '#5b5f64');
    if (inDir < 0) ents.reverse();
    const ins = ents.length > 1 ? [ents[0] - 1.6, ents[0] + 1.6] : [ents[0] - 1.6 * inDir], outs = ents.length > 1 ? [ents[1] - 1.6, ents[1] + 1.6] : [ents[0] + 1.6 * inDir];
    items.push({ t: 'sign', u: u1 - 1.5, v: v0 - 0.5, text: 'P', c: '#1d6fb8', h: 6 });
    for (let i = 0; i < n; i++) items.push({ t: 'rect', u0: ins[i % ins.length] - 0.9, v0: sv, du: 1.8, dv: 2.6, c: pick(r, CARS), h: 0.4, car: true, slot: 0.4 + r() * 0.6, indoor: true, out: { u: outs[i % outs.length], v: sv + 1.3 } });
  };
  // 停車場前單向車道的入口在哪一端：臨路車道往 +u 行駛時入口在 u 小的那端（inDir = 1），否則在另一端
  const inDir = b.tx === undefined || -b.ty * b.nx + b.tx * b.ny > 0 ? 1 : -1;
  // 停車場前的單向車道：有場內道路時由路網畫出，沒有時畫裝飾用的
  const drive = gd => { if (!b.roads) road([{ u: gd.ua, v: 0 }, { u: gd.ua, v: gd.cv }, { u: gd.ub, v: gd.cv }, { u: gd.ub, v: 0 }], 4.5); };
  // 把 a~b 平均切成長度不超過 max 的幾段
  const split = (a, b, max = 48) => { const k = Math.max(1, Math.ceil((b - a) / max - 1e-6)), L = (b - a) / k, out = []; for (let i = 0; i < k; i++) out.push([a + L * i, a + L * (i + 1)]); return out; };
  // 一棟日式集合住宅（u0~u1、v0~v1，長邊沿 u）：
  // - アパート（木造 / 輕鋼構兩層公寓）：低斜度鋼板雙坡屋頂、外走廊
  // - マンション（三～五層）：平屋頂、磁磚外牆、每層陽台
  const apartment = (u0, u1, v0, v1, mansion) => {
    if (mansion) rect(u0, v0, u1, v1, '#b9b6ae', 9 + lv * 2.5 + Math.floor(r() * 2) * 3, { wall: pick(r, TILEWALL), win: true, balc: true, door: true, units: 1 });
    else rect(u0, v0, u1, v1, pick(r, METAL), 6.8, { roof: 'gable', ridge: 'u', wall: pick(r, JWALL), win: true, balc: pick(r, ['#e8e6e0', '#8a8f94', '#c9c4b8']), balc0: 1, door: true });
  };
  // 團地式的板狀大樓（沿 u），8～15 層，每層陽台
  const slab = (u0, u1, v0, v1, H) => rect(u0, v0, u1, v1, '#b3b0a8', H, { wall: pick(r, TILEWALL), win: true, balc: true, units: Math.max(1, Math.round((u1 - u0) / 20)) });
  // 高密度街區：一塊範圍內放塔式住宅（タワーマンション，夠大才有）或平行排列的板狀大樓，大樓之間是綠地
  const housingBlock = (U0, V0, U1, V1) => {
    const W = U1 - U0, D = V1 - V0;
    if (W < 6 || D < 6) return;
    if (Math.min(W, D) >= 30 && r() < 0.3 + lv * 0.12) {
      // 塔式住宅：方形塔樓＋低層裙樓，周圍植栽
      const s0 = Math.min(W, D) * 0.55, cu = (U0 + U1) / 2, cv = (V0 + V1) / 2;
      rect(cu - s0 / 2 - 3, cv - s0 / 2 - 3, cu + s0 / 2 + 3, cv + s0 / 2 + 3, '#b9b6ae', 7, { wall: pick(r, TILEWALL), win: true, shop: lv > 1 ? pick(r, AWN) : undefined });
      const H = 50 + lv * 22 + Math.min(30, s0) + r() * 15;
      rect(cu - s0 / 2, cv - s0 / 2, cu + s0 / 2, cv + s0 / 2, '#c9c6be', H, { wall: pick(r, TILEWALL), win: true, balc: true, units: 3, tier: 1, base: [cu - s0 / 2 - 3, cv - s0 / 2 - 3, cu + s0 / 2 + 3, cv + s0 / 2 + 3] });
      items[items.length - 2].tier = 0; items[items.length - 2].base = items[items.length - 1].base;
      tree(U0 + 2.5, V0 + 2.5, 0.9); tree(U1 - 2.5, V1 - 2.5, 0.9); tree(U0 + 2.5, V1 - 2.5, 0.8);
      return;
    }
    // 板狀大樓：每排深 11 m，排與排之間留 13 m 綠地
    const H = 22 + lv * 7 + r() * 6;
    let n = 0;
    for (let v = V0 + 1; v + 9 <= V1 - 1; v += 24) {
      const v1 = Math.min(v + 11, V1 - 1);
      for (const [a, e] of split(U0 + 1, U1 - 1, 60)) {
        if (e - a < 6) continue;
        if (n++ > 0 && r() > fill + 0.15) { tree((a + e) / 2, (v + v1) / 2); continue; }
        slab(a, e, v, v1, H + (r() - 0.5) * 4);
      }
      if (v1 + 13 <= V1) { rect(U0 + 1, v1 + 1.5, U1 - 1, Math.min(V1 - 1, v1 + 11.5), '#9fbf86'); for (let u = U0 + 5; u < U1 - 4; u += 11) if (r() < 0.6) tree(u, v1 + 6.5, 0.9); }
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
    // 每戶一塊 12 m 寬的宅地：前院樹籬、前院並排三個室外停車位（直接從道路 / 巷道開進去）
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
      // 日式透天：兩層樓、外牆板；七成是寄棟（四坡）或切妻（雙坡）的日本瓦 / 鋼板屋頂，三成是平屋頂的現代箱型住宅
      const setback = 5.8, pw = 8.1, hw = Math.min(W - 2.2, 6.2 + r() * 1.8), hd = Math.min(D - 7, 6.8 + r() * 2);
      const left = r() < 0.5, ha = left ? W - 1 - hw : 1, pa = left ? 0.6 : W - 0.6 - pw;
      const box = r() < 0.3, roofC = roofCol(0.75), wall = facadeCol(), hh = 6.6 + lv * 0.4 + r() * 0.8;
      if (box) R(ha, setback, ha + hw, setback + hd, '#b9b6ae', hh + 0.6, { wall: r() < 0.5 ? pick(r, JDARK) : pick(r, JWALL), win: true, door: true, units: r() < 0.5 ? 1 : 0 });
      else R(ha, setback, ha + hw, setback + hd, roofC, hh, { roof: r() < 0.55 ? 'hip' : 'gable', ridge: r() < 0.7 ? alongT : alongN, wall, win: true, door: true, solar: r() < 0.3 });
      // 一樓突出的和室 / 客廳（平屋頂或單坡）
      if (r() < 0.4 && setback + hd + 3.5 <= D - 1) {
        const wa = left ? ha : ha + hw * 0.45;
        R(wa, setback + hd - 0.3, wa + hw * 0.55, setback + hd + 3.2, box ? '#b9b6ae' : roofC, 3.4, box ? { wall } : { roof: 'hip', ridge: alongT, wall, win: true });
      }
      // 前院並排三個停車位（碎石 / 水泥地）
      R(pa, 0, pa + pw, setback - 0.4, r() < 0.5 ? '#bdb8ae' : '#c9c4b8');
      for (let k = 0; k < 3; k++) C(pa + 0.35 + k * 2.7, 0.4, pa + 2.35 + k * 2.7, 5.0);
      // 前院：水泥磚圍牆或綠籬（停車位處留開口），庭院樹
      const fence = r() < 0.6 ? blockWall : r() < 0.6 ? hedge : null;
      if (fence) { const a = P(0.3, 0.2), e = P(pa - 0.3, 1), a2 = P(pa + pw + 0.3, 0.2), e2 = P(W - 0.3, 1);
        fence(Math.min(a.u, e.u), Math.min(a.v, e.v), Math.max(a.u, e.u), Math.max(a.v, e.v)); fence(Math.min(a2.u, e2.u), Math.min(a2.v, e2.v), Math.max(a2.u, e2.u), Math.max(a2.v, e2.v)); }
      if (r() < 0.8) { const c = P(ha + hw / 2, Math.min(D - 2, setback + hd + 2.5)); tree(c.u, c.v, 0.7); }
      if (r() < 0.4) { const c = P(left ? 1.8 : W - 1.8, Math.min(D - 2, setback + 1.5)); tree(c.u, c.v, 0.55); }
    };
    const lane = b.rows >= 6 && b.cols >= 6;
    if (!lane) {
      // 一排面向道路的宅地
      const D = Math.min(d, 24);
      for (let i = 0; i + 2 <= b.cols; i += 2) home(i * CELL, 0, 1, 0, 0, 1, 12, D);
    } else {
      // 中央巷道（盡頭不做迴車圓，只給住戶進出），巷道兩側的宅地面向巷道；巷道是實際的場內道路時由路網畫出
      const lu = w / 2, le = b.roads ? 4.6 : 2.5;
      if (!b.roads) road([{ u: lu, v: 0 }, { u: lu, v: d - 7 }], 5);
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
    // 日式集合住宅：一排排沿街的アパート（兩層、外走廊）與低層マンション（三～五層、陽台），排與排之間是綠地與圍牆
    // 停車：有巷道時沿巷道兩側；夠深（≥ 17 m）的臨路一排停車格；淺的地塊每戶門前一個車位
    const lu = w / 2, lane = !!b.roads;
    const parts = lane ? [[1.5, lu - 10], [lu + 10, w - 1.5]] : [[1.5, w - 1.5]];
    if (lane) {
      laneBays(lu, 2, d - 7.5);
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
          apartment(s0 + 0.5, s1 - 0.5, v, v1, r() < 0.35 + lv * 0.2);
          // 淺的地塊：每 6 m 一個門前車位
          if (!front && v < 6) for (let u = s0 + 1.2; u + 2 <= s1 - 1; u += 6) { rect(u - 0.3, 0.3, u + 2.3, v - 0.4, '#bdb8ae'); car(u, 0.6, 1.9, Math.min(4.6, v - 1.2)); }
        }
        // 後院：水泥磚圍牆與樹
        if (v1 + 6 <= d) {
          blockWall(a, v1 + 5.5, e, v1 + 6.1);
          for (let u = a + 4; u < e - 2; u += 12) if (r() < 0.5) tree(u, v1 + 3, 0.8);
        }
      }
    }
  } else if (b.zt === 'R3') {
    base = '#bfc6b2';
    // 日式高密度住宅：大地塊切成邊長最多 48 m 的街區，放塔式住宅或平行的板狀大樓（團地）
    // 停車：有巷道時巷道兩側是停車格（巷道左右各一組街廓）；沒有時臨路一排停車格，建物退縮在後面
    const lu = w / 2;
    const gd = garageDrive('R3', b.kind, b.cols, b.rows), legacy = b.roads && !(b.parkPlan && b.parkPlan.garage);
    if (legacy || (b.roads && !gd)) {
      // 舊存檔：中央巷道兩側是停車格
      laneBays(lu, 2, d - 7.5);
      for (const [a, e] of [[0, lu - 9.8], [lu + 9.8, w]]) for (const [U0, U1] of split(a, e)) for (const [V0, V1] of split(0, d)) housingBlock(U0, V0, U1, V1);
    } else if (b.cols < 6 || b.rows < 5) {
      const v0 = b.rows >= 3 ? 7 : 0;
      if (v0) frontBays(0.5, w - 0.5);
      for (const [U0, U1] of split(0, w)) for (const [V0, V1] of split(v0, d)) housingBlock(U0, V0, U1, V1);
    } else {
      // 住戶的車大多停在地下停車場或旁邊的立體停車場（從臨路右側的單向車道進出），地面只有一排臨路訪客車位
      const nIn = Math.round(b.cols * b.rows * (0.15 + lv * 0.05));
      drive(gd);
      frontBays(0.5, gd.ua - 3.5);
      if (gd.deck) {
        deckGarage(gd.gu0, gd.cv + 4, gd.gu1, gd.gv1, nIn, 8 + lv * 3, gd.cv + 2.8);
        for (const [U0, U1] of split(0, gd.gu0 - 1)) for (const [V0, V1] of split(7, d)) housingBlock(U0, V0, U1, V1);
        if (d - gd.gv1 > 14) for (const [V0, V1] of split(gd.gv1 + 1, d)) housingBlock(gd.gu0, V0, w, V1);
      } else {
        garageRamp(nIn, (gd.ua + gd.ub) / 2, gd.cv + 2.6);
        for (const [U0, U1] of split(0, gd.ua - 2)) for (const [V0, V1] of split(7, d)) housingBlock(U0, V0, U1, V1);
        if (d - gd.cv - 13 > 8) for (const [V0, V1] of split(gd.cv + 13, d)) housingBlock(gd.ua - 2, V0, w, V1);
      }
    }
  } else if (b.zt === 'T') {
    // 公車總站：中央場內車道，兩側是垂直的公車停車格（每格 4.2 m 寬、13.5 m 深，車頭朝車道），後方是鋸齒屋頂的維修廠，臨路有站務辦公室
    // 太窄的總站：臨路幾個公車停車格（直接從道路進出）＋後方辦公室
    base = '#c4c2bb';
    const spine = w / 2, real = !!b.roads, bus = { c: '#d23c2c', h: 1, truck: true, bus: true };
    if (b.cols >= 6 && b.rows >= 5) {
      if (!real) road([{ u: spine, v: 0 }, { u: spine, v: d - 6 }], 7);
      const yardEnd = Math.max(16, d * 0.64);
      for (const sd of [-1, 1]) {
        const lo = sd < 0 ? spine - 4.5 - 13.5 : spine + 4.5;
        if (lo < 0.5 || lo + 13.5 > w - 0.5) continue;
        rect(lo, 7, lo + 13.5, yardEnd, '#8a8d91');
        for (let v = 7.6; v + 3.4 < yardEnd; v += 4.2) {
          line([{ u: lo, v: v - 0.3 }, { u: lo + 13.5, v: v - 0.3 }], 'rgba(255,255,255,0.75)', 0.2);
          car(lo + 0.6, v + 0.35, 12.2, 2.7, bus);
        }
      }
      rect(3, yardEnd + 2, w - 3, d - 3, '#9b958c', 7 + lv, { roof: 'saw', wall: '#c9c3b5', win: true });
      rect(2, 1, Math.min(spine - 6, 16), 6, '#d9d3c4', 6, { wall: '#efe9dc', win: true, units: 1 });
      tree(w - 3, 3, 0.8);
    } else {
      const bd = Math.min(13.5, d - 4);
      if (bd >= 12.4) for (let u = 1; u + 4 <= w - 1 && u < 1 + 4 * 4.2; u += 4.2) {
        rect(u, 0.4, u + 4, 0.4 + bd, '#8a8d91');
        car(u + 0.65, 0.8, 2.7, 12.2, bus);
      }
      rect(2, Math.min(d - 6, bd + 1.5), w - 2, d - 1.5, '#d9d3c4', 6, { wall: '#efe9dc', win: true, units: 1 });
    }
  } else if (b.zt === 'TX' || b.zt === 'TS') {
    // 計程車：招呼站是臨路一排計程車位＋候車亭；車行夠大時中央場內車道兩側是計程車位，後方是車行辦公室
    base = '#c4c2bb';
    const lane = b.zt === 'TX' && b.cols >= 6 && b.rows >= 5;
    if (lane) {
      if (!b.roads) road([{ u: w / 2, v: 0 }, { u: w / 2, v: d - 6 }], 5);
      laneBays(w / 2, 2, d - 7.5);
      rect(2, d - 6, w - 2, d - 1, '#d9d3c4', 6, { wall: '#efe9dc', win: true, shop: '#f2c230', units: 1 });
    } else {
      frontBays(0.5, w - 0.5);
      if (d >= 10) rect(1.5, 7, Math.min(w - 1.5, 9), Math.min(d - 1, 11), '#e9e7e2', 3.4, { wall: '#f6f3ea', win: true, shop: '#f2c230' });
      if (d >= 12 && w >= 18) for (let u = 11; u + 9 <= w - 1; u += 10) rect(u, 7.4, u + 8, Math.min(d - 1, 11), '#d9d3c4', 3, { wall: '#efe9dc', win: true });
    }
    items.push({ t: 'sign', u: w - 1.6, v: lane ? 1.2 : Math.min(d - 1, 7.6), text: '計', c: '#f2c230', h: 5 });
    tree(1.2, d - 1.2, 0.6);
  } else if (b.zone === 'C') {
    base = '#c7c3b8';
    const real = !!b.roads, k = b.kind;
    if (k === 'bigbox') {
      // 大型量販店：前方大停車場（車道從臨路開進來）、後方大倉庫
      const bv = d * 0.45, pa = lotParkArea(k, w, d), ow = real && oneWayLot(k, lotAisles(pa.u0, pa.u1, w / 2));
      parking(pa.u0, pa.v0, pa.u1, pa.v1, w / 2, real, 0.35 + lv * 0.15, false, false, ow ? pa.v0 + 6 : null);
      loadingBay(w - 7.2);
      rect(w * 0.12, bv + 1, w * 0.88, d - 4, pick(r, ['#d9d6cf', '#cfd3d6', '#d8d0c0']), 7 + lv, { wall: '#e4e1da', stripe: pick(r, ['#c8102e', '#005daa', '#e4002b', '#f2a900', '#2a9d3f']), units: 4, sky: true });
    } else if (k === 'mall' || k === 'market') {
      const pv = d * 0.32, pa = lotParkArea(k, w, d), ow = real && oneWayLot(k, lotAisles(pa.u0, pa.u1, w / 2));
      parking(pa.u0, pa.v0, pa.u1, pa.v1, w / 2, real, 0.3 + lv * 0.15, false, false, ow ? pa.v0 + 6 : null);
      loadingBay(w - 7.2);
      if (k === 'mall') {
        rect(w * 0.15, pv + 2, w * 0.85, d - 4, '#e3ddd2', 8 + lv * 2, { wall: pick(r, ['#ece6da', '#e6d8c6', '#dfe3e6']), units: 5, sky: true });
        rect(w * 0.45, pv + 2, w * 0.55, d - 4, '#bcd6ee', 8.5 + lv * 2, { glass: true });
      } else rect(w * 0.1, pv + 2, w * 0.9, d - 3, pick(r, ['#93b9df', '#e4c9a8', '#c9d8b6', '#e8b9b0', '#d8c6e0']), 5 + lv, { wall: '#e8e2d4', awning: true, units: 3 });
    } else if (k === 'mallp') {
      // 購物中心（立體停車場）：臨路左側是多層停車樓（車子從入口開進去），右後方是購物中心本體與玻璃中庭，前方廣場
      const gd = garageDrive(b.zt, k, b.cols, b.rows), gv1 = gd.gv1, gu1 = gd.gu1;
      drive(gd);
      deckGarage(gd.gu0, gd.cv + 4, gu1, gv1, Math.round(b.cols * b.rows * 0.3), 10 + lv * 3, gd.cv + 2.8);
      loadingBay(w - 7.2);
      rect(w * 0.08, gv1 + 3, w * 0.92, d - 4, '#e3ddd2', 9 + lv * 2, { wall: pick(r, ['#ece6da', '#e6d8c6', '#dfe3e6']), units: 5, sky: true });
      rect(w * 0.5, 9, w * 0.92 - 8, gv1 + 3, '#d8d2c6', 8 + lv * 2, { wall: pick(r, ['#ece6da', '#e6d8c6']), win: true, shop: pick(r, AWN) });
      rect(w * 0.62, 9, w * 0.72, d - 4, '#bcd6ee', 10 + lv * 2, { glass: true });
      for (let u = gu1 + 4; u < w * 0.5 - 1; u += 7) for (let v = 6; v < d - 8; v += 12) tree(u, v, 0.8);
    } else if (k === 'parking') {
      // 收費停車場：入口旁的收費亭與 P 字招牌，四角植栽
      if (real) {
        parking(2, 2, w - 2, d - 2, w / 2, real, 0.4 + lv * 0.15);
        rect(w / 2 + 5, 1.2, w / 2 + 8, 4.2, '#e8e2d4', 3, { units: 0 });
        items.push({ t: 'sign', u: w / 2 - 7, v: 2.2, text: 'P', c: '#1d6fb8', h: 5 });
        tree(1.5, 1.5, 0.7); tree(w - 1.5, 1.5, 0.7);
      } else {
        // 太淺、沒有場內道路：臨路一排停車格（直接從道路進出），後面是收費亭與植栽
        frontBays(1, w - 1);
        rect(w / 2 - 1.5, 7, w / 2 + 1.5, 10, '#e8e2d4', 3, { units: 0 });
        items.push({ t: 'sign', u: w / 2 - 5, v: 8, text: 'P', c: '#1d6fb8', h: 5 });
        for (let u = 4; u < w - 2; u += 8) tree(u, Math.min(d - 2, 13), 0.8);
      }
      tree(1.5, d - 1.5, 0.7); tree(w - 1.5, d - 1.5, 0.7);
    } else if (k === 'hotel') {
      // 飯店：平屋頂的板狀主樓（商務飯店，每層一排客房窗），夠寬的有兩側低層翼樓；前庭落客車道與花壇，臨路停車格與地下停車場，後方日式庭園與池塘
      const s = Math.min(w, d), fv = Math.max(d * 0.26, 8.5), md = Math.min(16, d * 0.3);
      const hh = 22 + lv * 6 + Math.min(14, s * 0.15), rc = '#b3b0a8', wall = pick(r, TILEWALL);
      garageRamp(Math.round(b.cols * b.rows * 0.4));
      loadingBay(0.6);
      frontBays(4.4, w * 0.3 - 3.2); frontBays(w * 0.7 + 3.2, w - 6.5);
      rect(w * 0.1, fv, w * 0.9, fv + md, rc, hh, { wall, win: true, units: 3 });
      const ww = Math.min(12, w * 0.2 - 3);
      if (ww >= 6 && fv > 12) for (const u0 of [w * 0.1, w * 0.9 - ww]) rect(u0, 7, u0 + ww, fv, rc, 8 + lv * 2, { wall, win: true, units: 1 });
      rect(w * 0.42, fv - 2, w * 0.58, fv, '#8a6a4a', 4);
      rect(w * 0.3, d * 0.72, w * 0.6, d * 0.72 + Math.min(8, s * 0.18), '#6f9fb0', 0);
      road([{ u: w * 0.3, v: 0 }, { u: w * 0.3, v: fv - 3 }, { u: w * 0.7, v: fv - 3 }, { u: w * 0.7, v: 0 }], 4.5);
      rect(w * 0.36, 1, w * 0.64, fv - 5.5, '#7fb069');
      hedge(w * 0.36, 1, w * 0.64, 1.7);
      for (let i = 0; i < 6; i++) tree(4 + r() * (w - 8), d * 0.66 + r() * (d * 0.32), 0.9);
    } else if (k === 'office') {
      // 辦公大樓：臨路停車格、側邊地下停車場入口；石材基座＋玻璃帷幕主樓，前廣場
      const tw = (w - 10) * 0.8, td = (d - 12) * 0.75, th = 16 + lv * 9 + Math.min(18, Math.min(w, d) * 0.25) + r() * 5;
      garageRamp(Math.round(b.cols * b.rows * 0.5));
      loadingBay(0.6);
      frontBays(4.4, w - 6.5);
      rect(4.4, 6.4, w - 7, 8.4, '#d9d6cf');
      rect(w / 2 - tw / 2 - 2, d / 2 - td / 2 + 1, w / 2 + tw / 2 + 2, d / 2 + td / 2 + 5, pick(r, ['#b9b4aa', '#c4bfb3', '#a9a59c']), 6, { wall: pick(r, ['#d8d2c4', '#cfc6b4', '#e0dbd0']), win: true });
      const glassC = pick(r, ['#7fa7c9', '#8fb7d6', '#9bb0c4', '#6f93b3', '#8aa6a0', '#a2a9b8', '#6d8fa8', '#93a7b5']);
      const cu = w / 2, cv = d / 2 + 3, big = Math.min(b.cols, b.rows) >= 7;
      if (!big) rect(cu - tw / 2, cv - td / 2, cu + tw / 2, cv + td / 2, glassC, th, { glass: true, mull: true, units: 2 });
      else {
        // 摩天大樓：三段退縮的玻璃帷幕塔樓（直向窗框），頂部有天線；地塊越大、等級越高越高（約 80～190 m）
        const H = 55 + lv * 30 + Math.min(45, b.cols * b.rows / 6) + r() * 15, base = [cu - tw / 2, cv - td / 2, cu + tw / 2, cv + td / 2];
        [[1, 0.6], [0.78, 0.85], [0.56, 1]].forEach(([sc, hf], k2) => rect(cu - tw / 2 * sc, cv - td / 2 * sc, cu + tw / 2 * sc, cv + td / 2 * sc, k2 % 2 ? glassC : shadeHex(glassC, 0.94), H * hf,
          { glass: true, mull: true, units: k2 === 2 ? 3 : 0, tier: k2, base }));
        items.push({ t: 'circle', u: cu, v: cv, r: 0.45, c: '#c9ccd0', h: H * 1.14, tier: 3, base });
      }
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
      // 地塊右端臨路是卸貨區（貨車直接從道路開進 / 開出）
      const forecourt = !real && b.rows >= 4 && b.cols >= 6 && r() < 0.4, we = b.cols >= 3 ? w - 4.6 : w - 1;
      if (b.cols >= 3) loadingBay(w - 4.2);
      let sv = 2.4;
      if (forecourt) {
        rect(1, 0.3, we, 14, '#8a8d91');
        line([{ u: 4, v: 1.2 }, { u: 4, v: 5 }], 'rgba(255,255,255,0.85)', 0.3);
        line([{ u: we - 3, v: 5 }, { u: we - 3, v: 1.2 }], 'rgba(255,255,255,0.85)', 0.3);
        for (let u = 2; u + 2.6 <= we - 1; u += 2.7) { line([{ u, v: 8.8 }, { u, v: 13.8 }], 'rgba(255,255,255,0.85)', 0.2); car(u + 0.45, 9.2, 1.8, 4.3); }
        sv = 14.6;
      } else if (!real) {
        frontBays(1, we);
        sv = 7.2;
      }
      const back = real ? Math.min(b.rows, 2) * CELL - 1 : Math.min(d - 1, sv + Math.max(5, Math.min(12, d - sv - 1)));
      const gap = real;
      // 便利商店：小的商業地塊（前面是停車格）有一成半是一層樓的便利商店（白色店面、彩色招牌帶）
      if (!real && !forecourt && b.cols <= 5 && b.cols >= 3 && r() < 0.5) {
        rect(1.5, sv, we - 0.5, Math.min(back, sv + 12), '#e9e7e2', 4.6, { wall: '#f4f3f0', win: true, shop: pick(r, ['#2a9d3f', '#1d6fb8', '#e8743b', '#c8102e']), units: 2 });
      } else {
        let u = 1, nShop = 0;
        while (u < we - 3) {
          // 日式商店街：每間 4.5～9 m 寬的店舖兼住宅，兩～四層，平屋頂或日本瓦，一樓店面，部分掛直立看板
          let sw = Math.min(we - u, 4.5 + r() * 4.5);
          if (gap && u < w / 2 + 4 && u + sw > w / 2 - 4) { if (u < w / 2 - 6) sw = w / 2 - 4 - u; else { u = w / 2 + 4; continue; } }
          if (nShop++ === 0 || r() < fill + 0.15) {
            const flat = r() < 0.6, bh = 7 + lv * 2.5 + Math.floor(r() * 3) * 2.5;
            rect(u, sv, u + sw, back, flat ? '#b5b2aa' : pick(r, KAWARA), bh, flat ? { wall: pick(r, r() < 0.7 ? JWALL : TILEWALL), win: true, shop: pick(r, AWN) } : { roof: 'gable', ridge: 'u', wall: facadeCol(), win: true, shop: pick(r, AWN) });
            if (bh >= 11.5 && sw >= 3.5 && r() < 0.55) {
              const [kc, tc] = pick(r, KANBAN);
              items.push({ t: 'sign', vert: true, host: [u, sv, u + sw, back], u: u + 0.9 + r() * Math.max(0, sw - 1.8), v: sv - 0.15, h0: 3.4, h: Math.min(bh - 0.6, 3.4 + 6 + r() * 3), c: kc, tc, text: pick(r, KANJI) });
            }
          } else tree(u + sw / 2, (sv + back) / 2, 0.9);
          u += sw;
        }
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
    // 主幹道兩側的卸貨區：垂直於主幹道的貨車車位（車頭朝主幹道，貨車直接開進 / 開出），建物從主幹道 12.6 m 外開始
    // 每側要有 21 m 以上才放卸貨區；窄的園區建物直接靠著主幹道
    const strip = !compact && spine - 3 >= 21, gapS = strip ? 12.6 : 5;
    for (const sd of strip ? [-1, 1] : []) {
      const lo = sd < 0 ? spine - 12.3 : spine + 4.5;
      rect(lo, 6.6, lo + 7.8, d - 5, '#9c978b');
      for (let v = 7.4; v + 3 < d - 5; v += 4.2) {
        if (cross && v + 3 > cross - 5.5 && v < cross + 5.5) continue;
        line([{ u: lo, v: v - 0.3 }, { u: lo + 7.8, v: v - 0.3 }], 'rgba(255,255,255,0.7)', 0.2);
        car(lo + 0.3, v + 0.25, 7.2, 2.5, { c: '#d8d0c0', h: 0.8, truck: true });
      }
    }
    // 有實際的廠區道路時由路網繪製，這裡只畫裝飾用的
    if (!b.roads && !compact) {
      road([{ u: spine, v: 0 }, { u: spine, v: d - 4 }], 7);
      if (cross) road([{ u: 4, v: cross }, { u: w - 4, v: cross }], 7);
    }
    const blocks = [];
    if (compact) {
      // 前院：夠深（≥ 20 m）的有貨車車位（7.5 m 貨車）與員工停車位，淺的只有員工停車位
      const fy = d >= 20 ? 9 : Math.max(5, d * 0.3);
      rect(2, 0.5, w - 2, fy, '#9c978b');
      let u = 3;
      if (fy >= 8.6) for (; u + 2.6 <= w - 3 && u < 3 + 3 * 3.2; u += 3.2) car(u, 0.8, 2.5, 7.6, { c: '#d8d0c0', h: 0.8, truck: true });
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
      } else if (k === 'semi') {
        // 半導體晶圓廠：白色的大型無塵室廠房（屋頂滿是空調與排氣設備），前方玻璃辦公棟，側邊特殊氣體儲槽
        const W = u1 - u0, D = v1 - v0, ov = Math.min(9, D * 0.28);
        rect(u0 + 1, v0 + ov + 1, u1 - 1, v1 - 1, '#eceeef', 12 + lv * 3, { wall: pick(r, ['#f2f3f4', '#e6e9ec', '#eef0ee']), units: Math.max(3, Math.round(W * D / 250)), stripe: pick(r, ['#1d6fb8', '#2a9d3f', '#5a3d8a']) });
        if (ov >= 5) rect(u0 + 1, v0 + 1, u0 + Math.min(W * 0.45, 30), v0 + ov, '#8fb7d6', 9 + lv * 2, { glass: true, mull: true });
        const tr = Math.min(1.6, ov * 0.25);
        if (ov >= 5 && W > 20) for (let u = u0 + Math.min(W * 0.45, 30) + 3; u + tr < u1 - 2 && u < u0 + Math.min(W * 0.45, 30) + 3 + 5 * (tr * 2 + 0.8); u += tr * 2 + 0.8) items.push({ t: 'circle', u, v: v0 + ov / 2 + 0.5, r: tr, c: '#dfe3e6', h: 5 + lv });
      } else if (k === 'battery') {
        // 電池 / 電子零件廠：長條形的淺色廠房（藍灰色屋頂、天窗），前方辦公棟與一排變電設備
        const D = v1 - v0, ov = Math.min(7, D * 0.25);
        rect(u0 + 1, v0 + ov + 1, u1 - 1, v1 - 1, pick(r, ['#9fb3c4', '#8ea6b8', '#a7b4bd']), 8 + lv * 2, { wall: pick(r, ['#e6e8ea', '#dfe4e8', '#ecebe6']), sky: true, win: true });
        if (ov >= 4.5) {
          rect(u0 + 1, v0 + 1, u0 + Math.min(u1 - u0 - 2, 16), v0 + ov, '#c9ccd0', 7 + lv, { wall: '#f0f1f2', win: true });
          for (let u = u0 + 18; u + 2 < u1 - 2 && u < u0 + 34; u += 3.2) rect(u, v0 + 1.5, u + 2.2, v0 + Math.min(ov - 0.5, 4), '#9aa1a8', 2.4, { wall: '#aab1b8' });
        }
      } else if (k === 'tech') {
        // 科技園區：低矮玻璃建築、綠屋頂
        rect(u0 + 2, v0 + 2, u1 - 2, v1 - 2, '#8fae6a', 4 + lv * 2, { wall: pick(r, ['#a9c0d2', '#b8c8c0', '#c2c9d6']), glass: true });
        tree(u0 + 1, v0 + 1, 0.8); tree(u1 - 1, v1 - 1, 0.8);
      } else {
        // 製造工廠：鋼板外牆的廠房、鋸齒屋頂（北向採光窗）或低斜度鋼板屋頂、紅白相間的煙囪
        if (r() < 0.5) rect(u0, v0, u1, v1, '#9b958c', 6 + lv * 1.5, { roof: 'saw', wall: pick(r, METALWALL), win: true });
        else rect(u0, v0, u1, v1, pick(r, ['#7d8a8f', '#6f8496', '#8e989c']), 6 + lv * 1.5, { roof: 'gable', ridge: (u1 - u0) >= (v1 - v0) ? 'u' : 'v', wall: pick(r, METALWALL), win: true });
        items.push({ t: 'circle', u: u1 - 3, v: v0 + 3, r: 1.2, c: '#d8d4cc', h: 18, stack: true });
        items.push({ t: 'circle', u: u1 - 3, v: v0 + 3, r: 1.25, c: '#c0392b', h: 16, deco: true });
      }
    }
  }
  // 小客車停車位：依 slot 值排序，前 b.parked 個有車（貨車車位另外依使用率顯示）
  const slots = items.filter(it => it.slot !== undefined && !it.truck).sort((p, q) => p.slot - q.slot);
  slots.forEach((it, i) => { it.rank = i; });
  // 貨車車位（卸貨區）：依產生順序，記錄停著哪一輛貨車
  const tslots = items.filter(it => it.slot !== undefined && it.truck);
  tslots.forEach((it, i) => { it.trank = i; });
  return { base, items, slots, tslots };
}

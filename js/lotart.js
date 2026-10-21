// 地塊上的建築圖形（以地塊區域座標 u：沿路方向 0~w、v：離路方向 0~d 產生，渲染時再轉成世界座標）
import { CELL } from './config.js';

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const ROOF_R = ['#c96b4f', '#a9583f', '#7c5a48', '#d08a5a', '#6e7f8f', '#8d4c3a', '#b9a07a'];
const WALL_R2 = ['#e8dcc8', '#d9cbb3', '#cfd6dc', '#e2d2c0'];
const TOWER = ['#9fb4c7', '#b7c3cc', '#8fa3b5', '#c4cdd4', '#a9b8a8'];

// 回傳 { base, items }：items 依序繪製；rect：{ u0, v0, u1, v1, c, h（陰影高度）, ridge, stripes, grid }、circle：{ u, v, r, c, h }、line：{ pts, c, w, dash }
export function lotArt(b) {
  const r = rng(b.id * 97 + b.cols * 13 + b.rows), w = b.cols * CELL, d = b.rows * CELL, lv = b.level, items = [];
  const rect = (u0, v0, u1, v1, c, h = 0, extra = {}) => items.push({ t: 'rect', u0, v0, u1, v1, c, h, ...extra });
  const tree = (u, v, s = 1) => items.push({ t: 'circle', u, v, r: (2 + r() * 1.4) * s, c: pick(r, ['#4f8a3c', '#5d9a47', '#467d36']), h: 1.2 });
  const road = (pts, wd = 5) => items.push({ t: 'line', pts, c: '#5b5f64', w: wd });
  const line = (pts, c, wd, dash) => items.push({ t: 'line', pts, c, w: wd, dash });
  let base = '#a6c98f';
  const fill = [0.55, 0.8, 1][lv - 1];

  if (b.zt === 'R1') {
    base = '#a3c98c';
    // 深的地塊加一條巷道，兩側都排房子
    const lane = b.rows >= 6 && b.cols >= 4;
    const lu = Math.round(b.cols / 2) * CELL;
    if (lane) { road([{ u: lu, v: 0 }, { u: lu, v: d - 7 }], 5); items.push({ t: 'circle', u: lu, v: d - 7, r: 5, c: '#5b5f64', h: 0 }); }
    for (let i = 0; i + 2 <= b.cols; i += 2) for (let j = 0; j + 2 <= b.rows; j += 2) {
      const u0 = i * CELL, v0 = j * CELL;
      if (lane && Math.abs(u0 + CELL - lu) < CELL * 1.2) continue;
      if (r() > fill) { if (r() < 0.6) tree(u0 + 6, v0 + 6); continue; }
      const hw = 3.4 + r() * 1.3, hd = 2.8 + r() * 1.2, cu = u0 + 6 + (r() - 0.5) * 1.5, cv = v0 + 5.2 + (r() - 0.5) * 1.2;
      rect(cu - hw, cv - hd, cu + hw, cv + hd, pick(r, ROOF_R), 4 + lv * 0.8 + r() * 1.2, { ridge: r() < 0.5 ? 'u' : 'v', wall: pick(r, ['#efe6d6', '#e6dccb', '#f2efe8', '#e9d9c4', '#dfe3e6']) });
      if (r() < 0.55) tree(u0 + (r() < 0.5 ? 2 : 10), v0 + 10.5, 0.8);
    }
  } else if (b.zt === 'R2') {
    base = '#b7c4a6';
    // 連棟公寓：每排 2 格深，排與排之間留中庭
    for (let j = 0; j + 2 <= b.rows; j += 3) {
      for (let i = 0; i < b.cols; i += 4) {
        if (r() > fill + 0.15) { tree(i * CELL + 8, j * CELL + 6); continue; }
        const u1 = Math.min(b.cols, i + 4) * CELL - 1.5;
        rect(i * CELL + 1.5, j * CELL + 1.5, u1, j * CELL + 10.5, pick(r, WALL_R2), 7 + lv * 2.5, { grid: 'u' });
      }
      if (j + 3 <= b.rows) for (let i = 0; i < b.cols; i += 2) if (r() < 0.5) tree(i * CELL + 6, j * CELL + 15, 0.8);
    }
  } else if (b.zt === 'R3') {
    base = '#c4c6c0';
    // 大樓：每 4×4 格一棟，周圍是廣場與樹
    const bs = b.cols >= 4 && b.rows >= 4 ? 4 : Math.min(b.cols, b.rows);
    for (let i = 0; i + bs <= b.cols; i += bs) for (let j = 0; j + bs <= b.rows; j += bs) {
      const cu = (i + bs / 2) * CELL, cv = (j + bs / 2) * CELL, s = bs * CELL * (0.3 + r() * 0.08);
      if (r() > fill + 0.1) { rect(cu - s, cv - s, cu + s, cv + s, '#9aa58f'); tree(cu, cv, 1.3); continue; }
      rect(cu - s, cv - s, cu + s, cv + s, pick(r, TOWER), 6 + lv * 5 + r() * 6, { grid: 'both' });
      tree(cu - s - 2.5, cv + s + 2, 0.8); tree(cu + s + 2.5, cv - s - 2, 0.8);
    }
  } else if (b.zone === 'C') {
    base = '#c7c3b8';
    if (b.kind === 'bigbox') {
      // 大型量販店：後方大倉庫、前方大停車場
      const bv = d * 0.45;
      rect(3, 3, w - 3, bv - 2, '#7f8287');
      rect(w * 0.12, bv, w * 0.88, d - 4, '#d9d6cf', 6 + lv, { stripe: pick(r, ['#c8102e', '#005daa', '#e4002b']) });
      for (let v = 6; v < bv - 4; v += 6) line([{ u: 6, v }, { u: w - 6, v }], 'rgba(255,255,255,0.75)', 0.25, [2.2, 0.6]);
      road([{ u: w / 2, v: 0 }, { u: w / 2, v: bv - 2 }], 5);
      for (let k = 0; k < 10 + lv * 6; k++) items.push({ t: 'rect', u0: 8 + r() * (w - 16), v0: 5 + r() * (bv - 12), du: 4.4, dv: 1.9, c: pick(r, ['#e8e8e8', '#2b2b2b', '#c0392b', '#2e6fb7', '#8e9aa6']), h: 0.4, car: true });
    } else if (b.kind === 'hotel') {
      // 飯店：高樓主體＋泳池、花園與臨路的落客區
      const s = Math.min(w, d);
      rect(w * 0.2, d * 0.32, w * 0.8, d * 0.32 + Math.min(16, d * 0.4), '#e9e2d6', 10 + lv * 6, { grid: 'both' });
      rect(w * 0.42, d * 0.32, w * 0.58, d * 0.32 + Math.min(16, d * 0.4), '#d7c9a7', 13 + lv * 6);
      rect(w * 0.3, d * 0.72, w * 0.6, d * 0.72 + Math.min(8, s * 0.18), '#5fc4e8', 0, { pool: true });
      road([{ u: w * 0.3, v: 0 }, { u: w * 0.3, v: d * 0.22 }, { u: w * 0.7, v: d * 0.22 }, { u: w * 0.7, v: 0 }], 4.5);
      rect(w * 0.36, d * 0.07, w * 0.64, d * 0.18, '#7fb069');
      for (let k = 0; k < 6; k++) tree(4 + r() * (w - 8), d * 0.66 + r() * (d * 0.32), 0.9);
    } else if (b.kind === 'mall') {
      for (let k = 0; k < 8 + lv * 5; k++) items.push({ t: 'rect', u0: 6 + r() * (w - 12), v0: 4 + r() * (d * 0.23 - 7), du: 4.4, dv: 1.9, c: pick(r, ['#e8e8e8', '#2b2b2b', '#c0392b', '#2e6fb7', '#8e9aa6']), h: 0.4, car: true });
      rect(3, 3, w - 3, d * 0.23, '#7f8287');
      rect(w * 0.18, d * 0.25, w * 0.82, d * 0.85, '#e3ddd2', 7 + lv * 2, { grid: 'both' });
      rect(w * 0.45, d * 0.25, w * 0.55, d * 0.85, '#bcd6ee', 7 + lv * 2.2);
      for (let v = 5; v < d * 0.22; v += 6) line([{ u: 6, v }, { u: w - 6, v }], 'rgba(255,255,255,0.75)', 0.25, [2.2, 0.6]);
    } else {
      // 商店街 / 超市：臨路排一排店面，後方停車
      const deep = Math.min(b.rows, b.kind === 'market' ? 4 : 2) * CELL;
      let u = 1;
      while (u < w - 4) {
        const sw = b.kind === 'market' ? w - 2 : Math.min(w - 1 - u, 7 + r() * 9);
        if (r() < fill + 0.15) rect(u, 1.5, u + sw - 1, deep - 1, pick(r, ['#93b9df', '#bcd6ee', '#e4c9a8', '#c9d8b6', '#e8b9b0']), 4.5 + lv * 1.8, { awning: true });
        u += sw;
      }
      if (d - deep > 6) rect(2, deep + 1, w - 2, d - 2, '#7f8287');
      for (let v = deep + 4; v < d - 2; v += 6) line([{ u: 3, v }, { u: w - 3, v }], 'rgba(255,255,255,0.6)', 0.22, [2.2, 0.6]);
    }
  } else {
    base = '#bab4a7';
    // 工業區：從路邊進入的主幹道，大地塊再加一條橫向道路，建築依功能不同
    const spine = w / 2, cross = b.rows >= 10 ? d * 0.55 : null;
    // 裝卸用的貨車
    for (let k = 0; k < 2 + lv; k++) items.push({ t: 'rect', u0: spine + (r() < 0.5 ? -9 : 5) , v0: 8 + r() * (d - 20), du: 2.4, dv: 7, c: pick(r, ['#d8d8d8', '#e0b24f', '#2e6fb7']), h: 0.8, car: true });
    // 有實際的廠區道路時由路網繪製，這裡只畫裝飾用的
    if (!b.roads) {
      road([{ u: spine, v: 0 }, { u: spine, v: d - 4 }], 7);
      if (cross) road([{ u: 4, v: cross }, { u: w - 4, v: cross }], 7);
    }
    const blocks = [];
    for (const [u0, u1] of [[3, spine - 5], [spine + 5, w - 3]]) {
      if (u1 - u0 < 8) continue;
      if (cross) { blocks.push([u0, 3, u1, cross - 5.5], [u0, cross + 5.5, u1, d - 3]); } else blocks.push([u0, 3, u1, d - 3]);
    }
    const k = b.kind;
    for (const [u0, v0, u1, v1] of blocks) {
      if (v1 - v0 < 6) continue;
      if (r() > fill + 0.2) { items.push({ t: 'rect', u0, v0, u1, v1, c: '#a7a191', h: 0 }); continue; }
      if (k === 'chemical') {
        const n = Math.max(1, Math.floor(Math.min(u1 - u0, v1 - v0) / 12));
        const rr = Math.min(u1 - u0, v1 - v0) / (2 * n) * 0.8;
        for (let i = 0; i < n; i++) for (let j = 0; j < Math.max(1, Math.floor((v1 - v0) / (rr * 2.4))); j++) items.push({ t: 'circle', u: u0 + rr * 1.2 + i * rr * 2.4, v: v0 + rr * 1.2 + j * rr * 2.4, r: rr, c: '#dfe3e6', h: 3 + lv });
      } else if (k === 'logistics') {
        rect(u0, v0, u1, v1, '#cfc9bd', 4 + lv, { stripes: 'u', docks: true });
      } else if (k === 'food') {
        rect(u0, v0, u1, (v0 + v1) / 2 - 1, '#d8d2c2', 3 + lv, { stripes: 'v' });
        rect(u0, (v0 + v1) / 2 + 1, u1, v1, '#b8d6c2', 1, { grid: 'both' });
      } else if (k === 'tech') {
        rect(u0 + 2, v0 + 2, u1 - 2, v1 - 2, '#8fb3cf', 4 + lv * 2, { grid: 'both' });
        tree(u0 + 1, v0 + 1, 0.8); tree(u1 - 1, v1 - 1, 0.8);
      } else {
        rect(u0, v0, u1, v1, '#a39c90', 4 + lv * 1.5, { stripes: 'v' });
        items.push({ t: 'circle', u: u1 - 3, v: v0 + 3, r: 1.4, c: '#6b6159', h: 10, stack: true });
      }
    }
  }
  return { base, items };
}

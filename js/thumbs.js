// 工具列縮圖（SVG 字串）：道路斷面與行車方向、圓環、交流道平面
import { ROAD_TYPES } from './config.js';
import { TEMPLATES, templateElems } from './interchange.js';

const cache = new Map();
const memo = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };

// 道路：由左往右的一段路面，每條車道畫上行車方向箭頭（靠右行駛：下方車道往右）
export function roadThumb(key) {
  return memo('r:' + key, () => {
    const T = ROAD_TYPES[key], W = 50, H = 36;
    // 鐵路：道碴上兩條軌道（枕木＋鋼軌）
    if (T.rail) {
      let s = `<svg class="thumb" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect x="0" y="6" width="${W}" height="24" fill="${T.color}" rx="1"/>`;
      for (const y of [12, 24]) {
        for (let x = 1; x < W; x += 3.4) s += `<rect x="${x}" y="${y - 4}" width="1.6" height="8" fill="#5b4a3a"/>`;
        s += `<line x1="0" x2="${W}" y1="${y - 2.4}" y2="${y - 2.4}" stroke="#d6d9dc" stroke-width="1"/><line x1="0" x2="${W}" y1="${y + 2.4}" y2="${y + 2.4}" stroke="#d6d9dc" stroke-width="1"/>`;
      }
      return s + '</svg>';
    }
    const n = T.fwd + T.bwd, med = T.bwd ? Math.min(4, (T.median || 0) * 1.1) : 0;
    const lw = Math.min(5.2, (H - 2 - med) / n);
    const rh = n * lw + med, y0 = (H - rh) / 2;
    let s = `<svg class="thumb" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
    s += `<rect x="0" y="${y0 - 0.8}" width="${W}" height="${rh + 1.6}" fill="${T.color}" rx="1"/>`;
    const laneY = [];
    for (let i = 0; i < T.bwd; i++) laneY.push({ y: y0 + i * lw + lw / 2, dir: -1 });
    for (let i = 0; i < T.fwd; i++) laneY.push({ y: y0 + T.bwd * lw + med + i * lw + lw / 2, dir: 1 });
    if (med > 0) s += `<rect x="0" y="${y0 + T.bwd * lw}" width="${W}" height="${med}" fill="${T.green ? '#5c9a4f' : '#8b8f94'}"/>`;
    else if (T.bwd) s += `<line x1="0" x2="${W}" y1="${y0 + T.bwd * lw}" y2="${y0 + T.bwd * lw}" stroke="#f2c84b" stroke-width="0.9"/>`;
    // 同向車道分隔虛線
    for (let i = 1; i < laneY.length; i++) {
      if (laneY[i].dir !== laneY[i - 1].dir) continue;
      const y = (laneY[i].y + laneY[i - 1].y) / 2;
      s += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#fff" stroke-opacity="0.75" stroke-width="0.6" stroke-dasharray="3 3"/>`;
    }
    // 箭頭（每條車道一個，指向行車方向）
    for (const L of laneY) {
      const d = L.dir, cx = W / 2 + d * 2, hl = lw * 0.36;
      s += `<path d="M${cx - d * 7} ${L.y}H${cx}" stroke="#fff" stroke-width="1.1"/><path d="M${cx + d * 3.5} ${L.y}L${cx - d * 0.5} ${L.y - hl}L${cx - d * 0.5} ${L.y + hl}Z" fill="#fff"/>`;
    }
    return s + '</svg>';
  });
}

export function roundaboutThumb(R) {
  return memo('o:' + R, () => {
    const r = 5 + R / 4;
    return `<svg class="thumb" viewBox="0 0 48 30" width="48" height="30">
      <path d="M0 15H${24 - r}M${24 + r} 15H48M24 0V${15 - r}M24 ${15 + r}V30" stroke="#4a4d52" stroke-width="4"/>
      <circle cx="24" cy="15" r="${r}" fill="none" stroke="#4a4d52" stroke-width="4"/>
      <circle cx="24" cy="15" r="${r - 3}" fill="#5c9a4f"/></svg>`;
  });
}

// 交流道：依模板實際幾何縮小繪製（主線與橫交道路較粗，匝道較細）
export function interchangeThumb(key) {
  return memo('i:' + key, () => {
    const t = TEMPLATES[key], { roads, elems } = templateElems(key);
    const S = 52, k = (S / 2 - 2) / Math.max(t.L, t.Lc);
    const path = pts => 'M' + pts.filter((p, i) => i % 2 === 0 || i === pts.length - 1).map(p => `${(S / 2 + p.x * k).toFixed(1)} ${(S / 2 + p.y * k).toFixed(1)}`).join('L');
    let s = `<svg class="thumb" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`;
    for (const e of roads) s += `<path d="${path(e.pts)}" fill="none" stroke="#9aa3ad" stroke-width="${e.type === 'freeway1' ? 1.6 : 2.6}" stroke-linecap="round"/>`;
    for (const e of elems) s += `<path d="${path(e.pts)}" fill="none" stroke="${e.ring ? '#ffc93c' : '#5ac8ff'}" stroke-width="1.1" stroke-linecap="round"/>`;
    return s + '</svg>';
  });
}

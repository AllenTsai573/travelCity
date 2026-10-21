// Canvas 2D 繪圖：地形、樹木、建築、多層道路、車輛、號誌、疊加層
import { lotArt } from './lotart.js';
import { LANE_W, LEVEL_H, ZONES } from './config.js';
import { pointAt, offsetPoly, polyCum, cutPoly, clamp, arcCurve, convexHull, pointInPoly, closestOnPoly } from './util.js';
import { halfWidth, laneOffset } from './network.js';

const DRAW_LEVELS = [-2, -1, 0, 1, 2, 3];
const SHOW_WILD_TREES = false;
// 顏色明暗（建物牆面與斜屋頂用），結果快取
const shadeCache = new Map();
function shade(hex, f) {
  const k = hex + f.toFixed(2);
  let v = shadeCache.get(k);
  if (v) return v;
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  v = `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  shadeCache.set(k, v);
  return v;
}
const ASPHALT = '#46494e';
// 鋪面道路統一柏油色，銜接處不會出現色差；鄉間小路為碎石色
const roadColor = T => (T.rank === 0 ? T.color : ASPHALT);
// 路肩顏色：地面深、高架淺，依高度線性內插
function curbColor(h) {
  const t = clamp(h, 0, 1);
  const a = [0x6d, 0x6a, 0x63], b = [0xa3, 0xa1, 0x99];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}

function heatColor(r) {
  r = clamp(r, 0, 1);
  if (r > 0.75) return '#3ccf5a';
  if (r > 0.5) return '#c6d93b';
  if (r > 0.3) return '#f2a33a';
  if (r > 0.15) return '#e8572e';
  return '#b01e2e';
}

export class Renderer {
  constructor(game, canvas) {
    this.game = game;
    this.canvas = canvas;
    // 不透明畫布：瀏覽器合成時不需做 alpha 混合（GPU 合成較省）
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.bake = null;
    this.cam = { x: 1200, y: 1200, z: 1 };
    this.dpr = 1;
    this.W = 0; this.H = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = this.canvas.clientWidth;
    this.H = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
  }

  toWorld(sx, sy) {
    const c = this.cam;
    return { x: (sx - this.W / 2) / c.z + c.x, y: (sy - this.H / 2) / c.z + c.y };
  }
  toScreen(wx, wy) {
    const c = this.cam;
    return { x: (wx - c.x) * c.z + this.W / 2, y: (wy - c.y) * c.z + this.H / 2 };
  }
  worldTf() {
    const c = this.cam, d = this.dpr;
    this.ctx.setTransform(d * c.z, 0, 0, d * c.z, d * (this.W / 2 - c.x * c.z), d * (this.H / 2 - c.y * c.z));
  }
  screenTf() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
  view(pad = 0) {
    const a = this.toWorld(0, 0), b = this.toWorld(this.W, this.H);
    return { x0: a.x - pad, y0: a.y - pad, x1: b.x + pad, y1: b.y + pad };
  }
  inView(bb, v) { return bb.x1 >= v.x0 && bb.x0 <= v.x1 && bb.y1 >= v.y0 && bb.y0 <= v.y1; }

  strokePoly(pts) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  draw() {
    const g = this.game, ctx = this.ctx;
    if (!g.terrain) return;
    const z = this.cam.z;
    this.screenTf();
    ctx.fillStyle = g.terrain.biome.bg;
    ctx.fillRect(0, 0, this.W, this.H);
    this.worldTf();
    ctx.imageSmoothingEnabled = true;
    // 縮小檢視時使用預先繪好的地形＋樹木圖層，放大時才逐棵畫樹
    const baked = z < 1.3 ? this.bakedLayer() : null;
    ctx.drawImage(baked || g.terrain.getCanvas(), 0, 0, g.terrain.size, g.terrain.size);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3 / z;
    ctx.strokeRect(0, 0, g.terrain.size, g.terrain.size);
    const v = this.view(40);
    if (!baked) this.drawTrees(v);
    this.drawBuildings(v);
    this.drawNetwork(v);
    this.drawArrivals(v);
    this.drawGates(v);
    if (g.heatmap) this.drawHeatmap(v);
    this.drawSelection();
    g.tools.drawOverlay(ctx, this);
    this.screenTf();
    this.drawLabels(v);
    g.tools.drawScreenOverlay(ctx, this);
  }

  // 地形與樹木的快取圖層（1 像素 = 1 公尺），樹木變動時才重繪
  bakedLayer() {
    const t = this.game.terrain;
    const now = performance.now();
    if (this.bake && this.bake.terrain === t && (!t.treesDirty || now - this.bake.at < 800)) return this.bake.canvas;
    let cv = this.bake && this.bake.canvas;
    if (!cv || cv.width !== t.size) {
      cv = document.createElement('canvas');
      cv.width = t.size; cv.height = t.size;
    }
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(t.getCanvas(), 0, 0, t.size, t.size);
    const r = 3.6;
    // 地圖上零散的樹（綠點）暫不顯示
    for (let k = 0; k < (SHOW_WILD_TREES ? 3 : 0); k++) {
      ctx.fillStyle = t.biome.tree[k];
      ctx.beginPath();
      for (let i = 0; i < t.treeX.length; i++) {
        if (!t.treeAlive[i] || t.treeK[i] !== k) continue;
        ctx.moveTo(t.treeX[i] + r, t.treeY[i]);
        ctx.arc(t.treeX[i], t.treeY[i], r * (0.8 + (i % 5) * 0.08), 0, Math.PI * 2);
      }
      ctx.fill();
    }
    t.treesDirty = false;
    this.bake = { canvas: cv, terrain: t, at: now };
    return cv;
  }

  // 車輛的繪製位置：以剩餘的模擬時間外插，並跨越路段交界，讓移動在每一幀都連續
  vehPose(vh) {
    const g = this.game;
    const extra = g.paused || g.ui.modalOpen ? 0 : Math.min(g.simAcc, 0.1);
    let tr = vh.track, s = vh.s + vh.v * extra - vh.len / 2;
    if (s > tr.len) {
      const nxt = tr.kind === 'lane' ? (vh.committed ? vh.nextConn : null) : tr.to;
      if (nxt && !nxt.dead && nxt.pts) { s -= tr.len; tr = nxt; }
      if (s > tr.len) s = tr.len;
    } else if (s < 0 && vh.prevTrack && !vh.prevTrack.dead && vh.prevTrack.pts) {
      tr = vh.prevTrack;
      s = Math.max(0, tr.len + s);
    }
    const p = pointAt(tr.pts, tr.cum, s);
    p.lat = vh.lat ? vh.lat * Math.exp(-2.2 * extra) : 0;
    return p;
  }

  drawTrees(v) {
    if (!SHOW_WILD_TREES) return;
    const g = this.game, t = g.terrain, ctx = this.ctx, z = this.cam.z;
    if (z < 0.3) return;
    const cols = t.biome.tree;
    const r = 3.6;
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = cols[k];
      ctx.beginPath();
      const g0 = Math.floor(v.x0 / 50), g1 = Math.floor(v.x1 / 50), h0 = Math.floor(v.y0 / 50), h1 = Math.floor(v.y1 / 50);
      for (let gi = g0; gi <= g1; gi++) for (let hj = h0; hj <= h1; hj++) {
        const arr = t.treeGrid.get(gi + ',' + hj);
        if (!arr) continue;
        for (const i of arr) {
          if (!t.treeAlive[i] || t.treeK[i] !== k) continue;
          const x = t.treeX[i], y = t.treeY[i];
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r * (0.8 + (i % 5) * 0.08), 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
  }

  // 打通到後方道路的停車場 / 園區：出口的柵欄機（紅白相間的橫桿）
  drawGates(v) {
    const ctx = this.ctx, z = this.cam.z;
    if (z < 0.8) return;
    for (const b of this.game.city.buildings) {
      const gt = b.gate;
      if (!gt || gt.x < v.x0 || gt.x > v.x1 || gt.y < v.y0 || gt.y > v.y1) continue;
      const tx = -gt.dy, ty = gt.dx, L = 4;
      ctx.lineCap = 'butt';
      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = i % 2 ? '#ffffff' : '#d62828';
        ctx.lineWidth = 0.45;
        ctx.beginPath(); ctx.moveTo(gt.x - tx * L + tx * i * 2, gt.y - ty * L + ty * i * 2); ctx.lineTo(gt.x - tx * L + tx * (i + 1) * 2, gt.y - ty * L + ty * (i + 1) * 2); ctx.stroke();
      }
      ctx.fillStyle = '#3a3d42';
      ctx.fillRect(gt.x - tx * (L + 0.5) - 0.5, gt.y - ty * (L + 0.5) - 0.5, 1, 1);
      ctx.lineCap = 'round';
    }
  }

  drawBuildings(v) {
    const g = this.game, ctx = this.ctx, z = this.cam.z, city = g.city;
    const inV = b => !(b.x + b.rad < v.x0 || b.x - b.rad > v.x1 || b.y + b.rad < v.y0 || b.y - b.rad > v.y1);
    const quad = c => { ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < c.length; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath(); };
    // 已劃設、尚未發展的分區
    for (const l of city.lots) {
      if (!inV(l)) continue;
      const col = ZONES[l.zone].color[l.zt === 'R1' ? 0 : l.zt === 'R3' ? 2 : 1];
      quad(l.corners);
      ctx.fillStyle = col; ctx.globalAlpha = 0.3; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(0.3, 1.4 / z); ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]);
      if (z > 1.1) g.tools.drawCells(ctx, l, 'rgba(255,255,255,0.28)');
    }
    const detail = z > 0.55;
    // 由北往南畫，較南邊（離鏡頭近）的高樓會蓋住後方
    const vis = city.buildings.filter(inV).sort((p, q) => p.y - q.y);
    for (const b of vis) {
      const key = b.level + '|' + b.abandoned + '|' + !!b.roads;
      if (!b._art || b._art.key !== key) b._art = { key, ...lotArt(b) };
      const c0 = b.corners[0], tx = b.tx, ty = b.ty, nx = b.nx, ny = b.ny;
      const P = (u, w) => ({ x: c0.x + tx * u + nx * w, y: c0.y + ty * u + ny * w });
      const box = (u0, v0, u1, v1) => [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
      quad(b.corners);
      ctx.fillStyle = b.abandoned ? '#8f8c84' : b._art.base;
      ctx.fill();
      // 依底部（最南端）排序，讓同一地塊內的建物也能正確前後遮擋
      if (!b._art.sorted) {
        const low = it => (it.t === 'circle' || it.t === 'sign' ? P(it.u, it.v).y + (it.r || 0) : it.t === 'line' ? -1e9 : Math.max(...(it.car ? box(it.u0, it.v0, it.u0 + it.du, it.v0 + it.dv) : box(it.u0, it.v0, it.u1, it.v1)).map(p => p.y)));
        // 地面上的東西（鋪面、標線）照產生順序，再畫車，最後是由北往南排序的建物
        const flat = b._art.items.filter(it => !(it.h >= 1) && !it.car), cars = b._art.items.filter(it => it.car);
        const tall = b._art.items.filter(it => it.h >= 1 && !it.car).map(it => [low(it), it]).sort((p, q) => p[0] - q[0]).map(x => x[1]);
        b._art.sorted = [...flat, ...cars, ...tall];
      }
      const items = b._art.sorted;
      // 停車使用率：住宅白天上班時間車少、晚上多；商業 / 工業依在場員工與顧客
      const hour = (g.time % 1440) / 60;
      const occ = b.abandoned ? 0 : b.zone === 'R' ? (hour >= 8 && hour < 17 ? 0.35 : 0.85)
        : clamp((b.present + b.custLevel * 1.5) / Math.max(1, city.cap(b) * 0.5), 0.08, 1);
      // 陰影
      // 陰影從建物底部往右下方投射（與底部相連，不會看起來浮在空中）
      if (detail) {
        ctx.fillStyle = 'rgba(20,24,30,0.24)';
        for (const it of items) {
          if (!it.h || it.t === 'line' || it.t === 'sign' || it.car) continue;
          const o = it.h * 0.55;
          if (it.t === 'circle') {
            const p = P(it.u, it.v);
            ctx.lineCap = 'round'; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = it.r * 2;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + o, p.y + o * 0.6); ctx.stroke();
            continue;
          }
          const c = it.car ? box(it.u0, it.v0, it.u0 + it.du, it.v0 + it.dv) : box(it.u0, it.v0, it.u1, it.v1);
          quad(convexHull([...c, ...c.map(p => ({ x: p.x + o, y: p.y + o * 0.6 }))])); ctx.fill();
        }
        ctx.lineCap = 'round';
      }
      for (const it of items) {
        if (!detail && (it.t === 'line' || it.car || it.umb || (it.t === 'circle' && it.h < 2 && !it.tree))) continue;
        if (it.rank !== undefined ? it.indoor || !(b.slotOcc && b.slotOcc[it.rank]) : it.slot !== undefined && it.slot > occ) continue;
        if (it.car && detail) {
          // 停著的車與路上的車同樣畫法（顏色是實際停進來的那輛車）
          const cu = it.u0 + it.du / 2, cv = it.v0 + it.dv / 2, alongU = it.du > it.dv, pc = P(cu, cv);
          const ax = alongU ? tx : nx, ay = alongU ? ty : ny, a = this.dpr * z;
          const ox = this.dpr * (this.W / 2 - this.cam.x * z), oy = this.dpr * (this.H / 2 - this.cam.y * z);
          ctx.setTransform(a * ax, a * ay, -a * ay, a * ax, ox + a * pc.x, oy + a * pc.y);
          const L = Math.max(it.du, it.dv) + 0.2, W = Math.min(it.du, it.dv) + 0.1;
          this.carBody(it.rank !== undefined ? b.slotOcc[it.rank] : it.c, it.truck ? Math.max(L, 7) : Math.min(L, 4.6), it.truck ? 2.4 : Math.min(W, 1.85), !!it.truck, z > 2.2);
          this.worldTf();
          continue;
        }
        if (it.car) {
          // 停著的車：車身＋前後擋風玻璃
          quad(box(it.u0, it.v0, it.u0 + it.du, it.v0 + it.dv)); ctx.fillStyle = it.c; ctx.fill();
          if (z > 1.8) {
            ctx.fillStyle = 'rgba(30,40,55,0.7)';
            const al = it.du > it.dv, L = al ? it.du : it.dv;
            for (const [f0, f1] of [[0.18, 0.3], [0.68, 0.84]]) quad(al ? box(it.u0 + L * f0, it.v0 + 0.2, it.u0 + L * f1, it.v0 + it.dv - 0.2) : box(it.u0 + 0.2, it.v0 + L * f0, it.u0 + it.du - 0.2, it.v0 + L * f1)), ctx.fill();
          }
          continue;
        }
        const col = b.abandoned && it.h >= 1 && !it.car ? '#a5a39c' : it.c;
        if (it.t === 'line') {
          ctx.strokeStyle = it.c; ctx.lineWidth = it.w; ctx.lineCap = 'butt';
          ctx.setLineDash(it.dash || []);
          ctx.beginPath(); it.pts.forEach((q, i) => { const p = P(q.u, q.v); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }); ctx.stroke();
          ctx.setLineDash([]); ctx.lineCap = 'round';
          continue;
        }
        if (it.t === 'sign') {
          // 招牌：立柱＋方形牌面
          const p = P(it.u, it.v), H = it.h * 0.5;
          ctx.strokeStyle = '#6b6f75'; ctx.lineWidth = 0.25; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - H); ctx.stroke();
          ctx.fillStyle = it.c; ctx.fillRect(p.x - 1.3, p.y - H - 2.4, 2.6, 2.6);
          if (z > 1.2) { ctx.fillStyle = '#fff'; ctx.font = 'bold 2.2px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(it.text, p.x, p.y - H - 1.05); ctx.textBaseline = 'alphabetic'; }
          continue;
        }
        if (it.umb) {
          // 人行道上的咖啡座陽傘：立柱＋傘面
          const p = P(it.u, it.v), H = it.h * 0.5;
          ctx.fillStyle = '#6b6f75'; ctx.fillRect(p.x - 0.08, p.y - H, 0.16, H);
          ctx.fillStyle = it.c; ctx.beginPath(); ctx.arc(p.x, p.y - H, it.r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 0.12; ctx.stroke();
          continue;
        }
        if (it.t === 'circle' && it.tree) {
          // 樹：樹冠離地（往上抬），下緣較暗、左上方受光
          const p = P(it.u, it.v), H = detail ? it.h * 0.35 : 0, rr = it.r;
          if (detail) {
            ctx.fillStyle = '#5a4632'; ctx.fillRect(p.x - 0.25, p.y - H * 0.8, 0.5, H * 0.8);
            ctx.fillStyle = shade(it.c, 0.72); ctx.beginPath(); ctx.arc(p.x + rr * 0.08, p.y - H + rr * 0.1, rr, 0, Math.PI * 2); ctx.fill();
          }
          ctx.fillStyle = it.c; ctx.beginPath(); ctx.arc(p.x - rr * 0.06, p.y - H - rr * 0.06, rr * 0.9, 0, Math.PI * 2); ctx.fill();
          if (detail) {
            ctx.fillStyle = shade(it.c, 1.25); ctx.beginPath(); ctx.arc(p.x - rr * 0.32, p.y - H - rr * 0.34, rr * 0.45, 0, Math.PI * 2); ctx.fill();
          }
          continue;
        }
        if (it.t === 'circle') {
          const p = P(it.u, it.v), H = detail && it.h >= 2 ? it.h * 0.5 : 0;
          if (H) {
            // 圓柱（儲槽 / 煙囪）：側面＋頂面
            ctx.fillStyle = shade(col, 0.72);
            ctx.beginPath(); ctx.arc(p.x, p.y, it.r, 0, Math.PI); ctx.lineTo(p.x - it.r, p.y - H); ctx.arc(p.x, p.y - H, it.r, Math.PI, 0, true); ctx.closePath(); ctx.fill();
          }
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(p.x, p.y - H, it.r, 0, Math.PI * 2); ctx.fill();
          if (H) {
            ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 0.3; ctx.stroke();
            // 儲槽 / 筒倉頂：浮頂的內圈與中央通氣口
            if (!it.stack && it.r > 1.8 && z > 1.2) {
              ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 0.2;
              ctx.beginPath(); ctx.arc(p.x, p.y - H, it.r * 0.72, 0, Math.PI * 2); ctx.stroke();
              ctx.fillStyle = shade(col, 0.7); ctx.beginPath(); ctx.arc(p.x, p.y - H, Math.min(0.6, it.r * 0.12), 0, Math.PI * 2); ctx.fill();
            }
          }
          if (it.stack && detail && b.happy > 0.4 && !b.abandoned) {
            ctx.fillStyle = 'rgba(225,225,225,0.35)';
            const t = (g.time * 0.6 + b.id) % 6;
            ctx.beginPath(); ctx.arc(p.x + t, p.y - H - t * 1.2, 1.5 + t * 0.4, 0, Math.PI * 2); ctx.fill();
          }
          continue;
        }
        const c = it.car ? box(it.u0, it.v0, it.u0 + it.du, it.v0 + it.dv) : box(it.u0, it.v0, it.u1, it.v1);
        const H = detail && it.h >= 1 && !it.car ? it.h * 0.5 : 0;
        if (H) {
          // 牆面：朝南（朝鏡頭）的邊往上拉出，依朝向決定明暗（光從左上方來）
          let area = 0;
          for (let i = 0; i < 4; i++) { const p = c[i], q = c[(i + 1) % 4]; area += p.x * q.y - q.x * p.y; }
          const sg = area > 0 ? 1 : -1;
          for (let i = 0; i < 4; i++) {
            const p = c[i], q = c[(i + 1) % 4], ox = (q.y - p.y) * sg, oy = -(q.x - p.x) * sg;
            if (oy <= 0) continue;
            const L = Math.hypot(ox, oy) || 1;
            ctx.fillStyle = shade(it.wall || col, (it.wall ? 0.9 : 0.74) + 0.14 * (-ox / L));
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.lineTo(q.x, q.y - H); ctx.lineTo(p.x, p.y - H); ctx.closePath(); ctx.fill();
            if (z > 1.6 && H > 1.4) this.wallWindows(it, p, q, H, oy / L, b.abandoned, i === 0);
            // 牆腳的暗線，讓建物「站」在地上
            ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.35;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
        const up = pts => pts.map(p => ({ x: p.x, y: p.y - H }));
        if (H && it.roof === 'saw') { this.sawRoof(it, col, H, P, b, quad); continue; }
        if (H && it.roof) { this.pitchedRoof(it, col, H, P, b, quad, z); continue; }
        quad(up(c));
        ctx.fillStyle = col;
        ctx.fill();
        if (!detail || it.car || !it.h) continue;
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 0.3; ctx.stroke();
        // 平屋頂的女兒牆、天窗與屋頂設備
        if (H > 2 && z > 0.9 && !it.box) {
          const ins = 0.9;
          quad(up(box(it.u0 + ins, it.v0 + ins, it.u1 - ins, it.v1 - ins)));
          ctx.strokeStyle = shade(col, 0.82); ctx.lineWidth = 0.45; ctx.stroke();
          // 天窗：沿短邊方向、每 9 m 一條採光帶
          if (it.sky && z > 1.2) {
            ctx.fillStyle = 'rgba(200,222,236,0.7)';
            const du = it.u1 - it.u0, dv = it.v1 - it.v0;
            if (du >= dv) { for (let u = it.u0 + 5; u + 1.8 < it.u1 - 4; u += 9) { quad(up(box(u, it.v0 + 2.5, u + 1.8, it.v1 - 2.5))); ctx.fill(); } }
            else for (let w2 = it.v0 + 5; w2 + 1.8 < it.v1 - 4; w2 += 9) { quad(up(box(it.u0 + 2.5, w2, it.u1 - 2.5, w2 + 1.8))); ctx.fill(); }
          }
          if (it.units && !b.abandoned) {
            const n = it.units, du = (it.u1 - it.u0), dv = (it.v1 - it.v0);
            for (let k = 0; k < n; k++) {
              const fu = ((k * 0.618 + b.id * 0.13) % 1) * 0.6 + 0.2, fv = ((k * 0.382 + b.id * 0.29) % 1) * 0.6 + 0.2;
              const cu = it.u0 + du * fu, cv = it.v0 + dv * fv, sz = Math.min(2.2, du * 0.08, dv * 0.12);
              const bc = up(box(cu - sz, cv - sz * 0.7, cu + sz, cv + sz * 0.7));
              quad(bc.map(p => ({ x: p.x + 0.35, y: p.y + 0.35 }))); ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fill();
              quad(bc.map(p => ({ x: p.x, y: p.y - 0.5 }))); ctx.fillStyle = '#c9ccd0'; ctx.fill();
            }
          }
        }
        if (it.canopy) { quad(up(box(it.u0, it.v0, it.u1, it.v0 + 1))); ctx.fillStyle = it.canopy; ctx.fill(); quad(up(box(it.u0, it.v1 - 1, it.u1, it.v1))); ctx.fill(); }
        if (b.abandoned) continue;
        if (it.awning) { quad(up(box(it.u0, it.v0, it.u1, it.v0 + 1.2))); ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill(); }
        if (it.stripe) { quad(up(box(it.u0 + 3, it.v0 + 1.5, it.u0 + Math.min(18, (it.u1 - it.u0) * 0.4), it.v0 + 4.5))); ctx.fillStyle = it.stripe; ctx.fill(); }
        if (it.docks) { ctx.fillStyle = '#5b5f64'; for (let u = it.u0 + 2; u < it.u1 - 3; u += 5) { quad(box(u, it.v0 - 1.2, u + 3, it.v0)); ctx.fill(); } }
      }
    }
  }

  // 朝鏡頭牆面的窗：玻璃帷幕每層一條反光帶；一般建物一格格直立窗；臨街（front）的一樓店面為櫥窗＋遮陽棚；住宅加一扇門
  wallWindows(it, p, q, H, facing, abandoned, front) {
    const ctx = this.ctx, z = this.cam.z;
    const W = (t, h) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t - h });
    const pg = (t0, t1, h0, h1) => { const a = W(t0, h0), b = W(t1, h0), c = W(t1, h1), d = W(t0, h1); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); };
    if (it.glass) {
      ctx.strokeStyle = 'rgba(210,235,255,0.55)'; ctx.lineWidth = Math.min(0.7, H / 12);
      ctx.beginPath();
      for (let f = 1.0; f < H - 0.4; f += 1.5) { const a = W(0.06, f), e = W(0.94, f); ctx.moveTo(a.x, a.y); ctx.lineTo(e.x, e.y); }
      ctx.stroke();
      return;
    }
    if (!it.win || abandoned) return;
    const L = Math.hypot(q.x - p.x, q.y - p.y), n = Math.floor(L / 2.6);
    if (n < 1) return;
    // 每層樓約 3 m，畫面上壓縮成 1.5 m
    const floors = Math.max(1, Math.floor((H - 0.3) / 1.5)), shop = it.shop && front;
    ctx.fillStyle = 'rgba(52,66,86,0.6)';
    ctx.beginPath();
    for (let f = shop ? 1 : 0; f < floors; f++) for (let k = 0; k < n; k++) pg((k + 0.33) / n, (k + 0.67) / n, 0.45 + f * 1.5, 1.15 + f * 1.5);
    if (shop) for (let k = 0; k < n; k++) pg((k + 0.1) / n, (k + 0.9) / n, 0.1, 0.95);
    ctx.fill();
    if (shop) { ctx.fillStyle = it.shop; ctx.beginPath(); pg(0.02, 0.98, 1.0, 1.3); ctx.fill(); }
    if (it.door && facing > 0.5 && z > 2) { ctx.fillStyle = '#6e4f3a'; ctx.beginPath(); pg(0.46, 0.46 + Math.min(0.2, 1.1 / L), 0, 1.0); ctx.fill(); }
  }

  // 斜屋頂：簷口（外框，高度 H）往內收到屋脊 / 屋頂平台（高度 H + rH）
  // gable 雙坡（兩端是山牆）、hip 四坡、mansard 折線屋頂（陡坡＋平頂）；煙囪與太陽能板畫在屋面上
  pitchedRoof(it, col, H, P, b, quad, z) {
    const ctx = this.ctx, du = it.u1 - it.u0, dv = it.v1 - it.v0;
    const along = it.ridge || (du >= dv ? 'u' : 'v'), s = along === 'u' ? dv : du;
    let ku, kv, rH;
    if (it.roof === 'mansard') { ku = kv = Math.min(2.4, Math.min(du, dv) * 0.16); rH = Math.min(2.2, s * 0.14); }
    else {
      const k = it.roof === 'hip' ? s / 2 : 0;
      ku = along === 'u' ? Math.min(k, du / 2) : du / 2;
      kv = along === 'u' ? dv / 2 : Math.min(k, dv / 2);
      rH = Math.min(4.5, s * 0.3);
    }
    const o = [[it.u0, it.v0], [it.u1, it.v0], [it.u1, it.v1], [it.u0, it.v1]];
    const ii = [[it.u0 + ku, it.v0 + kv], [it.u1 - ku, it.v0 + kv], [it.u1 - ku, it.v1 - kv], [it.u0 + ku, it.v1 - kv]];
    const N = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const lift = (q, h) => { const p = P(q[0], q[1]); return { x: p.x, y: p.y - h }; };
    const faces = [];
    for (let e = 0; e < 4; e++) {
      const wx = N[e][0] * b.tx + N[e][1] * b.nx, wy = N[e][0] * b.ty + N[e][1] * b.ny;
      // 這一面往內收的距離為 0：垂直的山牆
      faces.push({ wx, wy, wall: (e % 2 ? ku : kv) < 0.01, pts: [lift(o[e], H), lift(o[(e + 1) % 4], H), lift(ii[(e + 1) % 4], H + rH), lift(ii[e], H + rH)] });
    }
    // 由北往南畫；背向鏡頭的山牆不畫
    faces.sort((p, q) => p.wy - q.wy);
    for (const f of faces) {
      if (f.wall) { if (f.wy <= 0.05) continue; ctx.fillStyle = shade(it.wall || col, 0.9 - 0.14 * f.wx); }
      else ctx.fillStyle = shade(col, 1 - 0.2 * f.wx - 0.16 * f.wy);
      quad(f.pts); ctx.fill();
    }
    if (it.roof === 'mansard') { quad(ii.map(q => lift(q, H + rH))); ctx.fillStyle = shade(col, 1.15); ctx.fill(); }
    if (b.abandoned || z < 1.1) return;
    // 太陽能板：朝南的屋面
    if (it.solar) {
      const f = faces.filter(x => !x.wall).reduce((a, x) => (x.wy > a.wy ? x : a));
      const [a, e, c, d] = f.pts, at = (s0, t) => { const ox = a.x + (e.x - a.x) * s0, oy = a.y + (e.y - a.y) * s0, ix = d.x + (c.x - d.x) * s0, iy = d.y + (c.y - d.y) * s0; return { x: ox + (ix - ox) * t, y: oy + (iy - oy) * t }; };
      quad([at(0.22, 0.18), at(0.78, 0.18), at(0.78, 0.7), at(0.22, 0.7)]); ctx.fillStyle = '#2c3e5a'; ctx.fill();
    }
    // 煙囪：屋脊旁、北側屋面上
    if (it.chimney !== undefined && it.roof !== 'mansard') {
      const cu = along === 'u' ? it.u0 + ku + (du - 2 * ku) * it.chimney : it.u0 + du * 0.3;
      const cv = along === 'u' ? it.v0 + dv * 0.3 : it.v0 + kv + (dv - 2 * kv) * it.chimney;
      const p = lift([cu, cv], H + rH * 0.6);
      ctx.fillStyle = '#8e4f3c'; ctx.fillRect(p.x - 0.45, p.y - 1.5, 0.9, 1.5);
      ctx.fillStyle = '#5a3a2e'; ctx.fillRect(p.x - 0.45, p.y - 1.9, 0.9, 0.4);
    }
  }

  // 鋸齒屋頂（舊式工廠）：沿畫面上下方向每 7 m 一道斜面，北低南高，南側是垂直的採光窗（朝鏡頭才看得到）
  sawRoof(it, col, H, P, b, quad) {
    const ctx = this.ctx, rH = 1.8, T = 7;
    // 沿著哪個軸切齒：選在畫面上比較接近南北向的那一軸
    const alongU = Math.abs(b.ty) >= Math.abs(b.ny), sg = Math.sign(alongU ? b.ty : b.ny) || 1;
    const t0 = alongU ? it.u0 : it.v0, t1 = alongU ? it.u1 : it.v1, w0 = alongU ? it.v0 : it.u0, w1 = alongU ? it.v1 : it.u1;
    const lift = (t, w, h) => { const p = alongU ? P(t, w) : P(w, t); return { x: p.x, y: p.y - h }; };
    const teeth = [];
    for (let a = t0; a < t1 - 0.5; a += T) teeth.push([a, Math.min(t1, a + T)]);
    // 北端到南端：sg > 0 時 t 越大越南
    if (sg < 0) { teeth.reverse(); for (const x of teeth) x.reverse(); }
    for (const [n, s] of teeth) {
      ctx.fillStyle = shade(col, 1.06);
      quad([lift(n, w0, H), lift(n, w1, H), lift(s, w1, H + rH), lift(s, w0, H + rH)]); ctx.fill();
      ctx.fillStyle = '#8fa9bd';
      quad([lift(s, w0, H + rH), lift(s, w1, H + rH), lift(s, w1, H), lift(s, w0, H)]); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.2;
      const a = lift(s, w0, H + rH), e = lift(s, w1, H + rH); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    }
  }

  // 道路標線（依道路類型沿中心線產生）
  markingsFor(T, core) {
    const lines = [];
    // 場內道路與停車場鋪面融為一體，不畫標線
    if (T.internal) return lines;
    const hw = halfWidth(T);
    lines.push({ pts: offsetPoly(core, hw - 0.75), c: 'rgba(255,255,255,0.75)', w: 0.15, dash: null, edge: true });
    lines.push({ pts: offsetPoly(core, -(hw - 0.75)), c: 'rgba(255,255,255,0.75)', w: 0.15, dash: null, edge: true });
    if (T.bwd > 0) {
      if ((T.median || 0) > 1) {
        lines.push({ pts: core, c: T.green ? '#6f9e4f' : '#9a9a92', w: T.median - 0.4, dash: null, median: true });
        lines.push({ pts: offsetPoly(core, T.median / 2 - 0.2), c: '#e8c547', w: 0.15, dash: null });
        lines.push({ pts: offsetPoly(core, -(T.median / 2 - 0.2)), c: '#e8c547', w: 0.15, dash: null });
      } else if ((T.median || 0) > 0) {
        lines.push({ pts: offsetPoly(core, 0.18), c: '#e8c547', w: 0.15, dash: null });
        lines.push({ pts: offsetPoly(core, -0.18), c: '#e8c547', w: 0.15, dash: null });
      } else if (T.rank !== 0) {
        lines.push({ pts: core, c: '#e8c547', w: 0.15, dash: [3, 3] });
      }
    }
    for (const dir of [1, -1]) {
      const n = dir > 0 ? T.fwd : T.bwd;
      for (let i = 0; i < n - 1; i++) {
        const o = (laneOffset(T, dir, i) + laneOffset(T, dir, i + 1)) / 2;
        lines.push({ pts: offsetPoly(core, o), c: 'rgba(255,255,255,0.8)', w: 0.14, dash: [3, 5] });
      }
    }
    for (const m of lines) m.cum = polyCum(m.pts);
    return lines;
  }

  markings(seg) {
    const net = this.game.net;
    if (!seg._mk || seg._mk.ver !== net.version) seg._mk = { ver: net.version, lines: this.markingsFor(seg.T, seg.core) };
    return seg._mk.lines;
  }

  // 由中心線點（含寬度 w）建立路面多邊形
  static withNormals(C) {
    for (let k = 0; k < C.length; k++) {
      const a = C[Math.max(0, k - 1)], b = C[Math.min(C.length - 1, k + 1)];
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
      C[k].nx = -dy / L; C[k].ny = dx / L;
    }
    return C;
  }
  static ribbonPoly(C, extra, shadowOf) {
    const out = [];
    for (const c of C) {
      const o = shadowOf ? shadowOf(c.h) : 0;
      out.push({ x: c.x + c.nx * (c.w + extra) + o * 0.55, y: c.y + c.ny * (c.w + extra) + o * 0.85 });
    }
    for (let k = C.length - 1; k >= 0; k--) {
      const c = C[k], o = shadowOf ? shadowOf(c.h) : 0;
      out.push({ x: c.x - c.nx * (c.w + extra) + o * 0.55, y: c.y - c.ny * (c.w + extra) + o * 0.85 });
    }
    return out;
  }

  // 路段繪製幾何（快取）：
  // - 只畫到車道起訖處，路口 / 轉折處由 jointGeom 補上
  // - 依高度切段：坡道下半段畫在地面層、上半段畫在高架層，與相接道路融為一體
  roadGeom(seg) {
    const net = this.game.net;
    if (seg._rg && seg._rg.ver === net.version) return seg._rg.pieces;
    const A = net.nodes.get(seg.a), B = net.nodes.get(seg.b);
    const hw = halfWidth(seg.T), len = seg.len;
    const ta = A.segs.length >= 2 ? seg.ra : 0, tb = B.segs.length >= 2 ? seg.rb : 0;
    const hA = A.level, hB = B.level;
    const hAt = t => hA + (hB - hA) * t / len;
    const pieces = [];
    seg._rg = { ver: net.version, pieces };
    if (len - ta - tb < 0.05) return pieces;
    const cuts = [ta, len - tb];
    if (hA !== hB) {
      for (let b = Math.min(hA, hB) + 0.5; b < Math.max(hA, hB); b += 1) {
        const t = (b - hA) / (hB - hA) * len;
        if (t > ta && t < len - tb) cuts.push(t);
      }
    }
    cuts.sort((a, b) => a - b);
    let marks = this.markings(seg);
    const openings = [A, B].flatMap(nd => (nd.jinfo && nd.jinfo.ramp ? (this.jointGeom(nd)?.openings || []) : []));
    const coreLen = Math.max(0.01, len - seg.ra - seg.rb);
    const shadowOf = h => (h <= 0.5 ? 0 : h < 1 ? (h - 0.5) * 2 : h) * LEVEL_H;
    for (let i = 0; i < cuts.length - 1; i++) {
      const s0 = cuts[i], s1 = cuts[i + 1];
      if (s1 - s0 < 0.01) continue;
      const set = new Set([s0, s1]);
      for (const c of seg.cum) if (c > s0 && c < s1) set.add(c);
      if (hA !== hB) for (let t = s0 + 6; t < s1; t += 6) set.add(t);
      // 與相鄰段 / 路口稍微重疊，避免接縫
      if (s0 > 0) set.add(Math.max(0, s0 - (i === 0 ? 0.3 : 0.8)));
      if (s1 < len) set.add(Math.min(len, s1 + (i === cuts.length - 2 ? 0.3 : 0.8)));
      const ss = [...set].sort((a, b) => a - b);
      const C = Renderer.withNormals(ss.map(t => { const q = pointAt(seg.pts, seg.cum, t); return { x: q.x, y: q.y, w: hw, h: hAt(t) }; }));
      const lvm = hAt((s0 + s1) / 2);
      const lv = lvm >= 0.5 ? Math.round(lvm) : lvm <= -0.5 ? Math.round(lvm) : 0;
      // 高度切點處路面有重疊，標線也一起往回延伸，避免被上層路面蓋住而斷開
      const mk0 = i > 0 ? s0 - 0.9 : s0;
      const f0 = clamp((mk0 - seg.ra) / coreLen, 0, 1), f1 = clamp((s1 - seg.ra) / coreLen, 0, 1);
      let mk = f1 - f0 < 1e-3 ? [] : marks.map(m => {
        if (f0 <= 0 && f1 >= 1) return m;
        const ml = m.cum[m.cum.length - 1];
        return { ...m, pts: cutPoly(m.pts, m.cum, f0 * ml, f1 * ml) };
      });
      if (openings.length) mk = Renderer.splitEdges(mk, openings);
      for (const nd of [A, B]) {
        const ji = nd.jinfo;
        if (!ji || !ji.ramp || !ji.others.includes(seg)) continue;
        const ms = ji.pairs[0];
        const lim = Math.max(...ms.map(m => halfWidth(m.T))) - 0.6;
        mk = Renderer.dropInside(mk, p => Math.min(...ms.map(m => closestOnPoly(m.pts, m.cum, p).d)) < lim);
      }
      pieces.push({
        lv, mk, col: roadColor(seg.T),
        grad: hA !== hB ? { p0: C[0], p1: C[C.length - 1], h0: C[0].h, h1: C[C.length - 1].h } : null,
        body: Renderer.ribbonPoly(C, 0), curb: Renderer.ribbonPoly(C, 0.5),
        shadow: lv > 0 ? Renderer.ribbonPoly(C, 0, shadowOf) : null,
        left: C.map(c => ({ x: c.x + c.nx * c.w, y: c.y + c.ny * c.w })),
        right: C.map(c => ({ x: c.x - c.nx * c.w, y: c.y - c.ny * c.w })),
        seg,
      });
    }
    return pieces;
  }

  fillPoly(pts) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
  }

  // 節點處的路面：
  // - 死路：圓頭
  // - 兩路相接（轉折 / 寬窄變化）：沿圓弧的連續路面，同類道路的分隔島與標線一路延續
  // - 三路以上（路口、匝道匯入 / 分出）：各路端點的凸包 + 每條車道連接的路面帶，形狀貼合實際行車軌跡
  jointGeom(n) {
    const net = this.game.net;
    if (n._jg && n._jg.ver === net.version) return n._jg.j;
    const segs = n.segs.map(id => net.segs.get(id)).filter(Boolean);
    let j = null;
    // 路口顏色取最寬的一般道路（場內道路接上一般道路時，路口用一般道路的柏油色）
    const pub = segs.filter(s => !s.T.internal);
    const widest = (pub.length ? pub : segs).reduce((a, s) => (!a || halfWidth(s.T) > halfWidth(a.T) ? s : a), null);
    if (segs.length === 1) {
      j = { kind: 'cap', r: halfWidth(segs[0].T), col: roadColor(segs[0].T), internal: !!segs[0].T.internal };
    } else if (segs.length >= 2) {
      const ends = segs.map(s => {
        const atA = s.a === n.id, core = s.core, cl = s.coreLen;
        const d = Math.min(3, cl * 0.5);
        const P = atA ? core[0] : core[core.length - 1];
        const q = pointAt(core, s.coreCum, atA ? d : cl - d);
        let tx = P.x - q.x, ty = P.y - q.y;
        const L = Math.hypot(tx, ty) || 1;
        return { s, P, t: { x: tx / L, y: ty / L }, hw: halfWidth(s.T) };
      });
      // 兩端之間的連續路面帶（沿圓弧，寬度平滑變化；同類道路時標線延續）
      const strip = (e1, e2) => {
        const t3 = { x: -e2.t.x, y: -e2.t.y };
        const arc = arcCurve(e1.P, e1.t, e2.P, t3, 6, 1.0);
        const pts = [{ x: e1.P.x - e1.t.x * 0.3, y: e1.P.y - e1.t.y * 0.3 }, ...arc, { x: e2.P.x + t3.x * 0.3, y: e2.P.y + t3.y * 0.3 }];
        const cum = polyCum(pts), tot = cum[cum.length - 1] || 1;
        const sm = t => t * t * (3 - 2 * t);
        const C = Renderer.withNormals(pts.map((p, i) => ({ x: p.x, y: p.y, w: e1.hw + (e2.hw - e1.hw) * sm(clamp(cum[i] / tot, 0, 1)), h: n.level })));
        return {
          body: Renderer.ribbonPoly(C, 0), curbs: Renderer.ribbonPoly(C, 0.5),
          mk: e1.s.type === e2.s.type && arc.length > 2 ? this.markingsFor(e1.s.T, arc) : this.transitionMarks(n, e1, e2, C),
        };
      };
      if (segs.length === 2) {
        j = { kind: 'hub', col: roadColor(widest.T), strips: [strip(ends[0], ends[1])], hull: null, ribbons: [] };
      } else {
        // 路口型態由路網計算（與車道截斷一致）
        const info = n.jinfo || net.junctionInfo(n);
        const endOf = sg => ends.find(e => e.s === sg);
        const pairs = info.ring ? [ends.filter(e => e.s.ring)].filter(p => p.length === 2) : info.pairs.map(([a, b]) => [endOf(a), endOf(b)]);
        const used = new Set(pairs.flat());
        const others = ends.filter(e => !used.has(e));
        const ring = info.ring;
        const rampJunction = info.ramp;
        let hull = null;
        const crossMk = [];
        let ribbons = n.conns.map(c => c.pts);
        if (!ring && !rampJunction) {
          // 一般路口：各路口端以「向內彎的轉角圓弧」相連（路緣轉角），不會像小圓環一樣鼓出來
          const ord = ends.map(e => { const d = { x: -e.t.x, y: -e.t.y }; return { e, d, a: Math.atan2(d.y, d.x) }; }).sort((p, q) => p.a - q.a);
          const perp = d => ({ x: -d.y, y: d.x });
          hull = [];
          for (let k = 0; k < ord.length; k++) {
            const cur = ord[k], nx = ord[(k + 1) % ord.length];
            const pc = perp(cur.d), pn = perp(nx.d);
            const before = { x: cur.e.P.x - pc.x * cur.e.hw, y: cur.e.P.y - pc.y * cur.e.hw };
            const after = { x: cur.e.P.x + pc.x * cur.e.hw, y: cur.e.P.y + pc.y * cur.e.hw };
            const nb = { x: nx.e.P.x - pn.x * nx.e.hw, y: nx.e.P.y - pn.y * nx.e.hw };
            hull.push(before, after);
            let gap = nx.a - cur.a;
            if (k === ord.length - 1) gap += Math.PI * 2;
            if (gap < 3.0) hull.push(...arcCurve(after, { x: -cur.d.x, y: -cur.d.y }, nb, nx.d, 6, 1.0).slice(1, -1));
          }
          ribbons = [];
          // 直通道路的邊線延伸穿過路口：有其他道路開口的一側畫虛線，沒有開口的一側維持實線
          const angOf = new Map(ord.map(o => [o.e, o]));
          for (const [ea, eb] of pairs) {
            const A = angOf.get(ea), Bo = angOf.get(eb);
            const pa = perp(A.d);
            for (const sgn of [1, -1]) {
              const from = sgn > 0 ? A : Bo, to = sgn > 0 ? Bo : A;
              let sweep = to.a - from.a;
              while (sweep <= 0) sweep += Math.PI * 2;
              const opening = ord.some(o => {
                if (o === A || o === Bo) return false;
                let d = o.a - from.a;
                while (d <= 0) d += Math.PI * 2;
                return d < sweep;
              });
              const p0 = { x: ea.P.x + pa.x * sgn * (ea.hw - 0.75), y: ea.P.y + pa.y * sgn * (ea.hw - 0.75) };
              const p1 = { x: eb.P.x + pa.x * sgn * (eb.hw - 0.75), y: eb.P.y + pa.y * sgn * (eb.hw - 0.75) };
              const pts = arcCurve(p0, { x: -A.d.x, y: -A.d.y }, p1, Bo.d, 4, 1.0);
              crossMk.push({ pts, cum: polyCum(pts), c: 'rgba(255,255,255,0.75)', w: 0.15, dash: opening ? [2, 2.5] : null });
            }
          }
        }
        const strips = (ring || rampJunction) ? pairs.map(([a, b]) => strip(a, b)) : [];
        if (rampJunction) {
          // 匝道：以完整匝道寬度沿匯入 / 分出軌跡接到主線外側車道，並加上加速 / 減速車道漸變段
          ribbons = [];
          const main = new Set(pairs[0].map(e => e.s));
          for (const o of others) {
            for (const merge of [true, false]) {
              let best = null, bd = -2;
              for (const c of n.conns) {
                if (merge ? !(c.from.seg === o.s && main.has(c.to.seg)) : !(c.to.seg === o.s && main.has(c.from.seg))) continue;
                const a = pointAt(c.pts, c.cum, 0), b = pointAt(c.pts, c.cum, c.len);
                const dd = a.dx * b.dx + a.dy * b.dy;
                if (dd > bd) { bd = dd; best = c; }
              }
              if (best) {
                const mainHW = Math.max(...pairs[0].map(e => e.hw));
                strips.push(this.rampMergeGeom(best, merge, o.hw, n.level, n, mainHW, pairs[0].map(e => e.s)));
              }
            }
          }
        }
        j = { kind: 'hub', col: roadColor(widest.T), strips, hull, ribbons, crossMk };
        j.openings = strips.filter(st => st.opening).map(st => st.opening);
        if (j.openings.length) for (const st of strips) if (!st.opening) st.mk = Renderer.splitEdges(st.mk, j.openings);
      }
      if (j.kind === 'hub') j.mk = [...j.strips.flatMap(st => st.mk), ...(j.crossMk || [])];
    }
    n._jg = { ver: net.version, j };
    return j;
  }

  // pass：'curb' 路肩、'body' 柏油
  drawJoint(n, j, pass, curbW) {
    const ctx = this.ctx;
    const ex = pass === 'curb' ? curbW : 0;
    if (j.kind === 'cap') {
      if (j.internal) return;
      ctx.beginPath(); ctx.arc(n.x, n.y, j.r + ex, 0, Math.PI * 2); ctx.fill();
    } else {
      for (const st of j.strips) this.fillPoly(pass === 'curb' ? st.curbs : st.body);
      if (j.hull && j.hull.length >= 3) {
        this.fillPoly(j.hull);
        if (ex) { ctx.lineWidth = ex * 2; ctx.strokeStyle = ctx.fillStyle; ctx.beginPath(); ctx.moveTo(j.hull[0].x, j.hull[0].y); for (const p of j.hull) ctx.lineTo(p.x, p.y); ctx.closePath(); ctx.stroke(); }
      }
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = LANE_W + 0.4 + ex * 2;
      ctx.lineCap = 'round';
      for (const r of j.ribbons) this.strokePoly(r);
    }
  }

  // 匝道與主線的銜接：匝道寬度漸變到一個車道寬的匯流帶，加上沿主線外側的漸變車道
  // 不同道路類型相接（車道增減、四轉三、分隔島變寬）的銜接帶標線：
  // 邊線沿漸變路緣、分隔島寬度內插、車道線由實際車道連接推得（被併掉的車道不畫分隔線）
  transitionMarks(n, e1, e2, C) {
    const W75 = 'rgba(255,255,255,0.75)', mk = [];
    const sm = t => t * t * (3 - 2 * t);
    const N = C.length;
    const off = (sgn, f) => C.map((q, i) => { const o = f(q, i); return { x: q.x + q.nx * sgn * o, y: q.y + q.ny * sgn * o }; });
    for (const sgn of [1, -1]) mk.push({ pts: off(sgn, q => q.w - 0.75), c: W75, w: 0.15, dash: null, edge: true });
    const T1 = e1.s.T, T2 = e2.s.T;
    if (T1.bwd > 0 && T2.bwd > 0) {
      const m1 = T1.median || 0, m2 = T2.median || 0;
      const med = i => m1 + (m2 - m1) * sm(i / (N - 1 || 1));
      if (Math.max(m1, m2) > 1) {
        const L = off(1, (q, i) => Math.max(0, med(i) / 2 - 0.2)), R = off(-1, (q, i) => Math.max(0, med(i) / 2 - 0.2));
        mk.push({ poly: [...L, ...R.reverse()], c: (T1.green || T2.green) ? '#6f9e4f' : '#9a9a92' });
      }
      for (const sgn of [1, -1]) mk.push({ pts: off(sgn, (q, i) => Math.max(0.18, med(i) / 2 - 0.2)), c: '#e8c547', w: 0.15, dash: null });
    }
    // 車道線：相鄰兩條直行連接若接到相鄰車道，中間畫虛線
    const pair = new Set([e1.s, e2.s]);
    const byLink = new Map();
    for (const c of n.conns) {
      if (!pair.has(c.from.seg) || !pair.has(c.to.seg) || c.from.seg === c.to.seg) continue;
      const k = c.from.link.key;
      if (!byLink.has(k)) byLink.set(k, []);
      byLink.get(k).push(c);
    }
    const resample = (c, k) => { const out = []; for (let i = 0; i <= k; i++) { const p = pointAt(c.pts, c.cum, c.len * i / k); out.push(p); } return out; };
    for (const cs of byLink.values()) {
      cs.sort((a, b) => a.from.idx - b.from.idx || a.to.idx - b.to.idx);
      for (let i = 0; i < cs.length; i++) for (let j = 0; j < cs.length; j++) {
        const a = cs[i], b = cs[j];
        if (b.from.idx !== a.from.idx + 1 || b.to.idx !== a.to.idx + 1) continue;
        const pa = resample(a, 16), pb = resample(b, 16);
        mk.push({ pts: pa.map((p, k) => ({ x: (p.x + pb[k].x) / 2, y: (p.y + pb[k].y) / 2 })), c: 'rgba(255,255,255,0.8)', w: 0.14, dash: [3, 5] });
      }
    }
    for (const m of mk) if (m.pts) m.cum = polyCum(m.pts);
    return mk;
  }

  // 把落在指定區域內的標線段去掉
  static dropInside(marks, inside) {
    const out = [];
    for (const m of marks) {
      if (!m.pts) { out.push(m); continue; }
      const dense = [];
      for (let i = 0; i < m.pts.length - 1; i++) {
        const a = m.pts[i], b = m.pts[i + 1];
        const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
        for (let t = 0; t < k; t++) dense.push({ x: a.x + (b.x - a.x) * t / k, y: a.y + (b.y - a.y) * t / k });
      }
      dense.push(m.pts[m.pts.length - 1]);
      let run = [];
      const flush = () => { if (run.length >= 2) { const r = { ...m, pts: run }; r.cum = polyCum(run); out.push(r); } run = []; };
      for (const p of dense) { if (inside(p)) flush(); else run.push(p); }
      flush();
    }
    return out;
  }

  // 匝道匯流帶：維持匝道寬度沿匯入 / 分出軌跡接到主線外側，並畫出匝道標線
  // - 外側邊線一路延續，最後與主線邊線接上
  // - 內側邊線畫到碰到主線路面為止（形成三角槽化區的尖端）
  rampMergeGeom(c, merge, rampHW, level, node, mainHW, mainSegs) {
    const endHW = LANE_W / 2 + 0.8;
    const sm = t => t * t * (3 - 2 * t);
    const C = Renderer.withNormals(c.pts.map((p, i) => {
      const f = sm(c.cum[i] / (c.len || 1));
      return { x: p.x, y: p.y, w: merge ? rampHW + (endHW - rampHW) * f : endHW + (rampHW - endHW) * f, h: level };
    }));
    const lat = p => Math.min(...mainSegs.map(m => closestOnPoly(m.pts, m.cum, p).d));
    const mid = C[Math.floor(C.length / 2)];
    // 外側 = 離主線較遠的一側
    const outer = lat({ x: mid.x + mid.nx, y: mid.y + mid.ny }) > lat({ x: mid.x - mid.nx, y: mid.y - mid.ny }) ? 1 : -1;
    const line = sgn => C.map(q => ({ x: q.x + q.nx * sgn * (q.w - 0.75), y: q.y + q.ny * sgn * (q.w - 0.75) }));
    const mk = [];
    // 匝道兩側邊線都只畫在主線路面之外（不會畫到主線車道上）
    const outside = p => lat(p) > mainHW - 0.75 + 0.15;
    for (const pts of [line(outer), line(-outer)]) {
      let run = [];
      for (const p of pts) {
        if (outside(p)) run.push(p);
        else { if (run.length >= 2) mk.push({ pts: run, c: 'rgba(255,255,255,0.75)', w: 0.15, dash: null }); run = []; }
      }
      if (run.length >= 2) mk.push({ pts: run, c: 'rgba(255,255,255,0.75)', w: 0.15, dash: null });
    }
    for (const m of mk) m.cum = polyCum(m.pts);
    const body = Renderer.ribbonPoly(C, 0);
    return { body, curbs: Renderer.ribbonPoly(C, 0.5), mk, opening: Renderer.ribbonPoly(C, 0.4) };
  }

  // 邊線遇到匝道開口時改為虛線（車輛可跨越匯入 / 分出）
  static splitEdges(marks, openings) {
    if (!openings || !openings.length) return marks;
    const out = [];
    for (const m of marks) {
      if (!m.edge) { out.push(m); continue; }
      const dense = [];
      for (let i = 0; i < m.pts.length - 1; i++) {
        const a = m.pts[i], b = m.pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
        for (let k = 0; k < n; k++) dense.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
      }
      dense.push(m.pts[m.pts.length - 1]);
      let run = [], runIn = null;
      const flush = () => {
        if (run.length >= 2) {
          const r = { ...m, pts: run, dash: runIn ? [2, 2.5] : m.dash };
          r.cum = polyCum(r.pts);
          out.push(r);
        }
      };
      for (const p of dense) {
        const inside = openings.some(o => pointInPoly(p, o));
        if (runIn === null) runIn = inside;
        if (inside !== runIn) { run.push(p); flush(); run = [p]; runIn = inside; } else run.push(p);
      }
      flush();
    }
    return out;
  }

  vehLevel(vh) {
    const tr = vh.track;
    if (tr.kind !== 'lane') return tr.drawLevel;
    if (tr.h0 === tr.h1) return tr.drawLevel;
    const h = tr.h0 + (tr.h1 - tr.h0) * clamp(vh.s / tr.len, 0, 1);
    return h >= 0.5 ? Math.round(h) : h <= -0.5 ? Math.round(h) : 0;
  }

  drawNetwork(v) {
    const g = this.game, ctx = this.ctx, net = g.net, z = this.cam.z;
    const byLevel = new Map(DRAW_LEVELS.map(l => [l, []]));
    for (const s of net.segs.values()) {
      if (!this.inView(s.bbox, v)) continue;
      for (const pc of this.roadGeom(s)) byLevel.get(pc.lv)?.push(pc);
    }
    const nodesBy = new Map(DRAW_LEVELS.map(l => [l, []]));
    for (const n of net.nodes.values()) if (n.x > v.x0 - 60 && n.x < v.x1 + 60 && n.y > v.y0 - 60 && n.y < v.y1 + 60) nodesBy.get(n.level)?.push(n);
    const vehBy = new Map(DRAW_LEVELS.map(l => [l, []]));
    for (const vh of g.traffic.vehicles) vehBy.get(this.vehLevel(vh))?.push(vh);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const L of DRAW_LEVELS) {
      const pieces = byLevel.get(L), nodes = nodesBy.get(L);
      if (!pieces.length && !nodes.length && !vehBy.get(L).length) continue;
      const tunnel = L < 0;
      const joints = [];
      for (const n of nodes) { const j = this.jointGeom(n); if (j) joints.push([n, j]); }
      if (L > 0) {
        // 陰影（依各點高度偏移）與橋墩
        ctx.fillStyle = 'rgba(0,0,0,0.26)';
        for (const pc of pieces) this.fillPoly(pc.shadow);
        ctx.save();
        ctx.translate(L * LEVEL_H * 0.55, L * LEVEL_H * 0.85);
        for (const [n, j] of joints) { ctx.fillStyle = 'rgba(0,0,0,0.26)'; this.drawJoint(n, j, 'body', 0); }
        ctx.restore();
        ctx.strokeStyle = '#7d7a72';
        ctx.lineWidth = 2.2;
        for (const pc of pieces) {
          const s = pc.seg;
          for (let t = 12; t < s.len - 4; t += 28) {
            if (net.segHeightAt(s, t) < 0.5) continue;
            const p = pointAt(s.pts, s.cum, t), w = halfWidth(s.T) * 0.7;
            ctx.beginPath();
            ctx.moveTo(p.x - p.dy * w, p.y + p.dx * w);
            ctx.lineTo(p.x + p.dy * w, p.y - p.dx * w);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = tunnel ? 0.35 : 1;
      // 人行道：一般道路兩側（建築地塊與路邊之間的 1.5 m）
      if (L === 0 && !tunnel && z > 0.5) {
        ctx.strokeStyle = '#c9c5bb'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const pc of pieces) {
          const T = pc.seg.T;
          if (!T.access || T.internal || pc.seg.drawLevel !== 0) continue;
          ctx.lineWidth = (halfWidth(T) + 1.6) * 2;
          this.strokePoly(pc.seg.pts);
        }
      }
      // 路肩（先畫全部路肩，再畫柏油，接縫處不會出現邊線）
      const curbCol = tunnel ? '#222' : curbColor(L);
      const curbW = 0.5;
      for (const pc of pieces) {
        // 坡道路肩顏色依高度漸變，地面段與高架段之間不會出現色塊斷層
        if (pc.grad && !tunnel) {
          const gr = ctx.createLinearGradient(pc.grad.p0.x, pc.grad.p0.y, pc.grad.p1.x, pc.grad.p1.y);
          gr.addColorStop(0, curbColor(pc.grad.h0));
          gr.addColorStop(1, curbColor(pc.grad.h1));
          ctx.fillStyle = gr;
        } else ctx.fillStyle = curbCol;
        if (!pc.seg.T.internal) this.fillPoly(pc.curb);
      }
      for (const [n, j] of joints) { ctx.fillStyle = curbCol; this.drawJoint(n, j, 'curb', curbW); }
      // 柏油
      for (const pc of pieces) { ctx.fillStyle = pc.col; this.fillPoly(pc.body); }
      for (const [n, j] of joints) { ctx.fillStyle = j.col; this.drawJoint(n, j, 'body', 0); }
      ctx.lineCap = 'round';
      // 標線
      if (z > 0.9 && !tunnel) {
        const mkSets = pieces.map(pc => pc.mk);
        for (const [, j] of joints) if (j.mk && j.mk.length) mkSets.push(j.mk);
        for (const mks of mkSets) {
          for (const m of mks) {
            if (m.poly) { ctx.fillStyle = m.c; this.fillPoly(m.poly); continue; }
            ctx.strokeStyle = m.c;
            ctx.lineWidth = m.w;
            ctx.lineCap = m.median ? 'butt' : 'round';
            ctx.setLineDash(m.dash || []);
            this.strokePoly(m.pts);
          }
        }
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
        // 停止線（號誌 / 全向停車：實線）與讓路線（自動路權下需讓路的方向：虛線）
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 0.4;
        for (const n of nodes) {
          if (n.control === 'auto' && (n.segs.length < 3 || (n.jinfo && n.jinfo.ramp))) continue;
          const ins = net.inLinks(n);
          let maxRank = -Infinity;
          if (n.control === 'auto') for (const Lk of ins) maxRank = Math.max(maxRank, net.approachRank(n, Lk));
          for (const Lk of ins) {
            if (n.control === 'auto' && net.approachRank(n, Lk) >= maxRank) continue;
            ctx.setLineDash(n.control === 'auto' ? [0.9, 0.7] : []);
            for (const lane of Lk.lanes) {
              const p = pointAt(lane.pts, lane.cum, lane.len - 0.3);
              ctx.beginPath();
              ctx.moveTo(p.x + p.dy * 1.6, p.y - p.dx * 1.6);
              ctx.lineTo(p.x - p.dy * 1.6, p.y + p.dx * 1.6);
              ctx.stroke();
            }
          }
        }
        ctx.setLineDash([]);
        // 路口前的轉向箭頭（依實際車道連接，玩家調整後會跟著改變）
        if (z > 1.6) for (const n of nodes) {
          if (n.segs.length < 3 || (n.jinfo && (n.jinfo.ramp || n.jinfo.ring))) continue;
          for (const Lk of net.inLinks(n)) if (!Lk.seg.T.internal) for (const lane of Lk.lanes) if (lane.len > 18) this.turnArrows(lane);
        }
      }
      if (tunnel) {
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#2a2a2a';
        ctx.lineWidth = 0.6;
        for (const pc of pieces) { this.strokePoly(pc.left); this.strokePoly(pc.right); }
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = tunnel ? 0.6 : 1;
      this.drawVehicles(vehBy.get(L), v);
      ctx.globalAlpha = 1;
      if (z > 0.6) this.drawSignals(nodes);
    }
  }

  drawVehicles(list, v) {
    const ctx = this.ctx, c = this.cam, d = this.dpr, z = c.z;
    const a = d * z;
    const ox = d * (this.W / 2 - c.x * z), oy = d * (this.H / 2 - c.y * z);
    const detail = z > 2.2;
    for (const vh of list) {
      if (vh.hold > 0) continue;   // 還在從停車位開出來（由停車動畫畫出）
      const p = this.vehPose(vh);
      const lat = p.lat;
      const x = p.x - p.dy * lat, y = p.y + p.dx * lat;
      if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) continue;
      let dx = p.dx, dy = p.dy;
      if (lat) {
        const k = -lat * 0.08;
        dx = p.dx - p.dy * k; dy = p.dy + p.dx * k;
        const L = Math.hypot(dx, dy); dx /= L; dy /= L;
      }
      ctx.setTransform(a * dx, a * dy, -a * dy, a * dx, ox + a * x, oy + a * y);
      const hl = vh.len / 2, hw = vh.w / 2;
      if (vh.fadeIn !== undefined && vh.fadeIn < 1) ctx.globalAlpha = vh.fadeIn;
      this.carBody(vh.color, vh.len, vh.w, vh.truck, detail);
      ctx.globalAlpha = 1;
      if (detail) {
        if (vh.braking) {
          ctx.fillStyle = '#ff3b30';
          ctx.fillRect(-hl - 0.1, -hw, 0.35, 0.5);
          ctx.fillRect(-hl - 0.1, hw - 0.5, 0.35, 0.5);
        }
      }
    }
    this.worldTf();
  }

  // 車身（區域座標：x 為車頭方向）：陰影、圓角車身、車頂亮面、前後擋風玻璃
  carBody(color, len, w, truck, detail) {
    const ctx = this.ctx, hl = len / 2, hw = w / 2;
    if (detail) { ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(-hl + 0.35, -hw + 0.35, len, w); }
    ctx.fillStyle = color;
    if (detail && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(-hl, -hw, len, w, 0.45); ctx.fill(); } else ctx.fillRect(-hl, -hw, len, w);
    if (!detail) return;
    if (truck) {
      ctx.fillStyle = '#5b6f8a'; ctx.fillRect(hl - 2.2, -hw, 2.2, w);
      ctx.fillStyle = 'rgba(30,40,55,0.8)'; ctx.fillRect(hl - 0.7, -hw + 0.15, 0.45, w - 0.3);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(-hl + 0.3, -hw + 0.3, len - 3, w - 0.6);
      return;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(-hl * 0.45, -hw + 0.3, len * 0.42, w - 0.6);
    ctx.fillStyle = 'rgba(30,40,55,0.78)';
    ctx.fillRect(hl - 1.75, -hw + 0.2, 0.8, w - 0.4);
    ctx.fillRect(-hl + 0.45, -hw + 0.25, 0.55, w - 0.5);
    ctx.fillStyle = 'rgba(255,250,220,0.9)'; ctx.fillRect(hl - 0.15, -hw + 0.15, 0.15, 0.35); ctx.fillRect(hl - 0.15, hw - 0.5, 0.15, 0.35);
  }

  // 停車 / 出車中的車：沿貝茲曲線開進或開出停車位
  drawArrivals(v) {
    const ctx = this.ctx, c = this.cam, d = this.dpr, z = c.z, a = d * z;
    const ox = d * (this.W / 2 - c.x * z), oy = d * (this.H / 2 - c.y * z);
    for (const f of this.game.traffic.fx) {
      const k = Math.min(1, f.t / f.dur), e = k * k * (3 - 2 * k), m = 1 - e, [p0, p1, p2, p3] = f.pts;
      const x = m * m * m * p0.x + 3 * m * m * e * p1.x + 3 * m * e * e * p2.x + e * e * e * p3.x;
      const y = m * m * m * p0.y + 3 * m * m * e * p1.y + 3 * m * e * e * p2.y + e * e * e * p3.y;
      if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) continue;
      const tt = Math.min(0.995, Math.max(0.005, e)), n = 1 - tt;
      let dx = 3 * n * n * (p1.x - p0.x) + 6 * n * tt * (p2.x - p1.x) + 3 * tt * tt * (p3.x - p2.x);
      let dy = 3 * n * n * (p1.y - p0.y) + 6 * n * tt * (p2.y - p1.y) + 3 * tt * tt * (p3.y - p2.y);
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      ctx.setTransform(a * dx, a * dy, -a * dy, a * dx, ox + a * x, oy + a * y);
      // 開進 / 開出車庫：在車庫門口淡出 / 淡入
      ctx.globalAlpha = !f.indoor ? 1 : f.arrive ? clamp((1 - k) / 0.35, 0, 1) : clamp(k / 0.35, 0, 1);
      this.carBody(f.color, f.len, f.w, f.truck, z > 2.2);
    }
    ctx.globalAlpha = 1;
    this.worldTf();
  }

  drawSignals(nodes) {
    const ctx = this.ctx, g = this.game, net = g.net;
    for (const n of nodes) {
      if (n.control === 'signal' && n.signal) {
        const sig = n.signal, ph = sig.phases[sig.cur];
        for (const L of net.inLinks(n)) {
          const inP = ph.set.has(L.key);
          let col = '#e53935';
          if (inP && sig.state === 'green') col = '#43d17a';
          else if (inP && sig.state === 'yellow') col = '#ffc93c';
          for (const lane of L.lanes) {
            const p = pointAt(lane.pts, lane.cum, lane.len);
            ctx.fillStyle = '#111';
            ctx.beginPath(); ctx.arc(p.x, p.y, 1.05, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = col;
            ctx.beginPath(); ctx.arc(p.x, p.y, 0.75, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else if (n.control === 'stop') {
        for (const L of net.inLinks(n)) {
          const lane = L.lanes[L.lanes.length - 1];
          const p = pointAt(lane.pts, lane.cum, lane.len);
          ctx.fillStyle = '#d32f2f';
          ctx.beginPath(); ctx.arc(p.x - p.dy * 2.4, p.y + p.dx * 2.4, 0.9, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  drawHeatmap(v) {
    const ctx = this.ctx, net = this.game.net;
    ctx.lineCap = 'butt';
    for (const s of net.segs.values()) {
      if (!this.inView(s.bbox, v)) continue;
      for (const dir of [1, -1]) {
        const L = s.links[dir];
        if (!L.lanes.length) continue;
        const ratio = L.count ? L.flow / L.limit : 1;
        ctx.strokeStyle = heatColor(ratio);
        ctx.globalAlpha = L.count ? 0.85 : 0.35;
        const n = L.lanes.length;
        ctx.lineWidth = n * LANE_W * 0.8;
        const off = s.T.bwd === 0 ? 0 : dir * ((s.T.median || 0) / 2 + n * LANE_W / 2);
        this.strokePoly(offsetPoly(s.core, off));
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
  }

  drawSelection() {
    const g = this.game, ctx = this.ctx, sel = g.ui.selection;
    if (!sel) return;
    const z = this.cam.z;
    if (sel.type === 'vehicle') {
      const vh = sel.obj;
      if (vh.dead) return;
      ctx.strokeStyle = 'rgba(80,220,255,0.7)';
      ctx.lineWidth = Math.max(1.2, 3 / z);
      for (let i = vh.ri; i < vh.route.length; i++) {
        const L = g.net.links.get(vh.route[i]);
        if (!L || !L.lanes.length) continue;
        this.strokePoly(L.lanes[L.lanes.length - 1].pts);
      }
      const p = this.vehPose(vh);
      ctx.strokeStyle = '#50dcff';
      ctx.lineWidth = 2 / z;
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.stroke();
      const dest = vh.trip.to;
      const ds = g.net.segs.get(dest.seg);
      if (ds) {
        const q = pointAt(ds.pts, ds.cum, dest.u);
        ctx.fillStyle = '#50dcff';
        ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(2, 5 / z), 0, Math.PI * 2); ctx.fill();
      }
    } else if (sel.type === 'building') {
      const c = sel.obj.corners;
      ctx.strokeStyle = '#50dcff';
      ctx.lineWidth = 2 / z;
      ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath(); ctx.stroke();
    } else if (sel.type === 'segment') {
      const s = sel.obj;
      if (!g.net.segs.has(s.id)) return;
      ctx.strokeStyle = 'rgba(80,220,255,0.5)';
      ctx.lineWidth = halfWidth(s.T) * 2 + 2;
      this.strokePoly(s.pts);
      // 方向箭頭
      ctx.fillStyle = '#fff';
      for (const lane of s.lanes) {
        for (let t = 10; t < lane.len - 4; t += 25) this.arrow(lane, t, 1.4);
      }
    } else if (sel.type === 'node') {
      this.drawJunctionEditor(sel.obj);
    }
  }

  // 地面轉向箭頭：直行 / 左轉 / 右轉 / 迴轉的組合
  turnArrows(lane) {
    const set = new Set(lane.conns.map(c => (c.turn === 'MR' || c.turn === 'ML' ? 'S' : c.turn)));
    if (!set.size) return;
    // 整個箭頭控制在車道中心 ±1 m 內，不壓到車道線
    const ctx = this.ctx, p = pointAt(lane.pts, lane.cum, lane.len - 8);
    const fx = p.dx, fy = p.dy, rx = -p.dy, ry = p.dx;
    const P = (f, r) => [p.x + fx * f + rx * r, p.y + fy * f + ry * r];
    const head = (f, r, hx, hy) => {
      const [x, y] = P(f, r), nx = -hy, ny = hx;
      ctx.beginPath(); ctx.moveTo(x + hx * 0.7, y + hy * 0.7);
      ctx.lineTo(x + nx * 0.45, y + ny * 0.45); ctx.lineTo(x - nx * 0.45, y - ny * 0.45); ctx.closePath(); ctx.fill();
    };
    ctx.strokeStyle = ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.lineWidth = 0.26;
    ctx.beginPath(); ctx.moveTo(...P(-2.4, 0)); ctx.lineTo(...P(0.2, 0)); ctx.stroke();
    if (set.has('S')) { ctx.beginPath(); ctx.moveTo(...P(0.2, 0)); ctx.lineTo(...P(1.8, 0)); ctx.stroke(); head(1.8, 0, fx, fy); }
    for (const [k, sg] of [['L', -1], ['R', 1]]) {
      if (!set.has(k)) continue;
      ctx.beginPath(); ctx.moveTo(...P(0.2, 0)); ctx.quadraticCurveTo(...P(1.1, 0), ...P(1.1, sg * 0.45)); ctx.stroke();
      head(1.1, sg * 0.45, rx * sg, ry * sg);
    }
    if (set.has('U')) {
      ctx.beginPath(); ctx.moveTo(...P(0.2, 0)); ctx.quadraticCurveTo(...P(1.5, 0), ...P(1.5, -0.45)); ctx.quadraticCurveTo(...P(1.5, -0.9), ...P(0.5, -0.9)); ctx.stroke();
      head(0.5, -0.9, -fx, -fy);
    }
  }

  arrow(lane, t, sz) {
    const ctx = this.ctx, p = pointAt(lane.pts, lane.cum, t);
    ctx.beginPath();
    ctx.moveTo(p.x + p.dx * sz, p.y + p.dy * sz);
    ctx.lineTo(p.x - p.dx * sz - p.dy * sz * 0.7, p.y - p.dy * sz + p.dx * sz * 0.7);
    ctx.lineTo(p.x - p.dx * sz + p.dy * sz * 0.7, p.y - p.dy * sz - p.dx * sz * 0.7);
    ctx.closePath();
    ctx.fill();
  }

  drawJunctionEditor(node) {
    const g = this.game, ctx = this.ctx, net = g.net, z = this.cam.z;
    if (!net.nodes.has(node.id)) return;
    const selLane = g.ui.jSelLane;
    ctx.lineCap = 'round';
    const turnCol = { L: '#ffb74d', R: '#81c784', S: '#e0e0e0', U: '#ce93d8', MR: '#90caf9', ML: '#90caf9' };
    ctx.lineJoin = 'round';
    // 深色底線讓連接線在柏油上更清楚
    for (const c of node.conns) {
      const hl = selLane && c.from === selLane;
      if (selLane && !hl) continue;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = hl ? 0.95 : 0.7;
      this.strokePoly(c.pts);
    }
    for (const c of node.conns) {
      const hl = selLane && c.from === selLane;
      ctx.strokeStyle = hl ? '#50dcff' : turnCol[c.turn];
      ctx.globalAlpha = selLane && !hl ? 0.25 : 0.95;
      ctx.lineWidth = hl ? 0.55 : 0.38;
      this.strokePoly(c.pts);
      // 箭頭放在接近終點處，順著曲線方向
      ctx.fillStyle = ctx.strokeStyle;
      const p = pointAt(c.pts, c.cum, Math.max(0, c.len - 1.1));
      const sz = hl ? 1.1 : 0.9;
      ctx.beginPath();
      ctx.moveTo(p.x + p.dx * sz, p.y + p.dy * sz);
      ctx.lineTo(p.x - p.dx * sz * 0.6 - p.dy * sz * 0.65, p.y - p.dy * sz * 0.6 + p.dx * sz * 0.65);
      ctx.lineTo(p.x - p.dx * sz * 0.6 + p.dy * sz * 0.65, p.y - p.dy * sz * 0.6 - p.dx * sz * 0.65);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const L of net.inLinks(node)) for (const lane of L.lanes) {
      const p = lane.pts[lane.pts.length - 1];
      ctx.fillStyle = lane === selLane ? '#50dcff' : '#ff8a3d';
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.75, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#111'; ctx.lineWidth = 0.2; ctx.stroke();
    }
    for (const L of net.outLinks(node)) for (const lane of L.lanes) {
      const p = lane.pts[0];
      ctx.fillStyle = selLane ? '#7cf29a' : '#2fbf71';
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.75, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#111'; ctx.lineWidth = 0.2; ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(80,220,255,0.6)';
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([4 / z, 4 / z]);
    ctx.beginPath(); ctx.arc(node.x, node.y, Math.max(node.radius + 6, 10), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  drawLabels(v) {
    const g = this.game, ctx = this.ctx, z = this.cam.z;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const o of g.city.outside) {
      const n = g.net.nodes.get(o.node);
      if (!n) continue;
      const p = this.toScreen(n.x, n.y);
      if (p.x < -50 || p.y < -50 || p.x > this.W + 50 || p.y > this.H + 50) continue;
      const lbl = `⇄ ${o.name}`;
      const w = ctx.measureText(lbl).width + 14;
      ctx.fillStyle = 'rgba(20,28,40,0.85)';
      ctx.beginPath(); ctx.roundRect(p.x - w / 2, p.y - 32, w, 20, 6); ctx.fill();
      ctx.fillStyle = '#ffd25e';
      ctx.fillText(lbl, p.x, p.y - 18);
    }
    if (z > 0.7) {
      ctx.font = '700 11px system-ui, sans-serif';
      for (const b of g.city.buildings) {
        if (b.x < v.x0 || b.x > v.x1 || b.y < v.y0 || b.y > v.y1) continue;
        if (b.happy >= 0.35 && !b.abandoned) continue;
        const p = this.toScreen(b.x, b.y);
        ctx.fillStyle = b.abandoned ? '#666' : '#e53935';
        ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(b.abandoned ? '×' : '!', p.x, p.y + 4);
      }
    }
  }
}

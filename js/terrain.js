// 程序化地形：4 種生態系、水域、河流、樹木
import { fbm, RNG, clamp, lerp, hash2 } from './util.js';
import { BIOMES } from './config.js';

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

export class Terrain {
  constructor(seed, biomeKey, size) {
    this.seed = seed;
    this.biomeKey = biomeKey;
    this.biome = BIOMES[biomeKey];
    this.size = size;
    this.cell = 8;
    this.n = Math.ceil(size / this.cell);
    const n = this.n, b = this.biome;
    this.h = new Float32Array(n * n);
    this.water = new Uint8Array(n * n);
    const c = size / 2;
    const rng = new RNG(seed ^ 0x5bd1e995);
    // 河流：與市中心保持距離的蜿蜒水道
    const riverSide = rng.chance(0.5) ? 1 : -1;
    const riverOff = riverSide * rng.range(330, 520);
    const riverVertical = rng.chance(0.5);
    const riverW = rng.range(26, 40);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * this.cell, y = (j + 0.5) * this.cell;
        let e = fbm(x / b.scale, y / b.scale, seed, 5);
        const d = Math.hypot(x - c, y - c);
        if (b.islands) e -= 0.32 * Math.pow(d / (size * 0.62), 2) - 0.08;
        if (b.river) {
          const along = riverVertical ? y : x, across = riverVertical ? x : y;
          const center = c + riverOff + Math.sin(along / 260) * 90 + (fbm(along / 500, 7.7, seed + 99, 3) - 0.5) * 320;
          const rd = Math.abs(across - center);
          const w = riverW * (0.8 + 0.4 * fbm(along / 300, 3.3, seed + 7, 2));
          if (rd < w) e = Math.min(e, b.water - 0.06);
          else if (rd < w + 30) e = Math.min(e, lerp(b.water - 0.02, e, (rd - w) / 30));
        }
        // 市中心保證是陸地
        e += 0.4 * clamp(1 - d / 430, 0, 1);
        this.h[j * n + i] = e;
        this.water[j * n + i] = e < b.water ? 1 : 0;
      }
    }
    this.genTrees(seed);
    this.canvas = null;
  }

  idx(x, y) {
    const i = Math.floor(x / this.cell), j = Math.floor(y / this.cell);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }
  isWater(x, y) {
    const k = this.idx(x, y);
    return k < 0 ? true : this.water[k] === 1;
  }
  inBounds(x, y, m = 0) { return x >= m && y >= m && x <= this.size - m && y <= this.size - m; }

  genTrees(seed) {
    const b = this.biome, rng = new RNG(seed + 4242);
    const xs = [], ys = [], kind = [];
    const count = Math.floor(9000 * b.treeDensity);
    for (let k = 0; k < count * 3 && xs.length < count; k++) {
      const x = rng.range(0, this.size), y = rng.range(0, this.size);
      if (this.isWater(x, y)) continue;
      const f = fbm(x / 260, y / 260, seed + 555, 3);
      if (f < 0.5 - b.treeDensity * 0.15) continue;
      const cx = x - this.size / 2, cy = y - this.size / 2;
      if (cx * cx + cy * cy < 180 * 180 && rng.chance(0.7)) continue;
      xs.push(x); ys.push(y); kind.push(Math.floor(hash2(k, 3, seed) * 3));
    }
    this.treeX = Float32Array.from(xs);
    this.treeY = Float32Array.from(ys);
    this.treeK = Uint8Array.from(kind);
    this.treeAlive = new Uint8Array(xs.length).fill(1);
    this.treeGrid = new Map();
    for (let i = 0; i < xs.length; i++) {
      const key = Math.floor(xs[i] / 50) + ',' + Math.floor(ys[i] / 50);
      if (!this.treeGrid.has(key)) this.treeGrid.set(key, []);
      this.treeGrid.get(key).push(i);
    }
  }

  // 清除距離折線 r 公尺內的樹
  clearTreesAlong(pts, r) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(L / 20));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + (b.x - a.x) * s / steps, y = a.y + (b.y - a.y) * s / steps;
        this.clearTreesCircle(x, y, Math.max(r, 12));
      }
    }
  }
  clearTreesCircle(x, y, r) {
    const g0 = Math.floor((x - r) / 50), g1 = Math.floor((x + r) / 50);
    const h0 = Math.floor((y - r) / 50), h1 = Math.floor((y + r) / 50);
    for (let gi = g0; gi <= g1; gi++) for (let hj = h0; hj <= h1; hj++) {
      const arr = this.treeGrid.get(gi + ',' + hj);
      if (!arr) continue;
      for (const t of arr) {
        if (!this.treeAlive[t]) continue;
        const dx = this.treeX[t] - x, dy = this.treeY[t] - y;
        if (dx * dx + dy * dy < r * r) this.treeAlive[t] = 0;
      }
    }
  }

  // 繪製地形底圖（瀏覽器才會呼叫）
  getCanvas() {
    if (this.canvas) return this.canvas;
    const n = this.n, b = this.biome;
    const cv = document.createElement('canvas');
    cv.width = n; cv.height = n;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(n, n);
    const land = b.land.map(hexToRgb), high = hexToRgb(b.high), shore = hexToRgb(b.shore);
    const wc = b.waterC.map(hexToRgb);
    for (let k = 0; k < n * n; k++) {
      const e = this.h[k];
      let col;
      if (this.water[k]) {
        const t = clamp((b.water - e) / 0.12, 0, 1);
        col = mix(wc[0], wc[1], t);
      } else {
        const t = clamp((e - b.water) / (1 - b.water), 0, 1);
        if (t < 0.03) col = mix(shore, land[0], t / 0.03);
        else if (t < 0.35) col = mix(land[0], land[1], (t - 0.03) / 0.32);
        else if (t < 0.65) col = mix(land[1], land[2], (t - 0.35) / 0.3);
        else col = mix(land[2], high, clamp((t - 0.65) / 0.35, 0, 1));
        const nz = (hash2(k % n, Math.floor(k / n), this.seed) - 0.5) * 8;
        col = [col[0] + nz, col[1] + nz, col[2] + nz];
      }
      img.data[k * 4] = col[0]; img.data[k * 4 + 1] = col[1]; img.data[k * 4 + 2] = col[2]; img.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.canvas = cv;
    return cv;
  }
}

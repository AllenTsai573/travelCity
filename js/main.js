// 遊戲主控：建立世界、主迴圈、存讀檔
import { SIM_DT, CLOCK, MAP_SIZE, DIFFICULTY, MILESTONES } from './config.js';
import { RNG } from './util.js';
import { Terrain } from './terrain.js';
import { Network, halfWidth } from './network.js';
import { Traffic } from './traffic.js';
import { City } from './city.js';
import { Renderer } from './render.js';
import { Tools } from './tools.js';
import { UI } from './ui.js';
import { generateWorld } from './worldgen.js';

// 部署版本（scripts/bump-version.mjs 加在網址上的 ?v=），錯誤回報用
export const VERSION = new URL(import.meta.url).searchParams.get('v') || 'local';
const ERR_KEY = 'travelcity_errors';
import { Transit } from './transit.js';

const SAVE_KEY = 'travelcity_save_v1';

class Game {
  constructor() {
    // 錯誤紀錄（上次當機前的錯誤也留著）
    try { this.errors = JSON.parse(localStorage.getItem(ERR_KEY) || '[]'); } catch { this.errors = []; }
    this.canvas = document.getElementById('view');
    this.renderer = new Renderer(this, this.canvas);
    this.ui = new UI(this);
    this.ui.onError(null);   // 上次留下的錯誤紀錄：顯示「⚠ 錯誤」按鈕
    this.tools = new Tools(this, this.canvas);
    // 一般速度為 1.5 倍模擬速度（▶▶ 3 倍、▶▶▶ 8 倍）
    this.speed = 1.5;
    this.paused = false;
    this.heatmap = false;
    this.zonemap = false;
    this.flowmap = false;      // 行程圖
    this.transitmap = false;   // 大眾運輸路線圖
    this.autoGrow = true;
    this.net = null;
    this.terrain = null;
    this.milestone = 0;
    this.last = performance.now();
    this.simAcc = 0;
    this.autosaveT = 0;
    this.ui.refreshToolbar();
    requestAnimationFrame(t => this.frame(t));
  }

  // ---------- 資金 ----------
  unlocked(level) { return !!(this.diff && this.diff.unlockAll) || level <= this.milestone; }
  canAfford(c) { return this.diff.unlockAll || this.money >= c; }
  spend(c) { if (!this.diff.unlockAll) this.money -= c; }
  earn(x, toll = false) {
    if (this.diff.unlockAll) return;
    this.money += x;
    if (toll) this.city.stats.hourIncome += x;
  }
  notify(msg, kind = 'info') { this.ui.toast(msg, kind); }

  // 城市稱號依曾達到的最高人口；升級時通知這一級解鎖了什麼
  checkMilestone(silent = false) {
    for (let i = MILESTONES.length - 1; i > this.milestone; i--) {
      if (this.city.peakPop >= MILESTONES[i].pop) {
        if (!silent) for (let k = this.milestone + 1; k <= i; k++) this.notify(`🎉 城市成長為「${MILESTONES[k].name}」！解鎖：${MILESTONES[k].unlock}`, 'good');
        this.milestone = i;
        this.ui.refreshToolbar();
        break;
      }
    }
  }

  setSpeed(s) { this.speed = s; this.paused = false; this.ui.refreshTop(); }
  togglePause() { this.paused = !this.paused; this.ui.refreshTop(); }
  toggleHeatmap() { this.heatmap = !this.heatmap; this.ui.refreshTop(); }
  toggleZonemap() { this.zonemap = !this.zonemap; this.ui.refreshTop(); }
  toggleFlowmap() { this.flowmap = !this.flowmap; this.ui.refreshTop(); }
  toggleTransitmap() { this.transitmap = !this.transitmap; this.ui.refreshTop(); }

  // ---------- 世界 ----------
  setup(seed, biome, difficulty, size = MAP_SIZE) {
    this.seed = seed;
    this.biomeKey = biome;
    this.diffKey = difficulty;
    this.diff = DIFFICULTY[difficulty];
    this.rng = new RNG(seed * 7 + 13);
    this.terrain = new Terrain(seed, biome, size);
    this.time = 7 * 60;
    this.money = this.diff.money;
    this.milestone = 0;
    this.net = new Network(this);
    this.city = new City(this);
    this.traffic = new Traffic(this);
    this.transit = new Transit(this);
    this.simAcc = 0;
  }

  // start：'town' 預設小鎮（道路與分區已規劃，6 個遊戲小時後才開始有人進駐）；'blank' 空白地圖（只有外部連線、不自動發展）
  newGame({ seed, biome, difficulty, start = 'town' }) {
    this.setup(seed, biome, difficulty);
    const blank = start === 'blank';
    generateWorld(this, blank ? { blank: true } : { empty: true });
    this.city.growStart = this.time + 360;
    this.autoGrow = !blank;
    Object.assign(this.renderer.cam, { x: MAP_SIZE / 2, y: MAP_SIZE / 2, z: blank ? 0.5 : 1.1 });
    this.afterLoad();
    this.notify(blank
      ? `歡迎來到${this.terrain.biome.name}！這是空白地圖：從地圖邊緣的外部連線開始鋪路、劃分區吧（自動發展已關閉）。`
      : `歡迎來到${this.terrain.biome.name}！小鎮的分區已經劃好，約 6 個遊戲小時後開始有人進駐。`, 'good');
  }

  afterLoad() {
    this.ui.select(null);
    this.tools.setTool('select');
    this.ui.refreshToolbar();
    this.ui.refreshTop();
  }

  serialize() {
    return {
      v: 1, mapSize: this.terrain.size, seed: this.seed, biome: this.biomeKey, diff: this.diffKey, time: this.time, money: this.money,
      milestone: this.milestone, autoGrow: this.autoGrow, cam: { ...this.renderer.cam },
      net: this.net.serialize(), city: this.city.serialize(),
    };
  }

  loadData(d) {
    this.setup(d.seed, d.biome, d.diff, d.mapSize || 2400);
    this.time = d.time;
    this.money = d.money;
    this.milestone = 0;   // 依最高人口重新判定（舊存檔的稱號分級不同）
    this.autoGrow = d.autoGrow !== false;
    this.net.load(d.net);
    this.city.load(d.city);
    this.city.recount();
    this.checkMilestone(true);
    for (const s of this.net.segs.values()) if (s.drawLevel === 0) this.terrain.clearTreesAlong(s.pts, halfWidth(s.T) + 3);
    if (d.cam) Object.assign(this.renderer.cam, d.cam);
    this.afterLoad();
  }

  hasSave() { try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; } }
  save(silent = false) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.serialize()));
      if (!silent) this.notify('遊戲已儲存', 'good');
    } catch (e) {
      if (!silent) this.notify('儲存失敗：' + e.message, 'warn');
    }
  }
  loadSaved() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      this.loadData(JSON.parse(raw));
      this.notify('已讀取存檔', 'good');
      return true;
    } catch (e) {
      this.notify('讀取失敗：' + e.message, 'warn');
      return false;
    }
  }
  exportSave() {
    const blob = new Blob([JSON.stringify(this.serialize())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `travelcity-day${Math.floor(this.time / 1440) + 1}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  importSave() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        this.loadData(JSON.parse(await f.text()));
        this.ui.closeModal();
        this.notify('已匯入存檔', 'good');
      } catch (e) { this.notify('匯入失敗：' + e.message, 'warn'); }
    };
    inp.click();
  }

  // ---------- 主迴圈 ----------
  stepSim(dt) {
    this.time += dt * CLOCK;
    this.traffic.step(dt);
    this.city.update(dt * CLOCK);
  }

  // 主迴圈：任何一步出錯都不會讓遊戲停住（下一幀照樣排程），錯誤訊息顯示在畫面上方便回報
  frame(now) {
    requestAnimationFrame(t => this.frame(t));
    try { this.frameBody(now); } catch (e) { this.reportError(e); }
  }
  // 程式錯誤：自動把目前的地圖畫面截圖，連同錯誤訊息、程式位置、版本與遊戲狀態記到錯誤紀錄
  // （存在瀏覽器裡，重新整理後還在），上方出現「⚠ 錯誤」按鈕，可一鍵回報到 GitHub issue（error 標籤）
  reportError(e) {
    console.error(e);
    const msg = (e && e.message) || String(e), stack = ((e && e.stack) || '').split('\n').slice(1, 9).map(s => s.trim().replace(/https?:\/\/[^/]+/, '').replace(/\?v=[^:)]+/, '')).join('\n');
    this._errs = this._errs || new Set();
    if (this._errs.has(msg)) return;
    this._errs.add(msg);
    // 先用目前畫布當截圖；下一幀畫完後再換成完整的畫面（出錯時這一幀可能只畫了一半）
    const shot = this.snapshot();
    this._shotFor = null;
    const c = this.city, t = this.time || 0;
    const rec = {
      at: new Date().toLocaleString('zh-TW'), msg, stack, ver: VERSION, shot,
      state: this.net ? `第 ${Math.floor(t / 1440) + 1} 天 ${String(Math.floor(t % 1440 / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')} · 種子 ${this.seed} · ${this.diffKey} · 人口 ${c.pop} · 建築 ${c.buildings.length} · 路段 ${this.net.segs.size} · 車輛 ${this.traffic.vehicles.length} · 工具 ${this.tools.tool}` : '',
    };
    this.errors.push(rec);
    if (this.errors.length > 10) this.errors.shift();
    this._shotFor = rec;
    this.saveErrors();
    this.ui.onError(rec);
  }
  // 地圖畫面截圖（JPEG）：先鋪上背景色，透明的地方才不會變成黑色
  snapshot() {
    try {
      const src = this.renderer.canvas, cv = document.createElement('canvas');
      cv.width = src.width; cv.height = src.height;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#7fae5c'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(src, 0, 0);
      return cv.toDataURL('image/jpeg', 0.72);
    } catch { return null; }
  }
  // 錯誤紀錄存到 localStorage（空間不夠時只留最近幾筆、拿掉較舊的截圖）
  saveErrors() {
    for (let keep = this.errors.length; keep >= 0; keep--) {
      try { localStorage.setItem(ERR_KEY, JSON.stringify(this.errors.map((r, i) => (i >= this.errors.length - keep ? r : { ...r, shot: null })))); return; } catch { /* 超過容量：少存一張截圖再試 */ }
    }
  }
  clearErrors() { this.errors = []; this._errs = new Set(); try { localStorage.removeItem(ERR_KEY); } catch { /* 忽略 */ } this.ui.onError(null); }
  frameBody(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.net) {
      if (!this.paused && !this.ui.modalOpen) {
        this.simAcc += dt * this.speed;
        let steps = 0;
        const t0 = performance.now();
        while (this.simAcc >= SIM_DT && steps < 80) {
          this.stepSim(SIM_DT);
          this.simAcc -= SIM_DT;
          steps++;
          if (performance.now() - t0 > 28) { this.simAcc = 0; break; }
        }
        this.autosaveT += dt * this.speed;
        if (this.autosaveT > 360) { this.autosaveT = 0; this.save(true); }
      }
      this.tools.update(dt);
      this.renderer.draw();
      // 剛記錄的錯誤：這一幀完整畫好了，換成這張截圖
      if (this._shotFor) { this._shotFor.shot = this.snapshot(); this._shotFor = null; this.saveErrors(); }
      this.ui.update(dt);
    }
  }
}

const game = new Game();
window.travelCity = game;
game.newGame({ seed: Math.floor(Math.random() * 999999), biome: 'temperate', difficulty: 'normal' });
game.ui.showNewGame(true);

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
import { Transit } from './transit.js';

const SAVE_KEY = 'travelcity_save_v1';

class Game {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new Renderer(this, this.canvas);
    this.ui = new UI(this);
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
  reportError(e) {
    console.error(e);
    const msg = (e && e.message) || String(e), where = ((e && e.stack) || '').split('\n')[1] || '';
    this._errs = this._errs || new Set();
    if (this._errs.has(msg)) return;
    this._errs.add(msg);
    this.notify(`⚠ 程式錯誤（遊戲會繼續執行，請截圖回報）：${msg} ${where.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+/, '').slice(0, 120)}`, 'warn');
  }
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
      this.ui.update(dt);
    }
  }
}

const game = new Game();
window.travelCity = game;
game.newGame({ seed: Math.floor(Math.random() * 999999), biome: 'temperate', difficulty: 'normal' });
game.ui.showNewGame(true);

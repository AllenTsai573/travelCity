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

const SAVE_KEY = 'travelcity_save_v1';

class Game {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new Renderer(this, this.canvas);
    this.ui = new UI(this);
    this.tools = new Tools(this, this.canvas);
    this.speed = 1;
    this.paused = false;
    this.heatmap = false;
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

  checkMilestone() {
    for (let i = MILESTONES.length - 1; i > this.milestone; i--) {
      if (this.city.pop >= MILESTONES[i].pop) {
        this.milestone = i;
        this.notify(`🎉 城市成長為「${MILESTONES[i].name}」！`, 'good');
        this.ui.refreshToolbar();
        break;
      }
    }
  }

  setSpeed(s) { this.speed = s; this.paused = false; this.ui.refreshTop(); }
  togglePause() { this.paused = !this.paused; this.ui.refreshTop(); }
  toggleHeatmap() { this.heatmap = !this.heatmap; this.ui.refreshTop(); }

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
    this.simAcc = 0;
  }

  newGame({ seed, biome, difficulty }) {
    this.setup(seed, biome, difficulty);
    generateWorld(this);
    Object.assign(this.renderer.cam, { x: MAP_SIZE / 2, y: MAP_SIZE / 2, z: 1.1 });
    this.afterLoad();
    this.notify(`歡迎來到${this.terrain.biome.name}！把地圖邊緣的外部連線接到市區吧。`, 'good');
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
    this.milestone = d.milestone;
    this.autoGrow = d.autoGrow !== false;
    this.net.load(d.net);
    this.city.load(d.city);
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

  frame(now) {
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
    requestAnimationFrame(t => this.frame(t));
  }
}

const game = new Game();
window.travelCity = game;
game.newGame({ seed: Math.floor(Math.random() * 999999), biome: 'temperate', difficulty: 'normal' });
game.ui.showNewGame(true);

// 玩家工具與輸入處理
import { ROAD_TYPES, ROAD_ORDER, LEVELS, ZONES, ZONE_TYPES, CELL, levelMul } from './config.js';
import { halfWidth } from './network.js';
import { pointAt, closestOnPoly, clamp, fmtMoney, convexOverlap, pointInPoly } from './util.js';
const convexOverlapSafe = (a, b) => { try { return convexOverlap(a, b); } catch { return false; } };
import { TEMPLATES, findCrossing, frameFromCrossing, previewTemplate, placeInterchange } from './interchange.js';


export class Tools {
  constructor(game, canvas) {
    this.g = game;
    this.canvas = canvas;
    this.tool = 'select';
    this.roadType = 'street';
    this.level = 0;
    this.curve = false;
    this.zone = 'R1';   // 分區種類（ZONE_TYPES 的鍵），'X' 為取消分區
    this.rbR = 26;
    this.ixType = 'diamond';
    this.ixAngle = 0;
    this.ix = null;
    this.pts = [];
    this.mouse = { sx: 0, sy: 0, x: 0, y: 0, inside: false, shift: false, alt: false };
    this.snapRes = null;
    this.plan = null;
    this.hover = null;
    this.tip = '';
    this.tipBad = false;
    this.down = null;
    this.ptrs = new Map();
    this.pinch = null;
    this.keys = new Set();
    this.dirty = true;
    this.bind();
  }

  get net() { return this.g.net; }
  get cam() { return this.g.renderer.cam; }

  setTool(t) {
    this.tool = t;
    this.jDrag = null; this.jHover = null;
    this.pts = [];
    this.plan = null;
    this.hover = null;
    this.dirty = true;
    if (t !== 'select' && t !== 'junction') this.g.ui.select(null);
    if (t === 'junction' && this.g.ui.selection?.type !== 'node') this.g.ui.select(null);
    this.g.ui.refreshToolbar();
  }

  cancel() {
    if (this.pts.length) { this.pts = []; this.plan = null; this.dirty = true; return; }
    if (this.g.ui.jSelLane) { this.g.ui.jSelLane = null; return; }
    if (this.g.ui.selection) { this.g.ui.select(null); return; }
    if (this.tool !== 'select') this.setTool('select');
  }

  bind() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      this.ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.cam.z };
        this.down = null;
        return;
      }
      this.updateMouse(e);
      this.down = { btn: e.button, sx: e.offsetX, sy: e.offsetY, cx: this.cam.x, cy: this.cam.y, moved: false, touch: e.pointerType === 'touch' };
      if (e.button === 0 && this.tool === 'zone') this.zoneStart();
      // 路口車道連接：從進入車道（橘點）按住拖曳到離開車道（綠點）
      if (e.button === 0 && this.tool === 'junction') {
        const h = this.jLaneHit();
        if (h && h.kind === 'in') { this.jDrag = { node: h.node, from: h.lane }; this.g.ui.jSelLane = h.lane; }
      }
    });
    cv.addEventListener('pointermove', e => {
      if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.pinch.z * d / this.pinch.d / this.cam.z);
        return;
      }
      this.updateMouse(e);
      const d = this.down;
      if (d && this.jDrag) { if (Math.hypot(e.offsetX - d.sx, e.offsetY - d.sy) > 6) d.moved = true; return; }
      if (d) {
        if (Math.hypot(e.offsetX - d.sx, e.offsetY - d.sy) > 6) d.moved = true;
        if (this.zStroke) { this.zoneMove(); return; }
        if (d.moved) {
          this.cam.x = d.cx - (e.offsetX - d.sx) / this.cam.z;
          this.cam.y = d.cy - (e.offsetY - d.sy) / this.cam.z;
          this.clampCam();
        }
      }
    });
    const up = e => {
      this.ptrs.delete(e.pointerId);
      if (this.ptrs.size < 2) this.pinch = null;
      const d = this.down;
      this.down = null;
      if (this.zStroke) { this.zoneCommit(d && d.moved); return; }
      if (this.jDrag) {
        const jd = this.jDrag;
        this.jDrag = null;
        const h = this.jLaneHit();
        if (h && h.kind === 'out' && h.node === jd.node) { this.toggleConn(jd.node, jd.from, h.lane); this.g.ui.renderPanel(true); }
        else if (d && !d.moved) this.g.ui.renderPanel(true);
        this.dirty = true;
        return;
      }
      if (!d || d.moved) return;
      if (d.btn === 0) this.click();
      else if (d.btn === 2) this.cancel();
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', e => { this.ptrs.delete(e.pointerId); this.down = null; this.pinch = null; });
    cv.addEventListener('pointerleave', () => { this.mouse.inside = false; });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    window.addEventListener('keydown', e => this.onKey(e, true));
    window.addEventListener('keyup', e => { this.keys.delete(e.key.toLowerCase()); this.mouse.shift = e.shiftKey; this.mouse.alt = e.altKey; this.dirty = true; });
  }

  zoomAt(sx, sy, f) {
    const before = this.g.renderer.toWorld(sx, sy);
    this.cam.z = clamp(this.cam.z * f, 0.15, 10);
    const after = this.g.renderer.toWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCam();
    this.dirty = true;
  }
  clampCam() {
    const s = this.g.terrain.size;
    this.cam.x = clamp(this.cam.x, -200, s + 200);
    this.cam.y = clamp(this.cam.y, -200, s + 200);
  }

  updateMouse(e) {
    const m = this.mouse;
    m.sx = e.offsetX; m.sy = e.offsetY; m.inside = true;
    m.shift = e.shiftKey; m.alt = e.altKey;
    const w = this.g.renderer.toWorld(m.sx, m.sy);
    m.x = w.x; m.y = w.y;
    this.dirty = true;
  }

  onKey(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    if (this.g.ui.modalOpen) { if (e.key === 'Escape') this.g.ui.closeModal(); return; }
    const k = e.key.toLowerCase();
    this.keys.add(k);
    this.mouse.shift = e.shiftKey; this.mouse.alt = e.altKey; this.dirty = true;
    const map = { v: 'select', r: 'road', o: 'roundabout', u: 'upgrade', j: 'junction', z: 'zone', b: 'bulldoze', i: 'interchange' };
    if (this.tool === 'interchange' && (k === 'q' || k === 'e')) { this.ixAngle += (k === 'e' ? 1 : -1) * Math.PI / 12; this.dirty = true; return; }
    if (map[k] && !e.ctrlKey && !e.metaKey) { this.setTool(map[k]); return; }
    if (k === 'escape') this.cancel();
    else if (k === ' ') { e.preventDefault(); this.g.togglePause(); }
    else if (k === '1') this.g.setSpeed(1);
    else if (k === '2') this.g.setSpeed(3);
    else if (k === '3') this.g.setSpeed(8);
    else if (k === 'h') this.g.toggleHeatmap();
    else if (k === 'c') { this.curve = !this.curve; this.pts = this.pts.slice(0, 1); this.g.ui.refreshToolbar(); }
    else if (k === 'pageup' || k === ']') { this.changeLevel(1); }
    else if (k === 'pagedown' || k === '[') { this.changeLevel(-1); }
    else if (k === ',' || k === '.') {
      const avail = ROAD_ORDER.filter(t => this.g.unlocked(ROAD_TYPES[t].unlock));
      let i = avail.indexOf(this.roadType);
      i = (i + (k === '.' ? 1 : -1) + avail.length) % avail.length;
      this.roadType = avail[i];
      this.g.ui.refreshToolbar();
    } else if (k === '=' || k === '+') this.zoomAt(this.g.renderer.W / 2, this.g.renderer.H / 2, 1.25);
    else if (k === '-') this.zoomAt(this.g.renderer.W / 2, this.g.renderer.H / 2, 0.8);
  }

  changeLevel(d) {
    const lv = clamp(this.level + d, -2, 3);
    const L = LEVELS.find(l => l.lv === lv);
    if (!this.g.unlocked(L.unlock)) { this.g.notify(`「${L.name}」尚未解鎖`, 'warn'); return; }
    this.level = lv;
    this.g.ui.refreshToolbar();
    this.dirty = true;
  }

  update(dt) {
    const sp = 700 * dt / this.cam.z;
    const k = this.keys;
    let mx = 0, my = 0;
    if (k.has('w') || k.has('arrowup')) my -= 1;
    if (k.has('s') || k.has('arrowdown')) my += 1;
    if (k.has('a') || k.has('arrowleft')) mx -= 1;
    if (k.has('d') || k.has('arrowright')) mx += 1;
    if (mx || my) {
      this.cam.x += mx * sp; this.cam.y += my * sp; this.clampCam();
      const w = this.g.renderer.toWorld(this.mouse.sx, this.mouse.sy);
      this.mouse.x = w.x; this.mouse.y = w.y;
      this.dirty = true;
    }
    if (this.dirty) { this.dirty = false; this.refreshHover(); }
  }

  // ---------- 吸附 ----------
  snap(x, y) {
    const net = this.net, z = this.cam.z;
    if (!this.mouse.alt) {
      const n = net.nodeNear(x, y, Math.max(4, 14 / z));
      if (n) return { x: n.x, y: n.y, node: n.id, level: n.level };
      const s = net.segNear(x, y, Math.max(1.5, 8 / z), 'any');
      if (s && Math.abs(s.h - Math.round(s.h)) < 0.2) return { x: s.x, y: s.y, seg: s.seg.id, u: s.u, level: Math.round(s.h) };
    }
    // 對齊地塊 / 建築的後緣或側邊：道路剛好貼著地塊（中間留 1.5 m 人行道）
    if (!this.mouse.alt && this.tool === 'road') {
      const al = this.lotAlign(x, y);
      if (al) return al;
    }
    if (this.pts.length && !this.mouse.alt) {
      // 角度吸附以起點所在道路為基準：接近平行 / 45° / 垂直時自動對齊；按 Shift 以 15° 為單位
      const a = this.pts[this.pts.length - 1], ref = this.refAngle(this.pts[0]);
      const ang = Math.atan2(y - a.y, x - a.x), d = Math.hypot(x - a.x, y - a.y);
      const rel = ang - ref;
      const st = this.mouse.shift ? Math.PI / 12 : Math.PI / 4, q = Math.round(rel / st) * st;
      if (this.mouse.shift || Math.abs(rel - q) < 3 * Math.PI / 180) return { x: a.x + Math.cos(ref + q) * d, y: a.y + Math.sin(ref + q) * d, level: this.level, snapAng: true };
    }
    return { x, y, level: this.level };
  }
  lotAlign(x, y) {
    const city = this.g.city, z = this.cam.z, tol = Math.max(2.5, 9 / z);
    const off = halfWidth(ROAD_TYPES[this.roadType]) + 1.5;
    let best = null;
    for (const b of [...city.lots, ...city.buildings]) {
      if (Math.abs(b.x - x) > b.rad + 40 || Math.abs(b.y - y) > b.rad + 40) continue;
      const c = b.corners;
      // 後緣（3→2）往外推，左右兩側（0→3、1→2）往外推
      for (const [a, e, nx, ny] of [[c[3], c[2], b.nx, b.ny], [c[0], c[3], -b.tx, -b.ty], [c[1], c[2], b.tx, b.ty]]) {
        const ax = a.x + nx * off, ay = a.y + ny * off, dx = e.x - a.x, dy = e.y - a.y, L = Math.hypot(dx, dy);
        const t = ((x - ax) * dx + (y - ay) * dy) / (L * L);
        if (t < -1.5 || t > 2.5) continue;
        const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(x - px, y - py);
        if (d < tol && (!best || d < best.d)) best = { d, x: px, y: py };
      }
    }
    return best ? { x: best.x, y: best.y, level: this.level, alignLot: true } : null;
  }

  // 起點所在道路的方向（沒有接在道路上時以地圖水平為基準）
  refAngle(p) {
    const net = this.net;
    let s = null, u = 0;
    if (p.node && net.nodes.has(p.node)) {
      const n = net.nodes.get(p.node);
      s = net.segs.get(n.segs[0]);
      if (s) u = s.a === n.id ? 0.5 : s.len - 0.5;
    } else if (p.seg && net.segs.has(p.seg)) { s = net.segs.get(p.seg); u = p.u; }
    if (!s) return 0;
    const q = pointAt(s.pts, s.cum, clamp(u, 0, s.len));
    return Math.atan2(q.dy, q.dx);
  }
  angleText(a, b) {
    const ref = this.refAngle(a), ang = Math.atan2(b.y - a.y, b.x - a.x);
    let deg = Math.abs(((ang - ref) * 180 / Math.PI) % 180);
    if (deg > 180) deg -= 180;
    deg = Math.round(deg > 90 ? 180 - deg : deg);
    return `∠${deg}°${deg === 90 ? '（垂直）' : deg === 0 ? '（平行）' : ''}`;
  }

  setTip(t, bad = false) { this.tip = t; this.tipBad = bad; }

  refreshHover() {
    const g = this.g, m = this.mouse, net = this.net;
    this.setTip('');
    this.hover = null;
    if (!m.inside || !g.net) return;
    switch (this.tool) {
      case 'road': {
        const sn = this.snap(m.x, m.y);
        this.snapRes = sn;
        if (!this.pts.length) { this.plan = null; this.setTip(`點擊設定起點 · ${ROAD_TYPES[this.roadType].name} · ${LEVELS.find(l => l.lv === this.level).name}`); break; }
        if (this.curve && this.pts.length === 1) {
          this.plan = null;
          this.setTip('點擊設定彎道控制點');
          break;
        }
        const a = this.pts[0];
        if (a.node && !net.nodes.has(a.node)) { this.pts = []; break; }
        const plan = net.planRoad(a, sn, this.curve ? this.pts[1] : null, this.roadType, this.level);
        this.plan = plan;
        const extra = plan.demolish && plan.demolish.length ? ` · 拆除 ${plan.demolish.length} 棟` : '';
        const angT = (this.curve ? '' : ` · ${this.angleText(a, sn)}`) + (sn.alignLot ? ' · 對齊地塊邊緣' : '');
        if (plan.ok) this.setTip(`${fmtMoney(plan.cost)} · ${Math.round(plan.len)} m${angT}${plan.crossings.length ? ` · ${plan.crossings.length} 個新路口` : ''}${extra}`);
        else this.setTip(plan.reason + (plan.cost ? ` (${fmtMoney(plan.cost)})` : ''), true);
        break;
      }
      case 'roundabout': {
        const sn = this.snap(m.x, m.y);
        const nodeId = sn.node && net.nodes.get(sn.node).segs.length >= 1 ? sn.node : null;
        this.plan = net.planRoundabout(sn.node ? sn.x : m.x, sn.node ? sn.y : m.y, this.rbR, nodeId);
        if (this.plan.ok) this.setTip(`圓環 半徑 ${this.rbR} m · ${fmtMoney(this.plan.cost)}`);
        else this.setTip(this.plan.reason, true);
        break;
      }
      case 'bulldoze': {
        const b = g.city.buildingAt(m.x, m.y);
        if (b) { this.hover = { type: 'building', obj: b }; this.setTip(`拆除${ZONES[b.zone].name}建築`); break; }
        const l = g.city.lotAt(m.x, m.y);
        if (l) { this.hover = { type: 'building', obj: l }; this.setTip(`取消${ZONE_TYPES[l.zt].name}分區`); break; }
        const s = net.segNear(m.x, m.y, Math.max(1, 4 / this.cam.z), 'any');
        if (s) { this.hover = { type: 'segment', obj: s.seg }; this.setTip(`拆除 ${s.seg.T.name}（${Math.round(s.seg.len)} m）`); }
        break;
      }
      case 'upgrade': {
        const s = net.segNear(m.x, m.y, Math.max(1, 4 / this.cam.z), 'any');
        if (!s) { this.setTip(`點擊道路改為「${ROAD_TYPES[this.roadType].name}」`); break; }
        this.hover = { type: 'segment', obj: s.seg };
        const info = this.upgradeInfo(s.seg);
        this.setTip(info.text, !info.ok);
        break;
      }
      case 'zone': {
        if (this.zStroke) {
          const st = this.zStroke;
          if (st.rect) { this.setTip(`取消分區：${st.rect.cols}×${st.rect.rows} 格`); break; }
          const ok = (st.plan || []).filter(p => p.ok), cols = Math.abs(st.i1 - st.i0) + 1;
          this.setTip(`${cols}×${Math.max(2, st.rows)} 格（${cols * CELL}×${Math.max(2, st.rows) * CELL} m）` + (ok.length > 1 ? ` → ${ok.length} 塊：${ok.map(p => p.cols + '×' + p.rows).join('、')}` : ok.length === 1 && (ok[0].rows !== st.rows) ? ` → 實際 ${ok[0].cols}×${ok[0].rows}` : '') + (!ok.length ? '（無法劃設）' : ''), !ok.length);
          break;
        }
        const a = this.zoneAnchor(m.x, m.y);
        this.hover = a;
        const name = this.zone === 'X' ? '取消分區' : ZONE_TYPES[this.zone].name;
        this.setTip(a ? `按住沿道路拖曳劃設${name}（往外拖可加深；免費）` : `移到道路旁劃設${name}`);
        break;
      }
      case 'junction': {
        const h = this.jLaneHit();
        this.jHover = h;
        if (this.jDrag) {
          if (h && h.kind === 'out') this.setTip(this.hasConn(this.jDrag.node, this.jDrag.from, h.lane) ? '放開：移除這條連接' : '放開：新增這條連接', this.hasConn(this.jDrag.node, this.jDrag.from, h.lane));
          else this.setTip('拖到綠色的離開車道上放開');
          break;
        }
        if (h) { this.hover = null; this.setTip(h.kind === 'in' ? '按住拖曳到綠點：新增連接（已存在則移除）' : '離開車道：從橘點拖到這裡'); break; }
        const n = this.nodeAt(m.x, m.y);
        if (n) { this.hover = { type: 'node', obj: n }; if (g.ui.selection?.obj !== n) this.setTip('點擊編輯路口'); }
        else if (!g.ui.selection) this.setTip('點擊路口以編輯號誌、路權與車道連接');
        break;
      }
      case 'select': {
        const h = this.pick(m.x, m.y);
        this.hover = h;
        break;
      }
      case 'interchange': {
        const t = TEMPLATES[this.ixType];
        const cr = t.freeOnly || t.tee ? null : findCrossing(net, m.x, m.y, 80);
        const fr = cr ? frameFromCrossing(net, cr)
          : { ok: true, x: m.x, y: m.y, ux: Math.cos(this.ixAngle), uy: Math.sin(this.ixAngle), M: t.M, C: t.C, snap: false };
        const pv = fr.ok ? previewTemplate(this.ixType, fr) : null;
        let bad = !fr.ok || (pv && pv.levelError);
        if (pv && !bad) for (const l of pv.lines) for (const p of l.pts) if (!g.terrain.inBounds(p.x, p.y, 2)) { bad = '超出地圖範圍'; break; }
        this.ix = { fr, pv, bad };
        const head = `${t.name}${fr.snap ? '（套用在既有交叉）' : '（自由放置 · Q/E 旋轉）'}`;
        if (bad) this.setTip(`${head}：${fr.ok ? (pv.levelError || bad) : fr.reason}`, true);
        else this.setTip(`${head} · 約 ${fmtMoney(pv.cost)} · 點擊建造`);
        break;
      }
    }
  }

  nodeAt(x, y) {
    let best = null, bd = Infinity;
    for (const n of this.net.nodes.values()) {
      if (n.segs.length < 2) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      const r = Math.max(n.radius + 4, 8 / this.cam.z);
      if (d < r && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  pick(x, y) {
    const g = this.g;
    let bv = null, bd = Math.max(3, 6 / this.cam.z);
    for (const v of g.traffic.vehicles) {
      const p = pointAt(v.track.pts, v.track.cum, v.s - v.len / 2);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; bv = v; }
    }
    if (bv) return { type: 'vehicle', obj: bv };
    const b = g.city.buildingAt(x, y);
    if (b) return { type: 'building', obj: b };
    const n = this.nodeAt(x, y);
    if (n && n.segs.length >= 3) return { type: 'node', obj: n };
    const s = this.net.segNear(x, y, Math.max(1, 4 / this.cam.z), 'any');
    if (s) return { type: 'segment', obj: s.seg };
    return null;
  }

  upgradeInfo(seg) {
    const T = ROAD_TYPES[this.roadType], net = this.net;
    if (seg.type === this.roadType) {
      if (T.bwd === 0) return { ok: true, text: '點擊反轉單行方向', reverse: true, cost: 0 };
      return { ok: false, text: '已是此道路類型' };
    }
    if (seg.ring) return { ok: false, text: '圓環道路無法升級' };
    const A = net.nodes.get(seg.a), B = net.nodes.get(seg.b);
    if ((A.outside && A.segs.length === 1) || (B.outside && B.segs.length === 1)) return { ok: false, text: '外部連線道路無法變更' };
    const cost = Math.max(100, Math.round(seg.len * T.cost * (levelMul(A.level) + levelMul(B.level)) / 2 * 0.8));
    const lost = T.access ? 0 : this.g.city.buildings.filter(b => b.seg === seg.id).length;
    if (!this.g.canAfford(cost)) return { ok: false, text: `資金不足（${fmtMoney(cost)}）` };
    return { ok: true, cost, text: `改為${T.name}：${fmtMoney(cost)}${lost ? ` · 將拆除 ${lost} 棟沿線建築` : ''}` };
  }

  // ---------- 分區（格子） ----------
  // 游標附近可劃設分區的道路，以及沿路的格子編號與離路邊的深度
  zoneAnchor(x, y) {
    const net = this.net, park = this.g.city.parkRoadSet();
    let best = null;
    for (const s of net.segs.values()) {
      if (!s.T.access || s.drawLevel !== 0 || net.nodes.get(s.a).level !== 0 || net.nodes.get(s.b).level !== 0 || park.has(s.id)) continue;
      const b = s.bbox, R = 32 * CELL;
      if (x < b.x0 - R || x > b.x1 + R || y < b.y0 - R || y > b.y1 + R) continue;
      const c = closestOnPoly(s.pts, s.cum, { x, y });
      if (!best || c.d < best.c.d) best = { seg: s, c };
    }
    if (!best || best.c.d > halfWidth(best.seg.T) + 4 * CELL) return null;
    return this.zoneCell(best.seg, x, y);
  }
  zoneCell(s, x, y, side = 0) {
    const c = closestOnPoly(s.pts, s.cum, { x, y });
    const p = pointAt(s.pts, s.cum, c.s);
    const sd = side || (((x - p.x) * -p.dy + (y - p.y) * p.dx) > 0 ? 1 : -1);
    const signed = ((x - p.x) * -p.dy + (y - p.y) * p.dx) * sd;
    const g0 = this.g.city.gridStart(s);
    const nCells = Math.floor((s.len - s.rb - g0) / CELL + 1e-6);
    const i = clamp(Math.floor((c.s - g0) / CELL), 0, Math.max(0, nCells - 1));
    const depth = Math.max(1, Math.ceil((signed - halfWidth(s.T) - 1.5) / CELL));
    return { seg: s, side: sd, i, depth, nCells, g0, geo: this.g.city.lotGeom(s, g0 + (i + 0.5) * CELL, sd, 1, 1) };
  }
  zoneStart() {
    const a = this.zoneAnchor(this.mouse.x, this.mouse.y);
    if (!a || a.nCells < 1) return;
    this.zStroke = { seg: a.seg, side: a.side, i0: a.i, i1: a.i, rows: a.depth, moved: false, g0: a.g0 };
    this.zoneMove();
  }
  zoneMove() {
    const st = this.zStroke, m = this.mouse, city = this.g.city;
    if (!this.net.segs.has(st.seg.id)) { this.zStroke = null; return; }
    const c = this.zoneCell(st.seg, m.x, m.y, st.side);
    if (c.i !== st.i0 || c.depth !== st.rows) st.moved = true;
    st.i1 = c.i; st.rows = c.depth;
    const s = st.seg, a = st.g0 + Math.min(st.i0, st.i1) * CELL, b = st.g0 + (Math.max(st.i0, st.i1) + 1) * CELL;
    if (this.zone === 'X') st.rect = city.lotGeom(s, (a + b) / 2, st.side, Math.round((b - a) / CELL), Math.max(1, st.rows));
    else st.plan = city.planStroke(this.zone, s, st.side, a, b, st.rows);
    this.dirty = true;
  }
  zoneCommit(dragged) {
    const st = this.zStroke, g = this.g, city = g.city;
    this.zStroke = null;
    this.dirty = true;
    if (!st) return;
    // 只點一下：依分區給一塊預設大小的地塊
    if (!st.moved && !dragged && this.zone !== 'X') {
      const Z = ZONE_TYPES[this.zone], cols = Math.min(Z.max, this.zone === 'R1' || this.zone === 'R2' ? 4 : 6);
      const i0 = clamp(st.i0 - Math.floor((cols - 1) / 2), 0, Math.max(0, Math.floor((st.seg.len - st.seg.rb - st.g0) / CELL) - cols));
      st.plan = city.planStroke(this.zone, st.seg, st.side, st.g0 + i0 * CELL, st.g0 + (i0 + cols) * CELL, cols);
    }
    if (this.zone === 'X') {
      const r = st.rect;
      const hit = r ? city.lots.filter(l => Math.hypot(l.x - r.x, l.y - r.y) < l.rad + r.rad && convexOverlapSafe(l.corners, r.corners)) : [];
      for (const l of hit) city.removeLot(l);
      if (hit.length) g.notify(`已取消 ${hit.length} 塊分區`, 'minor');
      return;
    }
    const ok = (st.plan || []).filter(p => p.ok);
    for (const p of ok) city.addLot(p.zt, p.seg, p.u, p.side, p.cols, p.rows);
    if (ok.length) g.notify(`已劃設 ${ok.length} 塊${ZONE_TYPES[this.zone].name}（${ok.map(p => p.cols + '×' + p.rows).join('、')} 格）`, 'minor');
    else if (st.plan && st.plan.length) g.notify(st.plan[0].reason || '無法劃設', 'warn');
  }

  // ---------- 點擊 ----------
  click() {
    const g = this.g, net = this.net, m = this.mouse;
    this.refreshHover();
    switch (this.tool) {
      case 'select': {
        g.ui.select(this.hover);
        break;
      }
      case 'road': {
        const sn = this.snapRes || this.snap(m.x, m.y);
        if (!this.pts.length) {
          if (sn.node === undefined && sn.seg === undefined && this.level === 0 && g.terrain.isWater(sn.x, sn.y)) { g.notify('地面道路無法建在水上', 'warn'); return; }
          this.pts.push(sn);
          break;
        }
        if (this.curve && this.pts.length === 1) { this.pts.push({ x: m.x, y: m.y }); break; }
        const plan = this.plan;
        if (!plan || !plan.ok) { g.notify(plan ? plan.reason : '無法建造', 'warn'); return; }
        const end = net.executeRoad(plan);
        this.pts = [{ x: end.x, y: end.y, node: end.id, level: end.level }];
        this.plan = null;
        break;
      }
      case 'roundabout': {
        const p = this.plan;
        if (!p || !p.ok) { g.notify(p ? p.reason : '無法建造', 'warn'); return; }
        net.executeRoundabout(p);
        break;
      }
      case 'bulldoze': {
        const h = this.hover;
        if (!h) return;
        if (h.type === 'building') { if (h.obj.built === false) g.city.removeLot(h.obj); else g.city.removeBuilding(h.obj, false, true); g.city.recount(); }
        else {
          const err = net.bulldoze(h.obj);
          if (err) g.notify(err, 'warn');
        }
        if (g.ui.selection && g.ui.selection.obj === h.obj) g.ui.select(null);
        break;
      }
      case 'upgrade': {
        const h = this.hover;
        if (!h) return;
        const info = this.upgradeInfo(h.obj);
        if (!info.ok) { g.notify(info.text, 'warn'); return; }
        net.replaceSegment(h.obj, this.roadType, !!info.reverse);
        g.spend(info.cost || 0);
        net.rebuild();
        break;
      }
      case 'zone': break;
      case 'interchange': {
        const ix = this.ix;
        if (!ix || ix.bad) { g.notify(ix ? (ix.fr.ok ? (ix.pv.levelError || ix.bad) : ix.fr.reason) : '無法建造', 'warn'); return; }
        const r = placeInterchange(g, this.ixType, ix.fr);
        if (r.ok) g.notify(`已建造${TEMPLATES[this.ixType].name}交流道（${fmtMoney(r.cost)}）`, 'good');
        else g.notify(`無法建造：${r.reason}`, 'warn');
        break;
      }
      case 'junction': this.junctionClick(); break;
    }
    this.dirty = true;
  }

  // 游標下的車道端點（目前選取的路口）
  jLaneHit() {
    const ui = this.g.ui, net = this.net, m = this.mouse, sel = ui.selection;
    if (!sel || sel.type !== 'node' || !net.nodes.has(sel.obj.id)) return null;
    const node = sel.obj;
    let hit = null, hd = Math.max(1.4, 9 / this.cam.z);
    for (const L of net.inLinks(node)) for (const lane of L.lanes) {
      const p = lane.pts[lane.pts.length - 1], d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < hd) { hd = d; hit = { kind: 'in', lane, node, p }; }
    }
    for (const L of net.outLinks(node)) for (const lane of L.lanes) {
      const p = lane.pts[0], d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < hd) { hd = d; hit = { kind: 'out', lane, node, p }; }
    }
    return hit;
  }
  hasConn(node, from, to) { return node.conns.some(c => c.from === from && c.to === to); }

  junctionClick() {
    const g = this.g, ui = g.ui, net = this.net, m = this.mouse;
    const sel = ui.selection;
    if (sel && sel.type === 'node' && net.nodes.has(sel.obj.id)) {
      const node = sel.obj;
      const hit = this.jLaneHit();
      if (hit) {
        if (hit.kind === 'in') ui.jSelLane = ui.jSelLane === hit.lane ? null : hit.lane;
        else if (ui.jSelLane) this.toggleConn(node, ui.jSelLane, hit.lane);
        else g.notify('請先點選橘色的進入車道', 'minor');
        ui.renderPanel(true);
        return;
      }
    }
    const n = this.nodeAt(m.x, m.y);
    ui.select(n ? { type: 'node', obj: n } : null);
  }

  toggleConn(node, from, to) {
    const net = this.net;
    if (!node.custom) node.custom = node.conns.map(c => [c.from.seg.id, c.from.dir, c.from.idx, c.to.seg.id, c.to.dir, c.to.idx, c.turn]);
    const key = [from.seg.id, from.dir, from.idx, to.seg.id, to.dir, to.idx];
    const i = node.custom.findIndex(c => key.every((v, k) => c[k] === v));
    if (i >= 0) node.custom.splice(i, 1);
    else {
      const a = pointAt(from.pts, from.cum, from.len), b = pointAt(to.pts, to.cum, 0);
      const ang = Math.atan2(a.dx * b.dy - a.dy * b.dx, a.dx * b.dx + a.dy * b.dy);
      const turn = from.seg === to.seg ? 'U' : Math.abs(ang) < 0.55 ? 'S' : ang > 0 ? 'R' : 'L';
      node.custom.push([...key, turn]);
    }
    net.rebuild();
  }

  // ---------- 疊加繪製 ----------
  drawOverlay(ctx, r) {
    const z = this.cam.z, net = this.net, m = this.mouse;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (this.tool === 'road') {
      const T = ROAD_TYPES[this.roadType];
      const sn = this.snapRes;
      if (this.plan) {
        const ok = this.plan.ok;
        ctx.strokeStyle = ok ? 'rgba(90,200,255,0.55)' : 'rgba(255,70,70,0.55)';
        ctx.lineWidth = halfWidth(T) * 2;
        r.strokePoly(this.plan.pts);
        ctx.strokeStyle = ok ? 'rgba(255,255,255,0.8)' : 'rgba(255,200,200,0.8)';
        ctx.lineWidth = 0.4;
        ctx.setLineDash([2, 2]);
        r.strokePoly(this.plan.pts);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffd25e';
        for (const c of this.plan.crossings) { ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(1.5, 4 / z), 0, Math.PI * 2); ctx.fill(); }
        ctx.strokeStyle = '#ff5050';
        ctx.lineWidth = 2 / z;
        for (const b of this.plan.demolish || []) {
          const c = b.corners;
          ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath(); ctx.stroke();
        }
      } else if (this.pts.length && sn) {
        ctx.strokeStyle = 'rgba(90,200,255,0.6)';
        ctx.lineWidth = 1.5 / z;
        ctx.setLineDash([5 / z, 4 / z]);
        ctx.beginPath(); ctx.moveTo(this.pts[0].x, this.pts[0].y);
        if (this.pts[1]) ctx.lineTo(this.pts[1].x, this.pts[1].y);
        ctx.lineTo(sn.x, sn.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const p of this.pts) {
        ctx.fillStyle = '#5ac8ff';
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, 4 / z), 0, Math.PI * 2); ctx.fill();
      }
      if (sn && m.inside) {
        ctx.strokeStyle = sn.node ? '#ffd25e' : sn.seg ? '#7cf29a' : sn.alignLot ? '#ffa94d' : '#ffffff';
        ctx.lineWidth = 2 / z;
        ctx.beginPath(); ctx.arc(sn.x, sn.y, Math.max(2.5, 7 / z), 0, Math.PI * 2); ctx.stroke();
      }
    } else if (this.tool === 'roundabout' && this.plan && m.inside) {
      const p = this.plan;
      ctx.strokeStyle = p.ok ? 'rgba(90,200,255,0.6)' : 'rgba(255,70,70,0.6)';
      ctx.lineWidth = halfWidth(p.ringType || 'oneway2') * 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.R, 0, Math.PI * 2); ctx.stroke();
    } else if ((this.tool === 'bulldoze' || this.tool === 'upgrade' || this.tool === 'select') && this.hover) {
      const h = this.hover;
      const col = this.tool === 'bulldoze' ? 'rgba(255,60,60,0.55)' : 'rgba(90,200,255,0.4)';
      if (h.type === 'segment') {
        ctx.strokeStyle = col;
        ctx.lineWidth = halfWidth(h.obj.T) * 2 + 2;
        r.strokePoly(h.obj.pts);
      } else if (h.type === 'building') {
        const c = h.obj.corners;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath(); ctx.fill();
      } else if (h.type === 'node') {
        ctx.strokeStyle = col; ctx.lineWidth = 2 / z;
        ctx.beginPath(); ctx.arc(h.obj.x, h.obj.y, h.obj.radius + 5, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (this.tool === 'zone') {
      const quad = (c, fill, stroke) => {
        ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath();
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = Math.max(0.4, 2 / z); ctx.stroke(); }
      };
      const st = this.zStroke;
      if (st && st.rect) quad(st.rect.corners, 'rgba(255,70,70,0.35)', '#ff5a5a');
      else if (st && st.plan) {
        const col = ZONES[ZONE_TYPES[this.zone].zone].color[1];
        for (const p of st.plan) {
          quad(p.geo.corners, p.ok ? col + '88' : 'rgba(255,70,70,0.45)', p.ok ? '#fff' : '#ff5a5a');
          if (z > 0.5) this.drawCells(ctx, p.geo, 'rgba(255,255,255,0.5)');
        }
      } else if (this.hover && this.hover.geo) quad(this.hover.geo.corners, 'rgba(255,255,255,0.35)', '#fff');
    } else if (this.tool === 'interchange' && this.ix && this.ix.pv && m.inside) {
      const bad = this.ix.bad;
      for (const l of this.ix.pv.lines) {
        ctx.strokeStyle = bad ? 'rgba(255,70,70,0.35)' : l.role === 'main' || l.role === 'cross' ? 'rgba(255,210,94,0.35)' : 'rgba(90,200,255,0.45)';
        ctx.lineWidth = halfWidth(l.type) * 2;
        r.strokePoly(l.pts);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = Math.max(0.3, 1.2 / z);
      ctx.setLineDash([4 / z, 4 / z]);
      for (const l of this.ix.pv.lines) r.strokePoly(l.pts);
      ctx.setLineDash([]);
      const f = this.ix.fr;
      ctx.fillStyle = f.snap ? '#ffd25e' : '#5ac8ff';
      ctx.beginPath(); ctx.arc(f.x, f.y, Math.max(3, 8 / z), 0, Math.PI * 2); ctx.fill();
    } else if (this.tool === 'junction') {
      ctx.strokeStyle = 'rgba(255,210,94,0.6)';
      ctx.lineWidth = 1.5 / z;
      const v = r.view(20);
      for (const n of net.nodes.values()) {
        if (n.segs.length < 2 || n.x < v.x0 || n.x > v.x1 || n.y < v.y0 || n.y > v.y1) continue;
        if (n.segs.length === 2 && n.radius < 1) continue;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.radius + 3, 0, Math.PI * 2); ctx.stroke();
      }
      if (this.hover) {
        ctx.strokeStyle = '#ffd25e'; ctx.lineWidth = 3 / z;
        ctx.beginPath(); ctx.arc(this.hover.obj.x, this.hover.obj.y, this.hover.obj.radius + 4, 0, Math.PI * 2); ctx.stroke();
      }
      // 拖曳中的連接線
      const h = this.jHover;
      if (h) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(0.3, 2 / z);
        ctx.beginPath(); ctx.arc(h.p.x, h.p.y, Math.max(1.3, 6 / z), 0, Math.PI * 2); ctx.stroke();
      }
      if (this.jDrag) {
        const a = this.jDrag.from.pts[this.jDrag.from.pts.length - 1];
        const tgt = h && h.kind === 'out' ? h.p : m;
        const del = h && h.kind === 'out' && this.hasConn(this.jDrag.node, this.jDrag.from, h.lane);
        ctx.strokeStyle = del ? '#ff5a5a' : '#50dcff';
        ctx.lineWidth = Math.max(0.5, 3 / z);
        ctx.setLineDash(del ? [4 / z, 3 / z] : []);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(tgt.x, tgt.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // 地塊內的格線
  drawCells(ctx, geo, col) {
    const c0 = geo.corners[0], z = this.cam.z;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(0.15, 0.8 / z);
    ctx.beginPath();
    for (let i = 1; i < geo.cols; i++) {
      const x = c0.x + geo.tx * i * CELL, y = c0.y + geo.ty * i * CELL;
      ctx.moveTo(x, y); ctx.lineTo(x + geo.nx * geo.d, y + geo.ny * geo.d);
    }
    for (let j = 1; j < geo.rows; j++) {
      const x = c0.x + geo.nx * j * CELL, y = c0.y + geo.ny * j * CELL;
      ctx.moveTo(x, y); ctx.lineTo(x + geo.tx * geo.w, y + geo.ty * geo.w);
    }
    ctx.stroke();
  }
  // 道路兩側的分區格子（像城市天際線那樣，沿路 6 格深）。不同道路的格子不重疊：
  // 等級高 / 較長的道路先佔格，與其他道路、已有格子、建築或水域重疊的格子就不顯示。結果依路網版本快取
  zoneCells() {
    const net = this.net, city = this.g.city, T = this.g.terrain;
    const key = net.version + ':' + city.buildings.length + ':' + city.lots.length;
    if (this._zc && this._zc.key === key) return this._zc.cells;
    const park = city.parkRoadSet(), D = 6, B = 12;
    const bucket = (m, x, y, v) => { const k = Math.floor(x / B) + ',' + Math.floor(y / B); let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
    const near = (m, x, y, r, f) => {
      for (let i = Math.floor((x - r) / B); i <= Math.floor((x + r) / B); i++) for (let j = Math.floor((y - r) / B); j <= Math.floor((y + r) / B); j++) {
        const a = m.get(i + ',' + j); if (a) for (const v of a) if (f(v)) return true;
      }
      return false;
    };
    // 道路取樣點（所有地面道路）
    const roadPts = new Map();
    for (const s of net.segs.values()) {
      if (s.drawLevel !== 0) continue;
      const hw = halfWidth(s.T);
      for (let t = 0; t <= s.len; t += 3) { const p = pointAt(s.pts, s.cum, t); bucket(roadPts, p.x, p.y, { x: p.x, y: p.y, hw, seg: s.id }); }
    }
    // 建築與地塊
    const blds = new Map();
    for (const b of [...city.buildings, ...city.lots]) {
      const bb = { x0: Math.min(...b.corners.map(p => p.x)), x1: Math.max(...b.corners.map(p => p.x)), y0: Math.min(...b.corners.map(p => p.y)), y1: Math.max(...b.corners.map(p => p.y)) };
      for (let x = Math.floor(bb.x0 / B); x <= Math.floor(bb.x1 / B); x++) for (let y = Math.floor(bb.y0 / B); y <= Math.floor(bb.y1 / B); y++) bucket(blds, x * B + 1, y * B + 1, b);
    }
    const taken = new Map(), cells = [];
    const segs = [...net.segs.values()].filter(s => s.T.access && s.drawLevel === 0 && !park.has(s.id) && net.nodes.get(s.a).level === 0 && net.nodes.get(s.b).level === 0)
      .sort((p, q) => q.T.rank - p.T.rank || q.len - p.len);
    for (const s of segs) {
      const g0 = city.gridStart(s), n = Math.floor((s.len - s.rb - g0) / CELL + 1e-6);
      if (n < 1) continue;
      const off = halfWidth(s.T) + 1.5;
      for (const side of [1, -1]) {
        const at = (i, j) => { const p = pointAt(s.pts, s.cum, g0 + i * CELL); return { x: p.x - p.dy * side * (off + j * CELL), y: p.y + p.dx * side * (off + j * CELL) }; };
        for (let i = 0; i < n; i++) for (let j = 0; j < D; j++) {
          const c = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
          const cx = (c[0].x + c[2].x) / 2, cy = (c[0].y + c[2].y) / 2;
          if (T.isWater(cx, cy)) break;
          if (near(roadPts, cx, cy, 20, v => v.seg !== s.id && Math.hypot(v.x - cx, v.y - cy) < v.hw + 3.2)) break;
          if (near(taken, cx, cy, 6, v => Math.hypot(v.x - cx, v.y - cy) < 5.2)) break;
          if (near(blds, cx, cy, 0, b => pointInPoly({ x: cx, y: cy }, b.corners))) continue;
          bucket(taken, cx, cy, { x: cx, y: cy });
          cells.push(c);
        }
      }
    }
    this._zc = { key, cells };
    return cells;
  }
  drawZoneGrid(ctx, r) {
    const z = this.cam.z;
    if (z < 0.45) return;
    const v = r.view(10);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = Math.max(0.12, 0.7 / z);
    ctx.beginPath();
    for (const c of this.zoneCells()) {
      if (c[0].x < v.x0 || c[0].x > v.x1 || c[0].y < v.y0 || c[0].y > v.y1) continue;
      ctx.moveTo(c[0].x, c[0].y); ctx.lineTo(c[1].x, c[1].y); ctx.lineTo(c[2].x, c[2].y); ctx.lineTo(c[3].x, c[3].y); ctx.closePath();
    }
    ctx.stroke();
  }

  drawScreenOverlay() {
    const tip = document.getElementById('tip');
    if (!tip) return;
    if (this.tip && this.mouse.inside && (!this.down || this.zStroke)) {
      tip.textContent = this.tip;
      tip.className = this.tipBad ? 'bad' : '';
      tip.style.display = 'block';
      tip.style.left = (this.mouse.sx + 16) + 'px';
      tip.style.top = (this.mouse.sy + 18) + 'px';
    } else tip.style.display = 'none';
  }
}

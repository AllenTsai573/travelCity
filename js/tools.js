// 玩家工具與輸入處理
import { ROAD_TYPES, ROAD_ORDER, LEVELS, ZONES, levelMul } from './config.js';
import { halfWidth } from './network.js';
import { pointAt, closestOnPoly, clamp, fmtMoney } from './util.js';
import { TEMPLATES, findCrossing, frameFromCrossing, previewTemplate, placeInterchange } from './interchange.js';

export const ZONE_COST = { R: 300, C: 450, I: 600 };

export class Tools {
  constructor(game, canvas) {
    this.g = game;
    this.canvas = canvas;
    this.tool = 'select';
    this.roadType = 'street';
    this.level = 0;
    this.curve = false;
    this.zone = 'R';
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
    this.lastZone = null;
    this.bind();
  }

  get net() { return this.g.net; }
  get cam() { return this.g.renderer.cam; }

  setTool(t) {
    this.tool = t;
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
      if (e.button === 0 && this.tool === 'zone') { this.lastZone = null; this.zonePaint(true); }
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
      if (d) {
        if (Math.hypot(e.offsetX - d.sx, e.offsetY - d.sy) > 6) d.moved = true;
        if (d.btn === 0 && this.tool === 'zone' && !d.touch) { this.zonePaint(false); return; }
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
    if (this.mouse.shift && this.pts.length) {
      const a = this.pts[this.pts.length - 1];
      const ang = Math.atan2(y - a.y, x - a.x), d = Math.hypot(x - a.x, y - a.y);
      const st = Math.PI / 12, q = Math.round(ang / st) * st;
      return { x: a.x + Math.cos(q) * d, y: a.y + Math.sin(q) * d, level: this.level };
    }
    return { x, y, level: this.level };
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
        if (plan.ok) this.setTip(`${fmtMoney(plan.cost)} · ${Math.round(plan.len)} m${plan.crossings.length ? ` · ${plan.crossings.length} 個新路口` : ''}${extra}`);
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
        const z = this.zoneTarget(m.x, m.y);
        this.hover = z;
        if (!z) { this.setTip(`沿道路點擊或拖曳以劃設${ZONES[this.zone].name}區（${fmtMoney(ZONE_COST[this.zone])}/塊）`); break; }
        if (z.reason) this.setTip(z.reason, true);
        else this.setTip(`${ZONES[this.zone].name}區 ${fmtMoney(ZONE_COST[this.zone])}`);
        break;
      }
      case 'junction': {
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
        const cr = findCrossing(net, m.x, m.y, 80);
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

  zoneTarget(x, y) {
    const net = this.net, city = this.g.city;
    let best = null;
    for (const s of net.segs.values()) {
      const hw = halfWidth(s.T);
      const b = s.bbox;
      if (x < b.x0 - 40 || x > b.x1 + 40 || y < b.y0 - 40 || y > b.y1 + 40) continue;
      const c = closestOnPoly(s.pts, s.cum, { x, y });
      if (c.d > hw + ZONES[this.zone].d + 4) continue;
      if (!best || c.d < best.d) best = { seg: s, u: c.s, d: c.d };
    }
    if (!best) return null;
    const s = best.seg;
    const p = pointAt(s.pts, s.cum, best.u);
    const side = ((x - p.x) * -p.dy + (y - p.y) * p.dx) > 0 ? 1 : -1;
    const Z = ZONES[this.zone];
    const u = clamp(best.u, s.ra + Z.w / 2 + 1, s.len - s.rb - Z.w / 2 - 1);
    let reason = city.canPlace(this.zone, s, u, side);
    if (!reason && !this.g.canAfford(ZONE_COST[this.zone])) reason = '資金不足';
    return { seg: s, u, side, reason, geo: city.lotGeom(this.zone, s, u, side) };
  }

  zonePaint(first) {
    const m = this.mouse;
    const t = this.zoneTarget(m.x, m.y);
    if (!t || t.reason) { if (first && t?.reason) this.g.notify(t.reason, 'warn'); return; }
    if (this.lastZone && Math.hypot(t.geo.x - this.lastZone.x, t.geo.y - this.lastZone.y) < 6) return;
    this.g.city.addBuilding(this.zone, t.seg, t.u, t.side);
    this.g.spend(ZONE_COST[this.zone]);
    this.g.city.recount();
    this.lastZone = { x: t.geo.x, y: t.geo.y };
    this.dirty = true;
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
        if (h.type === 'building') { g.city.removeBuilding(h.obj); g.city.recount(); }
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

  junctionClick() {
    const g = this.g, ui = g.ui, net = this.net, m = this.mouse;
    const sel = ui.selection;
    if (sel && sel.type === 'node' && net.nodes.has(sel.obj.id)) {
      const node = sel.obj;
      const tol = Math.max(1.4, 7 / this.cam.z);
      let hit = null, hd = tol;
      for (const L of net.inLinks(node)) for (const lane of L.lanes) {
        const p = lane.pts[lane.pts.length - 1];
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < hd) { hd = d; hit = { kind: 'in', lane }; }
      }
      for (const L of net.outLinks(node)) for (const lane of L.lanes) {
        const p = lane.pts[0];
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < hd) { hd = d; hit = { kind: 'out', lane }; }
      }
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
        ctx.strokeStyle = sn.node ? '#ffd25e' : sn.seg ? '#7cf29a' : '#ffffff';
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
    } else if (this.tool === 'zone' && this.hover) {
      const h = this.hover, c = h.geo.corners;
      ctx.fillStyle = h.reason ? 'rgba(255,70,70,0.45)' : 'rgba(120,230,140,0.5)';
      ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath(); ctx.fill();
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
    }
  }

  drawScreenOverlay() {
    const tip = document.getElementById('tip');
    if (!tip) return;
    if (this.tip && this.mouse.inside && !this.down) {
      tip.textContent = this.tip;
      tip.className = this.tipBad ? 'bad' : '';
      tip.style.display = 'block';
      tip.style.left = (this.mouse.sx + 16) + 'px';
      tip.style.top = (this.mouse.sy + 18) + 'px';
    } else tip.style.display = 'none';
  }
}

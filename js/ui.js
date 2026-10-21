// 介面：頂部資訊列、工具列、資訊面板、路口編輯器、對話框
import { ROAD_TYPES, ROAD_ORDER, LEVELS, ZONES, ZONE_TYPES, ZONE_ORDER, SHOP_KINDS, INDUSTRY_KINDS, BIOMES, DIFFICULTY, MILESTONES, POLLUTION, zoneMax, zoneNext, zoneColor } from './config.js';
import { fmtMoney, fmtTime, clamp } from './util.js';
import { TEMPLATES, TEMPLATE_ORDER } from './interchange.js';
import { roadThumb, roundaboutThumb, interchangeThumb } from './thumbs.js';

// 道路、圓環、交流道、升級合併成同一個「道路建設」工具，在副工具列切換
const BUILD = [
  { id: 'road', icon: '🛣️', name: '道路', key: 'R' },
  { id: 'roundabout', icon: '⭕', name: '圓環', key: 'O' },
  { id: 'interchange', icon: '🔀', name: '交流道', key: 'I' },
  { id: 'upgrade', icon: '⬆️', name: '升級', key: 'U' },
];
const isBuild = id => BUILD.some(b => b.id === id);
const TOOLS = [
  { id: 'select', icon: '🖱️', name: '選取', key: 'V' },
  { id: 'build', icon: '🛣️', name: '道路建設', key: 'R' },
  { id: 'junction', icon: '🚦', name: '路口', key: 'J' },
  { id: 'zone', icon: '🏘️', name: '分區', key: 'Z' },
  { id: 'bulldoze', icon: '🚧', name: '拆除', key: 'B' },
];
const PURPOSE = { work: '通勤上班', home: '回家', shop: '購物', goods: '貨運（商品）', mat: '貨運（原料）', through: '過境交通', visit: '觀光住宿', return: '回程', bus: '公車' };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = v => Math.round(clamp(v, 0, 1) * 100) + '%';
const bar = (v, good = true) => {
  const p = clamp(v, 0, 1);
  const col = good ? (p > 0.66 ? '#43d17a' : p > 0.33 ? '#ffc93c' : '#e5533d') : (p < 0.33 ? '#43d17a' : p < 0.66 ? '#ffc93c' : '#e5533d');
  return `<span class="bar"><i style="width:${p * 100}%;background:${col}"></i></span>`;
};

export class UI {
  constructor(game) {
    this.g = game;
    this.selection = null;
    this.jSelLane = null;
    this.t = 0;
    this.modalOpen = false;
    this.panel = document.getElementById('panel');
    this.toolbar = document.getElementById('toolbar');
    this.subbar = document.getElementById('subbar');
    this.bindStatic();
  }

  // ---------- 靜態綁定 ----------
  bindStatic() {
    const g = this.g;
    document.getElementById('speedbtns').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const s = Number(b.dataset.speed);
      if (s === 0) g.togglePause(); else g.setSpeed(s);
    });
    document.getElementById('btn-heat').onclick = () => g.toggleHeatmap();
    document.getElementById('btn-zmap').onclick = () => g.toggleZonemap();
    document.getElementById('btn-tilt').onclick = () => g.renderer.toggleTilt();
    document.getElementById('btn-rotl').onclick = () => g.renderer.rotate(-Math.PI / 2);
    document.getElementById('btn-rotr').onclick = () => g.renderer.rotate(Math.PI / 2);
    document.getElementById('btn-grow').onclick = () => { g.autoGrow = !g.autoGrow; this.refreshTop(); };
    document.getElementById('btn-stats').onclick = () => this.showStats();
    document.getElementById('btn-menu').onclick = () => this.showMenu();
    this.toolbar.addEventListener('click', e => {
      const b = e.target.closest('[data-tool]');
      if (b) g.tools.setTool(b.dataset.tool === 'build' ? (isBuild(g.tools.tool) ? g.tools.tool : this.lastBuild || 'road') : b.dataset.tool);
    });
    this.subbar.addEventListener('click', e => {
      const m = e.target.closest('[data-mode]');
      if (m) { g.tools.setTool(m.dataset.mode); return; }
      const b = e.target.closest('[data-sub]');
      if (!b) return;
      const t = g.tools, [k, v] = [b.dataset.sub, b.dataset.v];
      if (k === 'type') {
        if (!g.unlocked(ROAD_TYPES[v].unlock)) { g.notify(`需達到「${MILESTONES[ROAD_TYPES[v].unlock].name}」（人口 ${MILESTONES[ROAD_TYPES[v].unlock].pop}）才能解鎖`, 'warn'); return; }
        t.roadType = v;
      } else if (k === 'level') {
        const L = LEVELS.find(l => l.lv === Number(v));
        if (!g.unlocked(L.unlock)) { g.notify(`需達到「${MILESTONES[L.unlock].name}」才能解鎖${L.name}`, 'warn'); return; }
        t.level = Number(v);
      } else if (k === 'curve') { t.curve = !t.curve; t.pts = t.pts.slice(0, 1); }
      else if (k === 'zone') {
        if (v !== 'X' && !g.city.maxCells(v)) { g.notify(`${ZONE_TYPES[v].name}需要人口達到 ${zoneNext(v, g.city.unlockPop())[0]} 才能解鎖`, 'warn'); return; }
        t.zone = v;
      }
      else if (k === 'rb') t.rbR = Number(v);
      else if (k === 'ix') t.ixType = v;
      else if (k === 'rot') t.ixAngle += Number(v) * Math.PI / 12;
      t.dirty = true;
      this.refreshToolbar();
    });
    this.panel.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (b) this.panelAction(b.dataset.act, b.dataset);
    });
    this.panel.addEventListener('change', e => {
      const el = e.target.closest('[data-chg]');
      if (el) this.panelChange(el.dataset.chg, el);
    });
    document.getElementById('modal').addEventListener('click', e => {
      if (e.target.id === 'modal') this.closeModal();
      const b = e.target.closest('[data-m]');
      if (b) this.modalAction(b.dataset.m, b);
    });
  }

  refreshToolbar() {
    const g = this.g, t = g.tools;
    if (isBuild(t.tool)) this.lastBuild = t.tool;
    const on = x => (x.id === 'build' ? isBuild(t.tool) : t.tool === x.id);
    this.toolbar.innerHTML = TOOLS.map(x => `<button data-tool="${x.id}" class="${on(x) ? 'on' : ''}" title="${x.name}（${x.key}）"><span class="ic">${x.icon}</span><span>${x.name}</span><kbd>${x.key}</kbd></button>`).join('');
    let html = '';
    if (isBuild(t.tool)) html += `<div class="grp modes">` + BUILD.map(b => `<button data-mode="${b.id}" class="${t.tool === b.id ? 'on' : ''}" title="${b.name}（${b.key}）">${b.icon} ${b.name}<kbd>${b.key}</kbd></button>`).join('') + `</div><div class="brk"></div>`;
    if (t.tool === 'road' || t.tool === 'upgrade') {
      html += `<div class="grp types">` + ROAD_ORDER.map(k => {
        const T = ROAD_TYPES[k], locked = !g.unlocked(T.unlock);
        const lanes = T.bwd ? `${T.fwd}+${T.bwd}` : `單向 ${T.fwd}`;
        return `<button data-sub="type" data-v="${k}" class="th ${t.roadType === k ? 'on' : ''} ${locked ? 'locked' : ''}" title="${T.name}｜${T.bwd ? '雙向' : '單向'}｜${T.speed} km/h｜$${T.cost}/m${T.access ? '' : '｜不可沿線建築'}">
          ${roadThumb(k)}<b>${locked ? '🔒' : ''}${T.short}</b><small>${lanes} · ${T.speed}</small></button>`;
      }).join('') + `</div>`;
      if (t.tool === 'road') {
        html += `<div class="grp levels">` + [...LEVELS].reverse().map(L => `<button data-sub="level" data-v="${L.lv}" class="${t.level === L.lv ? 'on' : ''} ${g.unlocked(L.unlock) ? '' : 'locked'}" title="成本 ×${L.mul}">${L.lv > 0 ? '▲' : L.lv < 0 ? '▼' : '■'} ${L.name}</button>`).join('') + `</div>`;
        html += `<div class="grp"><button data-sub="curve" class="${t.curve ? 'on' : ''}" title="C">〰 彎道</button></div>`;
        html += `<div class="hint">左鍵連續鋪路 · 右鍵/Esc 結束 · 接近平行 / 45° / 垂直會自動對齊起點道路 · Shift 每 15° 吸附 · Alt 不吸附 · [ ] 切換高度</div>`;
      } else html += `<div class="hint">點擊道路以變更類型（同類單行道則反轉方向）</div>`;
    } else if (t.tool === 'zone') {
      const zdesc = { R1: '透天、獨棟', R2: 'アパート、低層公寓大樓', R3: '板狀大樓、塔式住宅', C: '15×15 以上可能有大型量販店', I: '園區內有道路，功能隨機', T: '公車總站，路線由系統自動規劃；6×5 格以上有場內車道與較多公車' };
      // 依人口解鎖：未解鎖的顯示需要的人口；已解鎖的顯示目前最大尺寸與下一次放大的人口
      const peak = g.city.unlockPop();
      html += `<div class="grp">` + ZONE_ORDER.map(k => {
        const Z = ZONE_TYPES[k], m = zoneMax(k, peak), nx = zoneNext(k, peak);
        const sub = m ? `最大 ${m}×${m}` + (nx ? `（${nx[0]} 人 → ${nx[1]}×${nx[1]}）` : '') : `🔒 人口 ${nx[0]}`;
        return `<button data-sub="zone" data-v="${k}" class="zone-${Z.zone} ${t.zone === k ? 'on' : ''} ${m ? '' : 'locked'}" title="${Z.name}：${m ? `最大 ${m}×${m} 格（每格 6 m）` : `人口達到 ${nx[0]} 才能解鎖`}${nx && m ? `；人口 ${nx[0]} 時放大到 ${nx[1]}×${nx[1]}` : ''}｜${zdesc[k]}"><b><i class="sw" style="background:${ZONES[Z.zone].color[k === 'R1' ? 0 : k === 'R3' ? 2 : 1]}"></i>${Z.short}</b><small>${sub}</small></button>`;
      }).join('')
        + `<button data-sub="zone" data-v="X" class="${t.zone === 'X' ? 'on' : ''}" title="拖曳範圍內的空分區取消"><b>✕ 取消分區</b><small>僅空地</small></button></div>`;
      html += `<div class="hint">在路旁按住拖曳：沿路拉長、往外拉深（每格 6 m），拖曳中按右鍵或 Esc 取消。一次拖曳的範圍會依最大尺寸切成數塊，有需求時才會蓋起建築。住宅怕高速公路噪音。各分區的最大尺寸隨人口解鎖放大。</div>`;
    } else if (t.tool === 'roundabout') {
      html += `<div class="grp">` + [18, 26, 36].map(r => `<button data-sub="rb" data-v="${r}" class="th ${t.rbR === r ? 'on' : ''}">${roundaboutThumb(r)}<b>半徑 ${r} m</b></button>`).join('') + `</div>`;
      html += `<div class="hint">點擊既有路口將其改建為圓環，或在空地放置圓環。環道車輛擁有路權。</div>`;
    } else if (t.tool === 'interchange') {
      const groups = [...new Set(TEMPLATE_ORDER.map(k => TEMPLATES[k].group))];
      html += groups.map(gr => `<div class="grp ix"><span class="lbl">${gr}</span>` + TEMPLATE_ORDER.filter(k => TEMPLATES[k].group === gr).map(k => `<button data-sub="ix" data-v="${k}" class="th ix ${t.ixType === k ? 'on' : ''}" title="${TEMPLATES[k].desc}">${interchangeThumb(k)}<b>${TEMPLATES[k].name}</b></button>`).join('') + `</div>`).join('');
      html += `<div class="grp"><button data-sub="rot" data-v="-1" title="Q">↺</button><button data-sub="rot" data-v="1" title="E">↻</button></div>`;
      html += `<div class="hint">${TEMPLATES[t.ixType].desc}。移到兩條不同高度道路的交叉處可直接套用；空地上則連主線一起建造。${TEMPLATES[t.ixType].freeOnly || TEMPLATES[t.ixType].tee ? '（此型式只能建在空地）' : ''}</div>`;
    } else if (t.tool === 'junction') {
      html += `<div class="hint">點擊路口：切換紅綠燈 / 全向停車 / 讓路標誌，調整時相，並可逐條編輯車道連接。</div>`;
    } else if (t.tool === 'bulldoze') {
      html += `<div class="hint">點擊道路或建築以拆除。</div>`;
    } else {
      html += `<div class="hint">點擊車輛、建築、路段或路口查看資訊 · 拖曳平移 · 滾輪縮放 · WASD 移動</div>`;
    }
    this.subbar.innerHTML = html;
  }

  // ---------- 頂部 ----------
  refreshTop() {
    const g = this.g, c = g.city, tr = g.traffic, st = c.stats;
    const $ = id => document.getElementById(id);
    $('s-money').textContent = g.diff.unlockAll ? '∞' : fmtMoney(g.money);
    $('s-money').className = g.money < 0 ? 'neg' : '';
    $('s-pop').textContent = c.pop.toLocaleString();
    $('s-jobs').textContent = (c.jobsC + c.jobsI).toLocaleString();
    $('s-veh').textContent = tr.vehicles.length.toLocaleString();
    const sp = tr.metrics.avgSpeedRatio;
    $('s-speed').textContent = Math.round(sp * 100) + '%';
    $('s-speed').className = sp > 0.65 ? 'good' : sp > 0.4 ? 'mid' : 'neg';
    $('s-trips').textContent = st.lastTrips;
    $('s-fails').textContent = st.lastFails;
    $('s-fails').className = st.lastFails > st.lastTrips * 0.1 ? 'neg' : '';
    const net = st.lastIncome - st.lastExpense;
    $('s-net').textContent = (net >= 0 ? '+' : '') + fmtMoney(net);
    $('s-net').className = net >= 0 ? 'good' : 'neg';
    const t = fmtTime(g.time);
    $('s-day').textContent = `第 ${t.day} 天`;
    $('s-time').textContent = t.clock;
    $('s-ms').textContent = MILESTONES[g.milestone].name;
    for (const b of document.querySelectorAll('#speedbtns button')) {
      const s = Number(b.dataset.speed);
      b.classList.toggle('on', s === 0 ? g.paused : !g.paused && g.speed === s);
    }
    $('btn-heat').classList.toggle('on', g.heatmap);
    $('btn-zmap').classList.toggle('on', g.zonemap);
    // 分區圖圖例：各分區的建築數、空地塊數與面積（格）
    $('zonemap').classList.toggle('hidden', !g.zonemap);
    if (g.zonemap) {
      const cnt = {};
      for (const b of c.buildings) { const o = cnt[b.zt] || (cnt[b.zt] = { b: 0, l: 0, a: 0 }); o.b++; o.a += b.cols * b.rows; }
      for (const l of c.lots) { const o = cnt[l.zt] || (cnt[l.zt] = { b: 0, l: 0, a: 0 }); o.l++; o.a += l.cols * l.rows; }
      $('zonemap').innerHTML = '<b>分區圖</b>' + ZONE_ORDER.map(k => { const o = cnt[k] || { b: 0, l: 0, a: 0 }, Z = ZONE_TYPES[k];
        return `<div class="zr"><i class="sw" style="background:${zoneColor(k)}"></i><span>${Z.name}</span><small>${o.b} 棟 · 空地 ${o.l} · ${o.a} 格</small></div>`; }).join('')
        + '<small class="dim">實心：已蓋建築；淡色虛線框：還沒蓋的空地塊</small>';
    }
    $('btn-grow').classList.toggle('on', g.autoGrow);
    // 需求條與資訊面板放在頂部列下方（視窗窄時頂部列會換行變高）
    const tb = $('topbar').getBoundingClientRect().bottom + 8;
    if (window.innerWidth > 760) { $('demand').style.top = tb + 'px'; this.panel.style.top = tb + 'px'; }
    else { $('demand').style.top = ''; this.panel.style.top = ''; }
    for (const z of ['R', 'C', 'I']) {
      const d = c.demand[z];
      const el = $('d-' + z);
      el.style.height = Math.abs(d) * 50 + '%';
      el.style.top = d >= 0 ? (50 - d * 50) + '%' : '50%';
      el.classList.toggle('negd', d < 0);
    }
  }

  update(dt) {
    this.t += dt;
    if (this.t > 0.25) {
      this.t = 0;
      this.refreshTop();
      this.renderPanel(false);
    }
  }

  // ---------- 資訊面板 ----------
  select(sel) {
    this.selection = sel;
    this.jSelLane = null;
    this.renderPanel(true);
  }

  renderPanel(full) {
    const sel = this.selection, p = this.panel, g = this.g;
    if (!sel || (sel.type === 'vehicle' && sel.obj.dead) || (sel.type === 'building' && sel.obj.dead) ||
        (sel.type === 'segment' && !g.net.segs.has(sel.obj.id)) || (sel.type === 'node' && !g.net.nodes.has(sel.obj.id))) {
      if (sel) this.selection = null;
      p.classList.add('hidden');
      return;
    }
    p.classList.remove('hidden');
    const builders = { vehicle: this.vehiclePanel, building: this.buildingPanel, segment: this.segmentPanel, node: this.nodePanel };
    const r = builders[sel.type].call(this, sel.obj);
    if (full || !p.querySelector('#p-dyn')) {
      p.innerHTML = `<button class="close" data-act="close">✕</button>${r.head}<div id="p-dyn">${r.dyn()}</div>${r.foot || ''}`;
    } else {
      p.querySelector('#p-dyn').innerHTML = r.dyn();
    }
  }

  vehiclePanel(v) {
    const g = this.g;
    const name = o => o.outside ? `外部連線：${o.name}` : `${ZONES[o.zone].name}建築 #${o.id}`;
    return {
      head: `<h3>${v.bus ? '🚌 公車' : v.truck ? '🚚 貨車' : '🚗 汽車'} #${v.id}</h3>`,
      dyn: () => v.bus ? (() => { const ln = g.transit.line(v.bus), st = v.busDest && g.transit.stop(v.busDest.stop); return `
        <dl>
          <dt>路線</dt><dd><span style="color:${ln ? ln.color : '#fff'}">■</span> ${ln ? ln.name : '—'}（${ln ? ln.stops.length : 0} 站）</dd>
          <dt>下一站</dt><dd>${st ? '第 ' + (v.stopIdx + 1) + ' 站' : '—'}${v.dwell > 0 ? '（停靠中）' : ''}</dd>
          <dt>乘客</dt><dd>${v.pax.length} 人</dd>
          <dt>車速</dt><dd>${Math.round(v.v * 3.6)} km/h</dd>
        </dl>`; })() : `
        <dl>
          <dt>目的</dt><dd>${PURPOSE[v.trip.kind]}</dd>
          <dt>出發地</dt><dd>${esc(name(v.trip.from))}</dd>
          <dt>目的地</dt><dd>${esc(name(v.trip.to))}</dd>
          <dt>車速</dt><dd>${Math.round(v.v * 3.6)} km/h</dd>
          <dt>行程時間</dt><dd>${Math.round(v.age)} 秒</dd>
          <dt>目前位置</dt><dd>${v.track.kind === 'lane' ? `${v.track.seg.T.name} 第 ${v.track.idx + 1} 車道` : '路口內'}</dd>
          <dt>等待</dt><dd>${v.waitT > 1 ? Math.round(v.waitT) + ' 秒' : '—'}${v.blocked ? '（路口等候）' : ''}</dd>
          <dt>剩餘路段</dt><dd>${Math.max(0, v.route.length - v.ri - 1)}</dd>
        </dl>
        ${v.lost ? '<p class="warn">⚠ 找不到可行路線</p>' : ''}`,
      foot: `<p class="note">藍色線為規劃路線，車輛會依壅塞狀況重新選路。</p>`,
    };
  }

  buildingPanel(b) {
    const g = this.g, Z = ZONES[b.zone], cap = g.city.cap(b);
    return {
      head: `<h3>${b.zone === 'T' ? '🚌' : b.zone === 'R' ? (b.zt === 'R3' ? '🏢' : '🏠') : b.zone === 'C' ? '🏬' : '🏭'} ${b.zone === 'C' ? SHOP_KINDS[b.kind]?.name || '商店' : b.zone === 'I' ? INDUSTRY_KINDS[b.kind]?.name || '工廠' : ZONE_TYPES[b.zt].name} #${b.id}</h3>
        <p class="note">${ZONE_TYPES[b.zt].name} · 地塊 ${b.cols}×${b.rows} 格（${b.cols * 6}×${b.rows * 6} m）</p>`,
      dyn: () => {
        let rows = `<dt>等級</dt><dd>${'★'.repeat(b.level)}${'☆'.repeat(3 - b.level)}${b.abandoned ? '（已廢棄）' : ''}</dd>
          <dt>滿意度</dt><dd>${bar(b.happy)} ${pct(b.happy)}</dd>`;
        if (b.zone === 'T') {
          const tr = g.transit, lines = tr.lines.filter(l => l.depot === b.id), run = g.traffic.vehicles.filter(v => v.bus && lines.some(l => l.id === v.bus));
          const stops = new Set(lines.flatMap(l => l.stops)), waiting = [...stops].reduce((a, id) => a + (tr.stop(id)?.queue.length || 0), 0);
          return `<dl><dt>公車</dt><dd>${run.length} 輛行駛中 / ${g.city.truckSlotsOf(b).length} 個車位</dd>
            <dt>路線</dt><dd>${lines.map(l => `<span style="color:${l.color}">■</span> ${l.name}（${l.stops.length} 站）`).join('<br>') || '—（附近還沒有住宅或工作地點）'}</dd>
            <dt>候車人數</dt><dd>${waiting}</dd><dt>車上乘客</dt><dd>${run.reduce((a, v) => a + v.pax.length, 0)}</dd>
            <dt>累計載客</dt><dd>${tr.stats.riders} 人次（轉乘 ${tr.stats.transfers || 0} 次；無公車可搭改走路 ${tr.stats.walked} 次）</dd></dl>
            <p class="note">路線由系統依附近住宅與工作地點自動規劃（每個遊戲日更新，站牌盡量不動）；每條路線都經過離總站最近的轉乘站，可以換一次車。家裡沒車可開、或選擇搭公車的居民，會走到 450 m 內的站牌搭車。</p>`;
        }
        if (b.zone === 'R') {
          rows += `<dt>居民</dt><dd>${cap}</dd>
            <dt>通勤成功</dt><dd>${bar(b.workOK)} ${pct(b.workOK)}</dd>
            <dt>購物成功</dt><dd>${bar(b.shopOK)} ${pct(b.shopOK)}</dd>
            <dt>通勤時間</dt><dd>${bar(b.timeScore)} ${pct(b.timeScore)}</dd>
            ${POLLUTION ? `<dt>工業污染</dt><dd>${bar(b.pollution, false)} ${pct(b.pollution)}</dd>` : ''}
            <dt>交通噪音</dt><dd>${bar(b.noise, false)} ${pct(b.noise)}</dd>`;
        } else {
          rows += `<dt>工作崗位</dt><dd>${cap}</dd>
            <dt>在場員工</dt><dd>${b.present}</dd>
            <dt>員工充足</dt><dd>${bar(b.workSat)} ${pct(b.workSat)}</dd>`;
          if (b.zone === 'C') rows += `<dt>商品庫存</dt><dd>${b.stock.toFixed(1)}</dd>
            <dt>商品供應</dt><dd>${bar(b.goodsSat)} ${pct(b.goodsSat)}</dd>
            <dt>顧客</dt><dd>${bar(b.custSat)} ${pct(b.custSat)}</dd>`;
          else rows += `<dt>原料庫存</dt><dd>${b.stock.toFixed(1)}</dd>
            <dt>原料供應</dt><dd>${bar(b.matSat)} ${pct(b.matSat)}</dd>`;
        }
        rows += `<dt>待出發車輛</dt><dd>${b.queue.length}</dd>`;
        const tips = [];
        if (b.zone === 'R' && b.workOK < 0.5) tips.push('居民無法順利通勤：檢查工作地點與道路連通');
        if (b.zone === 'R' && b.pollution > 0.4) tips.push('離工業區太近');
        if (b.zone === 'R' && b.timeScore < 0.5) tips.push('通勤時間過長，請改善壅塞');
        if (b.zone !== 'R' && b.workSat < 0.4) tips.push('員工不足：需要更多住宅或外部連線');
        if (b.zone === 'C' && b.goodsSat < 0.5) tips.push('缺少工業區送來的商品');
        if (b.zone === 'I' && b.matSat < 0.5) tips.push('缺少原料：請將工業區連接到外部連線');
        if (b.queue.length > 8) tips.push('車輛無法駛出：門前道路壅塞');
        return `<dl>${rows}</dl>${tips.map(t => `<p class="warn">⚠ ${t}</p>`).join('')}`;
      },
      foot: `<div class="btns"><button data-act="demolish">🚧 拆除</button></div>`,
    };
  }

  segmentPanel(s) {
    const g = this.g, net = g.net;
    const A = net.nodes.get(s.a), B = net.nodes.get(s.b);
    const lvName = lv => LEVELS.find(l => l.lv === lv).name;
    return {
      head: `<h3>🛣️ ${s.T.name}${s.ring ? '（圓環）' : ''}</h3>`,
      dyn: () => {
        const dirs = [1, -1].filter(d => s.links[d].lanes.length).map(d => {
          const L = s.links[d];
          const r = L.count ? L.flow / L.limit : 1;
          return `<dt>${d > 0 ? '順向' : '逆向'}</dt><dd>${L.count} 輛 · ${bar(r)} ${Math.round(L.flow * 3.6)} km/h</dd>`;
        }).join('');
        return `<dl>
          <dt>長度</dt><dd>${Math.round(s.len)} m</dd>
          <dt>車道</dt><dd>${s.T.bwd ? `${s.T.fwd} + ${s.T.bwd}` : `單向 ${s.T.fwd}`}</dd>
          <dt>速限</dt><dd>${s.T.speed} km/h</dd>
          <dt>高度</dt><dd>${A.level === B.level ? lvName(A.level) : `${lvName(A.level)} → ${lvName(B.level)}`}</dd>
          <dt>沿線建築</dt><dd>${s.T.access ? g.city.buildings.filter(b => b.seg === s.id).length + ' 棟' : '不可'}</dd>
          ${dirs}</dl>`;
      },
      foot: `<div class="btns">${s.T.bwd === 0 && !s.ring ? '<button data-act="reverse">⇄ 反轉方向</button>' : ''}<button data-act="bulldoze-seg">🚧 拆除</button></div>`,
    };
  }

  nodePanel(n) {
    const g = this.g, net = g.net;
    const ins = net.inLinks(n);
    let ctl = `<div class="seg3">
      ${[['auto', '自動路權'], ['signal', '紅綠燈'], ['stop', '全向停車']].map(([k, l]) => `<button data-act="ctl" data-v="${k}" class="${n.control === k ? 'on' : ''}" ${k === 'signal' && ins.length < 2 ? 'disabled' : ''}>${l}</button>`).join('')}
    </div>`;
    if (n.control === 'signal' && n.signal) {
      ctl += `<label class="row">時相方案
        <select data-chg="scheme"><option value="each" ${n.sigScheme === 'each' ? 'selected' : ''}>各方向輪流（保護式）</option><option value="pairs" ${n.sigScheme === 'pairs' ? 'selected' : ''}>對向同時通行</option></select></label>
        <label class="row"><input type="checkbox" data-chg="adaptive" ${n.sigAdaptive ? 'checked' : ''}> 感應式號誌（依車流跳過 / 延長）</label>
        <div class="phases">${n.signal.phases.map((ph, i) => `<div class="phase" data-i="${i}">
          <span>時相 ${i + 1}</span><small>${ph.links.map(k => this.approachName(n, k)).join('、')}</small>
          <button data-act="dur" data-i="${i}" data-d="-3">−</button><b>${ph.dur}s</b><button data-act="dur" data-i="${i}" data-d="3">＋</button></div>`).join('')}</div>`;
    } else if (n.control === 'auto') {
      ctl += `<div class="appr"><p class="note">各進入方向的路權（環道與高等級道路預設優先）：</p>` + n.segs.map(sid => {
        const s = net.segs.get(sid);
        if (!s) return '';
        const o = n.yieldOverride[sid] || 'auto';
        return `<label class="row">${esc(s.T.short)} #${sid}<select data-chg="yield" data-seg="${sid}">
          <option value="auto" ${o === 'auto' ? 'selected' : ''}>自動</option><option value="prio" ${o === 'prio' ? 'selected' : ''}>優先道路</option><option value="yield" ${o === 'yield' ? 'selected' : ''}>讓路 ▽</option></select></label>`;
      }).join('') + `</div>`;
    }
    const lanesInfo = `<div class="lanes"><p class="note">車道連接：從橘色點（進入車道）<b>按住拖曳</b>到綠色點（離開車道）即新增連接；對已存在的連接再拖一次就會移除。可藉此設定「只能直行」「只能左轉」等車道。</p>
      ${this.jSelLane ? `<p>已選取：${this.jSelLane.seg.T.short} 第 ${this.jSelLane.idx + 1} 車道</p>` : ''}
      ${n.custom ? '<button data-act="resetconn">↺ 恢復自動車道連接</button>' : ''}</div>`;
    return {
      head: `<h3>🚦 路口 #${n.id}</h3><p class="note">${n.segs.length} 條道路 · ${LEVELS.find(l => l.lv === n.level).name}${n.outside ? ' · 外部連線' : ''}</p>${ctl}${lanesInfo}`,
      dyn: () => {
        let waiting = 0, inside = 0;
        for (const L of ins) for (const lane of L.lanes) for (const v of lane.vehs) if (v.waitT > 1) waiting++;
        for (const c of n.conns) inside += c.vehs.length;
        let s = `<dl><dt>等待車輛</dt><dd>${waiting}</dd><dt>路口內車輛</dt><dd>${inside}</dd><dt>車道連接數</dt><dd>${n.conns.length}</dd>`;
        if (n.control === 'signal' && n.signal) {
          const sig = n.signal;
          s += `<dt>目前時相</dt><dd>${sig.cur + 1}（${{ green: '綠燈', yellow: '黃燈', allred: '全紅' }[sig.state]} ${Math.floor(sig.t)}s）</dd>`;
        }
        return s + '</dl>';
      },
    };
  }

  approachName(n, linkKey) {
    const L = this.g.net.links.get(linkKey);
    if (!L) return '?';
    const dx = n.x - L.lanes[0].pts[0].x, dy = n.y - L.lanes[0].pts[0].y;
    const a = Math.atan2(dy, dx) * 180 / Math.PI;
    const dir = a > -45 && a <= 45 ? '西來' : a > 45 && a <= 135 ? '北來' : a > 135 || a <= -135 ? '東來' : '南來';
    return `${dir}${L.seg.T.short}`;
  }

  panelAction(act, ds) {
    const g = this.g, sel = this.selection, net = g.net;
    if (act === 'close') { this.select(null); return; }
    if (!sel) return;
    const o = sel.obj;
    switch (act) {
      case 'demolish': g.city.removeBuilding(o, false, true); g.city.recount(); this.select(null); break;
      case 'bulldoze-seg': { const e = net.bulldoze(o); if (e) g.notify(e, 'warn'); else this.select(null); break; }
      case 'reverse': { const ns = net.replaceSegment(o, o.type, true); net.rebuild(); this.select({ type: 'segment', obj: ns }); break; }
      case 'ctl':
        if (ds.v === 'signal' && o.control !== 'signal') {
          if (!g.canAfford(500)) { g.notify('資金不足（紅綠燈 $500）', 'warn'); return; }
          g.spend(500);
        }
        o.control = ds.v;
        net.rebuild();
        this.renderPanel(true);
        break;
      case 'dur': {
        const ph = o.signal && o.signal.phases[Number(ds.i)];
        if (!ph) return;
        ph.dur = clamp(ph.dur + Number(ds.d), 6, 90);
        o.sigDur[ds.i] = ph.dur;
        this.renderPanel(true);
        break;
      }
      case 'resetconn': o.custom = null; this.jSelLane = null; net.rebuild(); this.renderPanel(true); break;
    }
  }

  panelChange(k, el) {
    const g = this.g, n = this.selection && this.selection.obj;
    if (!n) return;
    if (k === 'scheme') { n.sigScheme = el.value; n.sigDur = {}; n.signal = null; }
    else if (k === 'adaptive') n.sigAdaptive = el.checked;
    else if (k === 'yield') { if (el.value === 'auto') delete n.yieldOverride[el.dataset.seg]; else n.yieldOverride[el.dataset.seg] = el.value; }
    g.net.rebuild();
    this.renderPanel(true);
  }

  // ---------- 通知 ----------
  toast(msg, kind = 'info') {
    const box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3800);
  }

  // ---------- 對話框 ----------
  openModal(html) {
    document.getElementById('modal-card').innerHTML = html;
    document.getElementById('modal').classList.remove('hidden');
    this.modalOpen = true;
  }
  closeModal() {
    if (!this.g.net) return;
    document.getElementById('modal').classList.add('hidden');
    this.modalOpen = false;
  }

  showNewGame(first = false) {
    const seed = Math.floor(Math.random() * 999999);
    this.openModal(`
      <h2>🚦 TravelCity 交通城市</h2>
      <p class="sub">建造自由角度的道路網，讓每一位駕駛都能順利抵達目的地。</p>
      <h4>生態系</h4>
      <div class="cards" data-group="biome">${Object.entries(BIOMES).map(([k, b], i) => `<label class="cardopt"><input type="radio" name="biome" value="${k}" ${i === 0 ? 'checked' : ''}><span class="sw" style="background:linear-gradient(135deg, ${b.land[0]}, ${b.land[2]} 60%, ${b.waterC[0]})"></span>${b.name}</label>`).join('')}</div>
      <h4>難度</h4>
      <div class="cards">${Object.entries(DIFFICULTY).map(([k, d]) => `<label class="cardopt"><input type="radio" name="diff" value="${k}" ${k === 'normal' ? 'checked' : ''}><b>${d.name}</b><small>${d.unlockAll ? '無限資金、全部解鎖' : fmtMoney(d.money)}</small></label>`).join('')}</div>
      <h4>起始</h4>
      <div class="cards"><label class="cardopt"><input type="radio" name="start" value="town" checked><b>預設小鎮</b><small>道路與分區已規劃，稍後自動發展</small></label><label class="cardopt"><input type="radio" name="start" value="blank"><b>空白地圖</b><small>只有外部連線，自己從零規劃（不自動發展）</small></label></div>
      <h4>地圖種子</h4>
      <div class="row"><input id="ng-seed" type="number" value="${seed}"><button data-m="rand">🎲</button></div>
      <div class="btns end"><button data-m="${first ? 'help' : 'close'}">${first ? '直接遊玩目前地圖' : '取消'}</button>${this.g.hasSave() ? '<button data-m="load">讀取存檔</button>' : ''}<button class="primary" data-m="start">開始建設</button></div>`);
  }

  showMenu() {
    this.openModal(`<h2>選單</h2>
      <div class="menu-list">
        <button data-m="save">💾 儲存遊戲</button>
        <button data-m="load" ${this.g.hasSave() ? '' : 'disabled'}>📂 讀取存檔</button>
        <button data-m="export">⬇ 匯出存檔檔案</button>
        <button data-m="import">⬆ 匯入存檔檔案</button>
        <button data-m="new">🗺️ 新遊戲</button>
        <button data-m="help">❓ 操作說明</button>
      </div>
      <div class="btns end"><button data-m="close">關閉</button></div>`);
  }

  showHelp() {
    this.openModal(`<h2>操作說明</h2>
      <div class="help">
      <p><b>目標</b>：城市會依需求自動成長，居民要上班、購物，工廠要原料、商店要商品，外部連線還有過境車流。打造順暢的路網，讓行程成功、平均車速維持高水準，就能賺取稅收與過路費，城市也會一路從小村莊成長為大都會。所有道路類型與高度一開始就能使用。</p>
      <ul>
        <li><b>道路（R）</b>：無網格自由鋪設，連續點擊即可延伸；開啟「彎道」可用三點畫出曲線。交會處自動產生路口。</li>
        <li><b>高度</b>：用 <kbd>[</kbd> <kbd>]</kbd> 切換隧道 / 地面 / 高架層，不同高度的道路交叉時不會相連，可建造立體交流道。每升降一層需約 45 公尺坡道。</li>
        <li><b>圓環（O）</b>：點擊路口即可改建成圓環。</li>
        <li><b>路口（J）</b>：設定紅綠燈（時相長度、對向同時通行、感應式）、全向停車或讓路標誌，並可逐條編輯車道連接。</li>
        <li><b>升級（U）</b>：直接把既有道路改為其他類型，或反轉單行道方向。</li>
        <li><b>分區（Z）</b>：手動劃設住宅、商業、工業區（也可開啟「自動發展」讓城市自己長）。</li>
        <li><b>熱圖（H）</b>：以顏色顯示各路段壅塞程度。</li>
        <li><b>俯角（T）</b>：在 55° 斜看與正上方俯視之間切換（右上角「視角」按鈕）。</li>
        <li><b>旋轉視角</b>：<kbd>Q</kbd> / <kbd>E</kbd> 或右上角 ⟲ ⟳ 每次轉 90°；按住滑鼠中鍵左右拖曳可自由旋轉（交流道工具中 Q / E 是旋轉交流道）。</li>
        <li>空白鍵暫停，<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 切換速度；滑鼠右鍵或 Esc 取消。</li>
      </ul>
      <p><b>小技巧</b>：高速公路與快速道路沿線不能蓋房子，但適合連接外部連線；匝道路權低於主線，會自動讓路併入。</p>
      </div>
      <div class="btns end"><button data-m="close">了解</button></div>`);
  }

  showStats() {
    const h = this.g.city.history;
    this.openModal(`<h2>城市統計</h2>
      <div class="charts">
        <div><h4>人口</h4><canvas id="ch-pop" width="300" height="90"></canvas></div>
        <div><h4>平均車速（%）</h4><canvas id="ch-speed" width="300" height="90"></canvas></div>
        <div><h4>每小時成功 / 失敗行程</h4><canvas id="ch-trips" width="300" height="90"></canvas></div>
        <div><h4>資金</h4><canvas id="ch-money" width="300" height="90"></canvas></div>
      </div>
      <p class="note">累計成功行程 ${this.g.city.stats.trips.toLocaleString()} · 失敗 ${this.g.city.stats.fails.toLocaleString()} · 過境車流 ${this.g.city.stats.through.toLocaleString()}</p>
      <div class="btns end"><button data-m="close">關閉</button></div>`);
    const draw = (id, series, cols) => {
      const cv = document.getElementById(id), ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      const all = series.flat();
      if (!all.length) { ctx.fillStyle = '#8a94a6'; ctx.font = '12px sans-serif'; ctx.fillText('資料累積中…', 10, 50); return; }
      const mx = Math.max(1, ...all), mn = Math.min(0, ...all);
      series.forEach((s, k) => {
        ctx.strokeStyle = cols[k]; ctx.lineWidth = 2; ctx.beginPath();
        s.forEach((v, i) => {
          const x = s.length > 1 ? i / (s.length - 1) * (cv.width - 4) + 2 : cv.width / 2;
          const y = cv.height - 4 - (v - mn) / (mx - mn || 1) * (cv.height - 12);
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.stroke();
      });
      ctx.fillStyle = '#c9d1dd'; ctx.font = '11px sans-serif';
      ctx.fillText(Math.round(mx).toLocaleString(), 4, 12);
    };
    draw('ch-pop', [h.map(x => x.pop)], ['#5ac8ff']);
    draw('ch-speed', [h.map(x => x.speed * 100)], ['#43d17a']);
    draw('ch-trips', [h.map(x => x.trips), h.map(x => x.fails)], ['#43d17a', '#e5533d']);
    draw('ch-money', [h.map(x => x.money)], ['#ffc93c']);
  }

  modalAction(m, el) {
    const g = this.g;
    switch (m) {
      case 'close': this.closeModal(); break;
      case 'rand': document.getElementById('ng-seed').value = Math.floor(Math.random() * 999999); break;
      case 'start': {
        const biome = document.querySelector('input[name=biome]:checked').value;
        const diff = document.querySelector('input[name=diff]:checked').value;
        const seed = Math.abs(parseInt(document.getElementById('ng-seed').value, 10)) || 1;
        const start = document.querySelector('input[name=start]:checked')?.value || 'town';
        g.newGame({ seed, biome, difficulty: diff, start });
        this.modalOpen = false;
        document.getElementById('modal').classList.add('hidden');
        break;
      }
      case 'new': this.showNewGame(false); break;
      case 'save': g.save(); this.closeModal(); break;
      case 'load': if (g.loadSaved()) { this.modalOpen = false; document.getElementById('modal').classList.add('hidden'); } break;
      case 'help': this.showHelp(); break;
      case 'export': g.exportSave(); break;
      case 'import': g.importSave(); break;
    }
  }
}

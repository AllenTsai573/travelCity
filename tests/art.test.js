// 建築圖形測試：node tests/art.test.js
// 每種分區、大小、等級都至少要有一棟建物（不會出現「有分區卻沒蓋東西」）；樹籬、陽傘等裝飾不算
// 工業區的每個街區都要有東西（建物或貨櫃堆場），不能留下空白鋪面
import { lotArt } from '../js/lotart.js';
import { driveway } from '../js/city.js';

const cases = [['R1', 'R', [null]], ['R2', 'R', [null]], ['R3', 'R', [null]],
  ['C', 'C', ['shops', 'market', 'bigbox', 'mall', 'mallp', 'hotel', 'office', 'gas', 'parking']],
  ['I', 'I', ['factory', 'logistics', 'food', 'chemical', 'tech', 'semi', 'battery']], ['T', 'T', [null]], ['TX', 'T', [null]], ['TS', 'T', [null]], ['RT', 'T', [null]], ['RS', 'T', [null]], ['RC', 'T', [null]]];
const bad = [];
let n = 0;
for (const [zt, zone, kinds] of cases) for (const kind of kinds) for (let cols = 2; cols <= 32; cols += cols < 16 ? 1 : 4) for (let rows = 2; rows <= 32; rows += rows < 16 ? 1 : 4) for (const level of [1, 2, 3]) for (const roads of [null, [1]]) {
  // 只測遊戲實際會出現的組合：有場內道路的只有 driveway() 會開路的地塊
  if (roads && !driveway(zone, kind, { zt, cols, rows, w: cols * 6, d: rows * 6 })) continue;
  n++;
  const a = lotArt({ id: cols * 1000 + rows * 7 + level, cols, rows, zt, zone, kind, level, roads });
  const pads = zone === 'I' ? a.items.filter(it => it.t === 'rect' && it.c === '#a7a191' && !(it.h >= 1)) : [];
  const empty = pads.some(p => !a.items.some(it => it.h >= 1 && !it.car && it.u0 >= p.u0 - 0.1 && it.u1 <= p.u1 + 0.1 && it.v0 >= p.v0 - 0.1 && it.v1 <= p.v1 + 0.1));
  if (empty || !a.items.some(it => it.h >= 1 && !it.car && !it.tree && !it.deco)) bad.push(`${zt}${kind ? ':' + kind : ''} ${cols}×${rows}${roads ? '（有場內道路）' : ''} L${level}`);
}
if (bad.length) { console.error(`FAIL - ${bad.length} 種地塊沒有建物：${bad.slice(0, 10).join('、')}`); process.exit(1); }
console.log(`ok   - ${n} 種地塊組合都有建物`);

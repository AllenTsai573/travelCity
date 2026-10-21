// 建築圖形測試：node tests/art.test.js
// 每種分區、大小、等級都至少要有一棟建物（不會出現「有分區卻沒蓋東西」）
import { lotArt } from '../js/lotart.js';
import { driveway } from '../js/city.js';

const cases = [['R1', 'R', [null]], ['R2', 'R', [null]], ['R3', 'R', [null]],
  ['C', 'C', ['shops', 'market', 'bigbox', 'mall', 'hotel', 'office', 'gas', 'parking']],
  ['I', 'I', ['factory', 'logistics', 'food', 'chemical', 'tech']]];
const bad = [];
let n = 0;
for (const [zt, zone, kinds] of cases) for (const kind of kinds) for (let cols = 2; cols <= 32; cols += cols < 16 ? 1 : 4) for (let rows = 2; rows <= 32; rows += rows < 16 ? 1 : 4) for (const level of [1, 2, 3]) for (const roads of [null, [1]]) {
  // 只測遊戲實際會出現的組合：有場內道路的只有 driveway() 會開路的地塊
  if (roads && !driveway(zone, kind, { zt, cols, rows, w: cols * 6, d: rows * 6 })) continue;
  n++;
  const a = lotArt({ id: cols * 1000 + rows * 7 + level, cols, rows, zt, zone, kind, level, roads });
  if (!a.items.some(it => it.h >= 1 && !it.car && !it.tree)) bad.push(`${zt}${kind ? ':' + kind : ''} ${cols}×${rows}${roads ? '（有場內道路）' : ''} L${level}`);
}
if (bad.length) { console.error(`FAIL - ${bad.length} 種地塊沒有建物：${bad.slice(0, 10).join('、')}`); process.exit(1); }
console.log(`ok   - ${n} 種地塊組合都有建物`);

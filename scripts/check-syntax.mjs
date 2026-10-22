// 語法檢查：js/ 下所有模組（main.js、render.js 等依賴瀏覽器的模組不會被無頭測試載入，語法錯誤要靠這裡抓）
import { readdirSync } from 'fs';
import { execFileSync } from 'child_process';
const dir = new URL('../js/', import.meta.url);
let bad = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', new URL(f, dir).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error(`FAIL - js/${f} 語法錯誤\n${e.stderr}`); }
}
if (bad) process.exit(1);
console.log('ok   - 所有模組語法正確');

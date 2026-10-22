// 更新 index.html 的模組版本（import map）：每次部署前執行 node scripts/bump-version.mjs
// 瀏覽器會快取每個 ES 模組（GitHub Pages 約 10 分鐘），更新後可能新舊檔案混用而出錯；
// import map 把每個 js/*.js 對應到帶版本號的網址，版本一變，所有模組一起重新下載，不會混用
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
const root = new URL('..', import.meta.url);
let ver;
try { ver = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() + '-' + Date.now().toString(36); } catch { ver = Date.now().toString(36); }
const files = readdirSync(new URL('js/', root)).filter(f => f.endsWith('.js')).sort();
const map = { imports: Object.fromEntries(files.map(f => [`./js/${f}`, `./js/${f}?v=${ver}`])) };
const p = new URL('index.html', root);
let html = readFileSync(p, 'utf8');
const block = `<script type="importmap">${JSON.stringify(map)}</script>`;
html = html.includes('<script type="importmap">') ? html.replace(/<script type="importmap">[^<]*<\/script>/, block) : html.replace('<script type="module" src="js/main.js', block + '\n  <script type="module" src="js/main.js');
html = html.replace(/<script type="module" src="js\/main\.js[^"]*"><\/script>/, `<script type="module" src="js/main.js?v=${ver}"></script>`);
html = html.replace(/href="css\/style\.css[^"]*"/, `href="css/style.css?v=${ver}"`);
writeFileSync(p, html);
console.log('版本', ver, '模組', files.length);

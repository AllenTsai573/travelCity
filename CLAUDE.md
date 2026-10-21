# TravelCity 交通城市 — 接手說明（給 Claude）

這份文件讓另一台電腦上的 Claude 能直接接續開發。Claude Code 在這個資料夾開啟時會自動讀取本檔。

- GitHub：https://github.com/AllenTsai573/travelCity （分支 `main`，每次改完都直接 commit + push 到 `main`）
- 線上版（GitHub Pages，push 後約 1 分鐘更新）：https://allentsai573.github.io/travelCity/
- 使用者：以**繁體中文**溝通，回報也用繁體中文。程式碼註解、UI 文字、commit 訊息都用繁體中文。

## 這是什麼

瀏覽器遊戲，靈感來自 *Trafficity* 與 *Highway Co*：無網格自由鋪路＋代理式（agent-based）微觀交通模擬＋簡化城市經濟。純 HTML + JavaScript ES Modules，**沒有任何相依套件、沒有建置步驟**，Canvas 2D 繪圖。

## 執行與測試

```bash
# 本機執行（ES Modules 需要 HTTP）
python3 -m http.server 8765        # 在 travelCity 目錄下執行，打開 http://localhost:8765

# 全部測試（Node 18 以上，無頭執行，不需要瀏覽器）
npm test                            # = art.test.js && sim.test.js && interchange.test.js
node tests/interchange.test.js cloverleaf   # 只測一種交流道模板
```

- `tests/art.test.js`：檢查約 2.5 萬種「分區 × 大小 × 等級 × 有無場內道路」組合都畫得出建物（不會出現空地塊）。
- `tests/sim.test.js`：建立世界、號誌、圓環、升級拆除、高架、存讀檔、分區格子、園區道路、閘門、停車位、20 遊戲小時模擬等。
- `tests/interchange.test.js`：16 種交流道模板逐一建造，讓 12 種行向的車流全部通過，檢查沒有死路迴轉、沒有異常繞路（跑完要幾分鐘，可背景執行）。
- `tests/harness.js`：不依賴 DOM 的遊戲物件 `makeGame(seed, biome, diff, gen = true, size = MAP_SIZE)`、`step(g, n)`、`connectOutside(g)`。

**每次修改後都要跑 `npm test`，全部通過才 commit + push。** 改畫面的東西要在瀏覽器實際看過（使用者常附截圖指出問題）。

### 瀏覽器除錯小技巧

- 瀏覽器會快取 ES Module。改完檔案後在頁面執行：
  `for (const f of ['/js/render.js', ...]) await fetch(f, { cache: 'reload' }); location.reload();`
- 全域物件：`window.travelCity`（Game）。常用：`g.newGame({ seed, biome: 'temperate', difficulty: 'sandbox' })`、`g.ui.closeModal()`、`g.renderer.cam = { x, y, z }`、`g.speed`、`g.paused`、`g.time`（遊戲分鐘）。
- 本機曾用 `tests/_place.js`（放交流道）、`tests/_scene.js`（兩條平行街與各種地塊）當瀏覽器除錯場景，已用 `.git/info/exclude` 排除在版本控制外（不在 repo 裡，需要再自己寫）。

## 程式架構（js/）

| 檔案 | 說明 |
| --- | --- |
| `config.js` | 常數：`MAP_SIZE = 3600`、`CLOCK = 1.5`（每模擬秒 1.5 遊戲分鐘）、`TRIP_SCALE`、14 種 `ROAD_TYPES`（含內部用 `service` 場內道路）、`LEVELS`（-2～3）、`ZONE_TYPES`（R1/R2/R3/C/I，每格 `CELL = 6` m、最大地塊格數、每格容量）、`SHOP_KINDS`、`INDUSTRY_KINDS`、生態系、難度 |
| `util.js` | 亂數、雜訊、折線幾何（`pointAt`、`cutPoly`、`closestOnPoly`、`offsetPoly`、`arcCurve`、`polyIntersections`、`convexOverlap`…）、二元堆積 |
| `terrain.js` | 程序化地形（8 m 格點）、河流、水域、樹；`getCanvas()` 以每像素 2 m 雙線性內插畫地表。3.6 km 地圖保證市中心 700 m 內為陸地（2.4 km 舊存檔維持舊地形） |
| `network.js` | 路網核心：節點、路段（`seg.go` 為分區格線位移，切開 / 反向時沿用）、車道、路口車道連接（`genConnections`、`alignLanes` 處理車道增減）、衝突點、號誌時相、`planRoad` / `executeRoad`、圓環、`splitSegment`、`replaceSegment`、存讀檔 |
| `routing.js` | 以有向路段為節點的 Dijkstra，成本為即時壅塞下的行駛時間。`findRoute(net, starts, dest, allow)`：設有閘門（`seg.gate = 建築 id`）的場內道路只讓 `allow` 名單內（起訖建築）的車通過 |
| `traffic.js` | 車輛代理人：IDM 跟車、MOBIL 式換道、路口通行判斷、重新選路；停車（見下方「停車系統」）；`fx` 為停車 / 出車動畫清單 |
| `city.js` | 地塊與建築、行程產生、滿意度、需求、成長（`developLots`、`autoGrow`）、財務、場內道路（`driveway`、`buildParkRoads`、`connectPark`、閘門）、停車位（`slotsOf`、`slotOcc`、`slotRes`）、存讀檔 |
| `lotart.js` | 地塊上的建築圖形（歐洲風格；純函式 `lotArt(b)` → `{ base, items, slots }`，以地塊區域座標 u/v 產生），city 與 render 都會用；停車位順序（`it.rank`）兩邊一致。rect 的 `roof`（gable / hip / mansard / saw，沒有就是平屋頂）、`ridge`、`wall`、`win`、`shop`、`chimney`、`solar`、`sky` 由 `render.js` 的 `pitchedRoof` / `sawRoof` / `wallWindows` 畫出；`deco`（樹籬、陽傘）不算建物 |
| `render.js` | Canvas 2D：可旋轉視角（`cam.rot`；`worldTf` / `localTf`、`toWorld` / `toScreen` / `screenDelta` 都含旋轉；高度一律用 `lift(p, h)` 沿畫面上方抬高、`depth(p)` 決定前後順序、`so()` 沿畫面方向位移，不要再寫 `p.y - H`）。繪製順序：`drawBuildings(v, 'ground')` 地塊鋪面與停著的車 → 地面 / 地下道路與車 → `drawBuildings(v, 'tall')` 建物立體部分 → 高架道路（道路不會蓋到建物）。建築（斜投影立體：牆面、斜屋頂、陰影從底部投射、樹）、多層道路（路面切成高度段、路肩漸層、標線、路口幾何 `jointGeom`）、車輛（`carBody`）、停車動畫 `drawArrivals`、閘門、號誌、熱圖、路口編輯器 |
| `interchange.js` | 16 種交流道模板（`TEMPLATES`、`TEMPLATE_ORDER`）：以「主線沿 +x、橫交道路沿 y」的區域座標設計（靠右行駛），`Path` 烏龜式路徑、`fitCornerRamp` 自動貼合外側匝道、高度剖面 `prof`；先在複製路網試建再正式建造；整組價格 `interchangePrice()` 介於 $45,000～$60,000 |
| `thumbs.js` | 工具列縮圖 SVG（道路斷面含行車方向、圓環、交流道平面） |
| `tools.js` | 玩家工具與輸入：道路（角度吸附以起點道路為基準、吸附地塊後緣 `lotAlign`）、圓環、交流道、升級、路口（拖曳新增 / 移除車道連接）、分區（沿路拖曳、`zoneCells` 格子、右鍵 / Esc 取消）、拆除 |
| `ui.js` | 頂部資訊列、工具列（道路 / 圓環 / 交流道 / 升級合併為「道路建設」）、副工具列、資訊面板、對話框 |
| `worldgen.js` | 開局：外部連線（地圖邊緣 2 條高速公路＋1 條聯外道路）、棋盤狀小鎮（分街廓鋪設）、接上一條高速公路到小鎮最大連通區、初始分區 |
| `main.js` | 主迴圈（固定 0.1 s 模擬步、最多 80 步 / 幀）、存讀檔（localStorage，存檔記錄 `mapSize`） |

## 重要概念與慣例

- **座標**：世界座標公尺，y 向下。靠右行駛：沿 +x 行駛的車在 +y 側。
- **路段方向**：每條路段有 `links[1]`（a→b）與 `links[-1]`（b→a）；`laneOffset` 正值為行進方向右側。
- **地塊幾何**（`city.lotGeom`）：沿路段 `seg` 在 `u`、`side` 側，寬 `cols` 格、深 `rows` 格。`corners[0]` 臨路左、`[1]` 臨路右、`[2]` 後方右、`[3]` 後方左；`tx,ty` 沿路方向，`nx,ny` 往地塊內。地塊外緣距道路中心線 `halfWidth + 1.5`（1.5 m 人行道）。
- **分區**：每格 6 m；一次拖曳的範圍依該分區最大地塊（低/中密度 12、高密度 24、商業 30、工業 32 格）平均切塊；最小 2×2；劃設免費；空地塊在需求 > 0.05 時才發展。
- **建築種類**：商業依大小隨機（商店街、超市、加油站、停車場、辦公大樓、飯店；15×15 格以上可能是量販店、購物中心）；工業隨機（製造、物流、食品、化工、科技），各有不同工作數、貨運量、污染。
- **場內道路**（`ROAD_TYPES.service`，`internal: true`）：工業園區（≥ 8 格寬）、附停車場的商業、住宅巷道（低密度 ≥ 6×6、中密度 ≥ 6×6、高密度 ≥ 8 格寬 × 7 格深）自動開路；不畫路肩與標線、顏色與停車場相同。**一律 `seg.gate = 建築 id`**（`city.markGate`）：尋路時只有起訖是該建築的車能走，不會被當成迴轉道或捷徑。地塊後方或側邊緊鄰其他道路時打通，對外出入口畫柵欄（`b.gates`）。之後新增的鄰近道路會在下一步（`city.update` 的 `_newRoads`）自動接上。
- **停車系統**：每個車位記錄停著的車顏色（`b.slotOcc[i]`）與預約（`b.slotRes[i]`）。車位接到哪條道路由 `city.slotRoad(b, i)` 決定：建築自己的場內道路＋地塊附近的一般地面道路中，最近、車頭方向對齊、而且直直開過去不穿過建物牆面（`b._slots.walls`）的那條。出發：最多試 4 輛停著的車（`pickParked(b, 4)`），從車位開出到路邊（車輛 `hold` 等動畫結束）；沒有停著的車才從建物入口開出。抵達：出發時預約空車位，目的地是 `traffic.destOf(v)`（= `slotRoad`），到了沿貝茲曲線開進車位；沒有空位就開進建物（淡出）。住宅全部是室外車位；只有辦公大樓 / 飯店有 `indoor` 地下停車場。等待出發的行程上限依建築容量（大飯店可排比較長）。
- **時間**：時鐘 1.5 遊戲分鐘 / 模擬秒（1× 一天約 16 分鐘）；行程產生率乘上 `TRIP_SCALE`，讓路上車量不隨時鐘加快而暴增。
- **自動發展**：每 30 遊戲分鐘一次（交通壅塞 ≥ 0.35 時暫停）；需求依人口 / 工作比例、滿意度、壅塞與行程失敗計算；開啟「自動發展」時，需求 > 0.1 且空地塊 < 3 塊就自動在主路網旁劃設分區。
- **外部連線**：只有接到主路網（`city.liveOutside()`）的才會產生車流；兩成居民到外地上班、大型商場有外地顧客、三成商品外銷；過境車流需要兩條以上接通。

## 使用者的工作方式與偏好

- 會一次列出多個項目（＝開頭的條列），常附截圖。**每一項都要處理並在回覆中逐項回報**（做了什麼、原因、限制）。
- 問「是什麼 / 為什麼」時要說明依據。
- 要求「重新開啟伺服器」時：停止並重新啟動本機 `python3 -m http.server 8765`。
- 喜歡參考真實世界（Wikipedia、空拍、Cities: Skylines 風格）。交流道曾多次依真實設計重畫。
- 重視：銜接處要自然（路口、匝道、標線）、車子不要憑空消失、建築要有立體感但不要「浮起來」、格子要對齊、所有建築至少 2×2。

## 已完成的主要功能（依時間）

1. 微觀交通（IDM、換道、號誌、全向停車、讓路、圓環）、自由鋪路（直線 / 彎道）、6 層高度（-2～3）、14 種道路（含場內道路）
2. 路口與匝道幾何、標線、車道增減（四轉三）、路口車道連接拖曳編輯與地面轉向箭頭
3. 16 種交流道模板：鑽石、Parclo A/B、DDI、SPUI（左轉單一號誌、右轉自由右轉）、苜蓿葉（正圓環道）、苜蓿堆疊、渦輪、二層渦輪、渦輪堆疊、風車、編織、二層 / 三層圓環、喇叭、半定向 T（左右對稱）
4. 分區格子（6 m）、低 / 中 / 高密度住宅、商業與工業種類、建築立體圖形、停車場與停車格、場內道路與閘門
5. 停車系統（車位逐格記錄、停車 / 出車動畫；住宅全室外停車，各類建築都有停車位，車位接車頭前方的道路）
6. 3.6 km 地圖、開局小鎮接上高速公路、時間加快 3 倍、地表高解析度
7. 歐洲風格建築（雙坡 / 四坡 / 折線 / 鋸齒屋頂、窗、店面）、可旋轉視角（Q / E、中鍵拖曳）

## 已知問題 / 可以繼續的方向

- 無號誌的大路口（尤其 5 岔以上）在車流大時可能塞死；可考慮自動建議號誌或改善讓路邏輯。
- 只接一條外部連線時沒有過境車流（設計如此）；若要更多聯外車流可在開局接兩條。
- 工業園區道路之外的「內部道路依周邊道路調整」目前只做後方與兩側打通，沒有更複雜的內部路網重規劃。
- 人行道寬度只有 1.5 m（地塊外緣到路邊），縮小看時不明顯。
- 地圖上的野生樹木（`render.js` 的 `SHOW_WILD_TREES = false`）目前關閉；地塊內的庭院樹有立體畫法。
- 交流道測試是以「死路端點」當起訖點的人工情境，重車流下的 U 字迴轉多半是測試設計造成的。

## Commit 慣例

- 訊息用繁體中文，第一行概述，下方條列細節。
- 結尾加：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（或當下使用的模型）
- push 後可用 `gh api repos/AllenTsai573/travelCity/pages/builds/latest --jq '.status+" "+.commit[0:7]'` 確認 GitHub Pages 已部署到該 commit。

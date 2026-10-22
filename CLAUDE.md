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
npm test                            # = scripts/check-syntax.mjs（所有模組語法）&& art.test.js && sim.test.js && interchange.test.js
node tests/interchange.test.js cloverleaf   # 只測一種交流道模板
```

- `tests/art.test.js`：檢查約 2.5 萬種「分區 × 大小 × 等級 × 有無場內道路」組合都畫得出建物（不會出現空地塊）。
- `tests/sim.test.js`：建立世界、號誌、圓環、升級拆除、高架、存讀檔、分區格子、園區道路、閘門、停車位、20 遊戲小時模擬、公車總站（路線規劃、公車開出並載到乘客）、空白地圖開局等。
- `tests/interchange.test.js`：16 種交流道模板逐一建造，讓 12 種行向的車流全部通過，檢查沒有死路迴轉、沒有異常繞路（跑完要幾分鐘，可背景執行）。
- `tests/overlap.js`：車輛重疊檢查工具（不在 `npm test` 裡）。`node tests/overlap.js 48 [種子]` 模擬 48 遊戲小時，每 0.5 秒把路上、停車 / 出車動畫中、停著的車當矩形兩兩檢查，回報重疊次數（同一對車只算一次）與累計秒數，依情況分類（路上 / 路口 / 停車中 / 出車中 / 停著）。改交通或停車邏輯後可以跑來比較。
- `tests/harness.js`：不依賴 DOM 的遊戲物件 `makeGame(seed, biome, diff, gen = true, size = MAP_SIZE)`、`step(g, n)`、`connectOutside(g)`。

**每次修改後都要跑 `npm test`，全部通過才 commit + push。commit 前執行 `node scripts/bump-version.mjs`**：更新 `index.html` 的 import map（每個 `js/*.js` 對應到帶版本號的網址）與 main.js / style.css 的版本號，瀏覽器才不會新舊模組混用（GitHub Pages 每個檔案快取約 10 分鐘，混用時例如 traffic.js 呼叫舊 transit.js 沒有的函式，主迴圈每幀出錯、看起來像當機）。 改畫面的東西要在瀏覽器實際看過（使用者常附截圖指出問題）。

### 瀏覽器除錯小技巧

- 瀏覽器會快取 ES Module。改完檔案後在頁面執行：
  `for (const f of ['/js/render.js', ...]) await fetch(f, { cache: 'reload' }); location.reload();`
- 全域物件：`window.travelCity`（Game）。常用：`g.newGame({ seed, biome: 'temperate', difficulty: 'sandbox' })`、`g.ui.closeModal()`、`g.renderer.cam = { x, y, z }`、`g.speed`、`g.paused`、`g.time`（遊戲分鐘）。
- 本機曾用 `tests/_place.js`（放交流道）、`tests/_scene.js`（兩條平行街與各種地塊）當瀏覽器除錯場景，已用 `.git/info/exclude` 排除在版本控制外（不在 repo 裡，需要再自己寫）。

## 程式架構（js/）

| 檔案 | 說明 |
| --- | --- |
| `config.js` | 常數：`MAP_SIZE = 3600`、`CLOCK = 4`（每模擬秒 4 遊戲分鐘）、`TRIP_SCALE`、`TRIP_REF`（每遊戲小時行程數相對原始調校的比例，滿意度門檻要乘上它）、14 種 `ROAD_TYPES`（含內部用 `service` 場內道路）、`LEVELS`（-2～3）、`ZONE_TYPES`（R1/R2/R3/C/I，每格 `CELL = 6` m、最大地塊格數、每格容量）、`SHOP_KINDS`、`INDUSTRY_KINDS`、生態系、難度 |
| `util.js` | 亂數、雜訊、折線幾何（`pointAt`、`cutPoly`、`closestOnPoly`、`offsetPoly`、`arcCurve`、`polyIntersections`、`convexOverlap`…）、二元堆積 |
| `terrain.js` | 程序化地形（8 m 格點）、河流、水域、樹；`getCanvas()` 以每像素 2 m 雙線性內插畫地表。3.6 km 地圖保證市中心 700 m 內為陸地（2.4 km 舊存檔維持舊地形）。地形版本 `TERRAIN_VERSION = 2`：低窪處依連通區只留 0～2 個湖（群島的海保留），四成地圖有河且較窄；存檔記錄 `tv`，沒有記錄的舊存檔用第 1 版（道路才不會落在水上） |
| `network.js` | 路網核心：節點、路段（`seg.go` 為分區格線位移，切開 / 反向時沿用）、車道、路口車道連接（`genConnections`、`alignLanes` 處理車道增減）、衝突點、號誌時相、`planRoad` / `executeRoad`、圓環、`splitSegment`、`replaceSegment`、存讀檔 |
| `routing.js` | 以有向路段為節點的 Dijkstra，成本為即時壅塞下的行駛時間。`findRoute(net, starts, dest, allow)`：設有閘門（`seg.gate = 建築 id`）的場內道路只讓 `allow` 名單內（起訖建築）的車通過 |
| `traffic.js` | 車輛代理人：IDM 跟車、MOBIL 式換道（必須換道時請目標車道後車禮讓：`v.yieldTo`）、路口通行判斷（交叉車輛用時間窗 `crossBlocks` / `tReach`）、重新選路；停車（見下方「停車系統」）；`fx` 為停車 / 出車動畫清單 |
| `city.js` | 地塊與建築、行程產生、滿意度、需求、成長（`developLots`、`autoGrow`）、財務、場內道路（`driveway`、`buildParkRoads`、`connectPark`、閘門）、停車位（`slotsOf`、`slotOcc`、`slotRes`）、存讀檔 |
| `lotart.js` | 地塊上的建築圖形（日式風格，車輛仍靠右行駛；純函式 `lotArt(b)` → `{ base, items, slots }`，以地塊區域座標 u/v 產生），city 與 render 都會用；停車位順序（`it.rank`）兩邊一致。rect 的 `roof`（gable / hip / mansard / saw，沒有就是平屋頂）、`ridge`、`wall`、`win`、`shop`、`chimney`、`solar`、`sky`、`balc`（每層陽台 / 外走廊）由 `render.js` 的 `pitchedRoof`（屋簷外伸 0.5 m、坡度較緩）/ `sawRoof` / `wallWindows` 畫出；`{ t: 'sign', vert: true, host }` 為商店街的直立看板（依 host 建物排序前後）；`deco`（樹籬、水泥磚圍牆）不算建物 |
| `render.js` | Canvas 2D：可旋轉視角（`cam.rot`；`worldTf` / `localTf`、`toWorld` / `toScreen` / `screenDelta` 都含旋轉；高度一律用 `lift(p, h)` 沿畫面上方抬高、`depth(p)` 決定前後順序、`so()` 沿畫面方向位移，不要再寫 `p.y - H`）。繪製順序：`drawBuildings(v, 'ground')` 地塊鋪面與停著的車 → 地面 / 地下道路與車 → `drawBuildings(v, 'tall')` 建物立體部分 → 高架道路（道路不會蓋到建物）。建築（斜投影立體：牆面、斜屋頂、陰影從底部投射、樹）、多層道路（路面切成高度段、路肩漸層、標線、路口幾何 `jointGeom`）、車輛（`carBody`）、停車動畫 `drawArrivals`、閘門、號誌、熱圖、路口編輯器 |
| `interchange.js` | 16 種交流道模板（`TEMPLATES`、`TEMPLATE_ORDER`）：以「主線沿 +x、橫交道路沿 y」的區域座標設計（靠右行駛），`Path` 烏龜式路徑、`fitCornerRamp` 自動貼合外側匝道、高度剖面 `prof`；先在複製路網試建再正式建造；整組價格 `interchangePrice()` 介於 $45,000～$60,000 |
| `thumbs.js` | 工具列縮圖 SVG（道路斷面含行車方向、圓環、交流道平面） |
| `tools.js` | 玩家工具與輸入：道路（角度吸附以起點道路為基準、吸附地塊後緣 `lotAlign`）、圓環、交流道、升級、選取工具點路口即為路口編輯（`junctionClick`、`jLaneHit`，拖曳新增 / 移除車道連接；已沒有獨立的路口工具）、分區（沿路拖曳、`zoneChain` 在路口接直行道路可一路拖過去、`zoneCells` 格子、右鍵 / Esc 取消）、拆除 |
| `ui.js` | 頂部資訊列、工具列（道路 / 圓環 / 交流道 / 升級合併為「道路建設」；「大眾運輸」是只顯示 zone 為 `T` 種類的分區工具：`tools.zgroup = 'transit'`、`zoneBy` 記住兩組各自選的種類）、副工具列、資訊面板、對話框 |
| `citygen.js` | 「完整城市路網」開局：東西 / 南北兩條高架（第 1 層）高速公路，交會處渦輪型（放不下改風車型）系統交流道，沿線 SPUI / 分岔鑽石 DDI（放不下 SPUI 改 DDI；不用一般鑽石型），位置在候選範圍內依水域（`wetFoot`、`wetLine`）挑選；林蔭大道十字主軸 `XM` / `YM` 與大道 `XD` / `YD` 接在交流道橫交道路的兩端（`crossEnds`），不疊在橫交道路 / DDI 分岔車道上，外環大道、200 m 街廓（離幹道 < 120 m 的省略、交流道佔地 `foots` 內不鋪）；`line()` 跳過水上的點、`ground()` 中段遇水改高架橋；高速公路兩側 50 m 有側道；街廓超過 300 m（50×50 格）的在中間加街道（以外環為界，碰到匝道、鐵路的不鋪）；鐵路先鋪、全線高架（第 1 層，跨南北向高速公路處第 2 層，`railLine`），客運線 `RY` 東西橫貫（兩端外部鐵路），每個客運車站有主線分出的進站月台軌（`siding`：南側 `SID = 14` m、150 m 長），貨運線 `FY = RY - 32` 從東邊地圖邊緣接到貨運站（分軌、不與客運線相連，另有外部鐵路）；兩側 `RW = 80` m 的站前道路，道路全部從高架下方穿過；`build()` 用 `mixes` 拒絕不同類別（鐵路 / 高速公路與匝道 / 一般道路）在同一高度相交；交流道主線的實際端點用 `axisEnds` 找（比模板 L 短），同一座交流道兩端之間不再重鋪；只劃 RT / RS / RC 車站（產生時 `unlockPop` 暫時不限）；最後拆掉單端的短截道路。鋪路期間 `net.rebuild` 換成只算外框的版本（19 s → 0.6 s），最後才完整重算 |
| `worldgen.js` | 開局：外部連線（地圖邊緣的高速公路，一般 3 條、困難 4 條；沒有一般的聯外道路）、棋盤狀小鎮（分街廓鋪設）、接上一條高速公路到小鎮的大道（優先接大道端點），接上的那條市區道路沿高速公路方向一路改為林蔭大道（`boulevardFrom`，3+3 與高速公路車道數相同）、初始分區 |
| `transit.js` | 大眾運輸：`plan()` 每個遊戲日（或總站 / 車站增減、手動站牌變動時）重新規劃站牌與路線（依建築容量挑站、依方位分組、最近鄰排序後 `bestTour` 以「到站方向」計算的實際行駛時間做 2-opt，`line.legs` 為依序的每段有向路段，`line.path` 為全部路段）、`dispatch()` 依發車間隔派車、`board(trip)` 讓居民到站牌排隊、`exchange(v, stop)` 上下客 |
| `main.js` | 主迴圈（固定 0.1 s 模擬步、最多 80 步 / 幀）、存讀檔（localStorage，存檔記錄 `mapSize`） |

## 重要概念與慣例

- **座標**：世界座標公尺，y 向下。靠右行駛：沿 +x 行駛的車在 +y 側。
- **路段方向**：每條路段有 `links[1]`（a→b）與 `links[-1]`（b→a）；`laneOffset` 正值為行進方向右側。
- **地塊幾何**（`city.lotGeom`）：沿路段 `seg` 在 `u`、`side` 側，寬 `cols` 格、深 `rows` 格。`corners[0]` 臨路左、`[1]` 臨路右、`[2]` 後方右、`[3]` 後方左；`tx,ty` 沿路方向，`nx,ny` 往地塊內。地塊外緣距道路中心線 `halfWidth + 1.5`（1.5 m 人行道）。
- **分區**：每格 6 m；一次拖曳的範圍依該分區最大地塊（低密度 12、中密度 18、高密度 24、商業 30、工業 32 格）平均切塊；最小 2×2；劃設免費；空地塊在需求 > 0.05 時才發展。
- **建築種類**：商業依大小隨機（商店街、超市、加油站、停車場、辦公大樓、飯店；15×15 格以上可能是量販店、購物中心）；工業隨機（製造、物流、食品、化工、科技），各有不同工作數、貨運量、污染。
- **場內道路**（`ROAD_TYPES.service`，`internal: true`）：工業園區（≥ 8 格寬）、附停車場的商業、住宅巷道（低密度 ≥ 6×6、中密度 ≥ 6×6、高密度 ≥ 8 格寬 × 7 格深；盡頭不畫迴車圓）自動開路；不畫路肩與標線、顏色與停車場相同。**一律 `seg.gate = 建築 id`**（`city.markGate`）：尋路時只有起訖是該建築的車能走，不會被當成迴轉道或捷徑。地塊後方或側邊緊鄰其他道路時打通，對外出入口畫柵欄（`b.gates`）。之後新增的鄰近道路會在下一步（`city.update` 的 `_newRoads`）自動接上。
- **停車系統**：每個車位記錄停著的車顏色（`b.slotOcc[i]`）與預約（`b.slotRes[i]`）。車位接到哪條道路由 `city.slotRoad(b, i)` 決定：建築自己的場內道路＋地塊附近的一般地面道路中，最近、車頭方向對齊、而且直直開過去不穿過建物牆面（`b._slots.walls`）的那條。出發：最多試 4 輛停著的車（`pickParked(b, 4)`），從車位開出到路邊（車輛 `hold` 等動畫結束）；沒有停著的車才從建物入口開出。抵達：出發時預約空車位，目的地是 `traffic.destOf(v)`（= `slotRoad`），到了沿貝茲曲線開進車位；沒有空位就開進建物（淡出）。住宅全部是室外車位；只有辦公大樓 / 飯店有 `indoor` 地下停車場。等待出發的行程上限依建築容量（大飯店可排比較長）。
  - **貨車車位（卸貨區）**：`lotArt` 的 `tslots`（`it.trank`），`city.truckSlotsOf(b)`、`b.tOcc` / `b.tRes`；`city.slotSet(b, truck)` 依車種取得清單與陣列，`slotRoad` / `pickParked` / `parkedCount` 都有 `truck` 參數。工業區主幹道兩側是垂直的卸貨位，商業（商店街、量販店、超市、購物中心、辦公大樓、飯店）臨路有一個黃框卸貨區。原料貨車停進工業區卸貨位，送貨出去時從那裡開出；送到商店的貨車卸完貨（15～40 分鐘）開回工廠（行程 `return`）。貨車長 7.5 m。
  - **防止車輛重疊**：抵達後轉進車位時，車子先留在車道上（`v.leaving`，不畫出來）擋住後車，直到沿曲線開離車道；要橫越其他車道（`sideClear`，含後方路口正要開進來的車）、同一處車位有其他車在進出（`slotBusy`）、或前車太近時先停著等（最多 15 秒）。快到路邊車位時有足夠車距就先換到最外側車道。開出時在車位稍前方加入車流。路口分岔時（同一車道分出直行 / 轉彎）前車在 `forkLeader` 裡也算。建築升級後車位依「位置」對應（`slotIndexAt`），不會開到錯的車位。
  - 大型停車場（量販店、超市、購物中心、收費停車場）的每條車道（`lotAisles`，間距 19 m）與底部橫向車道都是真的場內道路（`driveway` 的 `plan.lot`），車位都在車道旁；量販店 / 購物中心 / 超市是單向環狀一進一出（見「單向場內道路」），收費停車場每條平行車道一路接到前面的道路（多個出入口）。場內道路彼此相接的路口用小轉角（`computeRadius`），否則短車道會被路口吃光。從場內道路開出來的車接受較短的車距（3.2 秒，等 15 秒後 1.6 秒）。
  - **大眾運輸**：住家的車都開走了（或去程就沒開車），居民改搭大眾運輸 / 走路（`trySpawn` 回傳 `'transit'`，行程照樣完成、不產生車，回程 `trip.transit` 也不開車），不會從房子憑空開出一輛車。路上的車量因此受各戶車位數限制（低密度住宅每戶 3 個車位）。
  - **迴轉**：死路迴轉在尋路成本加 300 秒，只有沒有別的路線才會用；場內道路不是封閉式道路，路口可以左轉（`genConnections` 的封閉式道路規則排除 `internal`）。
- **視角**：`cam.tilt`（0～1，`T` 鍵 / 「視角」按鈕平滑切換，預設 1）。1 = 55° 斜看（`render.js` 的 `PITCH`）：畫面上下方向壓縮成 sin 55° ≈ 0.82 倍（`TILT_SY`，用在 `worldTf` / `toWorld` / `toScreen` / `screenDelta`），建物高度倍率 `hs = 2 / tan 55° ≈ 1.4`（`TILT_HS`）；0 = 正上方俯視：地面不縮短，建物畫成實際高度的 0.5 倍（約 63.4° 斜投影）。建物的高度常數都以俯視為準（`H = it.h * 0.5`），`lift()` 會乘上 `hs`。高架道路不抬高、只靠陰影表現高度。陰影偏移 `(0.55h, 0.33h)`，太陽約在西北方、仰角約 57°。
- **時間**：參考 Cities: Skylines，時鐘走得比車子快很多（時間膨脹）：`CLOCK = 4` 遊戲分鐘 / 模擬秒，一般速度（1.5 倍模擬速度）一天約 4 分鐘、▶▶ 約 2 分鐘、▶▶▶ 約 45 秒。行程產生率乘上 `TRIP_SCALE`，路上車量不隨時鐘改變；「每小時到了幾個人」的滿意度門檻（`workSat`、`custSat`、`pickJob`）乘上 `TRIP_REF`。購物停留 40～130 分鐘、貨車卸貨 30～60 分鐘。
- **開局**：`generateWorld(g, { empty: true })` 只鋪路與劃分區、不蓋建築，`city.growStart` 之後（開局 6 個遊戲小時）才開始發展；新建築有 1 天緩衝才會被判定衰退。測試用的 `makeGame` 沿用直接蓋好的小鎮。
- **自動發展**：每 30 遊戲分鐘一次（交通壅塞 ≥ 0.35 時暫停）；需求依人口 / 工作比例、滿意度、壅塞與行程失敗計算；開啟「自動發展」時，需求 > 0.1 且空地塊 < 3 塊就自動在主路網旁劃設分區。`city.autoTransit()` 也自動劃大眾運輸（每次最多一塊、`placeTransit` 找離目標最近的道路）：300 人以上的住宅不在公車總站 1.8 km 內 → 公車總站；每 1500 人一座計程車招呼站（沒有涵蓋的商業區附近）；人口 1000 以上、有外部連線 → 跨縣市公車站。
- **大眾運輸**：分區 `T`（公車總站，最大 16×16），`developLots` 不看需求直接蓋；公車停車位用貨車車位（`tslots`、`b.tOcc`）。公車是 `v.bus = 路線 id` 的車輛（長 12 m），`v.busDest` 為下一站，到站停靠（`v.dwell`）後 `traffic.nextBusStop(v)`；路線取消時 `retireBus` 開回總站。居民沒車可開或以 `BUS_SHARE`（city.js）機率選擇公車時呼叫 `transit.board`（直達或在轉乘站 `line.hub` 換一次車，乘客 `p.next`）；站牌編號跨規劃沿用（`transit.nextId`），重新規劃後公車接著開往路線上的站；候車上限以模擬秒計（`MAX_WAIT_S`），因為時間膨脹下公車繞一圈要好幾個遊戲小時。站牌離路口 10～30 m；公車到站前在 `tryLaneChange` 靠最外側車道（`curb`），`transit.needStop` 沒人上下車就不停；每條路線最多 `MAX_BUSES = 8` 台、班距 `HEADWAY = 80` 秒。
- **商業顧客**（`city.hourly`）：`custLevel` 累積來客、每小時乘 0.9；全市來客 `stats.custTot` 依 `cap × SHOP_KINDS.shop` 分份額，達到份額六成即滿意。另有走路顧客（每戶住宅分給 450 m 內商店，不產生車）；加油站看路過車輛（`L.passAcc`，traffic.updateFlow 累積）；辦公大樓只看員工、不收貨。
- **依人口解鎖**（`config.js`）：`MILESTONES`（小村莊 0 / 小鎮 750 / 市鎮 1000 / 城市 2500 / 大城市 3000 / 大都會 5000，`unlock` 為通知文字）、`ZONE_UNLOCK`（各分區 [人口, 最大格數]）、`zoneMax(zt, pop)` / `zoneNext`、`HITECH_POP = 3000`（`INDUSTRY_KINDS` 的 `hitech`：`semi` 半導體、`battery` 電池）。人口以 `city.peakPop`（曾達到的最高人口，存檔）計；`city.maxCells(zt)` 給 `planStroke`、工具列、自動劃設用；解鎖判斷一律用 `city.unlockPop()`（沙盒 `diff.unlockAll` 時為 Infinity，一開始就全部解鎖）。稱號 `g.milestone` 讀檔時依 peakPop 重算。開局小鎮只有 R1 / C / I（≤ 12）。**測試的 `makeGame` 預設 `peakPop = 1e6`（全部解鎖）**，解鎖規則另有測試。
- **臨路道路限制地塊大小**：`ROAD_TYPES.lotMax`（dirt 6、street / oneway1 12、avenue / oneway2 18、boulevard 不限）；`city.maxCells(zt, seg)` = min(依人口上限, 道路上限)，`planStroke`、分區工具提示、`autoLotSize` 都傳路段。
- **擁塞圖**（`g.heatmap`，`H`）：`render.drawHeatmap` 每個行車方向依縮放切成約 12 m 的小段，用段內車子的減速程度與占用率算 0～1，存在 `L.heat` 隨時間平滑；`heatColor` 綠 → 黃 → 橘 → 紅連續漸層，小段之間用 `createLinearGradient` 銜接；圖例 `#heatlegend`。
- **里程碑進度表**：`ui.showMilestones()`（點城市稱號或「里程碑」按鈕），稱號下方 `#s-msbar` 為往下一階段的進度條。
- **工業污染**：`POLLUTION = false`（目前忽略，住宅不扣分、面板不顯示）。
- **分區圖**：`g.zonemap`（`M` 鍵 / 「分區圖」按鈕），`render.drawZoneMap` 塗地塊顏色（`zoneColor(zt)`），開啟時不畫建物立體部分；圖例在 `#zonemap`（ui.refreshTop）。
- **單向場內道路**（`ROAD_TYPES.service1`）：大型停車場（`lotart.oneWayLot`：量販店 / 購物中心 / 超市）與停車樓前的車道（`lotart.garageDrive`：高密度住宅、`mallp` 立體停車場購物中心）。`city.buildParkRoads` 依 `plan.lot.oneway` 依序建造：入口 → 前方分配車道 → 各停車車道 → 後方集散車道 → 出口；入口一律在臨路車道上游端（`-ty·nx + tx·ny > 0` 時在 u 小的那端），`network.genConnections` 讓 service1 與一般道路的左轉進出加上 240 秒的尋路成本（`conn.pen`），平常都右進右出（避免排隊回堵出口造成整個停車場卡死），只有沒有別的路時才左轉（例如停車場在通往地圖邊緣的路上）。室內車位（`indoor`）有 `out`（出口車道位置），`slotRoad(b, i, truck, out)`、`trySpawn` 開出時用 out；`slotBusy` 對室內車位只擋同一條車道。
- **公車停靠區**：站牌在最外側車道停靠的公車 `v.inBay = true`、`v.lat = v.bayLat`（偏到路邊加寬區），`leader` / `leaderOnLaneStart` / `hasSpace` / `neighbors` 都略過停靠區裡的公車（`lastOnLane`），後車直接開過；離開時等後方淨空。`render.drawBays` 畫加寬路面。手動站牌 `city.busStops`（`toggleBusStop`，分區工具 `zone = 'STOP'`），`transit.plan` 以最高權重排進站牌。
- **行程圖 / 路線圖**：`city.flows`（`recordFlow` 在 `onTripEnd` 記錄去程，每小時 ×0.88 衰減），`g.flowmap`（`F`）由 `render.drawFlows` 畫弧線（`FLOW_KINDS` 顏色）；`g.transitmap`（`L`）由 `render.drawTransitMap` 畫所有路線，圖例 `#flowlegend`、`#transitlegend`。
- **主迴圈防當機與錯誤回報**：`main.frame` 先排下一幀再執行 `frameBody`，出錯時 `reportError` 自動把畫布截圖（JPEG）、錯誤訊息、前幾行 stack、版本（`VERSION` = 網址 `?v=`）與遊戲狀態記到 `g.errors`（localStorage `travelcity_errors`，最多 10 筆，空間不夠時拿掉舊截圖），同一訊息只記一次，遊戲繼續；上方出現紅色「⚠ 錯誤 N」按鈕（`ui.showErrors`）：複製截圖到剪貼簿、下載截圖、開啟預先填好的 GitHub issue（標籤 `error`）。`render.draw` 的疊加圖層各自 try/catch。
  - 使用者回報錯誤時先看 `gh issue list --label error`、`gh issue view <編號>`（內容有錯誤訊息、程式位置、版本與遊戲狀態；截圖是 issue 裡的圖片）。
- **地圖線條**：`render.pathLine(keys)` 把有向路段序列沿中間車道與路口連接線（`conn.pts`）接成連續折線，`arrowsAlong` 畫箭頭；行程圖以 `routeFromPoint` 算每組往來的路線（`f.route` 依 `net.version` 快取，每幀最多算 30 條），累加到路段與轉彎上再畫。
- **成長壓力**：`city.js` 的 `GROWTH = { R: 0.25, C: 0.15, I: 0.12 }` 加在需求上（交通差時被 `jam` 抵銷）。大型商業的停車場道路開不出來時改蓋辦公大樓；工業沒有實際園區道路時一律用前院式（`compact`）配置。
- **卡死排除**：`traffic` 的 `GRID_T = 90` 模擬秒，車道最前面（`isHead`）停住超過就 `finish(v, false)`，計數 `traffic.cleared`。
- **服務範圍**：`ZONE_TYPES[zt].range`（公尺，`transit.rangeOf`）：公車總站 / 跨縣市總站的市內路線 1800、招呼站 1800、計程車派遣中心 Infinity（全地圖）；跨縣市公車用 `icbRange`（Infinity）。
- **跨縣市公車**：分區 `IT`（總站，也在 `depots()` 裡、市內路線只用一半停車格）、`IB`（公車站），停車格是 18 m 的連節公車位（lotArt `artic: true`，`ICB_COLOR`）。`transit.icb` 路線 = 每站 × 每個 `liveOutside()`（`icbPlan`，依 key 變動重建、沿用佇列）；`city.spawnFrom` 對往返外地的人（`ICB_KINDS`）以 `ICB_SHARE` 呼叫 `transit.icbBoard`（`trip.icb` 讓回程也搭）：出城的進 `L.q`、進城的進 `L.inQ`。`icbUpdate` 依 `ICB_MIN` / `ICB_MAXHOLD` 發車，`trySpawn({ kind: 'icb', icb: 路線, icbPax })` 產生 `v.icb = { line, pax, inbound }`（`len = ART_LEN`、`cars: 2`，`render.drawTrain` 畫兩節）；`traffic.endTrip` 交給 `transit.icbArrive`：乘客 `onTripEnd`，出城的在 `ICB_AWAY` 分鐘後（`L.away`）從外部連線載著 `inQ` 開回站內車位。
- **場內道路出入口**（`network.junctionInfo` 的 `info.drive`：一組直通的一般道路＋其他都是場內道路）：`rebuild` 用 `trims` 讓主線只截 `場內道路半寬 + 2.5`、場內道路從主線路緣開始；render 不畫斑馬線 / 停止線 / 轉向箭頭，主線標線（`markingsFor` 非邊線、非分隔帶）一路畫過去。`city.endTrim(seg, atB, side)`：另一側沒有場內道路時為 0，`gridStart(seg, side)`、`planStroke`、`canPlaceLot`、`zoneCell`、`zoneCells` 都依側別使用。
- **圓環進場**：`traffic.hasSpace` 進環道時只扣停滯（< 4 m/s）的車，`canEnter` 的臨界間距 3 → 2 秒（等越久越短）；`network.makeConn` 圓環相關連接線用側向加速度 3.2、最低 5 m/s。
- **號誌時相**：`network.ensureSignal`；`sigScheme = 'pairs'`（對向同時通行）時每組對向直行之後加 `only: 'L'` 的左轉專用時相（`traffic.sigState` 只讓左轉 / 迴轉的連接綠燈、`phaseDemand` 只算要左轉的車、`render.drawSignals` 畫綠色左轉箭頭）。
- **開局自動發展**：新遊戲對話框的「自動發展」勾選框（`newGame({ autoGrow })`，沒給時空白地圖關閉、其他開啟）。
- **計程車**：分區 `TX`（計程車派遣中心）、`TS`（招呼站），zone 都是 `T`；車位是小客車車位（`slotOcc` 停著黃色計程車 `TAXI_COLOR`）。`transit.callTaxi(trip)` 從範圍（`rangeOf`）涵蓋接客點、最近有車的站 `trySpawn({ kind: 'taxi', taxi: 乘客行程 }, 接客點)`；車輛 `v.taxi = { pax, stage }`、目的地沿用 `v.busDest`，到點停 3 秒後 `traffic.nextTaxiStage`：stage 0 接客 → stage 1 下客（乘客 `onTripEnd`）→ 改成 `taxiret` 行程開回 `transit.taxiHome` 找到的空車位。叫車時機：`spawnFrom` 中 `TAXI_SHARE`（有車也叫）、以及沒車可開時公車不行才叫車，再不行才走路。
- **鐵路**：`ROAD_TYPES.rail`（`rail: true`、rank 5）。多節車廂的車（`v.cars`：列車、連節公車）每步記錄開過的軌跡 `v.trail`（`traffic.trailPush`），`render.drawTrain` 沿軌跡排車廂；`trainRoute` 折返時車尾變車頭（`trainBody`），列車停在原地換到另一條軌道。只有鐵路相接的節點（道岔、彎道）在 `genConnections` 開頭另外處理：每條軌道接到所有角度平緩（< 70°）的軌道，雙線兩個方向都能進出月台軌，`junctionInfo` 也不把它當匝道。`genConnections` 不在鐵路與道路之間建連接，平面相交的節點就是平交道（衝突點照常計算；`canEnter` 中車輛遇到 14 秒內會到的列車一律等）。外部鐵路在 `city.railOutside`（不在 `city.outside`，不產生汽車車流）。車站分區 `RT`（總站）、`RS`（車站）、`RC`（貨運站），zone 都是 `T`、`ZONE_TYPES.rail`；`city.railNear(geo)` 找地塊後方 / 兩側 30 m 內的鐵軌（地面或高架，高架車站），`planStroke` 沒有就不能劃，`city.platformOf(b)` 是月台（快取）。
  - 客運：`transit.planRail` 每個 RT 一條路線（同一鐵路連通區 `railComp` 的車站，最近鄰排序後來回），站點 id 為 `'r' + 建築 id`，`type: 'rail'`，同時有月台（seg/u，列車用）與站前道路（bseg/bu，公車用，`stopPoint(t, train)`）。列車 `v.train`（沿用 `v.bus` = 路線、`pax`、`exchange`），`traffic.spawnTrain` 從總站月台發車，`trainRoute` 往兩個方向找路，要往回開時換到另一條軌道（在車站折返）。`board()` 對鐵路車站用 `RAIL_WALK = 800`。
  - 公車轉運站：RT 的 `b.busHub`（資訊面板升級，$8,000），lotArt 在前方畫公車停車格（tslots），`transit.depots()` 包含它，公車路線的轉乘站就是車站本身（公車 ↔ 列車轉乘）。
  - 貨運：`transit.sendFreight` 每 `FREIGHT_EVERY` 分鐘對接得到外部鐵路的 RC 派 `traffic.spawnFreight`（`v.freight`），到站停 15 秒：`rc.stock += 40`、外銷 `rc.exports` 計入 `shipped`，再開出地圖。`city.nearCargo` 讓工廠的原料（`mat`）從 RC 出發、外銷商品送到 RC。
  - 列車畫成沿軌道的多節車廂（`render.drawTrain`，含上一段軌道），軌道在路口沿列車的連接線畫枕木與鋼軌。
- **需求門檻**：`DEMAND_BUILD = 0.2`（空地塊發展）、`DEMAND_ZONE = 0.35`（自動劃設分區），需求條上有虛線。`SEP_RI = 250` m：工業與住宅的最小距離（開局與自動劃設都遵守）。
- **開局選項**：`newGame({ start: 'town' | 'city' | 'blank' })`；`blank` 只有外部連線、`autoGrow = false`；`city` 由 `citygen.js` 的 `generateCity` 鋪滿整張地圖（見下方「完整城市路網」）。小鎮為 3 條大道（`worldgen.js` 的 `avX` / `avY`）的大棋盤，街廓夠深可劃 24×24。
- **鋪路吸附**：`tools.js` 的 `snap()` 在接到另一條路時讓接點沿該路滑動成垂直 / 45° / 與起點道路平行；`planRoad` 會修掉超出路口不到 12 m 的多餘路段。只有 3 條以上道路的節點才會被選成「路口」（連續鋪路的轉折點不算）。
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
7. 可旋轉視角（Q / E、中鍵拖曳）；建築原為歐洲風格，之後改為日式（見第 10 項）
8. 公車總站與自動規劃的公車路線、55° 視角、摩天大樓、斑馬線、需求門檻、空白地圖開局、更大的開局小鎮、工業遠離住宅、鋪路垂直吸附
9. 路口交叉車輛的時間窗判斷、換道禮讓、商業顧客依份額計算（含走路顧客）、公車轉乘與站牌固定
10. 日式建築：透天、アパート / 公寓大樓（陽台）、團地與塔式住宅、商店街直立看板、便利商店、櫻花；中密度最大 18×18
11. 依人口解鎖分區與尺寸、城市稱號六級、高科技工廠、分區圖、忽略工業污染、大型停車場單向一進一出、高密度地下 / 立體停車場、立體停車場購物中心
12. 擁塞圖改為綠到紅的連續漸層（沿路分段）、臨路道路限制地塊大小（小路 6 / 市區 12 / 大道 18 / 林蔭不限）、里程碑進度表、沙盒全部解鎖、開局高速公路接林蔭大道
13. 計程車（車行、招呼站）、公車總站劃設提示停車位數、鐵路（軌道、平交道、外部鐵路、總站 / 車站 / 貨運站、客運與貨運列車、總站附設公車轉運站）
14. 公車擋路修正（靠外側車道、沒人上下車不停、站牌離路口 30 m、每線最多 8 台）、公車停靠區、手動公車站牌、行程圖、大眾運輸路線圖、卡死自動排除、鐵路上不能蓋圓環、模組版本號（import map）
15. 行程圖與路線圖沿道路畫成連續的線（箭頭、行程圖細到粗）、公車站序依行駛方向最佳化、SPUI 橫交道路改林蔭大道、需求加成長壓力、主迴圈防當機（錯誤顯示在畫面）、npm test 加語法檢查
16. 錯誤自動截圖與 GitHub 回報；路段銜接處標線（虛線依長度等分、中央分隔帶方頭）、辦公大樓尺寸上限與分層、換車道改為 S 形平順橫移（`v.lat0` / `v.lcP` / `v.latSlope`）、窄公車總站（7 格寬起）也有公車位、站牌少時也開路線（轉乘站＋1 站）、站牌可設在較短的路段（離路口 10～30 m，太短改用 120 m 內的道路）、分區拖曳跨過路口、路口工具併入選取工具
17. 大眾運輸獨立工具列（P）、計程車派遣中心（全市）與招呼站 1.8 km、公車總站 1.8 km、跨縣市公車站 / 總站（連節公車往返外部連線）、場內道路出入口不算十字路口（對面分區連續）、圓環進場不再過度等待
18. 「完整城市路網」開局（`citygen.js`）、鐵路高架橋的標線、地形第 2 版（湖泊 0～2 個、河流不一定有）、高速公路與交流道銜接修正、鐵路全線高架、車站進站月台軌、貨運與客運分軌、鐵路道岔、車站貼著月台軌、列車沿軌跡排車廂與原地折返、自動發展劃大眾運輸、完整城市路網格線鋪滿外環內

## 已知問題 / 可以繼續的方向

- 無號誌的大路口（尤其 5 岔以上）在車流大時可能塞死；可考慮自動建議號誌或改善讓路邏輯。高密度住宅附近塞車主要是無號誌路口容量不足；改用時間窗判斷交叉車輛、換道禮讓後，壓力測試城市（市中心 17 棟高密度住宅）的慢速時間從 8.7% 降到約 5%。在大道路口自動設號誌（各方向輪流或對向同時通行都試過）都更慢，沒有採用。
- 公車載客量還不高：只有沒車可開或少數（`BUS_SHARE`）居民會搭，而且起訖兩端都要在站牌 350 m 內。
- 只接一條外部連線時沒有過境車流（設計如此）；若要更多聯外車流可在開局接兩條。
- 工業園區道路之外的「內部道路依周邊道路調整」目前只做後方與兩側打通，沒有更複雜的內部路網重規劃。
- 人行道寬度只有 1.5 m（地塊外緣到路邊），縮小看時不明顯。
- 地圖上的野生樹木（`render.js` 的 `SHOW_WILD_TREES = false`）目前關閉；地塊內的庭院樹有立體畫法。
- 交流道測試是以「死路端點」當起訖點的人工情境，重車流下的 U 字迴轉多半是測試設計造成的。

## Commit 慣例

- 訊息用繁體中文，第一行概述，下方條列細節。
- 結尾加：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（或當下使用的模型）
- push 後可用 `gh api repos/AllenTsai573/travelCity/pages/builds/latest --jq '.status+" "+.commit[0:7]'` 確認 GitHub Pages 已部署到該 commit。

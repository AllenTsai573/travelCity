// 遊戲參數設定

export const LANE_W = 3.5;          // 車道寬（公尺）
export const SIM_DT = 0.1;          // 模擬步長（秒）
export const CLOCK = 0.5;           // 每 1 模擬秒推進的遊戲分鐘數（一天 = 48 分鐘 @1x）
export const MAP_SIZE = 2400;       // 地圖邊長（公尺）

// 10 種道路類型。rank 越高越有路權；access=false 表示沿線不可建築（封閉式道路）
export const ROAD_TYPES = {
  dirt:      { name: '鄉間小路',       short: '小路', fwd: 1, bwd: 1, speed: 30,  rank: 0, cost: 6,  median: 0,   access: true,  color: '#7d7466', unlock: 0 },
  street:    { name: '市區道路',       short: '市區', fwd: 1, bwd: 1, speed: 50,  rank: 1, cost: 12, median: 0,   access: true,  color: '#4a4d52', unlock: 0 },
  oneway1:   { name: '單行道（1 線）', short: '單1', fwd: 1, bwd: 0, speed: 50,  rank: 1, cost: 9,  median: 0,   access: true,  color: '#4a4d52', unlock: 0 },
  oneway2:   { name: '單行道（2 線）', short: '單2', fwd: 2, bwd: 0, speed: 60,  rank: 2, cost: 18, median: 0,   access: true,  color: '#45484d', unlock: 1 },
  avenue:    { name: '大道（2+2）',    short: '大道', fwd: 2, bwd: 2, speed: 60,  rank: 2, cost: 28, median: 0.6, access: true,  color: '#45484d', unlock: 0 },
  boulevard: { name: '林蔭大道（3+3）', short: '林蔭', fwd: 3, bwd: 3, speed: 60,  rank: 2, cost: 42, median: 2.5, access: true,  color: '#43464b', unlock: 1, green: true },
  ramp:      { name: '匝道',           short: '匝道', fwd: 1, bwd: 0, speed: 70,  rank: 2, cost: 20, median: 0,   access: false, color: '#3f4247', unlock: 0 },
  express:   { name: '快速道路（2+2）', short: '快速', fwd: 2, bwd: 2, speed: 90,  rank: 3, cost: 55, median: 2,   access: false, color: '#3c3f44', unlock: 1 },
  highway:   { name: '高速公路（3+3）', short: '國道', fwd: 3, bwd: 3, speed: 110, rank: 3, cost: 80, median: 3,   access: false, color: '#3a3d42', unlock: 2 },
  freeway1:  { name: '單向高速（3 線）', short: '單高', fwd: 3, bwd: 0, speed: 110, rank: 3, cost: 45, median: 0,   access: false, color: '#3a3d42', unlock: 2 },
};
export const ROAD_ORDER = ['dirt', 'street', 'oneway1', 'oneway2', 'avenue', 'boulevard', 'ramp', 'express', 'highway', 'freeway1'];

// 高度層級：-2 深隧道、-1 路塹/隧道、0 地面、1~3 高架
export const LEVELS = [
  { lv: -2, name: '深層隧道', mul: 5.0, unlock: 2 },
  { lv: -1, name: '隧道',     mul: 3.5, unlock: 0 },
  { lv: 0,  name: '地面',     mul: 1.0, unlock: 0 },
  { lv: 1,  name: '高架',     mul: 2.5, unlock: 0 },
  { lv: 2,  name: '高架二層', mul: 3.2, unlock: 1 },
  { lv: 3,  name: '高架三層', mul: 4.0, unlock: 2 },
];
export const levelMul = lv => (LEVELS.find(l => l.lv === lv) || LEVELS[2]).mul;
export const LEVEL_H = 6;           // 每層高度（公尺），用於陰影
export const SLOPE_LEN = 45;        // 每升降一層所需最短距離

// 人口里程碑（解鎖道路與高度）
export const MILESTONES = [
  { pop: 0,    name: '小村莊' },
  { pop: 300,  name: '小鎮' },
  { pop: 1200, name: '城市' },
  { pop: 3500, name: '大都會' },
];

export const DIFFICULTY = {
  sandbox: { name: '沙盒',  money: 1e9,    maint: 0,   patience: 2.0, tax: 1.0, through: 0.8, unlockAll: true },
  easy:    { name: '簡單',  money: 250000, maint: 0.5, patience: 1.5, tax: 1.3, through: 0.8 },
  normal:  { name: '普通',  money: 150000, maint: 1.0, patience: 1.0, tax: 1.0, through: 1.0 },
  hard:    { name: '困難',  money: 80000,  maint: 1.6, patience: 0.7, tax: 0.8, through: 1.3 },
};

export const BIOMES = {
  temperate: {
    name: '溫帶平原', water: 0.34, scale: 560, river: true, islands: false,
    land: ['#86b462', '#74a352', '#5f8d43'], high: '#8c9a6a', shore: '#cfc58f',
    waterC: ['#4b8cc4', '#2f6ba3'], tree: ['#3d7a35', '#4b8a3c', '#2f6a2c'], treeDensity: 0.5, bg: '#2f6ba3',
  },
  desert: {
    name: '沙漠綠洲', water: 0.24, scale: 620, river: true, islands: false,
    land: ['#e6cc8f', '#dbbb77', '#c9a35f'], high: '#b98d52', shore: '#c4b07a',
    waterC: ['#44a6b8', '#2b8399'], tree: ['#7b8f3b', '#6a7e33', '#8a9a48'], treeDensity: 0.1, bg: '#2b8399',
  },
  snow: {
    name: '寒帶雪原', water: 0.33, scale: 520, river: true, islands: false,
    land: ['#eef3f6', '#dde6ec', '#c6d3dc'], high: '#b4c2cc', shore: '#a7b4bd',
    waterC: ['#6f97b8', '#56809f'], tree: ['#2f5a45', '#3b6b52', '#27503c'], treeDensity: 0.45, bg: '#56809f',
  },
  tropical: {
    name: '熱帶群島', water: 0.47, scale: 480, river: false, islands: true,
    land: ['#93cc6f', '#7cba5a', '#62a246'], high: '#6f9a4e', shore: '#f0e2ab',
    waterC: ['#33bccf', '#1a8fb0'], tree: ['#2f8a3c', '#3c9a45', '#25793a'], treeDensity: 0.6, bg: '#1a8fb0',
  },
};

// 分區建築：寬（沿路）、深、各等級容量
export const ZONES = {
  R: { name: '住宅', w: 16, d: 18, cap: [0, 6, 14, 26], color: ['#7bc47f', '#5fae68', '#3f9150'], roof: ['#e9d9b8', '#d9b48a', '#c98d6b'] },
  C: { name: '商業', w: 22, d: 22, cap: [0, 5, 12, 22], color: ['#6aa9e0', '#4b8fd0', '#2f73b8'], roof: ['#bcd6ee', '#93b9df', '#6f9bcc'] },
  I: { name: '工業', w: 30, d: 30, cap: [0, 8, 18, 32], color: ['#e0b24f', '#cf9a35', '#b5801f'], roof: ['#b8b2a6', '#a39c90', '#8c857a'] },
};

export const VEHICLE_COLORS = ['#e8e8e8', '#2b2b2b', '#c0392b', '#2e6fb7', '#8e9aa6', '#f1c40f', '#1e8449', '#7d3c98', '#d35400', '#5d6d7e', '#ecf0f1', '#a93226'];

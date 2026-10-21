// 路徑規劃：以「有向路段」為圖節點的 Dijkstra，成本為即時壅塞下的預估行駛時間
import { Heap } from './util.js';

// starts: [{ link, cost }]，cost 為抵達該路段「終點」的成本
// dest: { seg, u }（u 為沿路段 a→b 的距離）
// allow：可以通過的閘門（建築 id）；設有閘門的場內道路只讓進出該建築的車使用
export function findRoute(net, starts, dest, allow = null) {
  const destSeg = net.segs.get(dest.seg);
  if (!destSeg) return null;
  const goal = new Map();
  for (const dir of [1, -1]) {
    const L = destSeg.links[dir];
    if (!L.lanes.length) continue;
    const along = dir > 0 ? dest.u : destSeg.len - dest.u;
    goal.set(L.key, along / L.eff);
  }
  if (!goal.size) return null;
  const distM = new Map(), prev = new Map();
  const heap = new Heap();
  for (const s of starts) {
    if (!s.link) continue;
    const old = distM.get(s.link.key);
    if (old === undefined || s.cost < old) {
      distM.set(s.link.key, s.cost);
      heap.push(s.cost, s.link.key);
    }
  }
  let best = Infinity, bestEnd = null, bestPrev = null;
  let guard = 0;
  while (heap.size && guard++ < 50000) {
    const k = heap.pop();
    const d = heap.lastKey;
    if (d > distM.get(k)) continue;
    if (d >= best) break;
    const L = net.links.get(k);
    if (!L) continue;
    for (const [nk, tc] of L.next) {
      const arrive = d + tc;
      const g = goal.get(nk);
      if (g !== undefined && arrive + g < best) { best = arrive + g; bestEnd = nk; bestPrev = k; }
      const NL = net.links.get(nk);
      if (!NL) continue;
      if (NL.seg.gate !== undefined && NL.seg.gate !== null && !(allow && allow.includes(NL.seg.gate)) && !goal.has(nk)) continue;
      const end = arrive + NL.len / NL.eff;
      const od = distM.get(nk);
      if (od === undefined || end < od) {
        distM.set(nk, end);
        prev.set(nk, k);
        heap.push(end, nk);
      }
    }
  }
  if (bestEnd === null) return null;
  const path = [bestEnd];
  let k = bestPrev, g2 = 0;
  while (k !== undefined && g2++ < 10000) { path.push(k); k = prev.get(k); }
  path.reverse();
  return { path, cost: best };
}

// 從路段上的某點（建築入口）出發的路徑
export function routeFromPoint(net, from, dest) {
  const seg = net.segs.get(from.seg);
  if (!seg) return null;
  let best = null;
  const starts = [];
  for (const dir of [1, -1]) {
    const L = seg.links[dir];
    if (!L.lanes.length) continue;
    const remain = dir > 0 ? seg.len - from.u : from.u;
    starts.push({ link: L, cost: remain / L.eff });
    if (dest.seg === from.seg) {
      const ahead = dir > 0 ? dest.u - from.u : from.u - dest.u;
      if (ahead > 4) {
        const c = ahead / L.eff;
        if (!best || c < best.cost) best = { path: [L.key], cost: c };
      }
    }
  }
  const r = findRoute(net, starts, dest, [from.id, dest.id]);
  if (r && (!best || r.cost < best.cost)) best = r;
  return best;
}

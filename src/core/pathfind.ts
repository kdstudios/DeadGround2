import type { Pos } from './types.js';

const SQRT2 = Math.SQRT2;

const DIRS: { x: number; y: number; cost: number }[] = [
  { x: 0, y: -1, cost: 1 },
  { x: 1, y: 0, cost: 1 },
  { x: 0, y: 1, cost: 1 },
  { x: -1, y: 0, cost: 1 },
  { x: 1, y: -1, cost: SQRT2 },
  { x: 1, y: 1, cost: SQRT2 },
  { x: -1, y: 1, cost: SQRT2 },
  { x: -1, y: -1, cost: SQRT2 },
];

/** Minimal binary min-heap keyed on cost. */
class Heap {
  private items: { k: number; v: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(k: number, v: number): void {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.k <= a[i]!.k) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): { k: number; v: number } {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.k < a[m]!.k) m = l;
        if (r < a.length && a[r]!.k < a[m]!.k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest path on an 8-connected grid (diagonals cost sqrt 2).
 * Returns the cells to walk through (excluding `start`), [] if `start` already
 * satisfies `isGoal`, or null if no goal is reachable.
 *
 * `canStep(fx, fy, tx, ty)` can forbid individual moves, e.g. squeezing diagonally
 * between two wall corners.
 */
export function findPath(
  width: number,
  height: number,
  start: Pos,
  isGoal: (x: number, y: number) => boolean,
  passable: (x: number, y: number) => boolean,
  canStep?: (fx: number, fy: number, tx: number, ty: number) => boolean,
): Pos[] | null {
  if (isGoal(start.x, start.y)) return [];
  const idx = (x: number, y: number) => y * width + x;
  const dist = new Float64Array(width * height).fill(Infinity);
  const prev = new Int32Array(width * height).fill(-1);
  const done = new Uint8Array(width * height);
  const heap = new Heap();
  dist[idx(start.x, start.y)] = 0;
  heap.push(0, idx(start.x, start.y));
  while (heap.size > 0) {
    const { v: cur } = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    if (cur !== idx(start.x, start.y) && isGoal(cx, cy)) {
      const out: Pos[] = [];
      for (let c = cur; c !== idx(start.x, start.y); c = prev[c]!) out.push({ x: c % width, y: Math.floor(c / width) });
      return out.reverse();
    }
    for (const d of DIRS) {
      const nx = cx + d.x;
      const ny = cy + d.y;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = idx(nx, ny);
      if (done[ni]) continue;
      if (!passable(nx, ny)) continue;
      if (canStep && !canStep(cx, cy, nx, ny)) continue;
      const nd = dist[cur]! + d.cost;
      if (nd < dist[ni]!) {
        dist[ni] = nd;
        prev[ni] = cur;
        heap.push(nd, ni);
      }
    }
  }
  return null;
}

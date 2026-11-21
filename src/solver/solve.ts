import { OBJECTS } from '../core/defs.js';
import { Level, type LevelData } from '../core/level.js';
import type { Pos } from '../core/types.js';
import { deduce } from './deduce.js';

export interface SolveReport {
  solved: boolean;
  reason: 'won' | 'stuck' | 'died' | 'limit';
  /** Damage events taken. A clean logical solve takes none. */
  damage: number;
  /** Where and from what each hit landed (diagnostics for the generator and tests). */
  hits: { source: string; x: number; y: number }[];
  toolsUsed: { ammo: number; key: number; crowbar: number; explosive: number };
  revealedFraction: number;
  /** Where the logic ran out (reason 'stuck'): hidden tiles bordering the explored region. */
  stuckAt?: Pos;
  frontier?: Pos[];
  /** Visible obstacles the solver couldn't open for lack of the tool. */
  blockedBy?: string[];
  /** The Level after the run (ground truth is available to the generator for repairs). */
  level: Level;
}

const N8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

/**
 * Plays a level the way a careful human would: only ever steps on tiles that are revealed or
 * logically proven safe, picks up what it can reach, and uses tools only when logic has run dry.
 * Patrols are ignored (they're a timing layer, not a logic gate).
 */
export function solveLevel(data: LevelData, maxActions = 4000): SolveReport {
  const level = new Level({ ...data, patrols: [] });
  const W = level.width;
  const H = level.height;
  const toolsUsed = { ammo: 0, key: 0, crowbar: 0, explosive: 0 };
  let damage = 0;
  const hits: SolveReport['hits'] = [];

  const drain = (): void => {
    for (const e of level.drainEvents()) if (e.type === 'damage') {
        damage++;
        hits.push({ source: String(e.source), x: e.at.x, y: e.at.y });
      }
  };
  const settle = (): void => {
    for (let i = 0; i < 4000 && level.isMoving(); i++) level.update(0.05);
    drain();
  };
  const walk = (x: number, y: number): void => {
    level.tap(x, y);
    settle();
  };

  const solid = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    const c = level.cell(x, y);
    return c.terrain === 'wall' || (c.object !== null && OBJECTS[c.object].solid === true);
  };
  const canStep = (fx: number, fy: number, tx: number, ty: number): boolean =>
    fx === tx || fy === ty || (!solid(tx, fy) && !solid(fx, ty));

  /** Distances over tiles the player can already SEE are safe and walkable. */
  const reach = (): Map<number, number> => {
    const dist = new Map<number, number>();
    const q: Pos[] = [{ ...level.player }];
    dist.set(level.player.y * W + level.player.x, 0);
    for (let h = 0; h < q.length; h++) {
      const p = q[h]!;
      const d = dist.get(p.y * W + p.x)!;
      for (const [dx, dy] of N8) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const key = ny * W + nx;
        if (dist.has(key)) continue;
        const c = level.cell(nx, ny);
        if (!c.revealed || level.knownBlocked(nx, ny)) continue;
        if (!canStep(p.x, p.y, nx, ny)) continue;
        dist.set(key, d + 1);
        q.push({ x: nx, y: ny });
      }
    }
    return dist;
  };

  const adjacentReached = (t: Pos, dist: Map<number, number>): { p: Pos; d: number } | null => {
    let best: { p: Pos; d: number } | null = null;
    for (const [dx, dy] of N8) {
      const ax = t.x + dx;
      const ay = t.y + dy;
      const d = dist.get(ay * W + ax);
      if (d === undefined || !canStep(ax, ay, t.x, t.y)) continue;
      if (!best || d < best.d) best = { p: { x: ax, y: ay }, d };
    }
    return best;
  };

  const status = (): string => level.status;

  const finish = (reason: SolveReport['reason'], extra: Partial<SolveReport> = {}): SolveReport => {
    let seen = 0;
    let open = 0;
    for (const c of level.cells) {
      if (c.terrain === 'wall') continue;
      open++;
      if (c.revealed) seen++;
    }
    return {
      solved: reason === 'won',
      reason,
      damage,
      hits,
      toolsUsed,
      revealedFraction: seen / open,
      level,
      ...extra,
    };
  };

  for (let action = 0; action < maxActions; action++) {
    drain();
    if (status() === 'won') return finish('won');
    if (status() === 'failed') return finish('died');

    const dist = reach();

    // 1. Revealed exit within known-safe reach: finish.
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = level.cell(x, y);
        if (c.object === 'exit' && c.revealed && dist.has(y * W + x)) {
          walk(x, y);
          if (status() === 'won') return finish('won');
        }
      }

    // 2. Pick up anything lying on reachable revealed tiles (nearest first).
    {
      let best: { x: number; y: number; d: number } | null = null;
      for (const [key, d] of dist) {
        const x = key % W;
        const y = (key / W) | 0;
        if (level.cell(x, y).pickup && (!best || d < best.d)) best = { x, y, d };
      }
      if (best) {
        walk(best.x, best.y);
        continue;
      }
    }

    // 3. Logic: step onto proven-safe hidden tiles. A tile proven safe stays safe as more is revealed,
    //    so work through the whole batch before paying for another full deduction.
    const { safe } = deduce(level);
    let moved = false;
    let d = dist;
    for (let guard = 0; guard < 600; guard++) {
      // Candidates are judged against the reach map we already have (tiles stay reachable as we go);
      // it is only rebuilt when it has run out of candidates.
      const pick = (): { s: Pos; from: Pos; near: number } | null => {
        let best: { s: Pos; from: Pos; near: number } | null = null;
        for (const s of safe) {
          if (level.cell(s.x, s.y).revealed) continue;
          const a = adjacentReached(s, d);
          if (!a) continue;
          const near = Math.max(Math.abs(level.player.x - s.x), Math.abs(level.player.y - s.y));
          if (!best || near < best.near) best = { s, from: a.p, near };
        }
        return best;
      };
      let step = pick();
      if (!step && moved) {
        d = reach();
        step = pick();
      }
      if (!step) break;
      moved = true;
      // A hidden tile next to an already-open empty tile gets uncovered by standing on that tile;
      // do that first so a zombie sitting there is seen rather than bumped into.
      let zero: Pos | null = null;
      for (const [dx, dy] of N8) {
        const nx = step.s.x + dx;
        const ny = step.s.y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const c = level.cell(nx, ny);
        if (c.revealed && c.clue === 0 && c.terrain === 'floor' && d.has(ny * W + nx) && canStep(nx, ny, step.s.x, step.s.y)) {
          const dd = d.get(ny * W + nx)!;
          if (!zero || dd < d.get(zero.y * W + zero.x)!) zero = { x: nx, y: ny };
        }
      }
      if (zero) {
        if (level.player.x !== zero.x || level.player.y !== zero.y) walk(zero.x, zero.y);
        else {
          // Already standing there and it still isn't uncovered: it lies outside the fog radius. Step in.
          walk(step.s.x, step.s.y);
        }
        if (level.cell(step.s.x, step.s.y).revealed) {
          if (status() !== 'playing') break;
          continue;
        }
      }
      walk(step.s.x, step.s.y);
      if (status() !== 'playing') break;
    }
    if (moved) continue;

    // 4. Logic is dry: spend a tool on a visible obstacle we can reach.
    let tool: { x: number; y: number; d: number; kind: 'ammo' | 'key' | 'crowbar' | 'explosive' } | null = null;
    const missing = new Set<string>();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = level.cell(x, y);
        if (!c.object || !level.objectVisible(c)) continue;
        const def = OBJECTS[c.object];
        const kind = (def.openedBy ?? (c.object === 'crackedWall' ? 'explosive' : null)) as
          | 'ammo' | 'key' | 'crowbar' | 'explosive' | null;
        if (!kind) continue;
        const a = adjacentReached({ x, y }, dist);
        if (!a) continue;
        if (level.inventory[kind] <= 0) {
          missing.add(`${c.object}@${x},${y} needs ${kind}`);
          continue;
        }
        if (!tool || a.d < tool.d) tool = { x, y, d: a.d, kind };
      }
    if (tool) {
      if (tool.kind === 'explosive') {
        const a = adjacentReached({ x: tool.x, y: tool.y }, dist)!;
        if (level.player.x !== a.p.x || level.player.y !== a.p.y) walk(a.p.x, a.p.y);
        level.pressItem('explosive');
        level.confirmUse();
        drain();
      } else {
        walk(tool.x, tool.y);
      }
      toolsUsed[tool.kind]++;
      continue;
    }

    // 5. Nothing left that logic can do.
    const frontier: Pos[] = [];
    const fseen = new Set<number>();
    for (const key of dist.keys()) {
      const x = key % W;
      const y = (key / W) | 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const c = level.cell(nx, ny);
        const k = ny * W + nx;
        if (c.terrain === 'floor' && !c.revealed && !fseen.has(k)) {
          fseen.add(k);
          frontier.push({ x: nx, y: ny });
        }
      }
    }
    return finish('stuck', { stuckAt: { ...level.player }, frontier, blockedBy: [...missing] });
  }
  return finish('limit');
}

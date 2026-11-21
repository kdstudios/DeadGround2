import { OBJECTS } from '../core/defs.js';
import type { Level } from '../core/level.js';
import type { Pos } from '../core/types.js';

/**
 * Pure logic deduction using ONLY what a player can see: revealed tiles, their clue numbers,
 * visible objects, and mines that have already gone off. Hidden mines / zombies / items are never read.
 *
 * Returns hidden tiles that are provably safe (not a mine) and provably mines, over every mine layout
 * consistent with the numbers on screen. No guessing, no probabilities.
 */
export interface Deduction {
  safe: Pos[];
  mines: Pos[];
}

const N8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

const NODE_LIMIT = 300_000;

interface Constraint {
  vars: number[];
  need: number;
}

export function deduce(level: Level): Deduction {
  const { width: W, height: H } = level;
  const isVar = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const c = level.cell(x, y);
    if (c.terrain === 'wall' || c.revealed) return false;
    // A visible obstacle (door, barricade, cracked wall) is plainly not a mine.
    return !(c.object && OBJECTS[c.object].visibility === 'always');
  };

  const varIndex = new Map<number, number>();
  const varPos: Pos[] = [];
  const constraints: Constraint[] = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = level.cell(x, y);
      if (c.terrain === 'wall' || !c.revealed) continue;
      if (c.object === 'mine') continue; // a detonated mine shows no number
      let known = 0;
      const vars: number[] = [];
      for (const [dx, dy] of N8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = level.cell(nx, ny);
        if (n.revealed && n.object === 'mine' && n.triggered) known++;
        else if (isVar(nx, ny)) {
          const key = ny * W + nx;
          let idx = varIndex.get(key);
          if (idx === undefined) {
            idx = varPos.length;
            varIndex.set(key, idx);
            varPos.push({ x: nx, y: ny });
          }
          vars.push(idx);
        }
      }
      if (vars.length) constraints.push({ vars, need: c.clue - known });
    }
  }

  const nVars = varPos.length;
  const val = new Int8Array(nVars).fill(-1); // -1 unknown, 0 safe, 1 mine

  // Phase 1: cheap propagation (single-constraint and subset rules) to a fixed point.
  const live = constraints.map((c) => ({ vars: [...c.vars], need: c.need }));
  let changed = true;
  const settle = (): void => {
    for (const c of live) {
      const rest: number[] = [];
      let need = c.need;
      for (const v of c.vars) {
        if (val[v] === -1) rest.push(v);
        else if (val[v] === 1) need--;
      }
      c.vars = rest;
      c.need = need;
    }
  };
  while (changed) {
    changed = false;
    settle();
    for (const c of live) {
      if (!c.vars.length) continue;
      if (c.need === 0) {
        for (const v of c.vars) val[v] = 0;
        changed = true;
      } else if (c.need === c.vars.length) {
        for (const v of c.vars) val[v] = 1;
        changed = true;
      }
    }
    if (changed) continue;
    // subset rule: A subset of B  =>  B\A holds need(B)-need(A) mines
    const active = live.filter((c) => c.vars.length);
    for (let i = 0; i < active.length && !changed; i++) {
      const a = active[i]!;
      const aset = new Set(a.vars);
      for (let j = 0; j < active.length; j++) {
        if (i === j) continue;
        const b = active[j]!;
        if (b.vars.length <= a.vars.length) continue;
        if (!a.vars.every((v) => b.vars.includes(v))) continue;
        const diff = b.vars.filter((v) => !aset.has(v));
        const dn = b.need - a.need;
        if (dn === 0) {
          for (const v of diff) val[v] = 0;
          changed = true;
        } else if (dn === diff.length) {
          for (const v of diff) val[v] = 1;
          changed = true;
        }
        if (changed) break;
      }
    }
  }

  // Phase 2: exhaustive enumeration of each remaining connected component (exact, with a node cap).
  settle();
  const open = live.filter((c) => c.vars.length);
  const parent = Array.from({ length: nVars }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  for (const c of open) for (let i = 1; i < c.vars.length; i++) parent[find(c.vars[i]!)] = find(c.vars[0]!);
  const groups = new Map<number, { vars: Set<number>; cons: typeof open }>();
  for (const c of open) {
    const r = find(c.vars[0]!);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { vars: new Set(), cons: [] }));
    g.cons.push(c);
    for (const v of c.vars) g.vars.add(v);
  }

  for (const g of groups.values()) {
    const vars = [...g.vars];
    // order variables by walking constraints so partial assignments prune early
    const order: number[] = [];
    const seen = new Set<number>();
    const byVar = new Map<number, number[]>();
    g.cons.forEach((c, ci) => c.vars.forEach((v) => (byVar.get(v) ?? byVar.set(v, []).get(v)!).push(ci)));
    const queue = [vars[0]!];
    seen.add(vars[0]!);
    while (queue.length) {
      const v = queue.shift()!;
      order.push(v);
      for (const ci of byVar.get(v)!) for (const w of g.cons[ci]!.vars) if (!seen.has(w)) (seen.add(w), queue.push(w));
    }
    const pos = new Map(order.map((v, i) => [v, i]));
    const cons = g.cons.map((c) => ({ vars: c.vars, need: c.need, left: c.vars.length, got: 0 }));
    const consOf = order.map((v) => byVar.get(v)!);
    const canMine = new Uint8Array(order.length);
    const canSafe = new Uint8Array(order.length);
    const cur = new Uint8Array(order.length);
    let nodes = 0;
    let solutions = 0;
    let aborted = false;

    const rec = (i: number): void => {
      if (aborted) return;
      if (++nodes > NODE_LIMIT) {
        aborted = true;
        return;
      }
      if (i === order.length) {
        solutions++;
        for (let k = 0; k < cur.length; k++) (cur[k] ? (canMine[k] = 1) : (canSafe[k] = 1));
        return;
      }
      for (let choice = 0; choice <= 1; choice++) {
        let ok = true;
        for (const ci of consOf[i]!) {
          const c = cons[ci]!;
          c.left--;
          c.got += choice;
        }
        for (const ci of consOf[i]!) {
          const c = cons[ci]!;
          if (c.got > c.need || c.got + c.left < c.need) ok = false;
        }
        if (ok) {
          cur[i] = choice;
          rec(i + 1);
        }
        for (const ci of consOf[i]!) {
          const c = cons[ci]!;
          c.left++;
          c.got -= choice;
        }
        if (aborted) return;
      }
    };
    rec(0);
    if (aborted || solutions === 0) continue; // inconclusive: claim nothing
    for (const v of order) {
      const k = pos.get(v)!;
      if (canMine[k] && !canSafe[k]) val[v] = 1;
      else if (canSafe[k] && !canMine[k]) val[v] = 0;
    }
  }

  const safe: Pos[] = [];
  const mines: Pos[] = [];
  for (let i = 0; i < nVars; i++) {
    if (val[i] === 0) safe.push(varPos[i]!);
    else if (val[i] === 1) mines.push(varPos[i]!);
  }
  return { safe, mines };
}

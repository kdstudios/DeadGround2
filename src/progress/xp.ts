import { PROGRESS } from './config.js';

const L = PROGRESS.level;

/** XP needed to advance from `level` to `level + 1`. */
export const xpToNext = (level: number): number => Math.round(L.base + L.growth * Math.pow(Math.max(0, level - 1), L.exponent));

/** Total XP required to *reach* `level` (level 1 needs none). */
export function xpForLevel(level: number): number {
  let t = 0;
  for (let i = 1; i < level; i++) t += xpToNext(i);
  return t;
}

export interface LevelInfo {
  level: number;
  /** XP earned inside the current level. */
  into: number;
  /** XP the current level is worth (0 at the cap). */
  need: number;
  /** 0..1 progress through the current level (1 at the cap). */
  pct: number;
  total: number;
  maxed: boolean;
}

export function levelFromXp(xp: number): LevelInfo {
  const total = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  let level = 1;
  let left = total;
  while (level < L.max) {
    const need = xpToNext(level);
    if (left < need) return { level, into: left, need, pct: left / need, total, maxed: false };
    left -= need;
    level++;
  }
  return { level, into: left, need: 0, pct: 1, total, maxed: true };
}

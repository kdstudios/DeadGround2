import { REGIONS, type Region } from '../gen/difficulty.js';
import type { Level } from '../core/level.js';

/**
 * Purely cosmetic, deterministic dressing for a level: which ground tile (and rotation) each cell gets,
 * which prop sits on rubble cells, and the scenery beyond the map edge. Nothing here is read by the rules,
 * and the same level always looks the same. Sprite choices come from the manifest's `groups`, so adding
 * a new ground tile or prop is just a manifest edit.
 */

/** Cheap integer hash -> [0, 1). */
export function hash(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) (so grass and bare dirt form patches rather than confetti). */
export function noise(x: number, y: number, salt: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, salt);
  const b = hash(x0 + 1, y0, salt);
  const c = hash(x0, y0 + 1, salt);
  const d = hash(x0 + 1, y0 + 1, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export type Groups = Record<string, string[]>;

const pick = (list: string[] | undefined, r: number): string | null =>
  list && list.length ? list[Math.min(list.length - 1, Math.floor(r * list.length))]! : null;

export interface Decor {
  name: string;
  /** Cell coordinates of the horizontal centre and of the base (feet) line. */
  x: number;
  y: number;
}

export interface Visuals {
  /** Margin (cells) of scenery drawn beyond the map: top gets the skyline, so it is deeper. */
  margin: { top: number; side: number; bottom: number };
  decor: Decor[];
  /** Ground sprite for any cell, including cells outside the map (negative coordinates). */
  groundFor(level: Level, x: number, y: number): { name: string; rot: number };
  /** Prop sprite for blocking rubble cells. */
  propAt(x: number, y: number): string | null;
  fogAt(x: number, y: number): string | null;
}

const MARGIN = { top: 4.5, side: 2.2, bottom: 2.2 };

export function buildVisuals(level: Level, groups: Groups, spriteSize: (name: string) => { w: number; h: number } | null): Visuals {
  const salt = (level.width * 131 + level.height * 17 + level.name.length * 7 + [...level.name].reduce((a, c) => a + c.charCodeAt(0), 0)) | 0;
  const reg = REGIONS[(level.region as Region) in REGIONS ? (level.region as Region) : 'wasteland'];
  const dirt = groups.ground_dirt;
  const dark = groups.ground_dark;
  const grass = groups.ground_grass;
  const misc = groups.ground_misc;
  const paved = groups.ground_paved;
  const floors = groups.floor_in;
  const props = groups.prop_out;

  const outdoor = (x: number, y: number): { name: string; rot: number } => {
    const v = noise(x / 5.5, y / 5.5, salt);
    const w = noise(x / 3 + 40, y / 3 + 40, salt + 5);
    const r = hash(x, y, salt + 1);
    let list = dirt;
    if (v < reg.grass + (w - 0.5) * 0.1) list = grass;
    else if (v > reg.dark) list = dark;
    if (r > 0.975) list = misc;
    return { name: pick(list, hash(x, y, salt + 2)) ?? 'g_dirt0', rot: Math.floor(hash(x, y, salt + 3) * 4) };
  };

  const decor: Decor[] = [];
  const decorNames = groups.decor ?? [];
  const bld = groups.buildings ?? [];
  const W = level.width;
  const H = level.height;
  const size = (n: string) => spriteSize(n) ?? { w: 64, h: 64 };

  // Skyline along the top edge: buildings (and the odd watchtower) standing behind the boundary wall.
  let x = -MARGIN.side - 1;
  let i = 0;
  while (x < W + MARGIN.side && bld.length) {
    const name = bld[Math.floor(hash(i, 7, salt) * bld.length)]!;
    const w = size(name).w / 64;
    decor.push({ name, x: x + w / 2, y: -0.5 + 0.35 });
    x += w * 0.92 + hash(i, 9, salt) * 0.9;
    i++;
  }
  // Scrub and junk filling the gaps in front of the skyline and around the other three edges.
  const scatter = (x0: number, x1: number, y0: number, y1: number, n: number, k: number): void => {
    for (let j = 0; j < n; j++) {
      const name = pick(decorNames, hash(j, k, salt + 11));
      if (!name) return;
      decor.push({
        name,
        x: x0 + hash(j, k + 1, salt) * (x1 - x0),
        y: y0 + hash(j, k + 2, salt) * (y1 - y0),
      });
    }
  };
  scatter(-MARGIN.side, W - 0.5 + MARGIN.side, -0.5 - 0.3, -0.5 + 0.1, Math.round(W / 3), 100); // before skyline
  scatter(-MARGIN.side, -0.6, -0.5, H, Math.round(H / 2.2), 200);
  scatter(W - 0.4, W - 0.5 + MARGIN.side, -0.5, H, Math.round(H / 2.2), 300);
  scatter(-MARGIN.side, W - 0.5 + MARGIN.side, H - 0.4, H - 0.5 + MARGIN.bottom, Math.round(W / 2.2), 400);
  decor.sort((a, b) => a.y - b.y);

  return {
    margin: MARGIN,
    decor,
    groundFor(lv: Level, cx: number, cy: number) {
      const inMap = lv.inBounds(cx, cy);
      const zone = inMap ? lv.zones?.[cy * lv.width + cx] : 'out';
      if (zone === 'in' && floors?.length) {
        const room = lv.roomIds?.[cy * lv.width + cx] ?? 0;
        const name = floors[(room * 5 + 2) % floors.length]!;
        // wood and tile have a grain: only flip them end for end
        return { name, rot: Math.floor(hash(cx, cy, salt + 4) * 2) * 2 };
      }
      if (inMap && paved?.length) {
        // thresholds: open ground touching a building interior
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (lv.inBounds(cx + dx, cy + dy) && lv.zones?.[(cy + dy) * lv.width + cx + dx] === 'in')
            return { name: paved[0]!, rot: Math.floor(hash(cx, cy, salt + 4) * 4) };
        }
      }
      return outdoor(cx, cy);
    },
    propAt(px, py) {
      return pick(props, hash(px, py, salt + 21));
    },
    fogAt(px, py) {
      return pick(groups.fog, hash(px, py, salt + 31));
    },
  };
}

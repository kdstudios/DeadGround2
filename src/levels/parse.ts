import type { LevelData } from '../core/level.js';
import type { Cell, ObjectId, PickupId, Pos } from '../core/types.js';

/**
 * ASCII level format (one character per cell):
 *   #  wall            .  floor            S  player start
 *   E  exit manhole
 *   m  mine           z  standard zombie   b  plank barricade (crowbar)
 *   D  locked door    X  cracked wall (explosive)
 *   s  scrap  f  food  t  materials  a  ammo  k  key  c  crowbar
 *   e  explosive  h  medkit  p  protective shield  r  map fragment  v  survivor to rescue
 */
const OBJECT_CHARS: Record<string, ObjectId> = {
  m: 'mine',
  z: 'zombie',
  b: 'barricade',
  D: 'door',
  X: 'crackedWall',
  E: 'exit',
};

const PICKUP_CHARS: Record<string, PickupId> = {
  s: 'scrap',
  f: 'food',
  t: 'materials',
  a: 'ammo',
  k: 'key',
  c: 'crowbar',
  e: 'explosive',
  h: 'medkit',
  p: 'shield',
  r: 'map',
  v: 'survivor',
};

export interface AsciiLevel {
  name: string;
  rows: string[];
  patrols?: { route: Pos[]; speed?: number }[];
}

export function parseLevel(src: AsciiLevel): LevelData {
  const height = src.rows.length;
  const width = src.rows[0]!.length;
  const cells: Cell[] = [];
  let start: Pos | null = null;

  src.rows.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(`${src.name}: row ${y} has width ${row.length}, expected ${width}`);
    }
    for (let x = 0; x < width; x++) {
      const ch = row[x]!;
      const cell: Cell = {
        terrain: ch === '#' ? 'wall' : 'floor',
        object: null,
        pickup: null,
        pickupAmount: 0,
        revealed: false,
        flagged: false,
        triggered: false,
        clue: 0,
      };
      if (ch === 'S') start = { x, y };
      else if (ch in OBJECT_CHARS) cell.object = OBJECT_CHARS[ch]!;
      else if (ch in PICKUP_CHARS) {
        cell.pickup = PICKUP_CHARS[ch]!;
        cell.pickupAmount = 1;
      } else if (ch !== '#' && ch !== '.') {
        throw new Error(`${src.name}: unknown character '${ch}' at ${x},${y}`);
      }
      cells.push(cell);
    }
  });

  if (!start) throw new Error(`${src.name}: no start 'S'`);
  return { name: src.name, width, height, cells, start, patrols: src.patrols ?? [] };
}

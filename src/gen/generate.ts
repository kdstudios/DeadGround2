import type { LevelData, Zone } from '../core/level.js';
import { parseLevel, type AsciiLevel } from '../levels/parse.js';
import { solveLevel, type SolveReport } from '../solver/solve.js';
import { DIFFICULTIES, REGIONS, withRegion, type Difficulty, type DifficultyParams, type GateChar, type Region } from './difficulty.js';
import { Rng } from './rng.js';
import type { PickupId, Pos, StoryKey, Vault, VaultKind } from '../core/types.js';

export interface GeneratedLevel {
  data: LevelData;
  ascii: AsciiLevel;
  difficulty: Difficulty;
  seed: number;
  info: {
    attempts: number;
    repairs: number;
    mines: number;
    density: number;
    buildings: number;
    rooms: number;
    report: Omit<SolveReport, 'level'>;
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type BuildingKind = 'house' | 'store' | 'warehouse' | 'clinic';
const KIND_LOOT: Record<BuildingKind, string[]> = {
  house: ['s', 'f', 't'],
  store: ['f', 'f', 'f', 's', 't'],
  warehouse: ['t', 't', 't', 's', 's', 'f'],
  clinic: ['f', 'f', 's', 's', 't'],
};

interface Building extends Rect {
  kind: BuildingKind;
  rooms: Rect[];
  /** Cells in the outer wall that lead outside (first = main entrance). */
  entrances: Pos[];
  /** Cells in partition walls that lead between rooms. */
  doorways: Pos[];
}
interface Slot {
  pos: Pos;
  kind: 'road' | 'entrance' | 'inner' | 'alt';
}
interface Gate {
  pos: Pos;
  char: GateChar;
  tool: 'a' | 'k' | 'c' | 'e';
}

const N4 = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
const cheb = (a: Pos, b: Pos): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;
const TOOL_OF = { z: 'a', D: 'k', b: 'c', X: 'e' } as const;

/**
 * Seeded random expedition. The map is an open wasteland ("outside") ringed by a boundary wall, with
 * rubble piles and a few buildings standing in it. Buildings have walls, one or more entrances and,
 * on harder levels, several rooms joined by doorways. Some doorways are sealed (zombie / locked door /
 * planks / cracked wall) and the matching tool is always placed somewhere reachable BEFORE the gate.
 * Mines are scattered both outside and inside, then the logic solver plays the map twice: once to
 * reach the exit, once more to collect everything. If it gets stuck, a mine from the stuck frontier
 * is removed and it tries again, so every returned map can be finished without a guess and without
 * taking a single hit. Maps that can't be repaired are discarded and regenerated.
 */
export function generateExpedition(difficulty: Difficulty, seed: number, region: Region = 'wasteland', story: readonly StoryKey[] = []): GeneratedLevel {
  const P = withRegion(DIFFICULTIES[difficulty], region);
  for (let attempt = 0; attempt < 200; attempt++) {
    const rng = new Rng((seed * 7919 + attempt * 104729) >>> 0);
    const g = build(P, rng, story);
    if (!g) continue;
    const res = repair(P, g);
    if (!res) continue;
    const vaults = addVaults(P, g, rng);
    addPatrols(P, g, rng);
    const ascii: AsciiLevel = {
      name: `${P.label} expedition #${seed}${region === 'wasteland' ? '' : ' · ' + REGIONS[region].label}`,
      rows: g.grid.map((r) => r.join('')),
      patrols: g.patrols,
    };
    const data = parseLevel(ascii);
    data.region = region;
    applyVaults(data, vaults);
    data.vaults = vaults.map((v) => v.vault);
    data.zones = g.zone;
    data.roomIds = g.roomId;
    for (const c of data.cells) if (c.pickup === 'scrap' || c.pickup === 'food' || c.pickup === 'materials') c.pickupAmount = P.lootAmount;
    const { level: _drop, ...report } = res.report;
    void _drop;
    return {
      data,
      ascii,
      difficulty,
      seed,
      info: {
        attempts: attempt + 1,
        repairs: res.repairs,
        mines: res.mines,
        density: res.density,
        buildings: g.buildings.length,
        rooms: g.buildings.reduce((n, b) => n + b.rooms.length, 0),
        report,
      },
    };
  }
  throw new Error(`generateExpedition(${difficulty}, ${seed}): no valid map found`);
}

interface Built {
  grid: string[][];
  zone: Zone[];
  roomId: number[];
  W: number;
  H: number;
  buildings: Building[];
  start: Pos;
  exit: Pos;
  gates: Gate[];
  /** Every doorway-like cell (gated or open). */
  doorCells: Pos[];
  patrols: { route: Pos[]; speed?: number }[];
  targetMines: number;
  placedMines: number;
  floorCells: number;
}

function build(P: DifficultyParams, rng: Rng, story: readonly StoryKey[] = []): Built | null {
  const W = P.width;
  const H = P.height;
  const grid: string[][] = Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? '#' : '.')),
  );
  const zone: Zone[] = Array<Zone>(W * H).fill('out');
  const at = (x: number, y: number): string => grid[y]![x]!;
  const z = (x: number, y: number): Zone => zone[y * W + x]!;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
  const open = (x: number, y: number): boolean => inside(x, y) && at(x, y) !== '#';

  // ── start (west edge) and exit manhole (east side) ──
  const start: Pos = { x: rng.range(2, 3), y: rng.range(3, H - 4) };
  const exit: Pos = { x: rng.range(W - 4, W - 3), y: rng.range(3, H - 4) };

  const slots: Slot[] = [];
  const doorCells: Pos[] = [];

  // ── ruined fence across the wasteland, one gap ──
  let rx = -1;
  if (P.roadblock) {
    rx = Math.round((W * rng.range(46, 56)) / 100);
    for (let y = 1; y < H - 1; y++) {
      grid[y]![rx] = '#';
      zone[y * W + rx] = 'fence';
    }
    const gy = rng.range(3, H - 4);
    grid[gy]![rx] = '.';
    slots.push({ pos: { x: rx, y: gy }, kind: 'road' });
    doorCells.push({ x: rx, y: gy });
  }

  // ── buildings ──
  const buildings: Building[] = [];
  const clearOf = (r: Rect, m: number): boolean =>
    !buildings.some((b) => r.x < b.x + b.w + m && r.x + r.w + m > b.x && r.y < b.y + b.h + m && r.y + r.h + m > b.y);
  for (let tries = 0; tries < 1500 && buildings.length < P.buildings; tries++) {
    const w = rng.range(P.buildingW[0], P.buildingW[1]);
    const h = rng.range(P.buildingH[0], P.buildingH[1]);
    const x = rng.range(3, W - w - 3);
    const y = rng.range(3, H - h - 3);
    const r: Rect = { x, y, w, h };
    if (!clearOf(r, 3)) continue;
    if (rx >= 0 && x < rx + 3 && x + w > rx - 2) continue; // keep the fence line and its gap clear
    const nearPt = (p: Pos): boolean => p.x >= x - 3 && p.x < x + w + 3 && p.y >= y - 3 && p.y < y + h + 3;
    if (nearPt(start) || nearPt(exit)) continue;
    buildings.push({ ...r, kind: 'house', rooms: [], entrances: [], doorways: [] });
  }
  if (buildings.length < P.buildings) return null;
  // Order buildings by distance to the start so the first ones are the "free" starter houses.
  const bc = (b: Building): Pos => ({ x: b.x + (b.w >> 1), y: b.y + (b.h >> 1) });
  buildings.sort((a, b) => cheb(bc(a), start) - cheb(bc(b), start));
  // Building types only colour what the loot inside is; the layout is identical, so solvability is untouched.
  buildings.forEach((b, i) => {
    const area = b.w * b.h;
    b.kind = i < P.freeBuildings ? 'house' : area >= 70 ? 'warehouse' : rng.pick<BuildingKind>(['house', 'store', 'clinic', 'house']);
  });

  buildings.forEach((b, bi) => {
    // walls + interior
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const rim = x === b.x || y === b.y || x === b.x + b.w - 1 || y === b.y + b.h - 1;
        grid[y]![x] = rim ? '#' : '.';
        zone[y * W + x] = rim ? 'out' : 'in';
      }
    // entrances: one wall cell per chosen side, never in a corner
    const sides = rng.shuffle([0, 1, 2, 3]);
    const wantAlt = bi >= P.freeBuildings && rng.chance(P.altEntrance);
    const nEnt = wantAlt ? 2 : 1;
    for (let s = 0; s < nEnt; s++) {
      const side = sides[s]!;
      const e: Pos =
        side === 0 ? { x: b.x + rng.range(1, b.w - 2), y: b.y }
        : side === 2 ? { x: b.x + rng.range(1, b.w - 2), y: b.y + b.h - 1 }
        : side === 3 ? { x: b.x, y: b.y + rng.range(1, b.h - 2) }
        : { x: b.x + b.w - 1, y: b.y + rng.range(1, b.h - 2) };
      grid[e.y]![e.x] = '.';
      b.entrances.push(e);
      doorCells.push(e);
    }
    // partitions
    const rooms: Rect[] = [{ x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 }];
    const want = rng.range(P.rooms[0], P.rooms[1]);
    const gapCells: Pos[] = [...b.entrances];
    for (let guard = 0; rooms.length < want && guard < 40; guard++) {
      // split the biggest splittable room
      const order = rooms.map((_, i) => i).sort((p, q) => rooms[q]!.w * rooms[q]!.h - rooms[p]!.w * rooms[p]!.h);
      let done = false;
      for (const ri of order) {
        const r = rooms[ri]!;
        const vertical = r.w === r.h ? rng.chance(0.5) : r.w > r.h;
        for (const vert of [vertical, !vertical]) {
          const len = vert ? r.w : r.h;
          if (len < 5) continue;
          const cands: number[] = [];
          for (let p = 2; p <= len - 3; p++) {
            const line: Pos[] = [];
            for (let k = 0; k < (vert ? r.h : r.w); k++)
              line.push(vert ? { x: r.x + p, y: r.y + k } : { x: r.x + k, y: r.y + p });
            // a new wall must not touch an existing doorway sideways (it would plug it)
            if (line.some((c) => gapCells.some((g) => Math.abs(g.x - c.x) + Math.abs(g.y - c.y) === 1))) continue;
            cands.push(p);
          }
          if (!cands.length) continue;
          const p = rng.pick(cands);
          const span = vert ? r.h : r.w;
          const gapAt = rng.int(span);
          for (let k = 0; k < span; k++) {
            const c = vert ? { x: r.x + p, y: r.y + k } : { x: r.x + k, y: r.y + p };
            if (k === gapAt) {
              b.doorways.push(c);
              gapCells.push(c);
              doorCells.push(c);
            } else grid[c.y]![c.x] = '#';
          }
          rooms.splice(
            ri, 1,
            vert ? { x: r.x, y: r.y, w: p, h: r.h } : { x: r.x, y: r.y, w: r.w, h: p },
            vert ? { x: r.x + p + 1, y: r.y, w: r.w - p - 1, h: r.h } : { x: r.x, y: r.y + p + 1, w: r.w, h: r.h - p - 1 },
          );
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) break;
    }
    b.rooms = rooms;
  });

  // ── room numbers (cosmetic: lets the renderer give every room its own floor) ──
  const roomId: number[] = Array<number>(W * H).fill(0);
  let nextRoom = 1;
  for (const b of buildings)
    for (const r of b.rooms) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) roomId[y * W + x] = nextRoom;
      nextRoom++;
    }
  for (const b of buildings)
    for (const d of b.doorways) {
      const nb = N4.map(([dx, dy]) => roomId[(d.y + dy) * W + d.x + dx]!).find((v) => v > 0);
      roomId[d.y * W + d.x] = nb ?? 0;
    }

  // ── rubble: small wall clusters on open ground, kept well clear of everything else ──
  const wallNear = (x: number, y: number, r: number, own: Set<number>): boolean => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inside(nx, ny)) return true;
        if (at(nx, ny) === '#' && !own.has(ny * W + nx)) return true;
        if (z(nx, ny) === 'in') return true;
      }
    return false;
  };
  for (let i = 0, tries = 0; i < P.rubble && tries < 300; tries++) {
    const c0: Pos = { x: rng.range(3, W - 4), y: rng.range(3, H - 4) };
    if (cheb(c0, start) <= 3 || cheb(c0, exit) <= 3) continue;
    if (wallNear(c0.x, c0.y, 2, new Set())) continue;
    if (doorCells.some((d) => cheb(d, c0) <= 3)) continue;
    const blob: Pos[] = [c0];
    const own = new Set<number>([c0.y * W + c0.x]);
    const size = rng.range(1, 3);
    for (let k = 0; k < 8 && blob.length < size; k++) {
      const base = rng.pick(blob);
      const [dx, dy] = rng.pick(N4);
      const n = { x: base.x + dx, y: base.y + dy };
      if (own.has(n.y * W + n.x) || wallNear(n.x, n.y, 2, own)) continue;
      blob.push(n);
      own.add(n.y * W + n.x);
    }
    for (const c of blob) {
      grid[c.y]![c.x] = '#';
      zone[c.y * W + c.x] = 'ruin';
    }
    i++;
  }

  grid[start.y]![start.x] = 'S';
  grid[exit.y]![exit.x] = 'E';

  // ── connectivity sanity: with every doorway open, all floor must be one region ──
  const allFloor = (): number => {
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(x, y) !== '#') n++;
    return n;
  };
  const flood = (blocked: Set<number>): Pos[] => {
    const seen = new Set<number>([start.y * W + start.x]);
    const q: Pos[] = [start];
    for (let h = 0; h < q.length; h++) {
      const p = q[h]!;
      for (const [dx, dy] of N4) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (!open(nx, ny)) continue;
        const k = ny * W + nx;
        if (seen.has(k) || blocked.has(k)) continue;
        seen.add(k);
        q.push({ x: nx, y: ny });
      }
    }
    return q;
  };
  if (flood(new Set()).length !== allFloor()) return null;

  // ── gates: seal some doorways ──
  const shuf = <T,>(a: T[]): T[] => rng.shuffle(a);
  const entranceSlots: Slot[] = [];
  const altSlots: Slot[] = [];
  const innerSlots: Slot[] = [];
  buildings.forEach((b, bi) => {
    if (bi >= P.freeBuildings) {
      entranceSlots.push({ pos: b.entrances[0]!, kind: 'entrance' });
      for (const e of b.entrances.slice(1)) altSlots.push({ pos: e, kind: 'alt' });
    }
    for (const d of b.doorways) innerSlots.push({ pos: d, kind: 'inner' });
  });
  const pool = [...slots, ...shuf(entranceSlots), ...shuf(innerSlots), ...shuf(altSlots)];
  const gateCount = Math.min(P.gates, pool.length);
  const kinds: GateChar[] = [];
  while (kinds.length < gateCount) kinds.push(...shuf([...P.gatePool]));
  kinds.length = gateCount;
  shuf(kinds);
  const gates: Gate[] = pool.slice(0, gateCount).map((s, i) => ({ pos: s.pos, char: kinds[i]!, tool: TOOL_OF[kinds[i]!] }));
  // dependency order: the fence gap last (its tool may lie inside a house), the rest as drawn
  gates.sort((a, b) => Number(a.pos.x === rx && rx >= 0) - Number(b.pos.x === rx && rx >= 0));
  for (const gt of gates) grid[gt.pos.y]![gt.pos.x] = gt.char;

  // ── tools: each lies somewhere reachable BEFORE its gate, without needing any gate of its own kind ──
  const choke = (x: number, y: number): boolean => {
    if (at(x, y) === '#') return false;
    const horiz = open(x - 1, y) && open(x + 1, y) && !open(x, y - 1) && !open(x, y + 1);
    const vert = open(x, y - 1) && open(x, y + 1) && !open(x - 1, y) && !open(x + 1, y);
    return horiz || vert;
  };
  const gateKey = (gt: Gate): number => gt.pos.y * W + gt.pos.x;
  const putAt = (cells: Pos[], ch: string, preferIndoor = false): boolean => {
    const free = cells.filter((c) => at(c.x, c.y) === '.' && !choke(c.x, c.y));
    if (!free.length) return false;
    const indoor = free.filter((c) => z(c.x, c.y) === 'in');
    const c = preferIndoor && indoor.length && rng.chance(0.7) ? rng.pick(indoor) : rng.pick(free);
    grid[c.y]![c.x] = ch;
    return true;
  };
  for (let i = 0; i < gates.length; i++) {
    const blocked = new Set<number>();
    gates.forEach((gt, j) => {
      if (j >= i || gt.char === gates[i]!.char) blocked.add(gateKey(gt));
    });
    if (!putAt(flood(blocked), gates[i]!.tool, true)) return null;
  }

  // spares: ammo for the odd stray zombie, bombs for the patrols, then comforts and loot
  const all = new Set(gates.map(gateKey));
  const early = flood(all);
  const everywhere: Pos[] = [];
  const indoorCells: Pos[] = [];
  const outdoorCells: Pos[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (at(x, y) === '#') continue;
      const p = { x, y };
      everywhere.push(p);
      (z(x, y) === 'in' ? indoorCells : outdoorCells).push(p);
    }
  const spares: [string, number, Pos[]][] = [
    ['a', P.spareAmmo, early],
    ['e', P.patrols, early],
    ['h', P.medkits, everywhere],
    ['p', P.shields, everywhere],
    ['r', P.maps, outdoorCells],
  ];
  for (const [ch, n, cells] of spares) for (let i = 0; i < n; i++) putAt(cells, ch);
  // stranded survivors wait inside buildings
  for (let i = 0; i < P.survivors; i++) putAt(indoorCells, 'v');
  // campaign story items (only requested while the matching campaign step is active): always inside a building.
  // They are ordinary pickups for the solver, so the "everything is reachable without a guess" check covers them.
  // A map that cannot hold one is thrown away and regenerated.
  for (const k of story) if (!putAt(indoorCells, k === 'transmitter' ? 'T' : 'Q')) return null;
  // loot: two thirds inside the buildings (the reward for exploring them), the rest out in the open
  const inLoot = indoorCells.length ? Math.round(P.loot * 0.66) : 0;
  for (let i = 0; i < P.loot; i++) putAt(i < inLoot ? indoorCells : outdoorCells, rng.pick(['s', 'f', 't']));
  // re-roll loot found indoors by the type of building it sits in
  for (const c of indoorCells) {
    if (!'sft'.includes(at(c.x, c.y))) continue;
    const b = buildings.find((q) => c.x >= q.x && c.x < q.x + q.w && c.y >= q.y && c.y < q.y + q.h);
    if (b) grid[c.y]![c.x] = rng.pick(KIND_LOOT[b.kind]);
  }

  // ── mines: open ground and building interiors. Never touching (not even diagonally: touching mines make
  //    ambiguous clues), never plugging a doorway, clear around start / exit / doors ──
  const eligibleOut: Pos[] = [];
  const eligibleIn: Pos[] = [];
  let floorCells = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (at(x, y) === '#') continue;
      floorCells++;
      if (at(x, y) !== '.') continue;
      const p = { x, y };
      if (cheb(p, start) <= 1 || cheb(p, exit) <= 1) continue;
      if (choke(x, y)) continue;
      if (doorCells.some((d) => cheb(p, d) <= 2)) continue;
      (z(x, y) === 'in' ? eligibleIn : eligibleOut).push(p);
    }
  const countZone = (inZone: boolean): number => (inZone ? indoorCells : outdoorCells).length;
  let placed = 0;
  let target = 0;
  for (const [eligible, tgt] of [
    [eligibleOut, Math.round(countZone(false) * P.density)],
    [eligibleIn, Math.round(countZone(true) * P.indoorDensity)],
  ] as const) {
    target += tgt;
    let n = 0;
    for (const p of shuf([...eligible])) {
      if (n >= tgt) break;
      if (N8.some(([dx, dy]) => at(p.x + dx, p.y + dy) === 'm')) continue;
      grid[p.y]![p.x] = 'm';
      n++;
    }
    placed += n;
  }
  return { grid, zone, roomId, W, H, buildings, start, exit, gates, doorCells, patrols: [], targetMines: target, placedMines: placed, floorCells };
}

const REPAIR_BATCH = 3;

const countPickups = (level: SolveReport['level']): number => level.cells.reduce((n, c) => n + (c.pickup ? 1 : 0), 0);

/**
 * Thin out mines until a logic-only player can (1) reach the exit and (2) collect every item on the
 * map, both without a single hit. Two solver runs per round: the real map, then a copy whose exit
 * manhole is sealed so the solver can't finish early and has to keep exploring.
 */
function repair(
  P: DifficultyParams,
  g: Built,
): { report: SolveReport; repairs: number; mines: number; density: number } | null {
  let repairs = 0;
  let mines = g.placedMines;
  const rowsOf = (sealExit: boolean): string[] =>
    g.grid.map((r) => r.map((ch) => (sealExit && ch === 'E' ? '#' : ch)).join(''));
  for (let round = 0; round < 600; round++) {
    // 1) can everything be collected without a hit? (exit sealed so the solver can't finish early)
    let rep = solveLevel(parseLevel({ name: 'gen-full', rows: rowsOf(true) }));
    let complete = false;
    if (rep.damage > 0) return null;
    if (countPickups(rep.level) === 0) {
      // 2) ...and can the real map, manhole included, be finished?
      rep = solveLevel(parseLevel({ name: 'gen', rows: rowsOf(false) }));
      complete = rep.solved;
    }
    if (complete) {
      if (rep.damage > 0) return null; // bumped a hidden zombie: reject this layout
      if (mines < g.targetMines * P.minDensityKept) return null;
      return { report: rep, repairs, mines, density: mines / g.floorCells };
    }
    if (mines < g.targetMines * P.minDensityKept) return null; // can't be thinned enough: give up early
    if (rep.reason !== 'stuck' || rep.damage > 0) return null;
    const frontier = rep.frontier ?? [];
    // Remove the few mines hugging the stuck frontier, nearest to where the player ran dry first.
    const victims: { p: Pos; d: number }[] = [];
    for (let y = 0; y < g.H; y++)
      for (let x = 0; x < g.W; x++) {
        if (g.grid[y]![x] !== 'm') continue;
        const p = { x, y };
        if (!frontier.some((f) => cheb(f, p) <= 1)) continue;
        victims.push({ p, d: cheb(p, rep.stuckAt!) });
      }
    if (!victims.length) return null;
    victims.sort((a, b) => a.d - b.d);
    for (const v of victims.slice(0, REPAIR_BATCH)) {
      g.grid[v.p.y]![v.p.x] = '.';
      mines--;
      repairs++;
    }
  }
  return null;
}

interface PlacedVault {
  vault: Vault;
  /** Loot to put inside once the map is parsed. */
  loot: { pos: Pos; pickup: PickupId; amount: number }[];
}

/**
 * Optional sealed rooms out in the open: four walls, a door with a lock or terminal minigame, loot inside.
 * The room is walled off in the grid BEFORE the solver validates it, with the door counted as plain wall, so
 * a logic-only player can still finish the map and collect everything else without touching the vault.
 * Nothing inside the room is required, no mines are within two tiles of it (so its clues stay at zero), and
 * a candidate spot is thrown away if it would change the solvability of the map.
 */
function addVaults(P: DifficultyParams, g: Built, rng: Rng): PlacedVault[] {
  const out: PlacedVault[] = [];
  const want = P.vaults + (rng.chance(P.vaultExtra) ? 1 : 0);
  const { W, H, grid } = g;
  const nextRoom = Math.max(0, ...g.roomId) + 1;
  const minDist = P.id === 'safe' ? 4 : 6;
  const validates = (): boolean => {
    const rows = (seal: boolean): string[] => grid.map((r) => r.map((ch) => (seal && ch === 'E' ? '#' : ch)).join(''));
    const full = solveLevel(parseLevel({ name: 'vault-full', rows: rows(true) }));
    if (full.damage > 0 || countPickups(full.level) > 0) return false;
    const real = solveLevel(parseLevel({ name: 'vault', rows: rows(false) }));
    return real.solved && real.damage === 0;
  };
  for (let n = 0; n < want; n++) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const iw = P.id === 'risky' && rng.chance(0.5) ? 3 : 2;
      const ih = 2;
      const horizontal = rng.chance(0.5);
      const w = horizontal ? iw : ih;
      const h = horizontal ? ih : iw;
      const x0 = rng.range(3, W - w - 4);
      const y0 = rng.range(3, H - h - 4);
      // the walled rectangle (interior grown by 1) must sit on plain open ground; any mine under it is simply built over
      let ok = true;
      for (let y = y0 - 1; y <= y0 + h && ok; y++)
        for (let x = x0 - 1; x <= x0 + w; x++) {
          if ((grid[y]![x] !== '.' && grid[y]![x] !== 'm') || g.zone[y * W + x] !== 'out') {
            ok = false;
            break;
          }
        }
      if (!ok) continue;
      const mid = { x: x0 + w / 2, y: y0 + h / 2 };
      if (Math.max(Math.abs(mid.x - g.start.x), Math.abs(mid.y - g.start.y)) < minDist) continue;
      if (Math.max(Math.abs(mid.x - g.exit.x), Math.abs(mid.y - g.exit.y)) < minDist) continue;
      if (g.doorCells.some((d) => cheb(d, { x: Math.round(mid.x), y: Math.round(mid.y) }) < minDist - 1)) continue;
      // door on a random side, away from the corners
      const side = rng.int(4);
      const door: Pos =
        side === 0 ? { x: x0 + rng.int(w), y: y0 - 1 } :
        side === 1 ? { x: x0 + w, y: y0 + rng.int(h) } :
        side === 2 ? { x: x0 + rng.int(w), y: y0 + h } :
        { x: x0 - 1, y: y0 + rng.int(h) };
      const approach: Pos = { x: door.x + (side === 1 ? 1 : side === 3 ? -1 : 0), y: door.y + (side === 2 ? 1 : side === 0 ? -1 : 0) };
      if (grid[approach.y]![approach.x] !== '.' || g.zone[approach.y * W + approach.x] !== 'out') continue;
      const saved = grid.map((r) => [...r]);
      const interior: Pos[] = [];
      for (let y = y0 - 1; y <= y0 + h; y++)
        for (let x = x0 - 1; x <= x0 + w; x++) {
          const edge = x < x0 || x >= x0 + w || y < y0 || y >= y0 + h;
          if (edge) grid[y]![x] = '#';
          else {
            grid[y]![x] = '.'; // a mine that happened to sit here is cleared away
            interior.push({ x, y });
          }
        }
      // walling the room must not squeeze a mine into a one-tile corridor (the no-chokepoint-mines rule)
      const openAt = (x: number, y: number): boolean => grid[y]?.[x] !== undefined && grid[y]![x] !== '#';
      let plugged = false;
      for (let y = y0 - 3; y <= y0 + h + 2 && !plugged; y++)
        for (let x = x0 - 3; x <= x0 + w + 2; x++) {
          if (grid[y]?.[x] !== 'm') continue;
          const horiz = openAt(x - 1, y) && openAt(x + 1, y) && !openAt(x, y - 1) && !openAt(x, y + 1);
          const vert = openAt(x, y - 1) && openAt(x, y + 1) && !openAt(x - 1, y) && !openAt(x + 1, y);
          if (horiz || vert) {
            plugged = true;
            break;
          }
        }
      if (plugged || !validates()) {
        for (let y = 0; y < H; y++) grid[y] = saved[y]!;
        continue;
      }
      // the approach tile must be somewhere a player can actually stand and reach, which validation proved
      const room = nextRoom + n;
      for (let y = y0 - 1; y <= y0 + h; y++)
        for (let x = x0 - 1; x <= x0 + w; x++) {
          g.zone[y * W + x] = 'in';
          g.roomId[y * W + x] = room;
        }
      const lvl = rng.range(P.vaultLevel[0], P.vaultLevel[1]);
      const kind: VaultKind = rng.chance(0.5) ? 'lock' : 'terminal';
      const flavour = rng.pick(['store', 'pantry', 'cache'] as const);
      const piles = rng.shuffle([...interior]).slice(0, Math.min(interior.length, 3));
      const amount = P.lootAmount + 1 + (lvl >= 4 ? 1 : 0);
      const loot = piles.map((pos, i) => ({
        pos,
        pickup: (flavour === 'pantry' ? 'food' : flavour === 'cache' ? 'scrap' : i % 2 === 0 ? 'materials' : 'scrap') as PickupId,
        amount,
      }));
      out.push({ vault: { id: n, kind, level: lvl, seed: rng.int(1_000_000) + 1, door, interior, status: 'sealed' }, loot });
      break;
    }
  }
  return out;
}

/** Turn the planned vault doors into doors and drop the loot inside (after parsing, so the solver never saw it). */
function applyVaults(data: LevelData, vaults: PlacedVault[]): void {
  for (const { vault, loot } of vaults) {
    const d = data.cells[vault.door.y * data.width + vault.door.x]!;
    d.terrain = 'floor';
    d.object = 'vaultDoor';
    for (const l of loot) {
      const c = data.cells[l.pos.y * data.width + l.pos.x]!;
      c.pickup = l.pickup;
      c.pickupAmount = l.amount;
    }
  }
}

/** SWAT zombies pace straight runs of open ground outside the buildings, away from the start. */
function addPatrols(P: DifficultyParams, g: Built, rng: Rng): void {
  const { grid, W, H } = g;
  const free = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && grid[y]![x] === '.' && g.zone[y * W + x] === 'out';
  const runs: { a: Pos; b: Pos }[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        let n = 0;
        while (free(x + dx * n, y + dy * n)) n++;
        // take the whole run only if it is a proper beat (5-9 tiles); trim long ones
        if (n >= 5) runs.push({ a: { x, y }, b: { x: x + dx * (Math.min(n, 9) - 1), y: y + dy * (Math.min(n, 9) - 1) } });
      }
    }
  rng.shuffle(runs);
  for (const r of runs) {
    if (g.patrols.length >= P.patrols) break;
    if (cheb(r.a, g.start) < 7 && cheb(r.b, g.start) < 7) continue;
    if (g.doorCells.some((d) => cheb(d, r.a) <= 2 || cheb(d, r.b) <= 2)) continue;
    if (g.patrols.some((p) => cheb(p.route[0]!, r.a) < 8)) continue;
    g.patrols.push({ route: [r.a, r.b], speed: 2 });
  }
}

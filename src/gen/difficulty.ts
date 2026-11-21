export type Difficulty = 'safe' | 'scouting' | 'risky';

/** Obstacle kinds a doorway / gap can be sealed with (ascii characters, see levels/parse.ts). */
export type GateChar = 'z' | 'D' | 'b' | 'X';

export interface DifficultyParams {
  id: Difficulty;
  label: string;
  blurb: string;
  width: number;
  height: number;

  // ── layout: an open wasteland with buildings standing in it ──
  /** Number of buildings dotted around the outside. */
  buildings: number;
  /** Outer size of a building, walls included. */
  buildingW: [number, number];
  buildingH: [number, number];
  /** Rooms per building (1 = a single open room, more = partition walls with doorways). */
  rooms: [number, number];
  /** How many buildings (nearest the start) have a plain open doorway. */
  freeBuildings: number;
  /** Chance a building gets a second entrance on another side. */
  altEntrance: number;
  /** A ruined fence splits the wasteland in two; the only gap is gated and the exit lies beyond it. */
  roadblock: boolean;
  /** Small rubble piles scattered through the open ground. */
  rubble: number;

  // ── hazards ──
  /** Target share of OPEN-GROUND floor covered by mines (the solver may thin this to stay guess-free). */
  density: number;
  /** Same, for building interiors. */
  indoorDensity: number;
  /** Minimum share of the target that must survive the guess-free repair, or the map is rejected. */
  minDensityKept: number;
  /** How many doorways get sealed, and which kinds are drawn from (cycled, so kinds don't repeat early). */
  gates: number;
  gatePool: GateChar[];
  patrols: number;

  // ── supplies ──
  medkits: number;
  shields: number;
  maps: number;
  spareAmmo: number;
  /** Number of scrap / food / materials piles lying around (about two thirds end up inside buildings). */
  loot: number;
  /** How much each pile is worth - harder expeditions pay out more. */
  lootAmount: number;
  /** Stranded survivors waiting inside the buildings. */
  survivors: number;
  /** Optional sealed vault rooms (lock / terminal minigame): this many for sure, plus a chance of one more. */
  vaults: number;
  vaultExtra: number;
  /** Minigame difficulty range for this tier. */
  vaultLevel: [number, number];
}

export const DIFFICULTIES: Record<Difficulty, DifficultyParams> = {
  safe: {
    id: 'safe', label: 'Safe', blurb: 'A small yard and one house. Sealed by a single obstacle.',
    width: 22, height: 16,
    buildings: 1, buildingW: [8, 9], buildingH: [6, 7], rooms: [1, 1], freeBuildings: 0, altEntrance: 0,
    roadblock: false, rubble: 4,
    density: 0.07, indoorDensity: 0.04, minDensityKept: 0.5,
    gates: 1, gatePool: ['b', 'z'], patrols: 0,
    medkits: 2, shields: 1, maps: 1, spareAmmo: 1, loot: 6, lootAmount: 1, survivors: 0, vaults: 0, vaultExtra: 0.8, vaultLevel: [1, 2],
  },
  scouting: {
    id: 'scouting', label: 'Scouting', blurb: 'A bigger yard, a fence with one way through, two houses with a few rooms.',
    width: 34, height: 24,
    buildings: 2, buildingW: [9, 12], buildingH: [7, 9], rooms: [2, 3], freeBuildings: 1, altEntrance: 0.3,
    roadblock: true, rubble: 9,
    density: 0.085, indoorDensity: 0.055, minDensityKept: 0.5,
    gates: 4, gatePool: ['z', 'D', 'b', 'X'], patrols: 1,
    medkits: 2, shields: 1, maps: 1, spareAmmo: 1, loot: 12, lootAmount: 2, survivors: 1, vaults: 1, vaultExtra: 0.35, vaultLevel: [2, 4],
  },
  risky: {
    id: 'risky', label: 'Risky', blurb: 'A sprawling wasteland, four buildings with many rooms, two SWAT patrols.',
    width: 48, height: 32,
    buildings: 4, buildingW: [9, 13], buildingH: [7, 10], rooms: [3, 5], freeBuildings: 1, altEntrance: 0.4,
    roadblock: true, rubble: 16,
    density: 0.09, indoorDensity: 0.06, minDensityKept: 0.5,
    gates: 7, gatePool: ['z', 'D', 'b', 'X'], patrols: 2,
    medkits: 3, shields: 2, maps: 2, spareAmmo: 1, loot: 24, lootAmount: 3, survivors: 2, vaults: 2, vaultExtra: 0.35, vaultLevel: [4, 6],
  },
};

export type Region = 'wasteland' | 'forest' | 'industrial';

export interface RegionParams {
  id: Region;
  label: string;
  blurb: string;
  /** Multipliers on rubble piles and loot piles, applied on top of the difficulty. */
  rubbleMul: number;
  lootMul: number;
  /** Ground look: noise below `grass` is grass, above `dark` is dark ground, the rest is dirt. */
  grass: number;
  dark: number;
}

export const REGIONS: Record<Region, RegionParams> = {
  wasteland: { id: 'wasteland', label: 'Wasteland', blurb: 'Cracked dirt and ruined houses.', rubbleMul: 1, lootMul: 1, grass: 0.3, dark: 0.8 },
  forest: { id: 'forest', label: 'Overgrown suburbs', blurb: 'Grass has taken over. Fewer piles of junk, less loot.', rubbleMul: 0.5, lootMul: 0.8, grass: 0.72, dark: 0.97 },
  industrial: { id: 'industrial', label: 'Industrial yard', blurb: 'Scorched ground and heaps of scrap. More junk, more loot.', rubbleMul: 1.2, lootMul: 1.25, grass: 0.06, dark: 0.45 },
};

export function withRegion(p: DifficultyParams, region: Region): DifficultyParams {
  const r = REGIONS[region];
  return { ...p, rubble: Math.max(1, Math.round(p.rubble * r.rubbleMul)), loot: Math.max(2, Math.round(p.loot * r.lootMul)) };
}

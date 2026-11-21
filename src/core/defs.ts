import type { InventoryKey, LootKey, ObjectId, PickupId } from './types.js';

/**
 * Data-driven definitions. To add a new obstacle or pickup, add an entry here
 * (and a sprite name in assets/manifest.json) rather than editing game logic.
 */

export interface ObjectDef {
  id: ObjectId;
  /** 'always' = drawn even under fog (walls, doors, barricades). 'revealed' = only once its cell is revealed. */
  visibility: 'always' | 'revealed';
  /** Blocks movement (once visible/known). */
  blocks: boolean;
  /** Contributes to the Minesweeper clue numbers. */
  countsForClues: boolean;
  /** Flood-reveal continues through this cell when its clue is 0. */
  floodThrough: boolean;
  /** Removed automatically when the player walks up to it holding this inventory item. */
  openedBy?: InventoryKey;
  /** Removed (or disarmed) by a bomb blast. */
  bombable: boolean;
  /** A solid structure: you can't squeeze diagonally past its corner (like a wall). */
  solid?: boolean;
}

export const OBJECTS: Record<ObjectId, ObjectDef> = {
  mine: {
    id: 'mine',
    visibility: 'revealed',
    blocks: true,
    countsForClues: true,
    floodThrough: false,
    bombable: true,
  },
  zombie: {
    id: 'zombie',
    visibility: 'revealed',
    blocks: true,
    countsForClues: false,
    floodThrough: false,
    openedBy: 'ammo',
    bombable: true,
  },
  barricade: {
    id: 'barricade',
    visibility: 'always',
    blocks: true,
    countsForClues: false,
    floodThrough: false,
    openedBy: 'crowbar',
    bombable: true,
    solid: true,
  },
  door: {
    id: 'door',
    visibility: 'always',
    blocks: true,
    countsForClues: false,
    floodThrough: false,
    openedBy: 'key',
    bombable: false,
    solid: true,
  },
  crackedWall: {
    id: 'crackedWall',
    visibility: 'always',
    blocks: true,
    countsForClues: false,
    floodThrough: false,
    bombable: true,
    solid: true,
  },
  vaultDoor: {
    id: 'vaultDoor',
    visibility: 'always',
    blocks: true,
    countsForClues: false,
    floodThrough: false,
    bombable: false,
    solid: true,
  },
  exit: {
    id: 'exit',
    visibility: 'revealed',
    blocks: false,
    countsForClues: false,
    floodThrough: true,
    bombable: false,
  },
};

export type PickupKind =
  | { kind: 'loot'; key: LootKey }
  | { kind: 'inventory'; key: InventoryKey }
  | { kind: 'shield' }
  | { kind: 'heal' }
  | { kind: 'survivor' };

export const PICKUPS: Record<PickupId, PickupKind> = {
  scrap: { kind: 'loot', key: 'scrap' },
  food: { kind: 'loot', key: 'food' },
  materials: { kind: 'loot', key: 'materials' },
  ammo: { kind: 'inventory', key: 'ammo' },
  key: { kind: 'inventory', key: 'key' },
  crowbar: { kind: 'inventory', key: 'crowbar' },
  explosive: { kind: 'inventory', key: 'explosive' },
  map: { kind: 'inventory', key: 'map' },
  shield: { kind: 'shield' },
  medkit: { kind: 'heal' },
  survivor: { kind: 'survivor' },
};

/** Items the player can aim at an area (3x3 around themselves) before confirming. */
export type AreaItem = 'explosive' | 'map';

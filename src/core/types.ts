export interface Pos {
  x: number;
  y: number;
}

export type Terrain = 'floor' | 'wall';

/** Things that occupy a cell. See defs.ts for behaviour. */
export type ObjectId = 'mine' | 'zombie' | 'barricade' | 'door' | 'crackedWall' | 'exit' | 'vaultDoor';

/** Things lying on a cell that the player picks up by walking over them. */
export type PickupId =
  | 'scrap'
  | 'food'
  | 'materials'
  | 'ammo'
  | 'key'
  | 'crowbar'
  | 'explosive'
  | 'shield'
  | 'medkit'
  | 'map'
  | 'survivor';

export type InventoryKey = 'ammo' | 'key' | 'crowbar' | 'explosive' | 'map';
export type LootKey = 'scrap' | 'food' | 'materials';

export interface Cell {
  terrain: Terrain;
  object: ObjectId | null;
  pickup: PickupId | null;
  pickupAmount: number;
  /** Fog of war: false = still covered by dirt. */
  revealed: boolean;
  /** Player-placed flag. */
  flagged: boolean;
  /** A mine that has already gone off (or been safely detonated): known and harmless. */
  triggered: boolean;
  /** Static Minesweeper clue: number of clue-hazards in the 8 surrounding cells. */
  clue: number;
}

export type Facing = 'up' | 'down' | 'left' | 'right';

export interface Patrol {
  id: number;
  /** Waypoints in cell coordinates. The zombie ping-pongs between them. */
  route: Pos[];
  speed: number;
  /** Current position in (fractional) cell coordinates. */
  x: number;
  y: number;
  target: number;
  direction: 1 | -1;
  alive: boolean;
}

export type LevelStatus = 'playing' | 'won' | 'failed';

export type DamageSource = 'mine' | 'zombie' | 'swat';

export type GameEvent =
  | { type: 'damage'; source: DamageSource; amount: number; absorbed: boolean; at: Pos }
  | { type: 'pickup'; id: PickupId; amount: number; at: Pos }
  | { type: 'mineTriggered'; at: Pos }
  | { type: 'zombieKilled'; at: Pos }
  | { type: 'swatKilled'; at: Pos }
  | { type: 'obstacleRemoved'; object: ObjectId; at: Pos }
  | { type: 'explosion'; at: Pos; radius: number }
  | { type: 'mapUsed'; at: Pos; radius: number }
  | { type: 'revealed'; cells: Pos[] }
  | { type: 'minigame'; vault: number }
  | { type: 'vaultOpened'; vault: number; at: Pos }
  | { type: 'vaultLocked'; vault: number; at: Pos }
  | { type: 'message'; key: MessageKey }
  | { type: 'won' }
  | { type: 'failed' };

export type MessageKey =
  | 'needAmmo'
  | 'needKey'
  | 'needCrowbar'
  | 'needExplosive'
  | 'noPath'
  | 'knownHazard'
  | 'flagged'
  | 'noneLeft'
  | 'vaultLocked';

/** An optional sealed room: open its lock or terminal (a minigame) to get at the loot inside. */
export type VaultKind = 'lock' | 'terminal';
export type VaultStatus = 'sealed' | 'open' | 'lockedOut';

export interface Vault {
  id: number;
  kind: VaultKind;
  /** Minigame difficulty, 1 (easy) .. 6 (lock) / 7 (terminal). */
  level: number;
  seed: number;
  door: Pos;
  interior: Pos[];
  status: VaultStatus;
}

export interface Results {
  status: LevelStatus;
  timeSeconds: number;
  loot: Record<LootKey, number>;
  heartsLeft: number;
  /** Survivors rescued this run (they only join the safehouse if the player escapes). */
  rescued: number;
  /** Carried supplies left over at the end of the run. */
  kit: Kit;
}

/** Consumable supplies carried between the safehouse and an expedition. */
export interface Kit {
  ammo: number;
  explosive: number;
  map: number;
  shield: number;
}

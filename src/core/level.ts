import { CONFIG } from './config.js';
import { OBJECTS, PICKUPS, type AreaItem } from './defs.js';
import { findPath } from './pathfind.js';
import type {
  Kit,
  Vault,
  Cell,
  DamageSource,
  Facing,
  GameEvent,
  InventoryKey,
  LevelStatus,
  LootKey,
  MessageKey,
  ObjectId,
  Patrol,
  PickupId,
  Pos,
  Results,
} from './types.js';

export interface LevelData {
  name: string;
  width: number;
  height: number;
  cells: Cell[];
  start: Pos;
  patrols: { route: Pos[]; speed?: number }[];
  /**
   * Optional cosmetic layer (one entry per cell): 'out' open wasteland, 'in' building interior,
   * 'ruin' rubble / junk blocking the open ground, 'fence' the barrier line. Never read by the game rules, only by the renderer.
   */
  zones?: Zone[];
  /** Optional cosmetic layer: room number for 'in' cells (0 elsewhere), so each room can get its own floor. */
  roomIds?: number[];
  /** Cosmetic: which region this map is in (ground look). */
  region?: string;
  /** Optional sealed rooms with a lock / terminal minigame on the door. */
  vaults?: Vault[];
}

export type Zone = 'out' | 'in' | 'ruin' | 'fence';

export interface PendingUse {
  item: AreaItem;
  /** Cells that will be affected (in-bounds part of the 3x3 around the player). */
  cells: Pos[];
}

type Intent = { kind: 'interact'; target: Pos } | null;

const NEIGHBOURS_8: Pos[] = [
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
  { x: -1, y: 0 }, { x: 1, y: 0 },
  { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 },
];
const NEIGHBOURS_4: Pos[] = [
  { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
];

/** Compute the static Minesweeper clue numbers for a cell grid (mutates `clue`). */
export function computeClues(width: number, height: number, cells: Cell[]): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (const d of NEIGHBOURS_8) {
        const nx = x + d.x;
        const ny = y + d.y;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const o = cells[ny * width + nx]!.object;
        if (o && OBJECTS[o].countsForClues) n++;
      }
      cells[y * width + x]!.clue = n;
    }
  }
}

export class Level {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly cells: Cell[];
  readonly zones: Zone[] | null;
  readonly roomIds: number[] | null;
  readonly region: string;
  readonly vaults: Vault[];
  /** The vault whose minigame is open right now (the game is paused while it is). */
  minigame: Vault | null = null;

  player: Pos;
  facing: Facing = 'down';
  hearts: number = CONFIG.startHearts;
  shield = 0;
  inventory: Record<InventoryKey, number> = { ammo: 0, key: 0, crowbar: 0, explosive: 0, map: 0 };
  loot: Record<LootKey, number> = { scrap: 0, food: 0, materials: 0 };
  rescued = 0;
  patrols: Patrol[] = [];
  status: LevelStatus = 'playing';
  time = 0;
  pending: PendingUse | null = null;

  private events: GameEvent[] = [];
  private path: Pos[] = [];
  private stepProgress = 0;
  private intent: Intent = null;
  private goal: Pos | null = null;
  private swatCooldown = 0;

  constructor(data: LevelData, loadout?: Partial<Kit> & { hearts?: number }) {
    this.name = data.name;
    this.width = data.width;
    this.height = data.height;
    this.cells = data.cells.map((c) => ({ ...c }));
    this.zones = data.zones ?? null;
    this.roomIds = data.roomIds ?? null;
    this.region = data.region ?? 'wasteland';
    this.vaults = (data.vaults ?? []).map((v) => ({ ...v, door: { ...v.door }, interior: v.interior.map((p) => ({ ...p })) }));
    computeClues(this.width, this.height, this.cells);
    this.player = { ...data.start };
    if (loadout) {
      this.inventory.ammo = loadout.ammo ?? 0;
      this.inventory.explosive = loadout.explosive ?? 0;
      this.inventory.map = loadout.map ?? 0;
      this.shield = Math.min(CONFIG.maxShield, loadout.shield ?? 0);
      if (loadout.hearts) this.hearts = Math.min(CONFIG.maxHearts, loadout.hearts);
    }
    data.patrols.forEach((p, i) => {
      const first = p.route[0]!;
      this.patrols.push({
        id: i,
        route: p.route.map((r) => ({ ...r })),
        speed: p.speed ?? CONFIG.swatSpeed,
        x: first.x,
        y: first.y,
        target: p.route.length > 1 ? 1 : 0,
        direction: 1,
        alive: true,
      });
    });
    this.reveal(this.player.x, this.player.y);
    this.collectPickup(this.player.x, this.player.y);
  }

  // ───────────────────────── queries ─────────────────────────

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  cell(x: number, y: number): Cell {
    return this.cells[y * this.width + x]!;
  }

  /** Is the object on this cell currently visible to the player? */
  objectVisible(c: Cell): boolean {
    if (!c.object) return false;
    return OBJECTS[c.object].visibility === 'always' || c.revealed;
  }

  isMoving(): boolean {
    return this.path.length > 0;
  }

  /** Cells the player is about to walk through (for drawing the destination marker). */
  pathPreview(): Pos[] {
    return this.path.map((p) => ({ ...p }));
  }

  /** Smooth position for rendering (fractional cell coordinates). */
  playerRenderPos(): Pos {
    const next = this.path[0];
    if (!next) return { x: this.player.x, y: this.player.y };
    return {
      x: this.player.x + (next.x - this.player.x) * this.stepProgress,
      y: this.player.y + (next.y - this.player.y) * this.stepProgress,
    };
  }

  /** Is this patrol standing on a revealed cell (so the player can see it)? */
  patrolVisible(p: Patrol): boolean {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    return this.inBounds(x, y) && this.cell(x, y).revealed;
  }

  /**
   * Cells the pathfinder refuses to walk through: walls, flags and anything the
   * player can currently *see* that is dangerous or in the way. Hidden hazards
   * under fog are, by design, not avoided.
   */
  knownBlocked(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true;
    const c = this.cell(x, y);
    if (c.terrain === 'wall') return true;
    if (c.flagged) return true;
    if (c.object && this.objectVisible(c)) {
      if (c.object === 'mine' && c.triggered) return false;
      return OBJECTS[c.object].blocks;
    }
    return false;
  }

  results(): Results {
    return { status: this.status, timeSeconds: this.time, loot: { ...this.loot },
      heartsLeft: this.hearts,
      rescued: this.rescued,
      kit: { ammo: this.inventory.ammo, explosive: this.inventory.explosive, map: this.inventory.map, shield: this.shield },
    };
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ───────────────────────── player commands ─────────────────────────

  /** Player tapped a grid cell. */
  tap(x: number, y: number): void {
    if (this.status !== 'playing') return;
    if (this.pending) {
      const inside = this.pending.cells.some((c) => c.x === x && c.y === y);
      if (inside) this.confirmUse();
      else this.cancelUse();
      return;
    }
    if (!this.inBounds(x, y)) return;
    const c = this.cell(x, y);
    if (c.terrain === 'wall') return;
    if (c.flagged) {
      this.say('flagged');
      return;
    }

    if (c.object && this.objectVisible(c)) {
      const def = OBJECTS[c.object];
      if (def.openedBy) {
        if (this.inventory[def.openedBy] <= 0) {
          this.say(def.openedBy === 'ammo' ? 'needAmmo' : def.openedBy === 'key' ? 'needKey' : 'needCrowbar');
          return;
        }
        this.goTo(null, { kind: 'interact', target: { x, y } });
        return;
      }
      if (c.object === 'vaultDoor') {
        const v = this.vaultAt(x, y);
        if (v?.status === 'lockedOut') this.say('vaultLocked');
        else this.goTo(null, { kind: 'interact', target: { x, y } });
        return;
      }
      if (c.object === 'crackedWall') {
        this.say('needExplosive');
        return;
      }
      if (def.blocks && !(c.object === 'mine' && c.triggered)) {
        this.say('knownHazard');
        return;
      }
    }
    this.goTo({ x, y }, null);
  }

  /** Place or remove a flag on a fogged cell. */
  toggleFlag(x: number, y: number): void {
    if (this.status !== 'playing' || !this.inBounds(x, y)) return;
    const c = this.cell(x, y);
    if (c.terrain === 'wall' || c.revealed) return;
    if (c.object && OBJECTS[c.object].visibility === 'always') return;
    c.flagged = !c.flagged;
  }

  /**
   * Press an area item (explosive / map). First press previews the 3x3 area
   * around the player, pressing the same item again confirms it.
   */
  pressItem(item: AreaItem): void {
    if (this.status !== 'playing') return;
    if (this.pending?.item === item) {
      this.confirmUse();
      return;
    }
    if (this.inventory[item] <= 0) {
      this.say('noneLeft');
      return;
    }
    const radius = item === 'explosive' ? CONFIG.bombRadius : CONFIG.mapRadius;
    this.pending = { item, cells: this.area(this.player, radius) };
  }

  cancelUse(): void {
    this.pending = null;
  }

  confirmUse(): void {
    const p = this.pending;
    if (!p || this.status !== 'playing') return;
    this.pending = null;
    if (this.inventory[p.item] <= 0) return;
    this.inventory[p.item]--;
    if (p.item === 'explosive') this.detonate(p.cells);
    else this.useMap(p.cells);
  }

  // ───────────────────────── simulation ─────────────────────────

  update(dt: number): void {
    if (this.status !== 'playing' || this.minigame) return;
    this.time += dt;
    this.swatCooldown = Math.max(0, this.swatCooldown - dt);
    this.updatePatrols(dt);
    this.checkSwatContact();
    this.advanceMovement(dt);
    this.checkSwatContact();
  }

  private updatePatrols(dt: number): void {
    for (const p of this.patrols) {
      if (!p.alive || p.route.length < 2) continue;
      let remaining = p.speed * dt;
      while (remaining > 1e-9) {
        const t = p.route[p.target]!;
        const dx = t.x - p.x;
        const dy = t.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= remaining) {
          p.x = t.x;
          p.y = t.y;
          remaining -= dist;
          let next = p.target + p.direction;
          if (next < 0 || next >= p.route.length) {
            p.direction = (p.direction * -1) as 1 | -1;
            next = p.target + p.direction;
          }
          p.target = next;
        } else {
          p.x += (dx / dist) * remaining;
          p.y += (dy / dist) * remaining;
          remaining = 0;
        }
      }
    }
  }

  private checkSwatContact(): void {
    if (this.swatCooldown > 0 || this.status !== 'playing') return;
    const pp = this.playerRenderPos();
    for (const p of this.patrols) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - pp.x, p.y - pp.y) < CONFIG.swatContactRadius) {
        this.swatCooldown = CONFIG.swatContactCooldown;
        this.hurt('swat', CONFIG.damage.swat, { x: Math.round(p.x), y: Math.round(p.y) });
        return;
      }
    }
  }

  /** Length of the step from the player's cell to `to` (diagonals are longer, so they take longer). */
  private stepLength(to: Pos): number {
    return Math.hypot(to.x - this.player.x, to.y - this.player.y) || 1;
  }

  private advanceMovement(dt: number): void {
    if (this.path.length === 0) return;
    this.faceTowards(this.path[0]!);
    this.stepProgress += (dt * CONFIG.playerSpeed) / this.stepLength(this.path[0]!);
    while (this.stepProgress >= 1 && this.path.length > 0 && this.status === 'playing') {
      const oldLen = this.stepLength(this.path[0]!);
      const leftover = this.stepProgress - 1;
      this.stepProgress = 0;
      const next = this.path.shift()!;
      this.arrive(next);
      if (this.path.length > 0) {
        this.validateNextStep();
        if (this.path.length > 0) {
          this.faceTowards(this.path[0]!);
          this.stepProgress = (leftover * oldLen) / this.stepLength(this.path[0]!);
        }
      }
    }
    if (this.path.length === 0) {
      this.stepProgress = 0;
      this.finishMove();
    }
  }

  /** Called when the player's step into `next` completes. */
  private arrive(next: Pos): void {
    const c = this.cell(next.x, next.y);

    // Blind step into a hidden zombie: take the hit, reveal it, stay where we are.
    if (c.object === 'zombie') {
      this.reveal(next.x, next.y);
      this.stopMoving();
      this.hurt('zombie', CONFIG.damage.zombie, next);
      return;
    }

    // Blind step onto a hidden mine: it goes off, the player ends up on the (now harmless) tile.
    if (c.object === 'mine' && !c.triggered) {
      this.player = { x: next.x, y: next.y };
      c.triggered = true;
      c.revealed = true;
      c.flagged = false;
      this.events.push({ type: 'mineTriggered', at: next });
      this.stopMoving();
      this.hurt('mine', CONFIG.damage.mine, next);
      return;
    }

    this.player = { x: next.x, y: next.y };
    this.reveal(next.x, next.y);
    this.collectPickup(next.x, next.y);
    if (c.object === 'exit' && this.status === 'playing') {
      this.status = 'won';
      this.stopMoving();
      this.events.push({ type: 'won' });
    }
  }

  private finishMove(): void {
    const intent = this.intent;
    this.intent = null;
    this.goal = null;
    if (intent && this.status === 'playing') this.performIntent(intent);
  }

  private performIntent(intent: NonNullable<Intent>): void {
    const { x, y } = intent.target;
    // Must be standing next to the target (diagonals count).
    if (Math.max(Math.abs(this.player.x - x), Math.abs(this.player.y - y)) !== 1) return;
    if (!this.canStep(this.player.x, this.player.y, x, y)) return;
    const c = this.cell(x, y);
    if (!c.object) return;
    if (c.object === 'vaultDoor') {
      const v = this.vaultAt(x, y);
      if (v && v.status === 'sealed') {
        this.minigame = v;
        this.stopMoving();
        this.events.push({ type: 'minigame', vault: v.id });
      }
      return;
    }
    const def = OBJECTS[c.object];
    if (!def.openedBy || this.inventory[def.openedBy] <= 0) return;
    this.inventory[def.openedBy]--;
    const removed = c.object;
    c.object = null;
    this.events.push(
      removed === 'zombie'
        ? { type: 'zombieKilled', at: { x, y } }
        : { type: 'obstacleRemoved', object: removed, at: { x, y } },
    );
    this.reveal(x, y); // opens up whatever lay behind it
  }

  vaultAt(x: number, y: number): Vault | undefined {
    return this.vaults.find((v) => v.door.x === x && v.door.y === y);
  }

  /** Close the open minigame. Success opens the vault; failure locks it for good; 'ignored' leaves it as it was. */
  resolveMinigame(outcome: 'success' | 'failed' | 'ignored'): void {
    const v = this.minigame;
    this.minigame = null;
    if (!v || outcome === 'ignored') return;
    if (outcome === 'failed') {
      v.status = 'lockedOut';
      this.events.push({ type: 'vaultLocked', vault: v.id, at: { ...v.door } });
      return;
    }
    v.status = 'open';
    const d = this.cell(v.door.x, v.door.y);
    d.object = null;
    this.events.push({ type: 'vaultOpened', vault: v.id, at: { ...v.door } });
    const out: Pos[] = [{ ...v.door }, ...v.interior];
    for (const p of out) this.cell(p.x, p.y).revealed = true;
    this.events.push({ type: 'revealed', cells: out });
  }

  // ───────────────────────── movement planning ─────────────────────────

  private goTo(target: Pos | null, intent: Intent): void {
    // If mid-step, finish that step first and plan from where we will be.
    const origin = this.path.length > 0 ? this.path[0]! : this.player;
    const passable = (x: number, y: number) => !this.knownBlocked(x, y);
    const step = (fx: number, fy: number, tx: number, ty: number) => this.canStep(fx, fy, tx, ty);
    const W = this.width;
    const H = this.height;

    // Rule for every tap: prefer a route made only of tiles we already know are safe (revealed and not a
    // known hazard). Only if no such route exists do we fall back to cutting through the fog.
    const known = (x: number, y: number) => this.cell(x, y).revealed && passable(x, y);
    let route: Pos[] | null = null;
    if (intent) {
      const t = intent.target;
      const beside = (ok: (x: number, y: number) => boolean) => (x: number, y: number) =>
        Math.max(Math.abs(x - t.x), Math.abs(y - t.y)) === 1 && ok(x, y) && this.canStep(x, y, t.x, t.y);
      route =
        findPath(W, H, origin, beside(known), known, step) ??
        findPath(W, H, origin, beside(passable), passable, step);
    } else {
      const t = target!;
      if (!this.cell(t.x, t.y).revealed) {
        // Hidden target: walk known-safe tiles to the nearest known tile beside it, then make the final
        // step onto it (a hidden tile within one square is simply stepped onto).
        // (Diagonally adjacent across a wall corner doesn't count as "within one": that step is illegal,
        // and the fallback route would cut through a different, possibly mined, fogged tile.)
        const adjacent = Math.max(Math.abs(t.x - origin.x), Math.abs(t.y - origin.y)) <= 1;
        if (!adjacent || !this.canStep(origin.x, origin.y, t.x, t.y)) {
          const approach = findPath(
            W,
            H,
            origin,
            (x, y) =>
              Math.max(Math.abs(x - t.x), Math.abs(y - t.y)) === 1 && known(x, y) && this.canStep(x, y, t.x, t.y),
            known,
            step,
          );
          if (approach) route = [...approach, { x: t.x, y: t.y }];
        }
      } else {
        route = findPath(W, H, origin, (x, y) => x === t.x && y === t.y, known, step);
      }
      route ??= findPath(W, H, origin, (x, y) => x === t.x && y === t.y, passable, step);
    }
    if (route === null) {
      this.say('noPath');
      return;
    }
    const midStep = this.path.length > 0;
    this.path = midStep ? [origin, ...route] : route;
    if (!midStep) this.stepProgress = 0;
    this.intent = intent;
    this.goal = target;
    if (this.path.length === 0) this.finishMove();
  }

  /** Diagonal moves may not cut the corner of a wall or other solid structure. */
  private canStep(fx: number, fy: number, tx: number, ty: number): boolean {
    if (fx === tx || fy === ty) return true;
    return !this.solidAt(tx, fy) && !this.solidAt(fx, ty);
  }

  private solidAt(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true;
    const c = this.cell(x, y);
    if (c.terrain === 'wall') return true;
    return c.object !== null && OBJECTS[c.object].solid === true;
  }

  /** Before each step: if something newly seen blocks the way, re-plan or stop. */
  private validateNextStep(): void {
    const next = this.path[0];
    if (!next || !this.knownBlocked(next.x, next.y)) return;
    const intent = this.intent;
    const goal = this.goal;
    this.path = [];
    this.stepProgress = 0;
    if (intent || goal) {
      this.goTo(goal, intent);
    }
  }

  private stopMoving(): void {
    this.path = [];
    this.stepProgress = 0;
    this.intent = null;
    this.goal = null;
  }

  private faceTowards(to: Pos): void {
    const dx = to.x - this.player.x;
    const dy = to.y - this.player.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx !== 0) this.facing = dx > 0 ? 'right' : 'left';
    } else {
      this.facing = dy > 0 ? 'down' : 'up';
    }
  }

  // ───────────────────────── fog of war ─────────────────────────

  /**
   * Minesweeper-style reveal around the avatar. Reveals (x,y); if a tile has no neighbouring mines the
   * reveal opens up outwards and uncovers the numbered border - but only within CONFIG.fogRadius tiles
   * of the player, so the fog only ever clears near the avatar. Already-revealed empty tiles are
   * walked through, so approaching a half-opened area keeps opening it.
   */
  private reveal(x: number, y: number): Pos[] {
    const R = CONFIG.fogRadius;
    const out: Pos[] = [];
    const stack: Pos[] = [{ x, y }];
    const seen = new Set<number>();
    while (stack.length) {
      const p = stack.pop()!;
      const key = p.y * this.width + p.x;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = this.cell(p.x, p.y);
      if (c.terrain === 'wall') continue;
      if (!c.revealed) {
        c.revealed = true;
        c.flagged = false;
        out.push(p);
      }
      const spreads =
        c.clue === 0 && c.object !== 'mine' && (c.object === null || OBJECTS[c.object].floodThrough);
      if (!spreads) continue;
      for (const d of NEIGHBOURS_8) {
        const nx = p.x + d.x;
        const ny = p.y + d.y;
        if (!this.inBounds(nx, ny)) continue;
        if (Math.max(Math.abs(nx - this.player.x), Math.abs(ny - this.player.y)) > R) continue;
        if (this.cell(nx, ny).terrain === 'wall') continue;
        stack.push({ x: nx, y: ny });
      }
    }
    if (out.length) this.events.push({ type: 'revealed', cells: out });
    return out;
  }

  // ───────────────────────── items, tools, hazards ─────────────────────────

  private collectPickup(x: number, y: number): void {
    const c = this.cell(x, y);
    if (!c.pickup) return;
    const id: PickupId = c.pickup;
    const amount = c.pickupAmount;
    const def = PICKUPS[id];
    switch (def.kind) {
      case 'loot':
        this.loot[def.key] += amount;
        break;
      case 'inventory':
        this.inventory[def.key] += amount;
        break;
      case 'shield':
        this.shield = Math.min(CONFIG.maxShield, this.shield + amount);
        break;
      case 'survivor':
        this.rescued += amount;
        break;
      case 'heal':
        this.hearts = Math.min(CONFIG.maxHearts, this.hearts + CONFIG.medkitHeal * amount);
        break;
    }
    c.pickup = null;
    c.pickupAmount = 0;
    this.events.push({ type: 'pickup', id, amount, at: { x, y } });
  }

  private hurt(source: DamageSource, amount: number, at: Pos): void {
    if (this.shield > 0) {
      this.shield--;
      this.events.push({ type: 'damage', source, amount, absorbed: true, at });
      return;
    }
    this.hearts = Math.max(0, this.hearts - amount);
    this.events.push({ type: 'damage', source, amount, absorbed: false, at });
    if (this.hearts <= 0) {
      this.status = 'failed';
      this.stopMoving();
      this.events.push({ type: 'failed' });
    }
  }

  private area(centre: Pos, radius: number): Pos[] {
    const out: Pos[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = centre.x + dx;
        const y = centre.y + dy;
        if (this.inBounds(x, y)) out.push({ x, y });
      }
    }
    return out;
  }

  private detonate(cells: Pos[]): void {
    const set = new Set(cells.map((p) => p.y * this.width + p.x));
    for (const p of cells) {
      const c = this.cell(p.x, p.y);
      if (c.terrain === 'wall' || !c.object) continue;
      const def = OBJECTS[c.object];
      if (!def.bombable) continue;
      const id: ObjectId = c.object;
      if (id === 'mine') {
        c.triggered = true; // safely detonated: stays on the map as a known, harmless crater
        c.revealed = true;
        c.flagged = false;
        this.events.push({ type: 'obstacleRemoved', object: 'mine', at: p });
      } else {
        c.object = null;
        this.events.push(
          id === 'zombie' ? { type: 'zombieKilled', at: p } : { type: 'obstacleRemoved', object: id, at: p },
        );
      }
    }
    for (const pt of this.patrols) {
      if (pt.alive && set.has(Math.round(pt.y) * this.width + Math.round(pt.x))) {
        pt.alive = false;
        this.events.push({ type: 'swatKilled', at: { x: Math.round(pt.x), y: Math.round(pt.y) } });
      }
    }
    this.events.push({ type: 'explosion', at: { ...this.player }, radius: CONFIG.bombRadius });
    for (const p of cells) this.reveal(p.x, p.y);
  }

  private useMap(cells: Pos[]): void {
    for (const p of cells) {
      const c = this.cell(p.x, p.y);
      if (c.terrain === 'wall') continue;
      // Hidden mines in the area are shown (and become known hazards); everything else is revealed.
      if (c.object === 'mine' && !c.revealed) {
        c.revealed = true;
        c.flagged = false;
      }
    }
    for (const p of cells) {
      const c = this.cell(p.x, p.y);
      if (c.terrain === 'wall' || c.object === 'mine') continue;
      this.reveal(p.x, p.y);
    }
    this.events.push({ type: 'mapUsed', at: { ...this.player }, radius: CONFIG.mapRadius });
  }

  private say(key: MessageKey): void {
    this.events.push({ type: 'message', key });
  }

  /** Cells 4-adjacent to (x,y); handy for tests/UI. */
  static neighbours4(x: number, y: number): Pos[] {
    return NEIGHBOURS_4.map((d) => ({ x: x + d.x, y: y + d.y }));
  }
}

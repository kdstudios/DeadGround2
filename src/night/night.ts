import { Rng } from '../gen/rng.js';
import type { Facility, Survivor } from '../core/base.js';

/**
 * Night defence: a casual, grid-based tower-defence-lite. Pure rules (no DOM), real-time `update(dt)`.
 * Zombies walk the grid to the core, chewing through barricades; arrows from the player and from survivors
 * stationed on towers shoot them down. Cell centres sit on integer coordinates, like the expedition engine.
 */

// '#' wall  '.' ground  'B' barricade gate  'C' core  'T' tower slot  'P' player start
export const NIGHT_MAP = [
  '..........................',
  '..........................',
  '..........................',
  '........#####B#####.......',
  '........#.........#.......',
  '........#.T.....T.#.......',
  '........#.........#.......',
  '........B...P...C.#.......',
  '........#.........#.......',
  '........#.........#.......',
  '........#.T.....T.#.......',
  '........#####B#####.......',
  '..........................',
  '..........................',
  '..........................',
];

/** Where zombies shamble in from. */
export const SPAWNS: readonly Pos[] = [
  { x: 0, y: 4 }, { x: 0, y: 7 }, { x: 0, y: 10 }, { x: 13, y: 0 }, { x: 6, y: 0 }, { x: 13, y: 14 }, { x: 6, y: 14 },
];

export interface Pos { x: number; y: number }

export const TUNING = {
  zombieHp: 3,
  zombieSpeed: 0.7,
  zombieBite: 1,
  biteEvery: 1.5,
  coreHp: 14,
  barricadeHp: 10,
  barricadeHpPerLevel: 4,
  repairHp: 3,
  repairCooldown: 0.8,
  repairCostMaterials: 1,
  playerSpeed: 4,
  playerRange: 5.5,
  playerFireEvery: 0.75,
  towerRange: 5.5,
  towerRangePerLevel: 0.75,
  towerFireEvery: 1.2,
  arrowSpeed: 9,
  lossFraction: 0.25,
  medicHealEvery: 8,
  engineerRepairEvery: 2.5,
} as const;

export const waveSize = (day: number, survivors: number): number => Math.min(28, 3 + day + survivors);
export const towerSlotsUnlocked = (watchtower: number): number => Math.min(4, 1 + watchtower);
/** Arrow damage and fire-rate multiplier from the Armoury. */
export const arrowDamage = (armoury: number): number => 1 + armoury;
export const fireRate = (armoury: number): number => 1 + 0.25 * armoury;

export type NightEvent =
  | { type: 'shot'; from: Pos }
  | { type: 'hit'; at: Pos; dmg: number }
  | { type: 'kill'; at: Pos }
  | { type: 'gateHit'; at: Pos }
  | { type: 'gateBreak'; at: Pos }
  | { type: 'coreHit'; at: Pos }
  | { type: 'repair'; at: Pos }
  | { type: 'spawn'; at: Pos };

export type Phase = 'prep' | 'wave' | 'won' | 'lost';

export interface Zombie { id: number; x: number; y: number; hp: number; bite: number; dir: 'up' | 'down' | 'left' | 'right'; hit: number }
export interface Arrow { x: number; y: number; target: number; dmg: number }
export interface Barricade { x: number; y: number; hp: number; max: number }
export interface Tower { x: number; y: number; unlocked: boolean; survivorId: number | null; cd: number }

export interface NightSetup {
  day: number;
  seed: number;
  survivors: Survivor[];
  facilities: Record<Facility, number>;
  materials: number;
}

export interface NightResult {
  won: boolean;
  killed: number;
  total: number;
  coreHp: number;
  barricadesLost: number;
  materialsSpent: number;
}

const key = (x: number, y: number): string => `${x},${y}`;

export class Night {
  readonly width = NIGHT_MAP[0]!.length;
  readonly height = NIGHT_MAP.length;
  phase: Phase = 'prep';
  time = 0;
  coreHp: number = TUNING.coreHp;
  readonly core: Pos;
  readonly towers: Tower[] = [];
  readonly barricades: Barricade[] = [];
  events: NightEvent[] = [];
  zombies: Zombie[] = [];
  arrows: Arrow[] = [];
  player: Pos;
  playerDir: 'up' | 'down' | 'left' | 'right' = 'right';
  playerMoving = false;
  materials: number;
  killed = 0;
  spent = 0;
  readonly total: number;
  spawned = 0;
  /** Cells that are walls (#). */
  private wall: boolean[] = [];
  private dist: number[] = [];
  private rng: Rng;
  private nextId = 1;
  private spawnTimer = 0;
  private spawnEvery: number;
  private path: Pos[] = [];
  private repairIntent: Barricade | null = null;
  private fireCd = 0.5;
  private repairCd = 0;
  private healTimer = 0;
  private engTimer = 0;
  private barricadesStart: number;

  constructor(readonly setup: NightSetup) {
    this.rng = new Rng(setup.seed);
    this.materials = setup.materials;
    let player: Pos = { x: 10, y: 9 };
    let core: Pos = { x: 16, y: 7 };
    const slots: Pos[] = [];
    const bLvl = setup.facilities.barricades;
    NIGHT_MAP.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        this.wall[y * this.width + x] = ch === '#' || ch === 'B';
        if (ch === 'P') player = { x, y };
        if (ch === 'C') core = { x, y };
        if (ch === 'T') slots.push({ x, y });
        if (ch === 'B') {
          const max = TUNING.barricadeHp + TUNING.barricadeHpPerLevel * bLvl;
          this.barricades.push({ x, y, hp: max, max });
        }
      }),
    );
    this.player = player;
    this.core = core;
    // west-side slots first, so the first tower guards the likeliest entrance
    slots.sort((a, b) => a.x - b.x || a.y - b.y);
    const open = towerSlotsUnlocked(setup.facilities.watchtower);
    slots.forEach((p, i) => this.towers.push({ ...p, unlocked: i < open, survivorId: null, cd: 0.3 + i * 0.2 }));
    this.total = waveSize(setup.day, setup.survivors.length);
    this.spawnEvery = Math.max(0.6, Math.min(2.5, 30 / this.total));
    this.barricadesStart = this.barricades.length;
    this.autoAssign();
    this.buildField();
  }

  // ───────────── layout helpers ─────────────

  isWall(x: number, y: number): boolean {
    return x < 0 || y < 0 || x >= this.width || y >= this.height || this.wall[y * this.width + x] === true;
  }

  barricadeAt(x: number, y: number): Barricade | undefined {
    return this.barricades.find((b) => b.x === x && b.y === y);
  }

  towerAt(x: number, y: number): Tower | undefined {
    return this.towers.find((t) => t.x === x && t.y === y && t.unlocked);
  }

  /** Can the player or a zombie stand here (barricades and wall segments aside)? */
  private solid(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return true;
    if (NIGHT_MAP[y]![x] === '#') return true;
    if (this.towerAt(x, y)) return true;
    return x === this.core.x && y === this.core.y;
  }

  /** Distance-to-core field for zombies; barricade gates count as open (they are chewed through). */
  private buildField(): void {
    const W = this.width;
    this.dist = new Array(W * this.height).fill(Infinity);
    const q: Pos[] = [{ ...this.core }];
    this.dist[this.core.y * W + this.core.x] = 0;
    for (let i = 0; i < q.length; i++) {
      const c = q[i]!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.height) continue;
        if (this.solid(nx, ny) || this.dist[ny * W + nx] !== Infinity) continue;
        this.dist[ny * W + nx] = this.dist[c.y * W + c.x]! + 1;
        q.push({ x: nx, y: ny });
      }
    }
  }

  // ───────────── survivors on towers ─────────────

  /** Station survivors on the unlocked towers, soldiers first. */
  autoAssign(): void {
    for (const t of this.towers) t.survivorId = null;
    const order = [...this.setup.survivors].sort((a, b) => (b.role === 'soldier' ? 1 : 0) - (a.role === 'soldier' ? 1 : 0));
    const free = this.towers.filter((t) => t.unlocked);
    free.forEach((t, i) => (t.survivorId = order[i]?.id ?? null));
  }

  /** Tap a tower in the prep phase: cycle through empty and each survivor not already stationed elsewhere. */
  cycleTower(t: Tower): void {
    if (this.phase !== 'prep' || !t.unlocked) return;
    const used = new Set(this.towers.filter((o) => o !== t && o.survivorId !== null).map((o) => o.survivorId));
    const options: (number | null)[] = [null, ...this.setup.survivors.filter((s) => !used.has(s.id)).map((s) => s.id)];
    const i = options.indexOf(t.survivorId);
    t.survivorId = options[(i + 1) % options.length]!;
  }

  survivorOn(t: Tower): Survivor | undefined {
    return this.setup.survivors.find((s) => s.id === t.survivorId);
  }

  // ───────────── input ─────────────

  start(): void {
    if (this.phase === 'prep') this.phase = 'wave';
  }

  /** Tap a cell: tower (prep) cycles its archer, a barricade is repaired, anything else is a walk target. */
  tap(x: number, y: number): void {
    if (this.phase === 'won' || this.phase === 'lost') return;
    const t = this.towerAt(x, y);
    if (t) return this.cycleTower(t);
    const b = this.barricadeAt(x, y);
    this.repairIntent = null;
    if (b) {
      this.repairIntent = b;
      const goal = this.standingCellFor(b);
      if (goal) this.walkTo(goal.x, goal.y);
      return;
    }
    this.walkTo(x, y);
  }

  /** The nearest open cell beside a barricade (inside the compound first). */
  private standingCellFor(b: Barricade): Pos | null {
    const options: Pos[] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const p = { x: b.x + dx, y: b.y + dy };
      if (!this.solid(p.x, p.y) && !this.barricadeAt(p.x, p.y)) options.push(p);
    }
    options.sort((p, q) => Math.hypot(p.x - this.player.x, p.y - this.player.y) - Math.hypot(q.x - this.player.x, q.y - this.player.y));
    return options[0] ?? null;
  }

  private walkable(x: number, y: number): boolean {
    return !this.solid(x, y) && !(this.barricadeAt(x, y)?.hp);
  }

  walkTo(gx: number, gy: number): void {
    const from = { x: Math.round(this.player.x), y: Math.round(this.player.y) };
    if (!this.walkable(gx, gy)) {
      this.path = [];
      return;
    }
    const prev = new Map<string, Pos | null>([[key(from.x, from.y), null]]);
    const q: Pos[] = [from];
    for (let i = 0; i < q.length; i++) {
      const c = q[i]!;
      if (c.x === gx && c.y === gy) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = { x: c.x + dx, y: c.y + dy };
        if (!this.walkable(n.x, n.y) || prev.has(key(n.x, n.y))) continue;
        prev.set(key(n.x, n.y), c);
        q.push(n);
      }
    }
    if (!prev.has(key(gx, gy))) {
      this.path = [];
      return;
    }
    const out: Pos[] = [];
    for (let c: Pos | null | undefined = { x: gx, y: gy }; c && !(c.x === from.x && c.y === from.y); c = prev.get(key(c.x, c.y))) out.push(c);
    this.path = out.reverse();
  }

  // ───────────── simulation ─────────────

  update(dt: number): void {
    if (this.phase !== 'wave') {
      this.movePlayer(dt);
      return;
    }
    this.time += dt;
    this.spawn(dt);
    this.moveZombies(dt);
    this.movePlayer(dt);
    this.shoot(dt);
    this.moveArrows(dt);
    this.supportRoles(dt);
    this.zombies = this.zombies.filter((z) => z.hp > 0);
    if (this.coreHp <= 0) this.phase = 'lost';
    else if (this.spawned >= this.total && this.zombies.length === 0) this.phase = 'won';
  }

  private spawn(dt: number): void {
    if (this.spawned >= this.total) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = this.spawnEvery * (0.7 + this.rng.next() * 0.6);
    const p = this.rng.pick(SPAWNS);
    this.zombies.push({ id: this.nextId++, x: p.x, y: p.y, hp: TUNING.zombieHp, bite: 0, dir: 'right', hit: 0 });
    this.events.push({ type: 'spawn', at: { x: p.x, y: p.y } });
    this.spawned++;
  }

  private moveZombies(dt: number): void {
    const W = this.width;
    for (const z of this.zombies) {
      z.hit = Math.max(0, z.hit - dt);
      const cx = Math.round(z.x), cy = Math.round(z.y);
      // next cell: the open neighbour closest to the core
      let best: Pos | null = null;
      let bd = this.dist[cy * W + cx] ?? Infinity;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.height) continue;
        const d = this.dist[ny * W + nx]!;
        if (d < bd) {
          bd = d;
          best = { x: nx, y: ny };
        }
      }
      const atCore = Math.abs(this.core.x - z.x) + Math.abs(this.core.y - z.y) <= 1.05;
      if (atCore) {
        z.bite -= dt;
        if (z.bite <= 0) {
          z.bite = TUNING.biteEvery;
          this.coreHp = Math.max(0, this.coreHp - TUNING.zombieBite);
          this.events.push({ type: 'coreHit', at: { ...this.core } });
        }
        continue;
      }
      if (!best) continue;
      const bar = this.barricadeAt(best.x, best.y);
      if (bar && bar.hp > 0 && Math.hypot(best.x - z.x, best.y - z.y) <= 1.05) {
        // chew through the barricade
        z.dir = best.x > cx ? 'right' : best.x < cx ? 'left' : best.y > cy ? 'down' : 'up';
        z.bite -= dt;
        if (z.bite <= 0) {
          z.bite = TUNING.biteEvery;
          bar.hp = Math.max(0, bar.hp - TUNING.zombieBite);
          this.events.push({ type: bar.hp <= 0 ? 'gateBreak' : 'gateHit', at: { x: bar.x, y: bar.y } });
        }
        continue;
      }
      // glide towards the centre of the next cell
      const vx = best.x - z.x, vy = best.y - z.y;
      const len = Math.hypot(vx, vy) || 1;
      const step = Math.min(len, TUNING.zombieSpeed * dt);
      z.x += (vx / len) * step;
      z.y += (vy / len) * step;
      z.dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : vy > 0 ? 'down' : 'up';
    }
  }

  private movePlayer(dt: number): void {
    this.playerMoving = false;
    let budget = TUNING.playerSpeed * dt;
    while (budget > 0 && this.path.length) {
      const n = this.path[0]!;
      if (!this.walkable(n.x, n.y)) {
        this.path = [];
        break;
      }
      const vx = n.x - this.player.x, vy = n.y - this.player.y;
      const len = Math.hypot(vx, vy);
      this.playerDir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : vy > 0 ? 'down' : 'up';
      this.playerMoving = true;
      if (len <= budget) {
        this.player = { x: n.x, y: n.y };
        budget -= len;
        this.path.shift();
      } else {
        this.player = { x: this.player.x + (vx / len) * budget, y: this.player.y + (vy / len) * budget };
        budget = 0;
      }
    }
    this.repairCd = Math.max(0, this.repairCd - dt);
    if (this.repairIntent && !this.path.length) {
      const b = this.repairIntent;
      const near = Math.abs(b.x - this.player.x) + Math.abs(b.y - this.player.y) <= 1.5;
      if (near && b.hp < b.max && this.materials >= TUNING.repairCostMaterials && this.repairCd <= 0) {
        b.hp = Math.min(b.max, b.hp + TUNING.repairHp);
        this.materials -= TUNING.repairCostMaterials;
        this.events.push({ type: 'repair', at: { x: b.x, y: b.y } });
        this.spent += TUNING.repairCostMaterials;
        this.repairCd = TUNING.repairCooldown;
      }
      if (!near || b.hp >= b.max || this.materials < TUNING.repairCostMaterials) this.repairIntent = null;
    }
  }

  private nearest(x: number, y: number, range: number): Zombie | null {
    let best: Zombie | null = null;
    let bd = range;
    for (const z of this.zombies) {
      if (z.hp <= 0) continue;
      const d = Math.hypot(z.x - x, z.y - y);
      if (d <= bd) {
        bd = d;
        best = z;
      }
    }
    return best;
  }

  private shoot(dt: number): void {
    const f = this.setup.facilities;
    const rate = fireRate(f.armoury);
    const dmg = arrowDamage(f.armoury);
    this.fireCd -= dt;
    if (this.fireCd <= 0) {
      const z = this.nearest(this.player.x, this.player.y, TUNING.playerRange);
      if (z) {
        this.arrows.push({ x: this.player.x, y: this.player.y, target: z.id, dmg });
        this.events.push({ type: 'shot', from: { ...this.player } });
        this.fireCd = TUNING.playerFireEvery / rate;
      } else this.fireCd = 0;
    }
    for (const t of this.towers) {
      if (!t.unlocked || t.survivorId === null) continue;
      t.cd -= dt;
      if (t.cd > 0) continue;
      const s = this.survivorOn(t);
      const z = this.nearest(t.x, t.y, TUNING.towerRange + TUNING.towerRangePerLevel * f.watchtower);
      if (z) {
        this.arrows.push({ x: t.x, y: t.y, target: z.id, dmg });
        this.events.push({ type: 'shot', from: { x: t.x, y: t.y } });
        t.cd = TUNING.towerFireEvery / (rate * (s?.role === 'soldier' ? 1.25 : 1));
      } else t.cd = 0;
    }
  }

  private moveArrows(dt: number): void {
    const keep: Arrow[] = [];
    for (const a of this.arrows) {
      const z = this.zombies.find((q) => q.id === a.target && q.hp > 0);
      if (!z) continue;
      const vx = z.x - a.x, vy = z.y - a.y;
      const d = Math.hypot(vx, vy);
      const step = TUNING.arrowSpeed * dt;
      if (d <= step + 0.2) {
        z.hp -= a.dmg;
        z.hit = 0.15;
        this.events.push({ type: 'hit', at: { x: z.x, y: z.y }, dmg: a.dmg });
        if (z.hp <= 0) {
          this.killed++;
          this.events.push({ type: 'kill', at: { x: z.x, y: z.y } });
        }
        continue;
      }
      a.x += (vx / d) * step;
      a.y += (vy / d) * step;
      keep.push(a);
    }
    this.arrows = keep;
  }

  /** Stationed medics mend the core; engineers patch barricades. */
  private supportRoles(dt: number): void {
    const on = (role: string): boolean => this.towers.some((t) => t.unlocked && this.survivorOn(t)?.role === role);
    this.healTimer += dt;
    this.engTimer += dt;
    if (this.healTimer >= TUNING.medicHealEvery) {
      this.healTimer = 0;
      if (on('medic') && this.coreHp > 0) this.coreHp = Math.min(TUNING.coreHp, this.coreHp + 1);
    }
    if (this.engTimer >= TUNING.engineerRepairEvery) {
      this.engTimer = 0;
      if (on('engineer')) {
        const b = this.barricades.filter((x) => x.hp > 0 && x.hp < x.max).sort((p, q) => p.hp - q.hp)[0];
        if (b) b.hp++;
      }
    }
  }

  drainEvents(): NightEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  result(): NightResult {
    return {
      won: this.phase === 'won',
      killed: this.killed,
      total: this.total,
      coreHp: this.coreHp,
      barricadesLost: this.barricades.filter((b) => b.hp <= 0).length,
      materialsSpent: this.spent,
    };
  }

  get zombiesLeft(): number {
    return this.total - this.killed;
  }

  get barricadeCount(): number {
    return this.barricadesStart;
  }
}

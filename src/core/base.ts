import { CONFIG } from './config.js';
import type { Kit, Results } from './types.js';

/**
 * The persistent safehouse: resources, survivors, facilities, the day counter and the daily stamina.
 * Pure data and rules (no DOM) so it can be unit tested and saved as JSON.
 */

export type Role = 'engineer' | 'medic' | 'farmer' | 'soldier' | 'scavenger';
export type Facility = 'storage' | 'garden' | 'workshop' | 'armoury' | 'barricades' | 'watchtower';
export type Stock = { scrap: number; food: number; materials: number };

export interface Survivor {
  id: number;
  name: string;
  role: Role;
}

export interface BaseState {
  version: 1;
  day: number;
  stamina: number;
  stock: Stock;
  kit: Kit;
  survivors: Survivor[];
  facilities: Record<Facility, number>;
  nextSurvivorId: number;
  /** A night attack that has started but not finished (so a reload resumes the same night). */
  pendingNight?: { seed: number } | null;
}

export const ROLES: Record<Role, { label: string; perk: string }> = {
  engineer: { label: 'Engineer', perk: 'Upgrades cost 1 less of each resource' },
  medic: { label: 'Medic', perk: 'Starts every expedition with +1 heart' },
  farmer: { label: 'Farmer', perk: '+2 food from the garden each night' },
  soldier: { label: 'Soldier', perk: 'Packs +2 ammo for every expedition' },
  scavenger: { label: 'Scavenger', perk: '+1 scrap from every escaped expedition' },
};

export const NAMES = ['Mara', 'Jonas', 'Priya', 'Cole', 'Tessa', 'Reuben', 'Imogen', 'Dale', 'Noor', 'Emil', 'Wren', 'Hugo', 'Sana', 'Gus', 'Ivy', 'Otis'];

export const FACILITIES: Record<Facility, { label: string; blurb: string; max: number; levelNote: (lvl: number) => string }> = {
  storage: { label: 'Storage', blurb: 'Raises how much of each resource you can keep.', max: 3, levelNote: (l) => `Cap ${storageCap(l)} each` },
  garden: { label: 'Garden', blurb: 'Grows food overnight.', max: 3, levelNote: (l) => `+${gardenYield(l)} food / night` },
  workshop: { label: 'Workshop', blurb: 'Craft supplies for expeditions. Upgrades make crafting cheaper.', max: 3, levelNote: (l) => (l === 0 ? 'Not built' : l === 1 ? 'Standard crafting prices' : `Crafting −${l - 1} scrap`) },
  armoury: { label: 'Armoury', blurb: 'Better bows: arrows fly faster and hit harder at night.', max: 3, levelNote: (l) => (l === 0 ? 'Plain bows' : `Fire rate +${l * 25}%, damage +${l}`) },
  barricades: { label: 'Barricades', blurb: 'Stronger walls for night attacks (used once night defence arrives).', max: 3, levelNote: (l) => `Level ${l}` },
  watchtower: { label: 'Watchtower', blurb: 'Early warning of night attacks (used once night defence arrives).', max: 3, levelNote: (l) => `Level ${l}` },
};

export const storageCap = (lvl: number): number => [30, 60, 100, 160][Math.min(3, lvl)]!;
export const gardenYield = (lvl: number): number => [0, 2, 4, 6][Math.min(3, lvl)]!;

/** Stamina each expedition type costs, and the stamina available each day. */
export const STAMINA_PER_DAY = 6;
export const EXPEDITION_COST = { safe: 1, scouting: 2, risky: 3 } as const;
export const KIT_CAP = 5;

export type Cost = Partial<Stock>;

export function upgradeCost(state: BaseState, f: Facility): Cost {
  const lvl = state.facilities[f];
  const base: Cost[] = [
    { scrap: 6, materials: 4 },
    { scrap: 14, materials: 10 },
    { scrap: 28, materials: 20 },
  ];
  const c = { ...(base[lvl] ?? {}) } as Cost;
  if (f === 'workshop' && lvl === 0) return { scrap: 5, materials: 3 };
  if (hasRole(state, 'engineer')) {
    for (const k of Object.keys(c) as (keyof Stock)[]) c[k] = Math.max(1, (c[k] ?? 0) - 1);
  }
  return c;
}

export const hasRole = (s: BaseState, r: Role): boolean => s.survivors.some((x) => x.role === r);

export type CraftItem = keyof Kit;
export const CRAFT: Record<CraftItem, { label: string; gives: number; cost: Cost }> = {
  ammo: { label: 'Ammo box (+3)', gives: 3, cost: { scrap: 3 } },
  explosive: { label: 'Explosive', gives: 1, cost: { scrap: 4, materials: 3 } },
  shield: { label: 'Shield', gives: 1, cost: { scrap: 2, materials: 3 } },
  map: { label: 'Map fragment', gives: 1, cost: { scrap: 3, materials: 1 } },
};

export function craftCost(state: BaseState, item: CraftItem): Cost {
  const c = { ...CRAFT[item].cost };
  const discount = Math.max(0, state.facilities.workshop - 1);
  if (c.scrap) c.scrap = Math.max(1, c.scrap - discount);
  return c;
}

export function newBase(): BaseState {
  return {
    version: 1,
    day: 1,
    stamina: STAMINA_PER_DAY,
    stock: { scrap: 8, food: 6, materials: 4 },
    kit: { ammo: 3, explosive: 0, map: 0, shield: 0 },
    survivors: [],
    facilities: { storage: 0, garden: 0, workshop: 0, armoury: 0, barricades: 0, watchtower: 0 },
    nextSurvivorId: 1,
  };
}

const canPay = (stock: Stock, cost: Cost): boolean => (Object.keys(cost) as (keyof Stock)[]).every((k) => stock[k] >= (cost[k] ?? 0));
const pay = (stock: Stock, cost: Cost): void => {
  for (const k of Object.keys(cost) as (keyof Stock)[]) stock[k] -= cost[k] ?? 0;
};

export const canAfford = (s: BaseState, cost: Cost): boolean => canPay(s.stock, cost);

export function canStart(s: BaseState, difficulty: keyof typeof EXPEDITION_COST): boolean {
  return s.stamina >= EXPEDITION_COST[difficulty];
}

/** Supplies and bonuses the player takes out on an expedition. */
export function loadout(s: BaseState): Kit & { hearts: number } {
  return {
    ammo: s.kit.ammo + (hasRole(s, 'soldier') ? 2 : 0),
    explosive: s.kit.explosive,
    map: s.kit.map,
    shield: s.kit.shield,
    hearts: CONFIG.startHearts + (hasRole(s, 'medic') ? 1 : 0),
  };
}

/** Spend the stamina and take the kit out of storage. Call when an expedition begins. */
export function departExpedition(s: BaseState, difficulty: keyof typeof EXPEDITION_COST): boolean {
  if (!canStart(s, difficulty)) return false;
  s.stamina -= EXPEDITION_COST[difficulty];
  s.kit = { ammo: 0, explosive: 0, map: 0, shield: 0 };
  return true;
}

export interface ReturnReport {
  escaped: boolean;
  gained: Stock;
  lost: Stock; // thrown away because storage was full
  recruited: Survivor[];
}

/**
 * Apply an expedition's results. Dying loses everything found and everything carried;
 * escaping keeps the loot (up to the storage cap), unused supplies and any rescued survivors.
 */
export function returnHome(s: BaseState, r: Results, rng: () => number = Math.random): ReturnReport {
  const rep: ReturnReport = { escaped: r.status === 'won', gained: { scrap: 0, food: 0, materials: 0 }, lost: { scrap: 0, food: 0, materials: 0 }, recruited: [] };
  if (!rep.escaped) return rep;
  const cap = storageCap(s.facilities.storage);
  const bonus = hasRole(s, 'scavenger') ? 1 : 0;
  for (const k of ['scrap', 'food', 'materials'] as const) {
    const got = r.loot[k] + (k === 'scrap' ? bonus : 0);
    const room = Math.max(0, cap - s.stock[k]);
    const take = Math.min(room, got);
    s.stock[k] += take;
    rep.gained[k] = take;
    rep.lost[k] = got - take;
  }
  // leftover supplies go back into the store room (soldier's extra ammo is not kept)
  for (const k of Object.keys(s.kit) as (keyof Kit)[]) {
    const carried = r.kit[k] - (k === 'ammo' && hasRole(s, 'soldier') ? 2 : 0);
    s.kit[k] = Math.min(KIT_CAP, s.kit[k] + Math.max(0, carried));
  }
  for (let i = 0; i < r.rescued; i++) rep.recruited.push(recruit(s, rng));
  return rep;
}

export function recruit(s: BaseState, rng: () => number = Math.random): Survivor {
  const roles = Object.keys(ROLES) as Role[];
  const taken = new Set(s.survivors.map((x) => x.name));
  const names = NAMES.filter((n) => !taken.has(n));
  const sv: Survivor = {
    id: s.nextSurvivorId++,
    name: (names.length ? names : NAMES)[Math.floor(rng() * (names.length || NAMES.length))]!,
    role: roles[Math.floor(rng() * roles.length)]!,
  };
  s.survivors.push(sv);
  return sv;
}

export function upgrade(s: BaseState, f: Facility): boolean {
  if (s.facilities[f] >= FACILITIES[f].max) return false;
  const cost = upgradeCost(s, f);
  if (!canPay(s.stock, cost)) return false;
  pay(s.stock, cost);
  s.facilities[f]++;
  return true;
}

export function craft(s: BaseState, item: CraftItem): boolean {
  if (s.facilities.workshop < 1) return false;
  const limit = item === 'shield' ? CONFIG.maxShield : KIT_CAP;
  if (s.kit[item] >= limit) return false;
  const cost = craftCost(s, item);
  if (!canPay(s.stock, cost)) return false;
  pay(s.stock, cost);
  s.kit[item] = Math.min(limit, s.kit[item] + CRAFT[item].gives);
  return true;
}

export interface NightReport {
  day: number;
  eaten: number;
  needed: number;
  grown: number;
  left: Survivor[];
  starving: boolean;
}

export const foodNeeded = (s: BaseState): number => 1 + s.survivors.length;

/**
 * Night falls: the garden grows food, then everyone eats (the player plus each survivor, one food each).
 * If there isn't enough, the shortfall is felt: one survivor leaves in the dark per missing 2 food (min 1).
 * (Zombie attacks on the base arrive with Phase 4.)
 */
export function endDay(s: BaseState, rng: () => number = Math.random): NightReport {
  const cap = storageCap(s.facilities.storage);
  const grown = gardenYield(s.facilities.garden) + (hasRole(s, 'farmer') && s.facilities.garden > 0 ? 2 : 0);
  s.stock.food = Math.min(Math.max(cap, s.stock.food), s.stock.food + grown);
  const needed = foodNeeded(s);
  const eaten = Math.min(needed, s.stock.food);
  s.stock.food -= eaten;
  const missing = needed - eaten;
  const left: Survivor[] = [];
  if (missing > 0) {
    const leaving = Math.min(s.survivors.length, Math.max(1, Math.ceil(missing / 2)));
    for (let i = 0; i < leaving; i++) {
      const k = Math.floor(rng() * s.survivors.length);
      left.push(...s.survivors.splice(k, 1));
    }
  }
  const rep: NightReport = { day: s.day, eaten, needed, grown, left, starving: missing > 0 };
  s.day++;
  s.stamina = STAMINA_PER_DAY;
  return rep;
}

// ───────────── persistence ─────────────

export const SAVE_KEY = 'deadground.save.v1';

export const serialize = (s: BaseState): string => JSON.stringify(s);

/** Parse and sanity-check a save; returns null if it is missing or corrupt. */
export function deserialize(text: string | null): BaseState | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as BaseState;
    if (o.version !== 1 || typeof o.day !== 'number' || !o.stock || !o.kit || !o.facilities || !Array.isArray(o.survivors)) return null;
    const base = newBase();
    return { ...base, ...o, stock: { ...base.stock, ...o.stock }, kit: { ...base.kit, ...o.kit }, facilities: { ...base.facilities, ...o.facilities } };
  } catch {
    return null;
  }
}

// ───────────── night defence outcome ─────────────

export interface NightOutcome {
  won: boolean;
  killed: number;
  materialsSpent: number;
}

/** What a defended night costs and pays. Winning salvages scrap; losing a night costs a quarter of the stock. */
export function applyNight(s: BaseState, o: NightOutcome): { salvage: number; lost: Stock } {
  s.stock.materials = Math.max(0, s.stock.materials - o.materialsSpent);
  const lost: Stock = { scrap: 0, food: 0, materials: 0 };
  let salvage = 0;
  if (o.won) {
    salvage = Math.floor(o.killed / 4);
    s.stock.scrap = Math.min(Math.max(storageCap(s.facilities.storage), s.stock.scrap), s.stock.scrap + salvage);
  } else {
    for (const k of ['scrap', 'food', 'materials'] as const) {
      lost[k] = Math.ceil(s.stock[k] * 0.25);
      s.stock[k] -= lost[k];
    }
  }
  return { salvage, lost };
}

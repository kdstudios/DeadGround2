import type { BaseState } from '../core/base.js';
import { ACHIEVEMENTS } from './achievementDefs.js';
import { PROGRESS } from './config.js';
import { CAMPAIGN, DAILY_POOL, WEEKLY_POOL } from './missionDefs.js';
import type { AchievementProgress, Board, LifetimeStats, Metric, MissionInstance, ProgressState } from './types.js';

export const METRICS: readonly Metric[] = [
  'expeditions', 'escapes', 'failures', 'riskyEscapes', 'scoutingEscapes', 'safeEscapes', 'untouchable',
  'zombies', 'survivors', 'vaults', 'nights', 'defences', 'upgrades', 'scrap', 'regions', 'missions', 'transmitters', 'researchers',
];

export const emptyStats = (): LifetimeStats => Object.fromEntries(METRICS.map((m) => [m, 0])) as LifetimeStats;
const emptyBoard = (): Board => ({ period: -1, missions: [] });

export function newProgress(): ProgressState {
  return {
    v: PROGRESS.version,
    xp: 0,
    stats: emptyStats(),
    regionsSeen: [],
    achievements: {},
    daily: emptyBoard(),
    weekly: emptyBoard(),
    campaign: {},
    highWater: 0,
    seen: [],
  };
}

// ───────────── defensive readers (saves can be hand-edited or truncated) ─────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A finite, non-negative integer no larger than the configured ceiling; anything else becomes `fallback`. */
export const count = (x: unknown, fallback = 0): number =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(PROGRESS.maxStat, Math.max(0, Math.floor(x))) : fallback;
const strings = (x: unknown, cap: number): string[] =>
  Array.isArray(x) ? [...new Set(x.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < 80))].slice(-cap) : [];

function readInstance(x: unknown, valid: ReadonlySet<string>): MissionInstance | null {
  if (!isObj(x) || typeof x.id !== 'string' || !valid.has(x.id)) return null;
  const inst: MissionInstance = { id: x.id, progress: count(x.progress), claimed: x.claimed === true };
  if (Array.isArray(x.keys)) inst.keys = strings(x.keys, 50);
  return inst;
}

function readBoard(x: unknown, valid: ReadonlySet<string>): Board {
  if (!isObj(x)) return emptyBoard();
  const seen = new Set<string>();
  const missions: MissionInstance[] = [];
  if (Array.isArray(x.missions)) {
    for (const m of x.missions) {
      const inst = readInstance(m, valid);
      if (inst && !seen.has(inst.id)) {
        seen.add(inst.id);
        missions.push(inst);
      }
    }
  }
  const period = typeof x.period === 'number' && Number.isFinite(x.period) ? Math.floor(x.period) : -1;
  return { period: missions.length ? period : -1, missions };
}

/**
 * Turn arbitrary parsed JSON into a valid ProgressState, field by field.
 * Returns null when there is nothing usable (not an object), so the caller can start fresh.
 */
export function sanitizeProgress(raw: unknown): ProgressState | null {
  if (!isObj(raw)) return null;
  const fresh = newProgress();
  const statsIn = isObj(raw.stats) ? raw.stats : {};
  const stats = emptyStats();
  for (const m of METRICS) stats[m] = count(statsIn[m]);

  const ach: Record<string, AchievementProgress> = {};
  const known = new Set(ACHIEVEMENTS.map((a) => a.id));
  if (isObj(raw.achievements)) {
    for (const [id, v] of Object.entries(raw.achievements)) {
      if (!known.has(id) || !isObj(v)) continue;
      ach[id] = v.done === true ? { done: true, ...(typeof v.at === 'number' && Number.isFinite(v.at) ? { at: v.at } : {}) } : { done: false };
    }
  }

  const campaignIds = new Set(CAMPAIGN.map((m) => m.id));
  const campaign: Record<string, MissionInstance> = {};
  if (isObj(raw.campaign)) {
    for (const v of Object.values(raw.campaign)) {
      const inst = readInstance(v, campaignIds);
      if (inst) campaign[inst.id] = inst;
    }
  }

  const out: ProgressState = {
    ...fresh,
    xp: count(raw.xp),
    stats,
    regionsSeen: strings(raw.regionsSeen, 50),
    achievements: ach,
    daily: readBoard(raw.daily, new Set(DAILY_POOL.map((m) => m.id))),
    weekly: readBoard(raw.weekly, new Set(WEEKLY_POOL.map((m) => m.id))),
    campaign,
    highWater: typeof raw.highWater === 'number' && Number.isFinite(raw.highWater) && raw.highWater > 0 ? raw.highWater : 0,
    seen: strings(raw.seen, PROGRESS.seenCap),
  };
  if (typeof raw.migratedFrom === 'number') out.migratedFrom = Math.floor(raw.migratedFrom);
  if (raw.welcomed === true) out.welcomed = true;
  return out;
}

/** Per-version upgrade steps for the `progress` block: MIGRATIONS[n] turns a version-n block into version n+1. */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 -> v2 (v22): the "transmitter" and "research team" campaign steps became real story items. Whatever progress they
  // had counted (vaults opened, survivors rescued) no longer means anything for them, so unfinished steps restart from 0.
  // Claimed steps keep their claim, and XP already earned is untouched.
  1: (raw) => {
    const out = { ...raw };
    if (isObj(raw.campaign)) {
      const campaign: Record<string, unknown> = {};
      for (const [id, v] of Object.entries(raw.campaign)) {
        campaign[id] = isObj(v) && (id === 'c_transmitter' || id === 'c_research') && v.claimed !== true ? { ...v, progress: 0 } : v;
      }
      out.campaign = campaign;
    }
    return out;
  },
};

/**
 * Counters a pre-progression (v20) save can honestly be credited with, derived from what it already holds.
 * Everything else starts at zero: the old game never recorded kills, vaults or escapes.
 */
export function seedFromBase(p: ProgressState, base: Pick<BaseState, 'day' | 'survivors' | 'facilities'>): void {
  p.stats.nights = Math.max(p.stats.nights, Math.max(0, base.day - 1));
  p.stats.survivors = Math.max(p.stats.survivors, base.survivors.length);
  p.stats.upgrades = Math.max(p.stats.upgrades, Object.values(base.facilities).reduce((a, b) => a + b, 0));
}

/**
 * Entry point used when a save is loaded: returns a valid ProgressState whatever the input was.
 *  - missing (a v20 save)            -> new block seeded from the safehouse, flagged `migratedFrom: 20`
 *  - older block version             -> run the migration steps
 *  - damaged block                   -> repaired field by field, or replaced and re-seeded if unreadable
 */
export function migrateProgress(raw: unknown, base: Pick<BaseState, 'day' | 'survivors' | 'facilities'>): ProgressState {
  if (raw === undefined || raw === null) {
    const p = newProgress();
    seedFromBase(p, base);
    p.migratedFrom = 20; // the last release without progression
    return p;
  }
  let cur: unknown = raw;
  if (isObj(cur) && typeof cur.v === 'number') {
    let v = Math.floor(cur.v);
    while (v < PROGRESS.version && MIGRATIONS[v]) {
      cur = { ...MIGRATIONS[v]!(cur as Record<string, unknown>), v: v + 1 };
      v++;
    }
  }
  const p = sanitizeProgress(cur);
  if (!p) {
    const f = newProgress();
    seedFromBase(f, base);
    f.migratedFrom = 0; // unreadable data was replaced
    return f;
  }
  p.v = PROGRESS.version;
  return p;
}

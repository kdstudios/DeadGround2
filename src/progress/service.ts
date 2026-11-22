import { storageCap, type BaseState, type Facility } from '../core/base.js';
import type { StoryKey } from '../core/types.js';
import { Rng } from '../gen/rng.js';
import { ACHIEVEMENTS } from './achievementDefs.js';
import { PROGRESS } from './config.js';
import { CAMPAIGN, DAILY_POOL, WEEKLY_POOL } from './missionDefs.js';
import { migrateProgress } from './state.js';
import { dayIndex, msToNextDay, msToNextWeek, weekIndex } from './time.js';
import type {
  AchievementDef,
  LifetimeStats,
  Metric,
  MissionCategory,
  MissionDef,
  MissionInstance,
  Notice,
  Objective,
  ProgEvent,
  ProgressState,
  Requirement,
  Reward,
  StateMetric,
} from './types.js';
import { levelFromXp, type LevelInfo } from './xp.js';

/** Content the service runs on. Defaults to the shipped config; tests (and future live-ops) can pass their own. */
export interface ProgressContent {
  achievements: readonly AchievementDef[];
  daily: readonly MissionDef[];
  weekly: readonly MissionDef[];
  campaign: readonly MissionDef[];
}
const DEFAULT_CONTENT: ProgressContent = { achievements: ACHIEVEMENTS, daily: DAILY_POOL, weekly: WEEKLY_POOL, campaign: CAMPAIGN };

export interface ServiceOptions {
  /** Clock in epoch ms. Injectable for tests. */
  now?: () => number;
  content?: ProgressContent;
  /** Receives every notice, including those raised while the service is being constructed. */
  listener?: (n: Notice) => void;
}

export interface HandleResult {
  /** XP earned by this event itself plus any rewards it unlocked. */
  xp: number;
  notices: Notice[];
}

export interface ClaimResult {
  ok: boolean;
  reason?: 'unknown' | 'locked' | 'incomplete' | 'claimed';
  reward?: Reward;
  /** Resources that did not fit in storage. */
  lost?: Reward;
  notices: Notice[];
}

export interface MissionView {
  def: MissionDef;
  category: MissionCategory;
  progress: number;
  target: number;
  done: boolean;
  claimed: boolean;
  unlocked: boolean;
  lockedReason?: string;
}

export interface AchievementView {
  def: AchievementDef;
  progress: number;
  target: number;
  done: boolean;
  unlocked: boolean;
  lockedReason?: string;
}

export interface ProfileView {
  level: LevelInfo;
  stats: LifetimeStats;
  achievementsDone: number;
  achievementsTotal: number;
  achievementPct: number;
  missionsCompleted: number;
  /** Escaped / finished expeditions, 0..1 (null before the first one). */
  successRate: number | null;
  /** Full days lived through. */
  daysSurvived: number;
  day: number;
}

type Tick = { metric: Metric; amount: number; key?: string };

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Deterministic daily / weekly selection: the same period index always yields the same missions, on every device,
 * with no server. Exported for tests.
 */
export function pickMissions(pool: readonly MissionDef[], category: string, period: number, count: number): MissionDef[] {
  const rng = new Rng(hash(`${category}:${period}`));
  return rng.shuffle([...pool]).slice(0, Math.min(count, pool.length));
}

/**
 * The central progression service. The game reports what happened (`handle`), and this class updates XP, lifetime
 * stats, achievements and missions in one place. It owns no DOM and no timers. All state lives in `base.progress`, so it
 * is saved, exported and imported with the safehouse; `onChange` is called after every mutation so the owner can persist.
 */
export class ProgressionService {
  private readonly listeners = new Set<(n: Notice) => void>();
  private readonly now: () => number;
  private readonly content: ProgressContent;
  private pending: Notice[] = [];
  /** While true, notices are collected but not sent to listeners (used to fold a migration into one summary). */
  private quiet = false;
  private xpGained = 0;

  constructor(
    private readonly base: BaseState,
    private readonly onChange: () => void = () => {},
    opts: ServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.content = opts.content ?? DEFAULT_CONTENT;
    if (opts.listener) this.listeners.add(opts.listener);
    if (!this.base.progress) this.base.progress = migrateProgress(undefined, this.base);
    const p = this.p;
    // A save from before progression: recognise what the player has already done, once, as a single summary notice.
    const welcome = p.migratedFrom !== undefined && !p.welcomed;
    const before = this.doneCount();
    this.quiet = welcome;
    this.refresh();
    if (welcome) {
      p.welcomed = true;
      this.sync();
      this.quiet = false;
      const earned = this.doneCount() - before;
      if (earned > 0) this.notify({ type: 'veteran', achievements: earned, level: this.level().level });
      this.commit();
    }
  }

  private get p(): ProgressState {
    return this.base.progress!;
  }

  on(fn: (n: Notice) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(n: Notice): void {
    this.pending.push(n);
    if (this.quiet) return;
    for (const l of this.listeners) l(n);
  }

  /** Flush: persist and hand back what happened since the last flush. */
  private commit(): HandleResult {
    const r = { xp: this.xpGained, notices: this.pending };
    this.pending = [];
    this.xpGained = 0;
    this.onChange();
    return r;
  }

  // ───────────── clock & period rollover ─────────────

  /** The effective "now": never earlier than the latest time ever seen (setting the clock back changes nothing). */
  private effectiveNow(): number {
    const t = this.now();
    if (Number.isFinite(t) && t > this.p.highWater) this.p.highWater = t;
    return this.p.highWater;
  }

  /** Roll daily / weekly boards over if a new day or week has begun. Safe to call at any time. */
  refresh(): HandleResult {
    const t = this.effectiveNow();
    const p = this.p;
    const d = dayIndex(t);
    const w = weekIndex(t);
    let changed = false;
    if (p.daily.period < d || !p.daily.missions.length) {
      this.rollBoard('daily', d);
      changed = true;
    }
    if (p.weekly.period < w || !p.weekly.missions.length) {
      this.rollBoard('weekly', w);
      changed = true;
    }
    if (changed) this.sync();
    return changed ? this.commit() : { xp: 0, notices: [] };
  }

  private rollBoard(cat: 'daily' | 'weekly', period: number): void {
    const p = this.p;
    const board = p[cat];
    if (PROGRESS.missions.autoClaimOnReset) {
      for (const m of board.missions) {
        const def = this.defOf(m.id);
        if (def && !m.claimed && m.progress >= this.targetOf(def)) {
          m.claimed = true;
          this.grant(def.reward);
          this.notify({ type: 'missionAutoClaimed', id: def.id, name: def.name, reward: def.reward });
        }
      }
    }
    const pool = cat === 'daily' ? this.content.daily : this.content.weekly;
    const n = cat === 'daily' ? PROGRESS.missions.dailyCount : PROGRESS.missions.weeklyCount;
    p[cat] = { period, missions: pickMissions(pool, cat, period, n).map((d) => ({ id: d.id, progress: 0, claimed: false })) };
  }

  msToDailyReset(): number {
    return msToNextDay(this.effectiveNow());
  }
  msToWeeklyReset(): number {
    return msToNextWeek(this.effectiveNow());
  }

  // ───────────── lookups ─────────────

  private defOf(id: string): MissionDef | undefined {
    return this.content.daily.find((m) => m.id === id) ?? this.content.weekly.find((m) => m.id === id) ?? this.content.campaign.find((m) => m.id === id);
  }
  private targetOf(def: { objective: Objective }): number {
    return def.objective.target;
  }

  private stateValue(m: StateMetric): number {
    const b = this.base;
    if (m === 'day') return b.day;
    if (m === 'level') return levelFromXp(this.p.xp).level;
    if (m === 'survivorsInBase') return b.survivors.length;
    return b.facilities[m.slice('facility:'.length) as Facility] ?? 0;
  }

  private lifetime(metric: Metric): number {
    return metric === 'regions' ? this.p.regionsSeen.length : this.p.stats[metric];
  }

  private met(req: Requirement | undefined): { ok: boolean; why?: string } {
    if (!req) return { ok: true };
    if (req.playerLevel && levelFromXp(this.p.xp).level < req.playerLevel) return { ok: false, why: `Reach level ${req.playerLevel}` };
    if (req.achievement && !this.p.achievements[req.achievement]?.done) {
      const a = this.content.achievements.find((x) => x.id === req.achievement);
      return { ok: false, why: `Earn the achievement: ${a?.name ?? req.achievement}` };
    }
    if (req.mission && !this.p.campaign[req.mission]?.claimed) {
      const m = this.content.campaign.find((x) => x.id === req.mission);
      return { ok: false, why: `Complete: ${m?.name ?? req.mission}` };
    }
    return { ok: true };
  }

  private activeInstances(): { def: MissionDef; inst: MissionInstance }[] {
    const out: { def: MissionDef; inst: MissionInstance }[] = [];
    for (const board of [this.p.daily, this.p.weekly]) {
      for (const inst of board.missions) {
        const def = this.defOf(inst.id);
        if (def) out.push({ def, inst });
      }
    }
    for (const def of this.content.campaign) out.push({ def, inst: this.campaignInstance(def.id) });
    return out;
  }

  private campaignInstance(id: string): MissionInstance {
    return (this.p.campaign[id] ??= { id, progress: 0, claimed: false });
  }

  // ───────────── event intake ─────────────

  /** Report a gameplay event. Idempotent for events that carry an id. */
  handle(ev: ProgEvent): HandleResult {
    const p = this.p;
    if ('id' in ev) {
      if (p.seen.includes(ev.id)) return { xp: 0, notices: [] };
      p.seen.push(ev.id);
      if (p.seen.length > PROGRESS.seenCap) p.seen.splice(0, p.seen.length - PROGRESS.seenCap);
    }
    // a new day may have begun since the last event: make sure progress lands on the right boards
    this.refresh();

    const ticks: Tick[] = [];
    const xp = PROGRESS.xp;
    let gained = 0;
    let reason = '';
    switch (ev.type) {
      case 'expeditionEnded': {
        ticks.push({ metric: 'expeditions', amount: 1 });
        if (ev.escaped) {
          ticks.push({ metric: 'escapes', amount: 1 });
          ticks.push({ metric: ev.difficulty === 'risky' ? 'riskyEscapes' : ev.difficulty === 'scouting' ? 'scoutingEscapes' : 'safeEscapes', amount: 1 });
          if (ev.damageTaken <= 0) ticks.push({ metric: 'untouchable', amount: 1 });
          if (ev.scrap > 0) ticks.push({ metric: 'scrap', amount: Math.floor(ev.scrap) });
          if (ev.rescued > 0) ticks.push({ metric: 'survivors', amount: Math.floor(ev.rescued) });
          if (ev.story?.transmitter) ticks.push({ metric: 'transmitters', amount: Math.floor(ev.story.transmitter) });
          if (ev.story?.researcher) ticks.push({ metric: 'researchers', amount: Math.floor(ev.story.researcher) });
          ticks.push({ metric: 'regions', amount: 1, key: ev.region });
          gained = xp.expeditionEscape[ev.difficulty] + xp.rescueSurvivor * Math.max(0, Math.floor(ev.rescued));
          reason = 'Expedition complete';
        } else {
          ticks.push({ metric: 'failures', amount: 1 });
          gained = xp.expeditionFailed;
          reason = 'Expedition failed';
        }
        break;
      }
      case 'zombieKilled':
        ticks.push({ metric: 'zombies', amount: Math.max(0, Math.floor(ev.amount)) });
        gained = xp.zombieKill * Math.max(0, Math.floor(ev.amount));
        reason = 'Zombies down';
        break;
      case 'vaultOpened':
        ticks.push({ metric: 'vaults', amount: 1 });
        gained = xp.vaultOpened;
        reason = 'Vault opened';
        break;
      case 'nightEnded': {
        const survived = ev.skipped || ev.won;
        if (survived) ticks.push({ metric: 'nights', amount: 1 });
        if (!ev.skipped) {
          if (ev.killed > 0) ticks.push({ metric: 'zombies', amount: Math.floor(ev.killed) });
          if (ev.won) {
            ticks.push({ metric: 'defences', amount: 1 });
            gained = xp.nightDefended;
            reason = 'Night defended';
          }
        }
        break;
      }
      case 'facilityUpgraded':
        ticks.push({ metric: 'upgrades', amount: 1 });
        break;
      case 'dayReached':
        break;
    }

    for (const t of ticks) this.apply(t);
    if (gained > 0) this.addXp(gained, reason);
    this.sync();
    return this.commit();
  }

  private apply(t: Tick): void {
    if (t.amount <= 0) return;
    const p = this.p;
    if (t.metric === 'regions') {
      if (t.key && !p.regionsSeen.includes(t.key)) p.regionsSeen.push(t.key);
    } else {
      p.stats[t.metric] = Math.min(PROGRESS.maxStat, p.stats[t.metric] + t.amount);
    }
    for (const { def, inst } of this.activeInstances()) {
      const o = def.objective;
      if (o.kind !== 'counter' || o.metric !== t.metric || inst.claimed || inst.progress >= o.target) continue;
      if (!this.met(def.requires).ok) continue;
      const before = inst.progress;
      if (t.metric === 'regions') {
        const keys = (inst.keys ??= []);
        if (t.key && !keys.includes(t.key)) keys.push(t.key);
        inst.progress = Math.min(o.target, keys.length);
      } else {
        inst.progress = Math.min(o.target, inst.progress + t.amount);
      }
      this.completionCheck(def, before, inst.progress);
    }
  }

  private completionCheck(def: MissionDef, before: number, after: number): void {
    if (before < def.objective.target && after >= def.objective.target) {
      this.p.stats.missions++;
      this.notify({ type: 'missionDone', id: def.id, name: def.name, category: def.category });
    }
  }

  /**
   * Bring everything that is derived from state up to date: state-based mission progress, achievements, and
   * anything those rewards in turn unlock (an XP reward can raise the level and unlock something else).
   */
  private sync(): void {
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const { def, inst } of this.activeInstances()) {
        const o = def.objective;
        if (o.kind !== 'state' || inst.claimed || !this.met(def.requires).ok) continue;
        const v = Math.min(o.target, this.stateValue(o.metric));
        if (v > inst.progress) {
          const before = inst.progress;
          inst.progress = v;
          this.completionCheck(def, before, v);
          changed = true;
        }
      }
      for (const a of this.content.achievements) {
        const st = (this.p.achievements[a.id] ??= { done: false });
        if (st.done || !this.met(a.requires).ok) continue;
        const value = a.objective.kind === 'counter' ? this.lifetime(a.objective.metric) : this.stateValue(a.objective.metric);
        if (value >= a.objective.target) {
          st.done = true;
          st.at = this.now();
          this.grant(a.reward);
          this.notify({ type: 'achievement', id: a.id, name: a.name, reward: a.reward });
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  // ───────────── XP and rewards ─────────────

  private addXp(amount: number, reason: string, announce = true): void {
    if (amount <= 0) return;
    const p = this.p;
    const before = levelFromXp(p.xp).level;
    p.xp = Math.min(PROGRESS.maxStat, p.xp + amount);
    this.xpGained += amount;
    if (announce) this.notify({ type: 'xp', amount, reason });
    const after = levelFromXp(p.xp).level;
    for (let l = before + 1; l <= after; l++) {
      const reward = l % PROGRESS.levelRewards.every === 0 ? PROGRESS.levelRewards.reward : undefined;
      if (reward) this.grant({ ...reward, xp: 0 });
      this.notify({ type: 'levelUp', level: l, ...(reward ? { reward } : {}) });
    }
  }

  /** Pay a reward out: XP to the profile, resources to the stock (never past the storage cap). Returns what did not fit. */
  private grant(r: Reward): Reward {
    const lost: Reward = {};
    if (r.xp) this.addXp(r.xp, 'Reward', false); // the achievement / claim card already names it
    const cap = storageCap(this.base.facilities.storage);
    for (const k of ['scrap', 'food', 'materials'] as const) {
      const amt = r[k] ?? 0;
      if (amt <= 0) continue;
      const cur = this.base.stock[k];
      const next = Math.min(Math.max(cap, cur), cur + amt);
      this.base.stock[k] = next;
      if (cur + amt > next) lost[k] = cur + amt - next;
    }
    return lost;
  }

  // ───────────── claiming ─────────────

  claim(id: string): ClaimResult {
    const entry = this.activeInstances().find((e) => e.def.id === id);
    if (!entry) return { ok: false, reason: 'unknown', notices: [] };
    const { def, inst } = entry;
    if (inst.claimed) return { ok: false, reason: 'claimed', notices: [] };
    if (!this.met(def.requires).ok) return { ok: false, reason: 'locked', notices: [] };
    if (inst.progress < this.targetOf(def)) return { ok: false, reason: 'incomplete', notices: [] };
    inst.claimed = true; // flagged before paying out, so a second click can never double-pay
    const lost = this.grant(def.reward);
    this.sync(); // claiming a campaign step can unlock the next one
    const r = this.commit();
    return { ok: true, reward: def.reward, lost, notices: r.notices };
  }

  /**
   * Story items the next expedition should contain: one per unlocked, unfinished campaign step that asks for them.
   * Only Scouting and Risky maps carry story items (Safe maps are a single small house).
   */
  storyItemsFor(difficulty: string): StoryKey[] {
    if (difficulty === 'safe') return [];
    const out: StoryKey[] = [];
    for (const def of this.content.campaign) {
      const o = def.objective;
      if (o.kind !== 'counter' || (o.metric !== 'transmitters' && o.metric !== 'researchers')) continue;
      const inst = this.campaignInstance(def.id);
      if (inst.claimed || inst.progress >= o.target || !this.met(def.requires).ok) continue;
      const key: StoryKey = o.metric === 'transmitters' ? 'transmitter' : 'researcher';
      if (!out.includes(key)) out.push(key);
    }
    return out;
  }

  // ───────────── views for the UI ─────────────

  level(): LevelInfo {
    return levelFromXp(this.p.xp);
  }

  missions(cat: MissionCategory): MissionView[] {
    const rows: { def: MissionDef; inst: MissionInstance }[] =
      cat === 'campaign'
        ? this.content.campaign.map((def) => ({ def, inst: this.campaignInstance(def.id) }))
        : this.p[cat].missions.flatMap((inst) => {
            const def = this.defOf(inst.id);
            return def ? [{ def, inst }] : [];
          });
    return rows.map(({ def, inst }) => {
      const m = this.met(def.requires);
      const target = this.targetOf(def);
      return {
        def,
        category: cat,
        progress: Math.min(target, inst.progress),
        target,
        done: inst.progress >= target,
        claimed: inst.claimed,
        unlocked: m.ok,
        ...(m.why ? { lockedReason: m.why } : {}),
      };
    });
  }

  achievements(): AchievementView[] {
    return this.content.achievements.map((def) => {
      const st = this.p.achievements[def.id];
      const m = this.met(def.requires);
      const target = def.objective.target;
      const value = def.objective.kind === 'counter' ? this.lifetime(def.objective.metric) : this.stateValue(def.objective.metric);
      const done = !!st?.done;
      return { def, progress: done ? target : Math.min(target, value), target, done, unlocked: m.ok, ...(m.why ? { lockedReason: m.why } : {}) };
    });
  }

  private doneCount(): number {
    return this.content.achievements.filter((a) => this.p.achievements[a.id]?.done).length;
  }

  /** Completed missions waiting for the player to claim them (for the badge on the Missions button). */
  unclaimed(): number {
    return (['daily', 'weekly', 'campaign'] as const).reduce((n, c) => n + this.missions(c).filter((m) => m.done && !m.claimed && m.unlocked).length, 0);
  }

  profile(): ProfileView {
    const s = this.p.stats;
    const total = this.content.achievements.length;
    const done = this.doneCount();
    return {
      level: this.level(),
      stats: { ...s },
      achievementsDone: done,
      achievementsTotal: total,
      achievementPct: total ? Math.round((done / total) * 100) : 0,
      missionsCompleted: s.missions,
      successRate: s.expeditions > 0 ? s.escapes / s.expeditions : null,
      daysSurvived: Math.max(0, this.base.day - 1),
      day: this.base.day,
    };
  }
}

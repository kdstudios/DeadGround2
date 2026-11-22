import type { Difficulty } from '../gen/difficulty.js';

/**
 * Types for the progression layer (player level, achievements, missions).
 * Everything here is plain JSON so it can live inside the existing save (`BaseState.progress`).
 */

/** What a reward can contain. Resources go into the safehouse stock (respecting the storage cap). */
export interface Reward {
  xp?: number;
  scrap?: number;
  food?: number;
  materials?: number;
}

/**
 * Lifetime counters ("metrics"). Gameplay events are translated into increments of these; achievements read
 * them directly, missions track their own per-period copy of the same metrics.
 */
export type Metric =
  | 'expeditions' // every expedition finished (escaped or failed)
  | 'escapes' // expeditions escaped alive
  | 'failures' // expeditions failed / abandoned
  | 'riskyEscapes'
  | 'scoutingEscapes'
  | 'safeEscapes'
  | 'untouchable' // escapes in which no heart was lost
  | 'zombies' // zombies killed (expeditions and night defence)
  | 'survivors' // survivors rescued and brought home
  | 'vaults'
  | 'nights' // nights survived (defended, or a quiet skipped night)
  | 'defences' // night defences won
  | 'upgrades' // facility upgrades bought
  | 'scrap' // scrap brought home from expeditions
  | 'regions' // distinct regions escaped from
  | 'missions' // missions completed (a statistic; also usable as an objective)
  | 'transmitters' // military radio transmitters brought home
  | 'researchers'; // research-team members brought home

/** Values read live from the safehouse rather than counted from events. */
export type StateMetric =
  | 'day'
  | 'level' // player level
  | 'facility:storage'
  | 'facility:garden'
  | 'facility:workshop'
  | 'facility:radio'
  | 'facility:armoury'
  | 'facility:barricades'
  | 'facility:watchtower'
  | 'survivorsInBase';

export type Objective =
  | { kind: 'counter'; metric: Metric; target: number }
  | { kind: 'state'; metric: StateMetric; target: number };

/** Optional gate: the entry stays locked (and cannot complete) until every listed condition holds. */
export interface Requirement {
  playerLevel?: number;
  /** Achievement id that must be completed. */
  achievement?: string;
  /** Campaign mission id that must have been claimed. */
  mission?: string;
}

export type AchievementCategory = 'combat' | 'exploration' | 'base' | 'survival';

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  category: AchievementCategory;
  objective: Objective;
  reward: Reward;
  requires?: Requirement;
}

export type MissionCategory = 'daily' | 'weekly' | 'campaign';

export interface MissionDef {
  id: string;
  category: MissionCategory;
  name: string;
  desc: string;
  objective: Objective;
  reward: Reward;
  requires?: Requirement;
}

/** Gameplay events the progression service understands. The game feeds these in; nothing else touches progress. */
export type ProgEvent =
  | {
      type: 'expeditionEnded';
      /** Unique per run; a repeated id is ignored (reload, double click). */
      id: string;
      difficulty: Difficulty;
      region: string;
      escaped: boolean;
      /** Hearts lost during the run. */
      damageTaken: number;
      /** Survivors that joined the safehouse. */
      rescued: number;
      /** Scrap brought home. */
      scrap: number;
      /** Campaign story items carried out (only meaningful when escaped). */
      story?: { transmitter: number; researcher: number };
    }
  | { type: 'zombieKilled'; amount: number }
  | { type: 'vaultOpened'; id: string }
  | { type: 'nightEnded'; id: string; won: boolean; skipped: boolean; killed: number }
  | { type: 'facilityUpgraded'; facility: string; level: number }
  | { type: 'dayReached'; day: number };

/** One mission handed out for a day / week (or a campaign slot). */
export interface MissionInstance {
  id: string;
  progress: number;
  claimed: boolean;
  /** Distinct keys seen so far (regions), for objectives that count distinct things. */
  keys?: string[];
}

export interface Board {
  /** Day index (daily) or week index (weekly) this board was generated for. */
  period: number;
  missions: MissionInstance[];
}

export type LifetimeStats = Record<Metric, number>;

export interface AchievementProgress {
  done: boolean;
  /** Epoch ms the achievement completed (display only). */
  at?: number;
}

export interface ProgressState {
  /** Schema version of this block (independent of the safehouse save version). */
  v: number;
  /** Lifetime XP; the level is derived from it, so XP can never be "lost". */
  xp: number;
  stats: LifetimeStats;
  regionsSeen: string[];
  achievements: Record<string, AchievementProgress>;
  daily: Board;
  weekly: Board;
  campaign: Record<string, MissionInstance>;
  /** Highest clock reading ever seen: the effective "now" never goes backwards (see time.ts). */
  highWater: number;
  /** Ids of recently processed events, so one run / night / vault can never pay out twice. */
  seen: string[];
  /** Set when this block was created by migrating an older save (0 = unreadable data was replaced). */
  migratedFrom?: number;
  /** True once the one-off "veteran" recognition of a migrated save has been shown. */
  welcomed?: boolean;
}

export type Notice =
  | { type: 'xp'; amount: number; reason: string }
  | { type: 'levelUp'; level: number; reward?: Reward }
  | { type: 'achievement'; id: string; name: string; reward: Reward }
  | { type: 'missionDone'; id: string; name: string; category: MissionCategory }
  | { type: 'missionAutoClaimed'; id: string; name: string; reward: Reward }
  | { type: 'veteran'; achievements: number; level: number };

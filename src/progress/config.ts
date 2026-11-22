import type { Reward } from './types.js';

/**
 * Every progression balance number lives here (XP rewards, the level curve, mission counts...),
 * so tuning never means touching the engine. Mission and achievement *content* is in missionDefs.ts / achievementDefs.ts.
 */
export const PROGRESS = {
  /** Version of the `progress` save block. Bump it and add a step in state.ts `MIGRATIONS` when the shape changes. */
  version: 2,

  xp: {
    /** XP for escaping an expedition, by difficulty. */
    expeditionEscape: { safe: 50, scouting: 80, risky: 120 },
    /** XP for an expedition that ends in failure. Zero: failing never costs XP, but it does not pay either. */
    expeditionFailed: 0,
    /** Per survivor that actually joins the safehouse. */
    rescueSurvivor: 40,
    vaultOpened: 30,
    /** A night defence that was fought and won (skipping the night pays nothing). */
    nightDefended: 40,
    /** Per zombie killed. Off by default: kills feed missions and achievements instead. */
    zombieKill: 0,
  },

  /**
   * XP needed to go from level L to L+1:  round(base + growth * (L-1) ^ exponent)
   * Level 1->2 takes 100, 5->6 about 490, 10->11 about 1260, 20->21 about 3800.
   */
  level: { max: 50, base: 100, growth: 60, exponent: 1.35 },

  /** Small resource gifts at level milestones. Deliberately modest: levels complement the economy, they do not replace it. */
  levelRewards: { every: 5, reward: { scrap: 5, materials: 3 } satisfies Reward },

  missions: {
    dailyCount: 3,
    weeklyCount: 3,
    /** When a day / week rolls over, finished-but-unclaimed missions are paid out automatically so no reward is lost. */
    autoClaimOnReset: true,
  },

  /** How many processed event ids are remembered (anti double-processing). */
  seenCap: 64,
  /** Hard ceiling on stored numbers, so a hand-edited save cannot overflow anything. */
  maxStat: 1_000_000_000,
} as const;

import type { MissionCategory, MissionDef } from './types.js';

/**
 * Mission content. Daily and weekly missions are drawn from these pools by a deterministic, date-seeded shuffle
 * (see missions.ts); campaign missions are permanent and form a chain via `requires.mission`.
 * Add a mission by appending an entry: ids must be unique and stable (they are stored in saves).
 */
export const DAILY_POOL: readonly MissionDef[] = [
  { id: 'd_scrap15', category: 'daily', name: 'Scrap Run', desc: 'Bring home 15 scrap from expeditions.', objective: { kind: 'counter', metric: 'scrap', target: 15 }, reward: { xp: 50 } },
  { id: 'd_exp2', category: 'daily', name: 'Out and Back', desc: 'Complete two expeditions.', objective: { kind: 'counter', metric: 'escapes', target: 2 }, reward: { xp: 60 } },
  { id: 'd_vault1', category: 'daily', name: 'Crack the Seal', desc: 'Open a vault.', objective: { kind: 'counter', metric: 'vaults', target: 1 }, reward: { xp: 60, scrap: 2 } },
  { id: 'd_kill10', category: 'daily', name: 'Thin the Herd', desc: 'Defeat 10 zombies.', objective: { kind: 'counter', metric: 'zombies', target: 10 }, reward: { xp: 50 } },
  { id: 'd_night1', category: 'daily', name: 'Hold the Line', desc: 'Successfully defend one night.', objective: { kind: 'counter', metric: 'defences', target: 1 }, reward: { xp: 70 } },
  { id: 'd_upgrade1', category: 'daily', name: 'Dig In', desc: 'Upgrade a facility.', objective: { kind: 'counter', metric: 'upgrades', target: 1 }, reward: { xp: 50 } },
];

export const WEEKLY_POOL: readonly MissionDef[] = [
  { id: 'w_rescue3', category: 'weekly', name: 'Search and Rescue', desc: 'Rescue three survivors.', objective: { kind: 'counter', metric: 'survivors', target: 3 }, reward: { xp: 120, food: 3 } },
  { id: 'w_risky5', category: 'weekly', name: 'High Risk, High Reward', desc: 'Complete five Risky expeditions.', objective: { kind: 'counter', metric: 'riskyEscapes', target: 5 }, reward: { xp: 150, scrap: 6 } },
  { id: 'w_upgrade2', category: 'weekly', name: 'Fortify', desc: 'Upgrade two facilities.', objective: { kind: 'counter', metric: 'upgrades', target: 2 }, reward: { xp: 100 } },
  { id: 'w_nights5', category: 'weekly', name: 'Long Nights', desc: 'Survive five nights.', objective: { kind: 'counter', metric: 'nights', target: 5 }, reward: { xp: 120, food: 3 } },
  { id: 'w_regions3', category: 'weekly', name: 'Cartographer', desc: 'Explore three regions.', objective: { kind: 'counter', metric: 'regions', target: 3 }, reward: { xp: 130, materials: 3 } },
  { id: 'w_vault3', category: 'weekly', name: 'Lockbreaker', desc: 'Open three vaults.', objective: { kind: 'counter', metric: 'vaults', target: 3 }, reward: { xp: 110, materials: 2 } },
];

/**
 * Campaign: permanent objectives that will later hang off a bigger storyline. Each step unlocks when the previous one
 * has been claimed. Counter objectives only count from the moment their step unlocks.
 * The transmitter and research-team steps use real story pickups: while such a step is active, Scouting and Risky maps are
 * generated with that item inside a building (see ProgressionService.storyItemsFor).
 */
export const CAMPAIGN: readonly MissionDef[] = [
  { id: 'c_comms', category: 'campaign', name: 'Open the Channel', desc: 'Build the communications room (Radio) at the safehouse.', objective: { kind: 'state', metric: 'facility:radio', target: 1 }, reward: { xp: 100, materials: 3 } },
  { id: 'c_transmitter', category: 'campaign', name: 'Dead Air', desc: 'Recover a military radio transmitter. It is hidden inside a building on a Scouting or Risky expedition. Bring it home alive.', objective: { kind: 'counter', metric: 'transmitters', target: 1 }, reward: { xp: 125, scrap: 8 }, requires: { mission: 'c_comms' } },
  { id: 'c_research', category: 'campaign', name: 'Missing Persons', desc: 'Find the missing research team: rescue two researchers stranded in buildings on Scouting or Risky expeditions.', objective: { kind: 'counter', metric: 'researchers', target: 2 }, reward: { xp: 150, food: 4 }, requires: { mission: 'c_transmitter' } },
  { id: 'c_tower', category: 'campaign', name: 'First Light', desc: 'Activate the first radio tower: upgrade the Radio to level 2.', objective: { kind: 'state', metric: 'facility:radio', target: 2 }, reward: { xp: 150, scrap: 10, materials: 5 }, requires: { mission: 'c_research' } },
];

export const missionPool = (c: Exclude<MissionCategory, 'campaign'>): readonly MissionDef[] => (c === 'daily' ? DAILY_POOL : WEEKLY_POOL);

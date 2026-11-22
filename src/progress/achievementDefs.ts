import type { AchievementDef } from './types.js';

/**
 * Achievements are pure data: to add one, append an entry. Progress is read from the lifetime counters
 * (or the live safehouse state), so no engine change is needed unless you invent a brand-new metric.
 * Rewards are XP plus, now and then, a small resource gift.
 */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'first_blood', name: 'First Blood', desc: 'Kill your first zombie.', category: 'combat', objective: { kind: 'counter', metric: 'zombies', target: 1 }, reward: { xp: 25 } },
  { id: 'scavenger', name: 'Scavenger', desc: 'Recover 500 scrap.', category: 'exploration', objective: { kind: 'counter', metric: 'scrap', target: 500 }, reward: { xp: 150, materials: 5 } },
  { id: 'home_sweet_home', name: 'Home Sweet Home', desc: 'Upgrade three facilities.', category: 'base', objective: { kind: 'counter', metric: 'upgrades', target: 3 }, reward: { xp: 75 } },
  { id: 'survivor', name: 'Survivor', desc: 'Reach Day 10.', category: 'survival', objective: { kind: 'state', metric: 'day', target: 10 }, reward: { xp: 100, food: 4 } },
  { id: 'commander', name: 'Commander', desc: 'Recruit five survivors.', category: 'base', objective: { kind: 'counter', metric: 'survivors', target: 5 }, reward: { xp: 125 } },
  { id: 'daredevil', name: 'Daredevil', desc: 'Successfully escape five Risky expeditions.', category: 'exploration', objective: { kind: 'counter', metric: 'riskyEscapes', target: 5 }, reward: { xp: 200, scrap: 10 } },
  { id: 'untouchable', name: 'Untouchable', desc: 'Complete an expedition without taking damage.', category: 'exploration', objective: { kind: 'counter', metric: 'untouchable', target: 1 }, reward: { xp: 100 } },
  { id: 'explorer', name: 'Explorer', desc: 'Complete 20 expeditions.', category: 'exploration', objective: { kind: 'counter', metric: 'escapes', target: 20 }, reward: { xp: 200, scrap: 8 } },
  { id: 'vault_hunter', name: 'Vault Hunter', desc: 'Open 10 vaults.', category: 'exploration', objective: { kind: 'counter', metric: 'vaults', target: 10 }, reward: { xp: 175, materials: 6 } },
  { id: 'last_stand', name: 'Last Stand', desc: 'Survive 10 night defences.', category: 'combat', objective: { kind: 'counter', metric: 'defences', target: 10 }, reward: { xp: 200 } },
];

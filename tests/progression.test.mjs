import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as B from '../dist/core/base.js';
import { ProgressionService, pickMissions } from '../dist/progress/service.js';
import { levelFromXp, xpToNext, xpForLevel } from '../dist/progress/xp.js';
import { PROGRESS } from '../dist/progress/config.js';
import { ACHIEVEMENTS } from '../dist/progress/achievementDefs.js';
import { DAILY_POOL, WEEKLY_POOL, CAMPAIGN } from '../dist/progress/missionDefs.js';
import { dayIndex, weekIndex, DAY_MS } from '../dist/progress/time.js';
import { migrateProgress, sanitizeProgress, newProgress } from '../dist/progress/state.js';
import { make, run } from './helpers.mjs';

// 2026-03-02 is a Monday
const MON = Date.UTC(2026, 2, 2, 12, 0, 0);
function setup(now = MON, mutate) {
  const base = B.newBase();
  mutate?.(base);
  const clock = { t: now };
  let saves = 0;
  const svc = new ProgressionService(base, () => saves++, { now: () => clock.t });
  return { base, svc, clock, saves: () => saves };
}
let n = 0;
const exp = (over = {}) => ({ type: 'expeditionEnded', id: `e${n++}`, difficulty: 'safe', region: 'wasteland', escaped: true, damageTaken: 1, rescued: 0, scrap: 0, ...over });
const notice = (r, t) => r.notices.filter((x) => x.type === t);

// ───────────── XP and levels ─────────────

test('level curve: starts at 1, strictly increasing cost, consistent with levelFromXp', () => {
  assert.equal(levelFromXp(0).level, 1);
  assert.equal(xpToNext(1), 100);
  for (let l = 1; l < 49; l++) assert.ok(xpToNext(l + 1) > xpToNext(l));
  for (let l = 1; l <= 50; l++) {
    const at = xpForLevel(l);
    assert.equal(levelFromXp(at).level, l);
    if (l > 1) assert.equal(levelFromXp(at - 1).level, l - 1);
  }
  const top = levelFromXp(xpForLevel(PROGRESS.level.max) + 99999);
  assert.equal(top.level, PROGRESS.level.max);
  assert.ok(top.maxed);
  assert.equal(levelFromXp(NaN).level, 1);
  assert.equal(levelFromXp(-5).level, 1);
});

test('progression is not too fast: level 10 needs dozens of expeditions', () => {
  assert.ok(xpForLevel(10) / PROGRESS.xp.expeditionEscape.risky > 25);
});

test('expedition XP follows the configured table and never goes down on failure', () => {
  const { svc } = setup();
  for (const [d, xp] of [['safe', 50], ['scouting', 80], ['risky', 120]]) {
    const before = svc.profile().level.total;
    const r = svc.handle(exp({ difficulty: d }));
    const gain = svc.profile().level.total - before;
    assert.ok(gain >= xp); // plus any achievement XP unlocked by it
    assert.ok(r.xp >= xp);
  }
  const before = svc.profile().level.total;
  svc.handle(exp({ escaped: false }));
  assert.ok(svc.profile().level.total >= before);
  assert.equal(PROGRESS.xp.expeditionFailed, 0);
});

test('rescued survivors, vaults and defended nights pay their XP; skipped nights pay none', () => {
  const { svc } = setup();
  svc.handle({ type: 'zombieKilled', amount: 1 }); // unlock first blood so it cannot muddy the numbers
  const xp0 = () => svc.profile().level.total;
  let a = xp0();
  svc.handle({ type: 'vaultOpened', id: 'v1' });
  assert.equal(xp0() - a, 30);
  a = xp0();
  svc.handle({ type: 'nightEnded', id: 'n1', won: true, skipped: true, killed: 0 });
  assert.equal(xp0() - a, 0);
  a = xp0();
  svc.handle({ type: 'nightEnded', id: 'n2', won: true, skipped: false, killed: 5 });
  assert.equal(xp0() - a, 40);
  a = xp0();
  svc.handle({ type: 'nightEnded', id: 'n3', won: false, skipped: false, killed: 5 });
  assert.equal(xp0() - a, 0);
  assert.equal(svc.profile().stats.nights, 2); // skipped + defended; a lost night is not survived
  a = xp0();
  svc.handle(exp({ rescued: 2 }));
  assert.ok(xp0() - a >= 50 + 2 * 40); // 50 for a Safe escape + 40 per rescued survivor (plus any achievement XP)
});

test('events with an id are processed once (reload / double-fire cannot pay twice)', () => {
  const { svc } = setup();
  const e = exp({ difficulty: 'risky', scrap: 10 });
  svc.handle(e);
  const once = JSON.parse(JSON.stringify(svc.profile()));
  const r = svc.handle(e);
  assert.deepEqual(r, { xp: 0, notices: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(svc.profile())), once);
  svc.handle({ type: 'vaultOpened', id: 'same' });
  svc.handle({ type: 'vaultOpened', id: 'same' });
  assert.equal(svc.profile().stats.vaults, 1);
});

test('level-ups raise a notice for every level crossed and give the milestone gift every 5th level', () => {
  const { svc, base } = setup();
  base.facilities.storage = 3;
  const scrap0 = base.stock.scrap;
  // 'risky' escapes: 120 XP each
  const seen = [];
  svc.on((nn) => nn.type === 'levelUp' && seen.push(nn.level));
  for (let i = 0; i < 12; i++) svc.handle(exp({ difficulty: 'risky' }));
  assert.ok(seen.length >= 4);
  assert.deepEqual(seen, seen.map((_, i) => i + 2));
  assert.ok(seen.includes(5));
  assert.ok(base.stock.scrap >= scrap0 + PROGRESS.levelRewards.reward.scrap);
});

// ───────────── achievements ─────────────

const done = (svc, id) => svc.achievements().find((a) => a.def.id === id).done;

test('First Blood, Scavenger, Daredevil, Untouchable, Explorer, Vault Hunter, Last Stand, Commander', () => {
  const { svc } = setup();
  assert.equal(done(svc, 'first_blood'), false);
  svc.handle({ type: 'zombieKilled', amount: 1 });
  assert.ok(done(svc, 'first_blood'));

  svc.handle(exp({ scrap: 499, difficulty: 'scouting' }));
  assert.equal(done(svc, 'scavenger'), false);
  svc.handle(exp({ scrap: 1 }));
  assert.ok(done(svc, 'scavenger'));

  assert.equal(done(svc, 'untouchable'), false);
  svc.handle(exp({ damageTaken: 0 }));
  assert.ok(done(svc, 'untouchable'));

  for (let i = 0; i < 4; i++) svc.handle(exp({ difficulty: 'risky' }));
  assert.equal(done(svc, 'daredevil'), false);
  svc.handle(exp({ difficulty: 'risky' }));
  assert.ok(done(svc, 'daredevil'));
  svc.handle(exp({ escaped: false, difficulty: 'risky' })); // failures never count
  assert.equal(svc.profile().stats.riskyEscapes, 5);

  assert.equal(done(svc, 'explorer'), false); // 3 + 5 + ... escapes so far
  while (svc.profile().stats.escapes < 20) svc.handle(exp());
  assert.ok(done(svc, 'explorer'));

  for (let i = 0; i < 9; i++) svc.handle({ type: 'vaultOpened', id: `v${i}` });
  assert.equal(done(svc, 'vault_hunter'), false);
  svc.handle({ type: 'vaultOpened', id: 'v9' });
  assert.ok(done(svc, 'vault_hunter'));

  for (let i = 0; i < 9; i++) svc.handle({ type: 'nightEnded', id: `n${i}`, won: true, skipped: false, killed: 3 });
  assert.equal(done(svc, 'last_stand'), false);
  svc.handle({ type: 'nightEnded', id: 'n9', won: true, skipped: false, killed: 3 });
  assert.ok(done(svc, 'last_stand'));

  svc.handle(exp({ rescued: 4 }));
  assert.equal(done(svc, 'commander'), false);
  svc.handle(exp({ rescued: 1 }));
  assert.ok(done(svc, 'commander'));
});

test('Home Sweet Home counts upgrades; Survivor needs day 10', () => {
  const { svc, base } = setup();
  for (let i = 1; i <= 2; i++) svc.handle({ type: 'facilityUpgraded', facility: 'radio', level: i });
  assert.equal(done(svc, 'home_sweet_home'), false);
  svc.handle({ type: 'facilityUpgraded', facility: 'garden', level: 1 });
  assert.ok(done(svc, 'home_sweet_home'));
  base.day = 9;
  svc.handle({ type: 'dayReached', day: 9 });
  assert.equal(done(svc, 'survivor'), false);
  base.day = 10;
  svc.handle({ type: 'dayReached', day: 10 });
  assert.ok(done(svc, 'survivor'));
});

test('an achievement is awarded exactly once and its reward is paid once', () => {
  const { svc, base } = setup();
  const r1 = svc.handle({ type: 'zombieKilled', amount: 1 });
  assert.equal(notice(r1, 'achievement').length, 1);
  const xp = svc.profile().level.total;
  const r2 = svc.handle({ type: 'zombieKilled', amount: 50 });
  assert.equal(notice(r2, 'achievement').length, 0);
  assert.equal(svc.profile().level.total, xp);
  assert.equal(svc.profile().achievementsDone, 1);
  void base;
});

test('every shipped achievement is well formed and ids are unique', () => {
  assert.equal(ACHIEVEMENTS.length, 10);
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length);
  for (const a of ACHIEVEMENTS) assert.ok(a.name && a.desc && a.category && a.reward.xp > 0 && a.objective.target > 0);
});

test('achievements can be added purely through content, including unlock conditions', () => {
  const content = {
    achievements: [
      { id: 'a_kills', name: 'Reaper', desc: '', category: 'combat', objective: { kind: 'counter', metric: 'zombies', target: 5 }, reward: { xp: 10 } },
      { id: 'a_gated', name: 'Gated', desc: '', category: 'combat', objective: { kind: 'counter', metric: 'zombies', target: 1 }, reward: { xp: 10 }, requires: { achievement: 'a_kills' } },
    ],
    daily: DAILY_POOL, weekly: WEEKLY_POOL, campaign: CAMPAIGN,
  };
  const svc = new ProgressionService(B.newBase(), () => {}, { now: () => MON, content });
  svc.handle({ type: 'zombieKilled', amount: 3 });
  assert.equal(svc.achievements()[1].unlocked, false);
  assert.equal(svc.achievements()[1].done, false);
  svc.handle({ type: 'zombieKilled', amount: 2 });
  assert.ok(svc.achievements()[0].done);
  assert.ok(svc.achievements()[1].done); // unlocked in the same sync, progress already there
});

// ───────────── missions ─────────────

test('time helpers: UTC days, Monday-based weeks', () => {
  assert.equal(dayIndex(0), 0);
  assert.equal(weekIndex(MON), weekIndex(MON + 6 * DAY_MS - 12 * 3600e3 - 1)); // through Sunday night
  assert.equal(weekIndex(MON + 6 * DAY_MS + 12 * 3600e3), weekIndex(MON) + 1); // Monday 00:00 UTC starts a new week
  assert.equal(new Date(MON).getUTCDay(), 1);
});

test('daily and weekly boards are deterministic per period and need no storage', () => {
  const a = pickMissions(DAILY_POOL, 'daily', 20000, 3).map((m) => m.id);
  const b = pickMissions(DAILY_POOL, 'daily', 20000, 3).map((m) => m.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 3);
  const seen = new Set();
  for (let d = 20000; d < 20030; d++) seen.add(pickMissions(DAILY_POOL, 'daily', d, 3).map((m) => m.id).join());
  assert.ok(seen.size > 10); // variety over a month
  const x = setup().svc.missions('daily').map((m) => m.def.id);
  const y = setup().svc.missions('daily').map((m) => m.def.id);
  assert.deepEqual(x, y);
  assert.equal(x.length, PROGRESS.missions.dailyCount);
  assert.equal(setup().svc.missions('weekly').length, PROGRESS.missions.weeklyCount);
});

// Content pinned for deterministic mission tests
const pinned = (clock) => {
  const mk = (id, cat, metric, target, reward = { xp: 50 }) => ({ id, category: cat, name: id, desc: '', objective: { kind: 'counter', metric, target }, reward });
  return {
    achievements: [],
    daily: [mk('d1', 'daily', 'escapes', 2), mk('d2', 'daily', 'scrap', 15), mk('d3', 'daily', 'zombies', 10)],
    weekly: [mk('w1', 'weekly', 'riskyEscapes', 2, { xp: 100, scrap: 5 }), mk('w2', 'weekly', 'regions', 3), mk('w3', 'weekly', 'upgrades', 2)],
    campaign: [
      { id: 'c1', category: 'campaign', name: 'c1', desc: '', objective: { kind: 'state', metric: 'facility:radio', target: 1 }, reward: { xp: 10 } },
      { id: 'c2', category: 'campaign', name: 'c2', desc: '', objective: { kind: 'counter', metric: 'vaults', target: 2 }, reward: { xp: 20 }, requires: { mission: 'c1' } },
    ],
    _clock: clock,
  };
};
function mSetup(now = MON) {
  const base = B.newBase();
  const clock = { t: now };
  const svc = new ProgressionService(base, () => {}, { now: () => clock.t, content: pinned() });
  return { base, svc, clock };
}
const mv = (svc, cat, id) => svc.missions(cat).find((m) => m.def.id === id);

test('missions track progress automatically from gameplay events', () => {
  const { svc } = mSetup();
  svc.handle(exp());
  assert.equal(mv(svc, 'daily', 'd1').progress, 1);
  svc.handle(exp({ scrap: 10 }));
  assert.ok(mv(svc, 'daily', 'd1').done);
  assert.equal(mv(svc, 'daily', 'd2').progress, 10);
  svc.handle({ type: 'zombieKilled', amount: 4 });
  svc.handle({ type: 'nightEnded', id: 'nn', won: true, skipped: false, killed: 7 });
  assert.ok(mv(svc, 'daily', 'd3').done);
  assert.equal(mv(svc, 'daily', 'd3').progress, 10); // capped at the target
});

test('claiming: only when complete, only once, rewards land in the stock and XP', () => {
  const { svc, base } = mSetup();
  assert.equal(svc.claim('d1').reason, 'incomplete');
  assert.equal(svc.claim('nope').reason, 'unknown');
  svc.handle(exp({ difficulty: 'risky' }));
  svc.handle(exp({ difficulty: 'risky' }));
  assert.equal(svc.unclaimed(), 2); // d1 and w1
  const scrap = base.stock.scrap;
  const xp = svc.profile().level.total;
  const r = svc.claim('w1');
  assert.ok(r.ok);
  assert.equal(base.stock.scrap, scrap + 5);
  assert.equal(svc.profile().level.total, xp + 100);
  const again = svc.claim('w1');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'claimed');
  assert.equal(base.stock.scrap, scrap + 5);
  assert.equal(svc.profile().level.total, xp + 100);
  assert.equal(svc.unclaimed(), 1);
});

test('claim rewards respect the storage cap and report what was lost', () => {
  const { svc, base } = mSetup();
  base.stock.scrap = 30; // exactly full at storage level 0
  svc.handle(exp({ difficulty: 'risky' }));
  svc.handle(exp({ difficulty: 'risky' }));
  const r = svc.claim('w1');
  assert.equal(base.stock.scrap, 30);
  assert.deepEqual(r.lost, { scrap: 5 });
});

test('daily missions reset on a new UTC day, weekly on Monday; unfinished progress does not carry over', () => {
  const { svc, clock } = mSetup(Date.UTC(2026, 2, 4, 12)); // Wednesday
  svc.handle(exp({ scrap: 5 }));
  assert.equal(mv(svc, 'daily', 'd2').progress, 5);
  clock.t = Date.UTC(2026, 2, 4, 23, 59);
  svc.refresh();
  assert.equal(mv(svc, 'daily', 'd2').progress, 5); // same day
  clock.t = Date.UTC(2026, 2, 5, 0, 1); // Thursday
  svc.refresh();
  assert.equal(mv(svc, 'daily', 'd2').progress, 0);
  assert.equal(svc.profile().stats.scrap, 5); // lifetime stats are never reset
  svc.handle(exp({ difficulty: 'risky' }));
  assert.equal(mv(svc, 'weekly', 'w1').progress, 1);
  clock.t = Date.UTC(2026, 2, 8, 23, 59); // Sunday
  svc.refresh();
  assert.equal(mv(svc, 'weekly', 'w1').progress, 1);
  clock.t = Date.UTC(2026, 2, 9, 0, 1); // Monday
  svc.refresh();
  assert.equal(mv(svc, 'weekly', 'w1').progress, 0);
});

test('a finished but unclaimed mission is paid out automatically when its period ends', () => {
  const { svc, base, clock } = mSetup();
  svc.handle(exp());
  svc.handle(exp());
  assert.ok(mv(svc, 'daily', 'd1').done);
  const xp = svc.profile().level.total;
  clock.t += DAY_MS;
  const r = svc.refresh();
  assert.equal(notice(r, 'missionAutoClaimed').length, 1);
  assert.equal(svc.profile().level.total, xp + 50);
  clock.t += DAY_MS;
  svc.refresh();
  assert.equal(svc.profile().level.total, xp + 50); // not paid again
  void base;
});

test('winding the clock back never re-opens a finished day or week', () => {
  const { svc, clock } = mSetup();
  svc.handle(exp());
  svc.handle(exp());
  assert.ok(mv(svc, 'daily', 'd1').done);
  assert.equal(svc.claim('d1').ok, true);
  const xp = svc.profile().level.total;
  clock.t -= 3 * DAY_MS;
  svc.refresh();
  assert.equal(mv(svc, 'daily', 'd1').claimed, true);
  svc.handle(exp());
  clock.t += 2 * DAY_MS; // still before the high-water mark
  svc.refresh();
  assert.equal(mv(svc, 'daily', 'd1').claimed, true);
  assert.ok(svc.profile().level.total >= xp);
  assert.equal(svc.claim('d1').ok, false);
});

test('a reload (new service over the same saved state) keeps boards and progress', () => {
  const { base, svc, clock } = setup();
  const scrapMission = svc.missions('daily').find((m) => m.def.objective.metric === 'scrap') ?? null;
  svc.handle(exp({ scrap: 7 }));
  const loaded = B.deserialize(B.serialize(base));
  const svc2 = new ProgressionService(loaded, () => {}, { now: () => clock.t });
  assert.deepEqual(svc2.missions('daily').map((m) => [m.def.id, m.progress]), svc.missions('daily').map((m) => [m.def.id, m.progress]));
  assert.deepEqual(svc2.missions('weekly').map((m) => m.def.id), svc.missions('weekly').map((m) => m.def.id));
  assert.equal(svc2.profile().stats.scrap, 7);
  if (scrapMission) assert.equal(svc2.missions('daily').find((m) => m.def.id === scrapMission.def.id).progress, 7);
});

test('weekly "explore three regions" counts distinct regions only', () => {
  const { svc } = mSetup();
  svc.handle(exp({ region: 'forest' }));
  svc.handle(exp({ region: 'forest' }));
  assert.equal(mv(svc, 'weekly', 'w2').progress, 1);
  svc.handle(exp({ region: 'industrial' }));
  svc.handle(exp({ region: 'wasteland' }));
  assert.ok(mv(svc, 'weekly', 'w2').done);
});

test('campaign missions: chained unlocks, state-based progress, never reset, survive the clock', () => {
  const { svc, base, clock } = mSetup();
  assert.equal(mv(svc, 'campaign', 'c2').unlocked, false);
  svc.handle({ type: 'vaultOpened', id: 'early' }); // before c2 unlocks: does not count towards it
  assert.equal(mv(svc, 'campaign', 'c2').progress, 0);
  base.facilities.radio = 1;
  svc.handle({ type: 'facilityUpgraded', facility: 'radio', level: 1 });
  assert.ok(mv(svc, 'campaign', 'c1').done);
  assert.equal(svc.claim('c2').reason, 'locked');
  assert.ok(svc.claim('c1').ok);
  assert.ok(mv(svc, 'campaign', 'c2').unlocked);
  svc.handle({ type: 'vaultOpened', id: 'v-a' });
  svc.handle({ type: 'vaultOpened', id: 'v-b' });
  assert.ok(mv(svc, 'campaign', 'c2').done);
  clock.t += 400 * DAY_MS; // a year later
  svc.refresh();
  assert.ok(mv(svc, 'campaign', 'c2').done);
  assert.equal(mv(svc, 'campaign', 'c1').claimed, true);
});

test('shipped content is consistent', () => {
  const ids = [...DAILY_POOL, ...WEEKLY_POOL, ...CAMPAIGN].map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(DAILY_POOL.length >= PROGRESS.missions.dailyCount && WEEKLY_POOL.length >= PROGRESS.missions.weeklyCount);
  assert.equal(CAMPAIGN.length, 4);
  for (const m of [...DAILY_POOL, ...WEEKLY_POOL, ...CAMPAIGN]) assert.ok(m.name && m.desc && m.reward.xp >= 50 && m.reward.xp <= 150);
  for (const c of CAMPAIGN.filter((c) => c.requires?.mission)) assert.ok(CAMPAIGN.some((x) => x.id === c.requires.mission));
});

// ───────────── save, migration, corruption ─────────────

const v20 = () => JSON.parse(readFileSync(new URL('./fixtures/v20-save.json', import.meta.url), 'utf8'));

test('v20 save: loads, keeps every old field, gains a migrated progress block', () => {
  const old = v20();
  assert.equal(old.progress, undefined);
  const b = B.deserialize(JSON.stringify(old));
  assert.ok(b);
  for (const k of ['day', 'stamina', 'stock', 'kit', 'survivors', 'facilities', 'nextSurvivorId']) assert.deepEqual(b[k], old[k], k);
  assert.equal(b.version, 1);
  assert.equal(b.progress.migratedFrom, 20);
  assert.equal(b.progress.stats.nights, 11);
  assert.equal(b.progress.stats.survivors, 3);
  assert.equal(b.progress.stats.upgrades, 5);
});

test('v20 save: existing progress is recognised once (veteran notice), nothing is reset or paid twice', () => {
  const b = B.deserialize(JSON.stringify(v20()));
  let saves = 0;
  const svc = new ProgressionService(b, () => saves++, { now: () => MON });
  assert.ok(saves > 0);
  assert.ok(done(svc, 'survivor')); // day 12
  assert.ok(done(svc, 'home_sweet_home')); // 5 upgrades
  assert.equal(done(svc, 'first_blood'), false);
  assert.equal(b.progress.welcomed, true);
  const xp = svc.profile().level.total;
  assert.ok(xp >= 175);
  assert.equal(b.stock.food, 24); // 20 + survivor reward (4)
  assert.equal(b.survivors.length, 3);
  assert.equal(b.facilities.radio, 2);
  // campaign: radio already built, so the first step is complete and waiting to be claimed
  assert.ok(svc.missions('campaign')[0].done);
  assert.equal(svc.missions('campaign')[0].claimed, false);
  // load it again (as after a reload): no second payout
  const b2 = B.deserialize(B.serialize(b));
  const svc2 = new ProgressionService(b2, () => {}, { now: () => MON + 1000 });
  assert.equal(svc2.profile().level.total, xp);
  assert.equal(b2.stock.food, 24);
});

test('v20 save: one veteran summary notice on first load, none on later loads, no per-item pop-ups', () => {
  const b = B.deserialize(JSON.stringify(v20()));
  const got = [];
  const svc = new ProgressionService(b, () => {}, { now: () => MON, listener: (x) => got.push(x) });
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'veteran');
  assert.equal(got[0].achievements, 2);
  assert.equal(got[0].level, svc.level().level);
  const got2 = [];
  new ProgressionService(B.deserialize(B.serialize(b)), () => {}, { now: () => MON, listener: (x) => got2.push(x) });
  assert.equal(got2.length, 0);
});

test('save-code round trip (btoa JSON, as the game exports it) keeps progression intact', () => {
  const { base, svc } = setup();
  svc.handle(exp({ difficulty: 'risky', scrap: 40, rescued: 1 }));
  svc.handle({ type: 'vaultOpened', id: 'x' });
  const code = btoa(B.serialize(base));
  const back = B.deserialize(atob(code));
  assert.deepEqual(back.progress, base.progress);
});

test('corrupted progress data is repaired or replaced without losing the safehouse', () => {
  const cases = [
    { progress: 'garbage' },
    { progress: 42 },
    { progress: null },
    { progress: [] },
    { progress: { v: 'x', xp: 'lots', stats: 5, achievements: [], daily: 3, weekly: { missions: 'no' }, campaign: 'x', seen: 9 } },
    { progress: { v: 1, xp: -50, stats: { zombies: -3, scrap: NaN, vaults: 1e99 }, achievements: { first_blood: 7, nope: { done: true } }, daily: { period: 'a', missions: [{ id: 'bogus' }, null, 5] } } },
    { progress: { v: 99, xp: 500, mystery: true } },
  ];
  for (const c of cases) {
    const b = B.deserialize(JSON.stringify({ ...v20(), ...c }));
    assert.ok(b, JSON.stringify(c));
    assert.equal(b.day, 12);
    assert.equal(b.survivors.length, 3);
    const svc = new ProgressionService(b, () => {}, { now: () => MON });
    const p = svc.profile();
    assert.ok(Number.isFinite(p.level.total) && p.level.total >= 0);
    assert.ok(svc.missions('daily').length === PROGRESS.missions.dailyCount);
    for (const v of Object.values(p.stats)) assert.ok(Number.isInteger(v) && v >= 0 && v <= PROGRESS.maxStat);
    svc.handle(exp()); // still functional afterwards
  }
});

test('sanitizeProgress / migrateProgress edge cases', () => {
  assert.equal(sanitizeProgress('x'), null);
  assert.equal(sanitizeProgress(null), null);
  const p = sanitizeProgress({ xp: 10.9, achievements: { first_blood: { done: true, at: 5 } } });
  assert.equal(p.xp, 10);
  assert.deepEqual(p.achievements.first_blood, { done: true, at: 5 });
  const m = migrateProgress({ v: 1, xp: 300 }, { day: 3, survivors: [], facilities: B.newBase().facilities });
  assert.equal(m.xp, 300);
  assert.equal(m.v, PROGRESS.version);
  const fresh = migrateProgress('trash', { day: 3, survivors: [], facilities: B.newBase().facilities });
  assert.equal(fresh.migratedFrom, 0);
  assert.equal(fresh.stats.nights, 2);
  assert.deepEqual(Object.keys(newProgress().stats).sort(), Object.keys(fresh.stats).sort());
});

test('a brand-new game starts at level 1 with no migration flag', () => {
  const { svc, base } = setup();
  assert.equal(svc.profile().level.level, 1);
  assert.equal(base.progress.migratedFrom, undefined);
  assert.equal(svc.profile().achievementsDone, 0);
  assert.equal(svc.profile().successRate, null);
});

test('onChange fires after mutations so the owner can persist', () => {
  const { svc, saves } = setup();
  const s0 = saves();
  svc.handle(exp());
  assert.ok(saves() > s0);
  const s1 = saves();
  svc.claim('nope');
  assert.equal(saves(), s1);
});

// ───────────── core hooks ─────────────

test('Level tracks hearts lost (shield-absorbed hits cost none) and keeps it through snapshot/restore', () => {
  const l = make(['#####', '#S.m#', '#####']);
  assert.equal(l.damageTaken, 0);
  l.shield = 1;
  l.tap(3, 1);
  run(l, 3);
  assert.equal(l.damageTaken, 0); // shield took the mine
  assert.equal(l.hearts, 4);
  const l2 = make(['#####', '#S.m#', '#####']);
  l2.tap(3, 1);
  run(l2, 3);
  assert.equal(l2.damageTaken, 1);
  const snap = l2.snapshot();
  const l3 = make(['#####', '#S.m#', '#####']);
  assert.ok(l3.restore(snap));
  assert.equal(l3.damageTaken, 1);
  const legacy = { ...snap };
  delete legacy.damageTaken;
  const l4 = make(['#####', '#S.m#', '#####']);
  assert.ok(l4.restore(legacy));
  assert.ok(l4.damageTaken >= 1); // an old snapshot cannot prove a clean run
});

// ───────────── v22: story items in the campaign ─────────────

const story = (t = 0, r = 0) => ({ transmitter: t, researcher: r });
const campaignRows = (svc) => Object.fromEntries(svc.missions('campaign').map((m) => [m.def.id, m]));

test('campaign story chain: items are requested only while their step is active, and only for Scouting/Risky', () => {
  const { svc, base } = setup();
  assert.deepEqual(svc.storyItemsFor('scouting'), []); // comms room not built yet
  base.facilities.radio = 1;
  svc.handle({ type: 'facilityUpgraded', facility: 'radio', level: 1 });
  assert.deepEqual(svc.storyItemsFor('scouting'), []); // built, but not claimed: next step still locked
  assert.ok(svc.claim('c_comms').ok);
  assert.deepEqual(svc.storyItemsFor('scouting'), ['transmitter']);
  assert.deepEqual(svc.storyItemsFor('risky'), ['transmitter']);
  assert.deepEqual(svc.storyItemsFor('safe'), []);
  // an escape that does not carry the transmitter changes nothing; one that does completes the step
  svc.handle(exp({ difficulty: 'scouting', story: story(0, 0) }));
  assert.equal(campaignRows(svc).c_transmitter.progress, 0);
  svc.handle(exp({ difficulty: 'scouting', story: story(1, 0) }));
  assert.ok(campaignRows(svc).c_transmitter.done);
  assert.deepEqual(svc.storyItemsFor('scouting'), []); // already have it: do not spawn another
  assert.ok(svc.claim('c_transmitter').ok);
  assert.deepEqual(svc.storyItemsFor('risky'), ['researcher']);
  svc.handle(exp({ difficulty: 'risky', story: story(0, 1) }));
  assert.equal(campaignRows(svc).c_research.progress, 1);
  assert.deepEqual(svc.storyItemsFor('risky'), ['researcher']); // needs two
  svc.handle(exp({ difficulty: 'risky', story: story(0, 1) }));
  assert.ok(campaignRows(svc).c_research.done);
  assert.ok(svc.claim('c_research').ok);
  assert.deepEqual(svc.storyItemsFor('risky'), []);
  assert.equal(svc.profile().stats.transmitters, 1);
  assert.equal(svc.profile().stats.researchers, 2);
});

test('story items only count when the expedition is escaped, and only once per run', () => {
  const { svc, base } = setup();
  base.facilities.radio = 1;
  svc.handle({ type: 'dayReached', day: 1 });
  svc.claim('c_comms');
  const dead = exp({ difficulty: 'risky', escaped: false, story: story(1, 0) });
  svc.handle(dead);
  assert.equal(svc.profile().stats.transmitters, 0);
  const ok = exp({ difficulty: 'risky', story: story(1, 0) });
  svc.handle(ok);
  svc.handle(ok);
  assert.equal(svc.profile().stats.transmitters, 1);
});

test('migration v1 -> v2: unfinished transmitter / research steps restart, claimed ones and XP are kept', () => {
  const b = B.deserialize(JSON.stringify(v20()));
  const svc = new ProgressionService(b, () => {}, { now: () => MON });
  svc.claim('c_comms'); // radio is level 2 in this save
  // pretend the old (v21) vault-based steps had progress
  b.progress.v = 1;
  b.progress.campaign.c_transmitter = { id: 'c_transmitter', progress: 1, claimed: false };
  b.progress.campaign.c_research = { id: 'c_research', progress: 3, claimed: true };
  b.progress.stats.vaults = 7;
  const xp = b.progress.xp;
  const back = B.deserialize(B.serialize(b));
  assert.equal(back.progress.v, PROGRESS.version);
  assert.equal(back.progress.campaign.c_transmitter.progress, 0);
  assert.equal(back.progress.campaign.c_transmitter.claimed, false);
  assert.equal(back.progress.campaign.c_research.claimed, true);
  assert.equal(back.progress.campaign.c_comms.claimed, true);
  assert.equal(back.progress.xp, xp);
  assert.equal(back.progress.stats.vaults, 7);
  const svc2 = new ProgressionService(back, () => {}, { now: () => MON });
  assert.equal(campaignRows(svc2).c_transmitter.done, false);
});

test('shipped campaign: four steps in order, using the new story metrics', () => {
  assert.deepEqual(CAMPAIGN.map((m) => m.id), ['c_comms', 'c_transmitter', 'c_research', 'c_tower']);
  assert.equal(CAMPAIGN[1].objective.metric, 'transmitters');
  assert.equal(CAMPAIGN[2].objective.metric, 'researchers');
});

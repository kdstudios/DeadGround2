import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../dist/night/night.js';
import * as B from '../dist/core/base.js';

const fac = (o = {}) => ({ storage: 0, garden: 0, workshop: 0, armoury: 0, barricades: 0, watchtower: 0, ...o });
const surv = (n, role = 'soldier') => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: 'S' + i, role }));
function run(setup, hands = false) {
  const n = new N.Night(setup);
  n.start();
  let t = 0;
  while (n.phase === 'wave' && t < 600) {
    if (hands && Math.round(t * 10) % 20 === 0) for (const b of n.barricades) if (b.hp < b.max) n.tap(b.x, b.y);
    n.update(0.05);
    t += 0.05;
  }
  return n;
}

test('wave size grows with day and survivors, capped', () => {
  assert.equal(N.waveSize(1, 0), 4);
  assert.equal(N.waveSize(5, 3), 11);
  assert.equal(N.waveSize(99, 99), 28);
});

test('watchtower unlocks tower slots', () => {
  assert.equal(N.towerSlotsUnlocked(0), 1);
  assert.equal(N.towerSlotsUnlocked(3), 4);
  const n = new N.Night({ day: 1, seed: 1, survivors: [], facilities: fac({ watchtower: 2 }), materials: 0 });
  assert.equal(n.towers.filter((t) => t.unlocked).length, 3);
});

test('survivors are auto-stationed, soldiers first, and tapping cycles an archer', () => {
  const s = [{ id: 1, name: 'A', role: 'farmer' }, { id: 2, name: 'B', role: 'soldier' }];
  const n = new N.Night({ day: 1, seed: 1, survivors: s, facilities: fac({ watchtower: 1 }), materials: 0 });
  const open = n.towers.filter((t) => t.unlocked);
  assert.equal(open[0].survivorId, 2);
  assert.equal(open[1].survivorId, 1);
  n.cycleTower(open[0]);
  assert.equal(open[0].survivorId, null); // survivor 1 is used elsewhere: next is empty
});

test('a first night with no defences besides the player and a plain tower is winnable', () => {
  let wins = 0;
  for (let seed = 1; seed <= 20; seed++) if (run({ day: 1, seed, survivors: [], facilities: fac(), materials: 0 }).phase === 'won') wins++;
  assert.ok(wins >= 17, `won ${wins}/20`);
});

test('mid game with survivors and upgrades is comfortably winnable', () => {
  let wins = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const s = surv(3);
    if (run({ day: 6, seed, survivors: s, facilities: fac({ watchtower: 2, armoury: 1, barricades: 1 }), materials: 10 }).phase === 'won') wins++;
  }
  assert.ok(wins >= 19, `won ${wins}/20`);
});

test('an overwhelming wave can still be lost, and the core falls to zero', () => {
  const n = run({ day: 40, seed: 3, survivors: [], facilities: fac(), materials: 0 });
  assert.equal(n.phase, 'lost');
  assert.equal(n.coreHp, 0);
});

test('repairing spends materials and restores barricade health', () => {
  const n = new N.Night({ day: 1, seed: 1, survivors: [], facilities: fac(), materials: 5 });
  const b = n.barricades[0];
  b.hp = 2;
  n.phase = 'wave';
  n.tap(b.x, b.y);
  for (let i = 0; i < 200 && b.hp < b.max; i++) n.update(0.05);
  assert.ok(b.hp > 2);
  assert.ok(n.materials < 5);
});

test('zombies never get stuck: every spawn has a route to the core', () => {
  const n = new N.Night({ day: 1, seed: 1, survivors: [], facilities: fac(), materials: 0 });
  for (const p of N.SPAWNS) assert.ok(Number.isFinite(n.dist[p.y * n.width + p.x]), `${p.x},${p.y}`);
});

test('losing a night costs a quarter of the stock, winning salvages scrap, repairs cost materials', () => {
  const s = B.newBase();
  s.stock = { scrap: 20, food: 8, materials: 10 };
  const win = B.applyNight(s, { won: true, killed: 9, materialsSpent: 3 });
  assert.equal(win.salvage, 2);
  assert.equal(s.stock.scrap, 22);
  assert.equal(s.stock.materials, 7);
  const lose = B.applyNight(s, { won: false, killed: 3, materialsSpent: 0 });
  assert.equal(lose.lost.scrap, 6);
  assert.equal(s.stock.scrap, 16);
  assert.ok(s.stock.food > 0);
});

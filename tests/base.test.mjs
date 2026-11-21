import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../dist/core/base.js';

const res = (over = {}) => ({ status: 'won', timeSeconds: 10, loot: { scrap: 5, food: 3, materials: 2 }, heartsLeft: 3, rescued: 0, kit: { ammo: 1, explosive: 0, map: 0, shield: 0 }, ...over });

test('stamina gates expeditions and is spent on departure', () => {
  const s = B.newBase();
  assert.ok(B.canStart(s, 'risky'));
  assert.ok(B.departExpedition(s, 'risky'));
  assert.equal(s.stamina, 3);
  assert.ok(B.departExpedition(s, 'risky'));
  assert.equal(B.canStart(s, 'safe'), false);
  assert.equal(B.departExpedition(s, 'safe'), false);
});

test('escaping banks loot, returns unused kit and recruits rescued survivors', () => {
  const s = B.newBase();
  B.departExpedition(s, 'scouting');
  const rep = B.returnHome(s, res({ rescued: 2 }), () => 0.1);
  assert.equal(s.stock.scrap, 13);
  assert.equal(rep.recruited.length, 2);
  assert.equal(s.survivors.length, 2);
  assert.equal(s.kit.ammo, 1);
});

test('dying loses loot, kit and survivors', () => {
  const s = B.newBase();
  const before = { ...s.stock };
  B.departExpedition(s, 'safe');
  B.returnHome(s, res({ status: 'failed', rescued: 1 }));
  assert.deepEqual(s.stock, before);
  assert.equal(s.survivors.length, 0);
  assert.equal(s.kit.ammo, 0);
});

test('storage caps what can be banked', () => {
  const s = B.newBase();
  s.stock.scrap = 28;
  const rep = B.returnHome(s, res());
  assert.equal(s.stock.scrap, 30);
  assert.equal(rep.lost.scrap, 3);
});

test('upgrades and crafting spend resources and respect limits', () => {
  const s = B.newBase();
  s.stock = { scrap: 100, food: 0, materials: 100 };
  assert.equal(B.craft(s, 'ammo'), false); // no workshop yet
  assert.ok(B.upgrade(s, 'workshop'));
  assert.ok(B.craft(s, 'shield'));
  assert.equal(s.kit.shield, 1);
  for (let i = 0; i < 5; i++) B.upgrade(s, 'storage');
  assert.equal(s.facilities.storage, 3);
});

test('cannot upgrade or craft without the resources', () => {
  const s = B.newBase();
  s.stock = { scrap: 0, food: 0, materials: 0 };
  assert.equal(B.upgrade(s, 'garden'), false);
});

test('night: everyone eats, garden grows food, day advances and stamina refills', () => {
  const s = B.newBase();
  B.recruit(s, () => 0.2);
  s.facilities.garden = 1;
  s.stock.food = 1;
  s.stamina = 0;
  const n = B.endDay(s);
  assert.equal(n.needed, 2);
  assert.equal(n.grown, 2);
  assert.equal(s.stock.food, 1);
  assert.equal(s.day, 2);
  assert.equal(s.stamina, B.STAMINA_PER_DAY);
  assert.equal(n.starving, false);
});

test('night: a food shortage makes a survivor leave; the player never does', () => {
  const s = B.newBase();
  B.recruit(s);
  s.stock.food = 0;
  const n = B.endDay(s);
  assert.ok(n.starving);
  assert.equal(n.left.length, 1);
  assert.equal(s.survivors.length, 0);
  const t = B.newBase();
  t.stock.food = 0;
  assert.equal(B.endDay(t).left.length, 0);
});

test('roles give their perks', () => {
  const s = B.newBase();
  s.survivors.push({ id: 1, name: 'A', role: 'medic' }, { id: 2, name: 'B', role: 'soldier' });
  const l = B.loadout(s);
  assert.equal(l.hearts, 5);
  assert.equal(l.ammo, s.kit.ammo + 2);
});

test('save round trip and corrupt saves are rejected', () => {
  const s = B.newBase();
  B.recruit(s);
  s.facilities.garden = 2;
  assert.deepEqual(B.deserialize(B.serialize(s)), s);
  assert.equal(B.deserialize('{oops'), null);
  assert.equal(B.deserialize(null), null);
  assert.equal(B.deserialize('{"version":2}'), null);
});

test('a pending night survives a save round trip', () => {
  const s = B.newBase();
  s.pendingNight = { seed: 42 };
  assert.deepEqual(B.deserialize(B.serialize(s)).pendingNight, { seed: 42 });
});

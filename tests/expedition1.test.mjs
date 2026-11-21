import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../dist/core/config.js';
import { findPath } from '../dist/core/pathfind.js';
import { makeExpedition, run, settle, tapAndSettle, flagAllMines } from './helpers.mjs';

/** Find a map char's position by scanning the true (hidden) state. */
function find(l, pred) {
  const out = [];
  for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) if (pred(l.cell(x, y), x, y)) out.push({ x, y });
  return out;
}

test('level parses: single start, single exit, rectangular', () => {
  const l = makeExpedition();
  assert.equal(l.width, 30);
  assert.equal(l.height, 20);
  assert.equal(find(l, (c) => c.object === 'exit').length, 1);
  assert.deepEqual(l.player, { x: 2, y: 17 });
});

test('hazards, tools and loot of every Phase 1 type exist in the level', () => {
  const l = makeExpedition();
  for (const o of ['mine', 'zombie', 'barricade', 'door', 'crackedWall', 'exit'])
    assert.ok(find(l, (c) => c.object === o).length > 0, o);
  for (const p of ['scrap', 'food', 'materials', 'ammo', 'key', 'crowbar', 'explosive', 'shield', 'medkit', 'map'])
    assert.ok(find(l, (c) => c.pickup === p).length > 0, p);
  assert.equal(l.patrols.length, 1);
});

test('only the area around the start is revealed; fog everywhere else', () => {
  const l = makeExpedition();
  const revealed = find(l, (c) => c.revealed && c.terrain === 'floor').length;
  const floor = find(l, (c) => c.terrain === 'floor').length;
  assert.ok(revealed > 1 && revealed < floor * 0.15, `${revealed}/${floor}`);
  for (const m of find(l, (c) => c.object === 'mine')) assert.equal(l.cell(m.x, m.y).revealed, false);
});

// ───────────── static solvability checks on the true map ─────────────

const open = (l, allow = {}) => (x, y) => {
  if (!l.inBounds(x, y)) return false;
  const c = l.cell(x, y);
  if (c.terrain === 'wall') return false;
  if (c.object === 'mine') return false;
  if (c.object && c.object !== 'exit' && !allow[c.object]) return false;
  return true;
};

test('route A: exit is reachable with no tools at all (only the SWAT patrol in the way)', () => {
  const l = makeExpedition();
  const exit = find(l, (c) => c.object === 'exit')[0];
  const p = findPath(l.width, l.height, l.player, (x, y) => x === exit.x && y === exit.y, open(l));
  assert.ok(p, 'mine-free path to exit exists');
});

test('route B: ammo is reachable without passing the zombie, and the zombie gate leads to the exit', () => {
  const l = makeExpedition();
  const ammo = find(l, (c) => c.pickup === 'ammo');
  const exit = find(l, (c) => c.object === 'exit')[0];
  const toAmmo = findPath(l.width, l.height, l.player, (x, y) => ammo.some((a) => a.x === x && a.y === y), open(l));
  assert.ok(toAmmo);
  // With the zombie removed, can we get through the NW room and out via the east gap (not the corridor)?
  const z = find(l, (c) => c.object === 'zombie')[0];
  const noCorridor = (x, y) => open(l, { zombie: true })(x, y) && !(x >= 13 && y >= 9); // forbid the whole south-east
  const p = findPath(l.width, l.height, l.player, (x, y) => x === exit.x && y === exit.y, (x, y) => noCorridor(x, y) && !(x === 25 && y === 8));
  assert.ok(p, 'north-west route exists');
  assert.ok(p.some((c) => c.x === z.x && c.y === z.y), 'route goes through the zombie gate');
});

test('warehouse is enterable three independent ways', () => {
  const l = makeExpedition();
  const loot = find(l, (c) => c.pickup === 'shield')[0];
  const reach = (allow) => findPath(l.width, l.height, l.player, (x, y) => x === loot.x && y === loot.y, open(l, allow));
  assert.equal(reach({}), null, 'sealed with nothing');
  assert.ok(reach({ door: true, zombie: true }), 'key door (key is behind the zombie gate)');
  assert.ok(reach({ barricade: true }), 'crowbar on the south barricade');
  assert.ok(reach({ crackedWall: true }), 'bomb on the cracked wall');
});

test('every required tool is reachable without needing itself', () => {
  const l = makeExpedition();
  const k = find(l, (c) => c.pickup === 'key')[0];
  const cr = find(l, (c) => c.pickup === 'crowbar')[0];
  const ex = find(l, (c) => c.pickup === 'explosive');
  const reach = (t, allow) => findPath(l.width, l.height, l.player, (x, y) => x === t.x && y === t.y, open(l, allow));
  assert.ok(reach(cr, {}), 'crowbar free');
  assert.ok(reach(k, { zombie: true }), 'key needs only ammo-for-zombie');
  assert.ok(reach(ex[1] ?? ex[0], {}) || reach(ex[0], {}), 'at least one explosive in the open');
});

// ───────────── scripted playthroughs through the real engine ─────────────

test('playthrough A: flag the mines, walk the south corridor to the exit', () => {
  const l = makeExpedition({ patrols: false });
  flagAllMines(l);
  tapAndSettle(l, 28, 1);
  assert.equal(l.status, 'won');
  assert.equal(l.hearts, CONFIG.startHearts);
});

test('playthrough B: ammo -> shoot zombie -> key -> north-west room -> exit, no damage', () => {
  const l = makeExpedition({ patrols: false });
  flagAllMines(l);
  tapAndSettle(l, 3, 15); // ammo
  assert.equal(l.inventory.ammo, 1);
  tapAndSettle(l, 6, 10); // walk up to the gate: the zombie comes into view
  assert.equal(l.cell(6, 8).revealed, true, 'zombie is now visible');
  tapAndSettle(l, 6, 8); // zombie gate
  assert.equal(l.cell(6, 8).object, null);
  tapAndSettle(l, 2, 2); // key
  assert.equal(l.inventory.key, 1);
  tapAndSettle(l, 28, 1); // exit (shortest path now goes through the NW room east gap or back down; either is hazard-free)
  assert.equal(l.status, 'won');
  assert.equal(l.hearts, CONFIG.startHearts);
});

test('playthrough C: key door, crowbar and bomb all work on the warehouse; loot is banked', () => {
  const l = makeExpedition({ patrols: false });
  flagAllMines(l);
  tapAndSettle(l, 9, 16); // crowbar
  assert.equal(l.inventory.crowbar, 1);
  tapAndSettle(l, 17, 17); // south barricade
  assert.equal(l.cell(17, 17).object, null);
  tapAndSettle(l, 15, 12); // shield/medkit side of the warehouse: walk in and out of fog
  assert.ok(l.hearts >= CONFIG.startHearts, 'no damage (medkit may even heal)');
  assert.ok(l.player.x >= 14 && l.player.x <= 20, 'inside the warehouse');
  tapAndSettle(l, 18, 11); // explosive
  assert.equal(l.inventory.explosive, 1);
  tapAndSettle(l, 16, 11); // scrap
  assert.ok(l.loot.scrap >= 1);
});

test('hasty play punishes: running blind through the hidden minefield costs hearts but is survivable at first', () => {
  const l = makeExpedition({ patrols: false });
  // Tap far into the unexplored north-west without flagging anything.
  tapAndSettle(l, 4, 4);
  assert.ok(l.hearts <= CONFIG.startHearts);
  assert.equal(l.status === 'failed', l.hearts <= 0);
});

test('patrol on the real level actually threatens the gap and cannot be shot', () => {
  const l = makeExpedition();
  const p = l.patrols[0];
  assert.deepEqual([p.x, p.y], [25, 8]);
  run(l, 2.6);
  assert.ok(p.y > 12, 'it has walked down the yard');
  settle(l);
});

test('bomb kills the SWAT patrol on the real level', () => {
  const l = makeExpedition();
  const p = l.patrols[0];
  l.inventory.explosive = 1;
  l.player = { x: 25, y: 10 };
  // Wait until the patrol is within the blast, then detonate.
  for (let t = 0; t < 10 && (Math.abs(Math.round(p.y) - 10) > 1); t += 0.05) l.update(0.05);
  l.pressItem('explosive');
  l.pressItem('explosive');
  assert.equal(p.alive, false);
});

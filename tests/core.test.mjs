import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../dist/core/config.js';
import { make, run, settle, tapAndSettle, events } from './helpers.mjs';

// ───────────── clues & fog ─────────────

test('clue numbers count the 8 surrounding mines', () => {
  const l = make([
    '#######',
    '#.m.m.#',
    '#..S..#',
    '#.....#',
    '#######',
  ]);
  assert.equal(l.cell(3, 1).clue, 2); // between the mines
  assert.equal(l.cell(1, 2).clue, 1); // diagonal to (2,1)
  assert.equal(l.cell(3, 3).clue, 0);
});

test('only mines count for clues (zombies and walls do not)', () => {
  const l = make(['#####', '#zbS#', '#####']);
  assert.equal(l.cell(3, 1).clue, 0);
});

test('start tile is revealed, empty tiles open up and numbered tiles form the border', () => {
  const l = make([
    '########',
    '#S.....#',
    '#......#',
    '#...m..#',
    '#......#',
    '########',
  ]);
  assert.equal(l.cell(1, 1).revealed, true);
  assert.equal(l.cell(4, 3).revealed, false, 'mine is never auto-revealed');
  assert.equal(l.cell(3, 2).revealed, true, 'numbered border is revealed');
  assert.equal(l.cell(3, 2).clue, 1);
});

test('fog only clears near the avatar: reveal never goes beyond the fog radius', () => {
  const l = make(['#' + '#'.repeat(20) + '#', '#S' + '.'.repeat(19) + '#', '#' + '.'.repeat(20) + '#', '#' + '#'.repeat(20) + '#']);
  const R = CONFIG.fogRadius;
  for (let y = 0; y < l.height; y++)
    for (let x = 0; x < l.width; x++) {
      const c = l.cell(x, y);
      if (c.terrain === 'wall') continue;
      const d = Math.max(Math.abs(x - l.player.x), Math.abs(y - l.player.y));
      assert.equal(c.revealed, d <= R, `cell ${x},${y} distance ${d}`);
    }
});

test('walking on keeps clearing the fog around the new position', () => {
  const l = make(['#' + '#'.repeat(20) + '#', '#S' + '.'.repeat(19) + '#', '#' + '.'.repeat(20) + '#', '#' + '#'.repeat(20) + '#']);
  assert.equal(l.cell(12, 1).revealed, false);
  tapAndSettle(l, 10, 1);
  assert.equal(l.cell(12, 1).revealed, true);
  assert.equal(l.cell(10 + CONFIG.fogRadius + 1, 1).revealed, false);
});

test('approaching a half-opened empty area keeps opening it', () => {
  const l = make(['#' + '#'.repeat(20) + '#', '#S' + '.'.repeat(19) + '#', '#' + '.'.repeat(20) + '#', '#' + '#'.repeat(20) + '#']);
  l.tap(3, 1);
  run(l, 0.2);
  const before = l.cells.filter((c) => c.revealed).length;
  settle(l);
  assert.ok(l.cells.filter((c) => c.revealed).length > before);
});

test('flood-fill stops at numbers: fog remains beyond the clue border', () => {
  const l = make([
    '###########',
    '#S..m.....#',
    '#...m.....#',
    '#...m.....#',
    '###########',
  ]);
  assert.equal(l.cell(3, 1).revealed, true); // number next to mines
  assert.equal(l.cell(5, 1).revealed, false); // hidden behind the mine wall
  assert.equal(l.cell(9, 2).revealed, false);
});

test('flood-fill does not pass through zombies, barricades or doors', () => {
  const l = make([
    '#########',
    '#S.z....#',
    '#..#....#',
    '#########',
  ]);
  assert.equal(l.cell(3, 1).revealed, true, 'zombie cell itself is revealed (visible)');
  assert.equal(l.cell(5, 1).revealed, false, 'area behind zombie stays fogged');
});

// ───────────── hazards & health ─────────────

test('walking blind onto a mine damages the player, stops them and marks the tile', () => {
  const l = make([
    '#########',
    '#S..m..E#',
    '#########',
  ]);
  tapAndSettle(l, 7, 1); // fog: pathfinder walks straight into the hidden mine
  assert.equal(l.hearts, CONFIG.startHearts - CONFIG.damage.mine);
  assert.deepEqual(l.player, { x: 4, y: 1 });
  assert.equal(l.cell(4, 1).triggered, true);
  assert.equal(l.cell(4, 1).revealed, true);
  assert.equal(l.status, 'playing');
  // Triggered mine is now harmless: walking on works.
  tapAndSettle(l, 7, 1);
  assert.equal(l.status, 'won');
  assert.equal(l.hearts, CONFIG.startHearts - 1);
});

test('shield absorbs one hit of any kind', () => {
  const l = make(['#########', '#Sp.m..E#', '#########']);
  tapAndSettle(l, 2, 1); // pick up shield
  assert.equal(l.shield, 1);
  tapAndSettle(l, 7, 1);
  assert.equal(l.hearts, CONFIG.startHearts, 'hit absorbed');
  assert.equal(l.shield, 0);
});

test('blind step into a hidden zombie hurts, reveals it and does not move the player', () => {
  const l = make([
    '#########',
    '#S.mmm..#',
    '#...z...#',
    '#########',
  ]);
  assert.equal(l.cell(4, 2).revealed, false);
  l.toggleFlag(3, 1); l.toggleFlag(4, 1); l.toggleFlag(5, 1);
  tapAndSettle(l, 4, 2); // walks into the hidden zombie from the west
  assert.equal(l.hearts, CONFIG.startHearts - CONFIG.damage.zombie);
  assert.deepEqual(l.player, { x: 3, y: 2 });
  assert.equal(l.cell(4, 2).revealed, true);
  assert.equal(l.cell(4, 2).object, 'zombie', 'zombie is still there');
});

test('hearts reaching zero fails the expedition', () => {
  const l = make(['######', '#Smm.#', '######']);
  l.hearts = 1;
  tapAndSettle(l, 4, 1);
  assert.equal(l.status, 'failed');
});

test('medkit heals one heart and is capped at max hearts', () => {
  const l = make(['#######', '#Shh..#', '#######']);
  l.hearts = CONFIG.maxHearts - 1;
  tapAndSettle(l, 2, 1);
  assert.equal(l.hearts, CONFIG.maxHearts);
  tapAndSettle(l, 3, 1);
  assert.equal(l.hearts, CONFIG.maxHearts);
});

// ───────────── pathfinding ─────────────

test('pathfinder routes around flags and known hazards but through unknown fog', () => {
  const l = make([
    '#######',
    '#S....#',
    '#.....#',
    '#####.#',
    '#######',
  ]);
  l.toggleFlag(1, 2); // flags only matter where there is fog; (1,2) is revealed so this is ignored
  assert.equal(l.cell(1, 2).flagged, false);
  const m = make([
    '########',
    '#S.m...#',
    '#......#',
    '########',
  ]);
  m.toggleFlag(3, 1);
  assert.equal(m.cell(3, 1).flagged, true);
  tapAndSettle(m, 6, 1);
  assert.equal(m.hearts, CONFIG.startHearts, 'went round the flagged mine');
  assert.deepEqual(m.player, { x: 6, y: 1 });
});

test('tapping a flagged tile does nothing; flags can be removed', () => {
  const l = make(['######', '#Sm..#', '######']);
  l.toggleFlag(2, 1);
  l.tap(2, 1);
  assert.equal(l.isMoving(), false);
  l.toggleFlag(2, 1);
  assert.equal(l.cell(2, 1).flagged, false);
});

test('unreachable target reports noPath and does not move', () => {
  const l = make(['#######', '#S.#..#', '#######']);
  l.tap(5, 1);
  assert.equal(l.isMoving(), false);
  assert.ok(l.drainEvents().some((e) => e.type === 'message' && e.key === 'noPath'));
});

test('re-planning: a zombie revealed mid-walk is routed around, not walked into', () => {
  const l = make([
    '#########',
    '#S......#',
    '#.......#',
    '#########',
  ]);
  // Place a zombie in fog after the level is built, directly in the straight-line path.
  l.cell(4, 1).object = 'zombie';
  l.cell(4, 1).revealed = true; // as if flood-reveal had uncovered it
  tapAndSettle(l, 7, 1);
  assert.equal(l.hearts, CONFIG.startHearts);
  assert.deepEqual(l.player, { x: 7, y: 1 });
});

// ───────────── tools & obstacles ─────────────

test('ammo: player walks up to a visible zombie, shoots it, ammo is spent', () => {
  const l = make(['#########', '#Sa.z...#', '#########']);
  tapAndSettle(l, 2, 1); // ammo
  assert.equal(l.inventory.ammo, 1);
  assert.equal(l.cell(4, 1).revealed, true);
  tapAndSettle(l, 4, 1);
  assert.equal(l.cell(4, 1).object, null);
  assert.equal(l.inventory.ammo, 0);
  assert.deepEqual(l.player, { x: 3, y: 1 }, 'stops next to the zombie');
  assert.equal(l.hearts, CONFIG.startHearts);
});

test('zombie without ammo: tap is refused with a message', () => {
  const l = make(['########', '#S.z...#', '########']);
  l.tap(3, 1);
  assert.equal(l.isMoving(), false);
  assert.ok(l.drainEvents().some((e) => e.type === 'message' && e.key === 'needAmmo'));
  assert.equal(l.cell(3, 1).object, 'zombie');
});

test('crowbar removes a plank barricade, one use per barricade', () => {
  const l = make(['##########', '#Sc.b.b..#', '##########']);
  tapAndSettle(l, 2, 1);
  assert.equal(l.inventory.crowbar, 1);
  tapAndSettle(l, 4, 1);
  assert.equal(l.cell(4, 1).object, null);
  assert.equal(l.inventory.crowbar, 0);
  tapAndSettle(l, 6, 1); // second barricade, no crowbar left
  assert.equal(l.cell(6, 1).object, 'barricade');
});

test('barricades and doors are visible through fog and block the pathfinder', () => {
  const l = make(['#######', '#S.b..#', '#######']);
  assert.equal(l.objectVisible(l.cell(3, 1)), true);
  l.tap(5, 1);
  assert.equal(l.isMoving(), false, 'no route through a barricade');
});

test('key opens a locked door and reveals what is behind it', () => {
  const l = make(['##########', '#Sk.D..f.#', '##########']);
  assert.equal(l.cell(6, 1).revealed, false);
  tapAndSettle(l, 2, 1);
  assert.equal(l.inventory.key, 1);
  tapAndSettle(l, 4, 1);
  assert.equal(l.cell(4, 1).object, null);
  assert.equal(l.inventory.key, 0);
  assert.equal(l.cell(6, 1).revealed, true, 'room behind the door is now visible');
});

test('door without a key is refused', () => {
  const l = make(['#######', '#S.D..#', '#######']);
  l.tap(3, 1);
  assert.ok(l.drainEvents().some((e) => e.type === 'message' && e.key === 'needKey'));
});

test('cracked wall cannot be walked into or opened by tapping', () => {
  const l = make(['#######', '#S.X..#', '#######']);
  l.tap(3, 1);
  assert.ok(l.drainEvents().some((e) => e.type === 'message' && e.key === 'needExplosive'));
});

// ───────────── area items ─────────────

test('explosive: first press previews 3x3, second press detonates', () => {
  const l = make([
    '#######',
    '#S.XXb#',
    '#..XXb#',
    '#######',
  ]);
  l.inventory.explosive = 1;
  l.player = { x: 2, y: 1 };
  l.pressItem('explosive');
  assert.equal(l.pending.cells.length, 9); // full 3x3 around the player
  assert.equal(l.inventory.explosive, 1, 'nothing spent on preview');
  l.pressItem('explosive');
  assert.equal(l.inventory.explosive, 0);
  assert.equal(l.cell(3, 1).object, null, 'cracked wall destroyed');
  assert.equal(l.cell(3, 2).object, null);
  assert.equal(l.cell(4, 1).object, 'crackedWall', 'outside the 3x3 untouched');
  assert.equal(l.cell(5, 1).object, 'barricade');
});

test('explosive: tapping outside the preview cancels without spending', () => {
  const l = make(['########', '#S.....#', '########']);
  l.inventory.explosive = 1;
  l.pressItem('explosive');
  assert.ok(l.pending);
  l.tap(6, 1);
  assert.equal(l.pending, null);
  assert.equal(l.inventory.explosive, 1);
});

test('explosive: tapping inside the preview confirms', () => {
  const l = make(['########', '#SX....#', '########']);
  l.inventory.explosive = 1;
  l.pressItem('explosive');
  l.tap(1, 1);
  assert.equal(l.inventory.explosive, 0);
  assert.equal(l.cell(2, 1).object, null);
});

test('explosive: kills zombies, safely detonates mines, but does not open locked doors', () => {
  const l = make([
    '#######',
    '#.zDm.#',
    '#..S..#',
    '#######',
  ]);
  l.inventory.explosive = 1;
  l.pressItem('explosive');
  l.pressItem('explosive');
  assert.equal(l.cell(2, 1).object, null, 'zombie killed');
  assert.equal(l.cell(4, 1).triggered, true, 'mine disarmed');
  assert.equal(l.hearts, CONFIG.startHearts, 'no damage taken');
  assert.equal(l.cell(3, 1).object, 'door', 'door is key-only');
});

test('explosive kills a SWAT zombie inside the blast, not one outside it', () => {
  const l = make(
    ['##########', '#S.......#', '#........#', '##########'],
    [
      { route: [{ x: 2, y: 1 }, { x: 2, y: 1 }], speed: 0 },
      { route: [{ x: 7, y: 2 }, { x: 7, y: 2 }], speed: 0 },
    ],
  );
  l.inventory.explosive = 1;
  l.pressItem('explosive');
  l.pressItem('explosive');
  assert.equal(l.patrols[0].alive, false);
  assert.equal(l.patrols[1].alive, true);
});

test('map fragment reveals the 3x3 area, showing hidden mines as known hazards', () => {
  const l = make([
    '###########',
    '#S.m......#',
    '#..m.m....#',
    '#...mmm...#',
    '###########',
  ]);
  // Move the player into the middle of the cluster's neighbourhood and read the map.
  l.inventory.map = 1;
  l.player = { x: 4, y: 2 };
  l.pressItem('map');
  l.pressItem('map');
  assert.equal(l.inventory.map, 0);
  assert.equal(l.cell(3, 2).revealed, true, 'mine revealed');
  assert.equal(l.cell(3, 2).object, 'mine');
  assert.equal(l.objectVisible(l.cell(3, 2)), true);
  assert.equal(l.cell(5, 2).revealed, true);
  assert.equal(l.cell(8, 1).revealed, false, 'outside the 3x3 stays fogged');
  // Known mine is avoided by the pathfinder.
  assert.equal(l.knownBlocked(3, 2), true);
});

test('area items refuse when none are left', () => {
  const l = make(['#####', '#S..#', '#####']);
  l.pressItem('map');
  assert.equal(l.pending, null);
  assert.ok(l.drainEvents().some((e) => e.type === 'message' && e.key === 'noneLeft'));
});

// ───────────── loot, exit ─────────────

test('loot is tallied separately from tools and exit ends the expedition', () => {
  const l = make(['##########', '#Ssft.aE.#', '##########']);
  tapAndSettle(l, 7, 1);
  assert.equal(l.status, 'won');
  assert.deepEqual(l.loot, { scrap: 1, food: 1, materials: 1 });
  assert.equal(l.inventory.ammo, 1);
  const r = l.results();
  assert.equal(r.status, 'won');
  assert.ok(r.timeSeconds > 0);
});

test('movement speed is configurable and roughly tiles per second', () => {
  const l = make(['############', '#S.........#', '############']);
  l.tap(10, 1);
  run(l, 9 / CONFIG.playerSpeed + 0.2);
  assert.deepEqual(l.player, { x: 10, y: 1 });
});

test('changing target mid-walk finishes the current step then re-routes', () => {
  const l = make(['########', '#S.....#', '#......#', '########']);
  l.tap(6, 1);
  run(l, 0.25);
  l.tap(1, 2);
  settle(l);
  assert.deepEqual(l.player, { x: 1, y: 2 });
});

test('revealed events fire so the renderer can animate', () => {
  const l = make(['#####', '#S..#', '#####']);
  assert.ok(l.drainEvents().some((e) => e.type === 'revealed'));
});

test('events() helper filters', () => {
  const l = make(['#####', '#Ss.#', '#####']);
  tapAndSettle(l, 2, 1);
  assert.equal(events(l, 'pickup').length, 1);
});

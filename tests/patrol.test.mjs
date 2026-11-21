import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../dist/core/config.js';
import { make, run, tapAndSettle } from './helpers.mjs';

const hall = (w = 12) => ['#'.repeat(w), '#S' + '.'.repeat(w - 3) + '#', '#' + '.'.repeat(w - 2) + '#', '#'.repeat(w)];

test('SWAT zombie patrols back and forth along its route at its own speed', () => {
  const l = make(hall(), [{ route: [{ x: 4, y: 2 }, { x: 8, y: 2 }], speed: 2 }]);
  const p = l.patrols[0];
  assert.deepEqual([p.x, p.y], [4, 2]);
  run(l, 1); // 2 tiles
  assert.ok(Math.abs(p.x - 6) < 0.1, `x=${p.x}`);
  run(l, 1); // reaches the end
  assert.ok(Math.abs(p.x - 8) < 0.1);
  run(l, 1); // heads back
  assert.ok(Math.abs(p.x - 6) < 0.1);
  run(l, 1);
  assert.ok(Math.abs(p.x - 4) < 0.1);
  run(l, 1); // and out again
  assert.ok(Math.abs(p.x - 6) < 0.1);
});

test('patrols follow multi-waypoint routes around corners', () => {
  const l = make(hall(), [{ route: [{ x: 3, y: 1 }, { x: 3, y: 2 }, { x: 6, y: 2 }], speed: 1 }]);
  const p = l.patrols[0];
  run(l, 1);
  assert.ok(Math.abs(p.y - 2) < 0.1 && Math.abs(p.x - 3) < 0.1);
  run(l, 2);
  assert.ok(Math.abs(p.x - 5) < 0.1);
});

test('SWAT zombie is hidden while its cell is under fog, visible once revealed', () => {
  const l = make(
    ['##########', '#S.m.....#', '#........#', '##########'],
    [{ route: [{ x: 8, y: 1 }, { x: 8, y: 1 }], speed: 0 }],
  );
  assert.equal(l.cell(8, 1).revealed, false);
  assert.equal(l.patrolVisible(l.patrols[0]), false);
  l.cell(8, 1).revealed = true;
  assert.equal(l.patrolVisible(l.patrols[0]), true);
});

test('contact with a SWAT zombie costs 2 hearts, then a cooldown prevents repeat hits', () => {
  const l = make(hall(), [{ route: [{ x: 1, y: 2 }, { x: 1, y: 2 }], speed: 0 }]);
  l.player = { x: 1, y: 1 };
  run(l, 0.05);
  // not touching yet (distance 1)
  assert.equal(l.hearts, CONFIG.startHearts);
  l.patrols[0].x = 1;
  l.patrols[0].y = 1.2; // overlapping
  run(l, 0.05);
  assert.equal(l.hearts, CONFIG.startHearts - CONFIG.damage.swat);
  run(l, 0.5); // still overlapping, but within cooldown
  assert.equal(l.hearts, CONFIG.startHearts - CONFIG.damage.swat);
  run(l, CONFIG.swatContactCooldown);
  assert.equal(l.hearts, CONFIG.startHearts - 2 * CONFIG.damage.swat);
});

test('a patrol walking into a stationary player damages them (real-time collision)', () => {
  const l = make(hall(), [{ route: [{ x: 8, y: 1 }, { x: 1, y: 1 }], speed: 2 }]);
  run(l, 4);
  assert.ok(l.hearts < CONFIG.startHearts);
});

test('shield absorbs a SWAT hit', () => {
  const l = make(hall(), [{ route: [{ x: 1, y: 1 }, { x: 1, y: 1 }], speed: 0 }]);
  l.shield = 1;
  run(l, 0.1);
  assert.equal(l.hearts, CONFIG.startHearts);
  assert.equal(l.shield, 0);
});

test('player can slip past a patrol by timing it', () => {
  // 1-wide corridor with a side alcove to hide in.
  const l = make(
    [
      '############',
      '#S.........#',
      '######.#####',
      '######.#####',
      '############',
    ],
    [{ route: [{ x: 10, y: 1 }, { x: 5, y: 1 }], speed: 2 }],
  );
  // Hide in the alcove below (6,1) until the patrol has come past, then continue.
  tapAndSettle(l, 6, 3);
  assert.equal(l.hearts, CONFIG.startHearts);
});

test('ordinary ammunition cannot kill a SWAT zombie (tapping it does nothing)', () => {
  const l = make(hall(), [{ route: [{ x: 5, y: 2 }, { x: 5, y: 2 }], speed: 0 }]);
  l.inventory.ammo = 5;
  l.tap(5, 2); // just a walk target; there is no "shoot" interaction for patrols
  assert.equal(l.patrols[0].alive, true);
  assert.equal(l.inventory.ammo, 5);
});

test('dead patrols no longer hurt or move', () => {
  const l = make(hall(), [{ route: [{ x: 1, y: 1 }, { x: 4, y: 1 }], speed: 2 }]);
  l.patrols[0].alive = false;
  run(l, 3);
  assert.equal(l.hearts, CONFIG.startHearts);
  assert.equal(l.patrols[0].x, 1);
});

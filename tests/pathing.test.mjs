import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../dist/core/config.js';
import { make, run, settle, tapAndSettle } from './helpers.mjs';

/** Mark every non-wall cell revealed except the listed ones (to stage a specific fog shape). */
function fogOnly(l, hidden) {
  for (const c of l.cells) if (c.terrain !== 'wall') c.revealed = true;
  for (const [x, y] of hidden) l.cell(x, y).revealed = false;
}
const preview = (l) => l.pathPreview().map((p) => `${p.x},${p.y}`);

// ───────────── diagonal movement ─────────────

test('diagonal walking: a 2x2 diagonal is two steps, not four', () => {
  const l = make(['#######', '#S....#', '#.....#', '#.....#', '#######']);
  l.tap(3, 3);
  assert.deepEqual(preview(l), ['2,2', '3,3']);
});

test('diagonal steps take proportionally longer (distance, not step count)', () => {
  const diag = make(['#########', '#S......#', '#.......#', '#.......#', '#.......#', '#.......#', '#########']);
  const straight = make(['#########', '#S......#', '#.......#', '#.......#', '#.......#', '#.......#', '#########']);
  diag.tap(4, 4); // 3 diagonal steps = 4.24 tiles
  straight.tap(5, 1); // 4 straight steps = 4 tiles
  run(diag, 4.0 / CONFIG.playerSpeed);
  run(straight, 4.0 / CONFIG.playerSpeed + 0.05);
  assert.notDeepEqual(diag.player, { x: 4, y: 4 }, 'diagonal not instant');
  assert.deepEqual(straight.player, { x: 5, y: 1 });
  settle(diag);
  assert.deepEqual(diag.player, { x: 4, y: 4 });
});

test('cannot cut the corner of a wall diagonally: goes round instead', () => {
  const l = make([
    '#####',
    '#S#.#',
    '#...#',
    '#####',
  ]);
  l.tap(3, 1); // (2,1) is wall: neither diagonal past it is allowed, so the route hugs the corner
  assert.deepEqual(preview(l), ['1,2', '2,2', '3,2', '3,1']);
  const open = make(['#####', '#S..#', '#...#', '#####']);
  open.tap(2, 2);
  assert.deepEqual(preview(open), ['2,2'], 'same diagonal with no wall is a single step');
});

test('wall corners block a diagonal step: no squeezing between two touching walls', () => {
  const l = make([
    '####',
    '#S##',
    '##.#',
    '####',
  ]);
  l.tap(2, 2); // only link is a diagonal through the corner
  assert.equal(l.isMoving(), false);
});

test('barricades are solid corners too', () => {
  const l = make([
    '#####',
    '#Sb.#',
    '#...#',
    '#####',
  ]);
  l.tap(2, 2); // (2,1) is a barricade, so (1,1)->(2,2) would cut its corner
  assert.deepEqual(preview(l), ['1,2', '2,2']);
});

test('diagonal step onto an adjacent hidden tile goes straight there', () => {
  const l = make(['#######', '#S....#', '#.....#', '#.....#', '#######']);
  fogOnly(l, [[2, 2]]);
  l.tap(2, 2);
  assert.deepEqual(preview(l), ['2,2']);
});

test('diagonal interaction: shoots a zombie standing diagonally', () => {
  const l = make(['#######', '#S....#', '#.z...#', '#.....#', '#######']);
  l.inventory.ammo = 1;
  l.tap(2, 2);
  settle(l);
  assert.equal(l.cell(2, 2).object, null);
  assert.deepEqual(l.player, { x: 1, y: 1 });
});

// ───────────── hidden tiles: approach via known-safe tiles ─────────────

test('hidden tile >1 away: walks the known-safe route to the nearest safe tile beside it, then steps on', () => {
  // The straight line to the target runs through hidden tiles; a known route exists around them.
  const l = make([
    '###########',
    '#S........#',
    '#.........#',
    '#.........#',
    '#.........#',
    '###########',
  ]);
  fogOnly(l, [[3, 1], [3, 2], [4, 2], [5, 2], [6, 2]]); // a hidden block between us and the target
  l.player = { x: 1, y: 2 };
  l.tap(5, 2); // hidden target; straight route would barge through (3,2),(4,2)
  const p = l.pathPreview();
  const hiddenBeforeEnd = p.slice(0, -1).filter((c) => !l.cell(c.x, c.y).revealed);
  assert.deepEqual(hiddenBeforeEnd, [], 'only the final step is onto a hidden tile: ' + preview(l).join(' '));
  assert.deepEqual(p[p.length - 1], { x: 5, y: 2 });
  assert.ok(p.length >= 3, 'took a detour via known tiles');
});

test('the final step onto the hidden tile comes from a known tile adjacent to it', () => {
  const l = make(['###########', '#S........#', '#.........#', '#.........#', '###########']);
  fogOnly(l, [[4, 1], [4, 2], [5, 1], [5, 2]]);
  l.player = { x: 1, y: 1 };
  l.tap(5, 2);
  const p = l.pathPreview();
  const before = p[p.length - 2];
  assert.ok(l.cell(before.x, before.y).revealed, 'standing on a known tile before the last step');
  assert.ok(Math.max(Math.abs(before.x - 5), Math.abs(before.y - 2)) === 1, 'adjacent to the target');
});

test('with no known route to a tile beside it, falls back to walking through the fog', () => {
  const l = make(['########', '#S.....#', '#......#', '########']);
  for (const c of l.cells) if (c.terrain !== 'wall') c.revealed = false;
  l.cell(1, 1).revealed = true;
  l.tap(6, 1);
  assert.ok(l.isMoving(), 'still goes there blind');
  assert.deepEqual(l.pathPreview().at(-1), { x: 6, y: 1 });
});

test('known-safe approach avoids flagged mines and known hazards', () => {
  const l = make([
    '###########',
    '#S........#',
    '#...m.....#',
    '#.........#',
    '###########',
  ]);
  fogOnly(l, [[4, 2], [5, 2], [6, 2]]);
  l.cell(4, 2).flagged = true;
  l.player = { x: 1, y: 2 };
  l.tap(6, 2);
  for (const c of l.pathPreview()) assert.ok(!(c.x === 4 && c.y === 2), 'steered round the flag');
});

test('walking the known route and then onto a mine still hurts (it is a hidden-tile step)', () => {
  const l = make([
    '###########',
    '#S........#',
    '#.........#',
    '#.....m...#',
    '###########',
  ]);
  fogOnly(l, [[6, 3]]);
  l.player = { x: 1, y: 3 };
  tapAndSettle(l, 6, 3);
  assert.equal(l.hearts, CONFIG.startHearts - CONFIG.damage.mine);
  assert.deepEqual(l.player, { x: 6, y: 3 });
});

test('a revealed target is unaffected by the hidden-tile rule', () => {
  const l = make(['########', '#S.....#', '#......#', '########']);
  l.tap(6, 1);
  assert.equal(l.pathPreview().length, 5);
});

// ───────────── revealed targets: also prefer known-safe routes (reported from play) ─────────────

const roomRows = (w, h) => [
  '#'.repeat(w),
  '#S' + '.'.repeat(w - 3) + '#',
  ...Array.from({ length: h - 3 }, () => '#' + '.'.repeat(w - 2) + '#'),
  '#'.repeat(w),
];

test('revealed target with a hidden tile in the straight line: walks round on known tiles', () => {
  // Mirrors the "circled 2" report: a row of hidden tiles (one flagged) between us and a known tile.
  const l = make(roomRows(11, 7));
  fogOnly(l, [[3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3]]);
  l.cell(3, 3).flagged = true;
  l.player = { x: 4, y: 2 };
  l.tap(5, 4);
  const p = l.pathPreview();
  assert.deepEqual(p.filter((c) => !l.cell(c.x, c.y).revealed), [], 'never steps on a hidden tile: ' + preview(l).join(' '));
  assert.deepEqual(p[p.length - 1], { x: 5, y: 4 });
  settle(l);
  assert.deepEqual(l.player, { x: 5, y: 4 });
  assert.equal(l.hearts, CONFIG.startHearts);
});

test('known route is preferred even when much longer than the shortcut through fog', () => {
  const l = make(roomRows(15, 7));
  // A big hidden block in the middle; the only known route is along the bottom row.
  const band = [];
  for (let y = 1; y <= 5; y++) for (let x = 4; x <= 13; x++) if (x === 4 || y !== 5) band.push([x, y]);
  fogOnly(l, band.filter(([x, y]) => !(x === 4 && y === 5)));
  l.player = { x: 2, y: 3 };
  l.tap(13, 5); // known tile at the far end of the (known) bottom row
  const bad = l.pathPreview().filter((c) => !l.cell(c.x, c.y).revealed);
  assert.deepEqual(bad, [], 'hugged the known bottom row: ' + preview(l).join(' '));
});

test('when no known route exists, a revealed target is still reached through the fog', () => {
  const l = make(roomRows(9, 5));
  const band = [];
  for (let y = 1; y <= 3; y++) band.push([4, y]); // hidden column fully blocks the room
  fogOnly(l, band);
  l.player = { x: 2, y: 2 };
  l.tap(6, 2);
  assert.ok(l.isMoving());
  assert.ok(l.pathPreview().some((c) => !l.cell(c.x, c.y).revealed), 'crosses the hidden column');
});

test('interaction (shooting a zombie) also walks known tiles rather than barging through hidden ones', () => {
  const l = make(roomRows(11, 7));
  l.cell(8, 3).object = 'zombie';
  fogOnly(l, [[4, 2], [4, 3], [4, 4], [5, 3], [3, 3]]);
  l.inventory.ammo = 1;
  l.player = { x: 2, y: 3 };
  l.tap(8, 3);
  assert.deepEqual(l.pathPreview().filter((c) => !l.cell(c.x, c.y).revealed), [], preview(l).join(' '));
  settle(l);
  assert.equal(l.cell(8, 3).object, null);
  assert.equal(l.hearts, CONFIG.startHearts);
});

test('re-planning mid-walk keeps preferring known tiles', () => {
  const l = make(roomRows(11, 7));
  fogOnly(l, [[5, 2], [5, 3], [5, 4]]);
  l.player = { x: 2, y: 3 };
  l.tap(8, 3);
  run(l, 0.35);
  const bad = l.pathPreview().filter((c) => !l.cell(c.x, c.y).revealed);
  assert.deepEqual(bad, []);
});

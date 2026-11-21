import test from 'node:test';
import assert from 'node:assert/strict';
import { generateExpedition } from '../dist/gen/generate.js';
import { DIFFICULTIES } from '../dist/gen/difficulty.js';
import { solveLevel } from '../dist/solver/solve.js';
import { deduce } from '../dist/solver/deduce.js';
import { Rng } from '../dist/gen/rng.js';
import { Level } from '../dist/core/level.js';
import { parseLevel } from '../dist/levels/parse.js';
import { make } from './helpers.mjs';

const TIERS = ['safe', 'scouting', 'risky'];
const grid = (g) => g.ascii.rows.join('\n');
const count = (g, ch) => grid(g).split(ch).length - 1;

test('rng: same seed gives the same sequence, different seeds differ', () => {
  const a = new Rng(42), b = new Rng(42), c = new Rng(43);
  const xs = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b.next()));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, () => c.next()));
});

test('deduce: classic cases (1 next to a wall of hidden, a safe corner, a forced mine)', () => {
  // start at left; clue under the corridor tells us what must be a mine
  const lv = make(['#####', '#S..#', '#.m.#', '#...#', '#####']);
  // player reveals around start; (1,1) has clue 1 (the mine at 2,2)
  const d = deduce(lv);
  for (const p of d.mines) assert.equal(lv.cell(p.x, p.y).object, 'mine');
  for (const p of d.safe) assert.notEqual(lv.cell(p.x, p.y).object, 'mine');
});

test('deduce: never claims a wrong fact on generated maps (start state and end state)', () => {
  for (const tier of TIERS) {
    for (let seed = 1; seed <= 6; seed++) {
      const g = generateExpedition(tier, seed);
      const check = (lv) => {
        const d = deduce(lv);
        for (const p of d.mines) assert.equal(lv.cell(p.x, p.y).object, 'mine', `${tier}#${seed} false mine`);
        for (const p of d.safe) assert.notEqual(lv.cell(p.x, p.y).object, 'mine', `${tier}#${seed} false safe`);
      };
      check(new Level({ ...g.data, patrols: [] }));
      check(solveLevel(g.data).level);
    }
  }
});

test('solver: refuses to walk through a deduced mine (forced hit => stuck)', () => {
  // One-wide corridor fully blocked by a mine: a logic player must stop, never step on it.
  const rep = solveLevel(parseLevel({ name: 'plug', rows: ['#######', '#S.m.E#', '#######'] }));
  assert.equal(rep.reason, 'stuck');
  assert.equal(rep.damage, 0);
});

test('generator: deterministic for a given difficulty + seed', () => {
  for (const tier of TIERS) {
    assert.equal(grid(generateExpedition(tier, 77)), grid(generateExpedition(tier, 77)));
    assert.notEqual(grid(generateExpedition(tier, 77)), grid(generateExpedition(tier, 78)));
  }
});

const cells = (g, pred) => {
  const out = [];
  g.ascii.rows.forEach((r, y) => [...r].forEach((ch, x) => pred(ch, x, y) && out.push({ x, y, ch })));
  return out;
};
const zoneAt = (g, x, y) => g.data.zones[y * g.data.width + x];
const SEEDS = { safe: 12, scouting: 10, risky: 5 };

test('generator: one start, one exit, the right size, gates and tools for the tier', () => {
  for (const tier of TIERS) {
    const P = DIFFICULTIES[tier];
    for (let seed = 1; seed <= SEEDS[tier]; seed++) {
      const g = generateExpedition(tier, seed);
      assert.equal(count(g, 'S'), 1);
      assert.equal(count(g, 'E'), 1);
      assert.equal(g.data.width, P.width);
      assert.equal(g.data.height, P.height);
      const gates = count(g, 'z') + count(g, 'D') + count(g, 'b') + count(g, 'X');
      assert.equal(gates, P.gates, `${tier}#${seed} sealed doorways`);
      // one tool per gate of each kind (plus spares)
      assert.ok(count(g, 'k') >= count(g, 'D'));
      assert.ok(count(g, 'c') >= count(g, 'b'));
      assert.ok(count(g, 'a') >= count(g, 'z'));
      assert.ok(count(g, 'e') >= count(g, 'X'));
      assert.equal(g.ascii.patrols.length <= P.patrols, true);
    }
  }
});

test('generator: every map has an open outside area with buildings standing in it', () => {
  for (const tier of TIERS) {
    const P = DIFFICULTIES[tier];
    for (let seed = 1; seed <= SEEDS[tier]; seed++) {
      const g = generateExpedition(tier, seed);
      assert.equal(g.info.buildings, P.buildings, `${tier}#${seed} buildings`);
      assert.ok(g.info.rooms >= P.buildings * P.rooms[0], `${tier}#${seed} rooms ${g.info.rooms}`);
      assert.ok(g.info.rooms <= P.buildings * P.rooms[1]);
      const floor = cells(g, (ch) => ch !== '#');
      const outside = floor.filter((c) => zoneAt(g, c.x, c.y) === 'out');
      const inside = floor.filter((c) => zoneAt(g, c.x, c.y) === 'in');
      assert.ok(inside.length > 0, 'something to explore indoors');
      // the wasteland is the bulk of the map, not a few corridors
      assert.ok(outside.length >= floor.length * 0.55, `${tier}#${seed} outside share ${(outside.length / floor.length).toFixed(2)}`);
      // you start and escape outdoors
      const [s] = cells(g, (ch) => ch === 'S');
      const [e] = cells(g, (ch) => ch === 'E');
      assert.equal(zoneAt(g, s.x, s.y), 'out');
      assert.equal(zoneAt(g, e.x, e.y), 'out');
      // and there is minesweeping to do out there as well as inside
      const mines = cells(g, (ch) => ch === 'm');
      assert.ok(mines.filter((m) => zoneAt(g, m.x, m.y) === 'out').length >= 3, 'mines outside');
      // loot is out in the open too, not only behind walls
      assert.ok(cells(g, (ch) => 'sft'.includes(ch)).some((c) => zoneAt(g, c.x, c.y) === 'out'), 'loot outside');
    }
  }
});

test('generator: buildings are sealed boxes - interiors only open onto outside through doorways', () => {
  for (const tier of TIERS) {
    for (let seed = 1; seed <= SEEDS[tier]; seed++) {
      const g = generateExpedition(tier, seed);
      const { width: W, height: H } = g.data;
      const rows = g.ascii.rows;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          if (zoneAt(g, x, y) !== 'in' || rows[y][x] === '#') continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (zoneAt(g, nx, ny) !== 'out') continue;
            // the only way from inside to outside is a one-tile gap with wall on both sides of it
            const ch = rows[ny][nx];
            if (ch === '#') continue;
            const sideA = rows[ny + dx]?.[nx + dy];
            const sideB = rows[ny - dx]?.[nx - dy];
            assert.ok(sideA === '#' && sideB === '#', `${tier}#${seed}: wide opening into a building at ${nx},${ny}`);
          }
        }
    }
  }
});

test('generator: scale and complexity grow Safe < Scouting < Risky', () => {
  const [s, c, r] = TIERS.map((t) => DIFFICULTIES[t]);
  assert.ok(s.width * s.height < c.width * c.height && c.width * c.height < r.width * r.height);
  assert.ok(s.buildings < c.buildings && c.buildings < r.buildings);
  assert.ok(s.rooms[1] < c.rooms[1] && c.rooms[1] < r.rooms[1]);
  assert.ok(s.gates < c.gates && c.gates < r.gates);
  assert.ok(s.patrols < c.patrols && c.patrols < r.patrols);
  assert.ok(s.density < c.density && c.density < r.density);
  assert.ok(s.loot < c.loot && c.loot < r.loot);
  assert.ok(s.lootAmount < c.lootAmount && c.lootAmount < r.lootAmount);
  // Easy is one single-room house; harder maps have a fence with a gated gap
  assert.equal(s.buildings, 1);
  assert.equal(s.rooms[1], 1);
  assert.equal(s.roadblock, false);
  assert.ok(c.roadblock && r.roadblock);
  // measured, too
  const stat = (t, f) => [1, 2, 3, 4].reduce((n, seed) => n + f(generateExpedition(t, seed)), 0);
  const floor = (g) => g.data.cells.filter((x) => x.terrain === 'floor').length;
  const [a, b, d] = TIERS.map((t) => stat(t, floor));
  assert.ok(a < b && b < d, `floor ${a} < ${b} < ${d}`);
  const loot = (g) => g.data.cells.reduce((n, x) => n + (['scrap', 'food', 'materials'].includes(x.pickup) ? x.pickupAmount : 0), 0);
  const [la, lb, ld] = TIERS.map((t) => stat(t, loot));
  assert.ok(la < lb && lb < ld, `loot ${la} < ${lb} < ${ld}`);
});

test('generator: every map is solved by pure logic with zero hits - exit reachable, every item collectable', () => {
  for (const tier of TIERS) {
    const P = DIFFICULTIES[tier];
    for (let seed = 1; seed <= SEEDS[tier]; seed++) {
      const g = generateExpedition(tier, seed);
      const rep = solveLevel(g.data);
      assert.equal(rep.reason, 'won', `${tier}#${seed} should be guess-free`);
      assert.equal(rep.damage, 0, `${tier}#${seed} took a hit`);
      // second run with the manhole sealed so the solver has to clear everything: no item may be left behind
      const sealed = parseLevel({ name: 'sealed', rows: g.ascii.rows.map((r) => r.replace('E', '#')) });
      const full = solveLevel(sealed);
      assert.equal(full.damage, 0, `${tier}#${seed} full clear took a hit`);
      const left = full.level.cells.filter((c) => c.pickup).length;
      assert.equal(left, 0, `${tier}#${seed}: ${left} items can't be collected by logic`);
      assert.ok(g.info.mines >= 1);
      assert.ok(g.info.density > 0 && g.info.density <= P.density + 0.02);
    }
  }
});

test('generator: mines never touch each other, sit in doorways, or crowd the start / doors', () => {
  for (const tier of TIERS) {
    for (let seed = 1; seed <= SEEDS[tier]; seed++) {
      const g = generateExpedition(tier, seed);
      const rows = g.ascii.rows;
      const open = (x, y) => rows[y]?.[x] !== undefined && rows[y][x] !== '#';
      const [s] = cells(g, (ch) => ch === 'S');
      for (const m of cells(g, (ch) => ch === 'm')) {
        const { x, y } = m;
        assert.ok(Math.max(Math.abs(x - s.x), Math.abs(y - s.y)) > 1, 'mine next to start');
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (dx || dy) assert.notEqual(rows[y + dy]?.[x + dx], 'm', `${tier}#${seed}: touching mines at ${x},${y}`);
        const corridor = (open(x - 1, y) && open(x + 1, y) && !open(x, y - 1) && !open(x, y + 1)) ||
          (open(x, y - 1) && open(x, y + 1) && !open(x - 1, y) && !open(x + 1, y));
        assert.ok(!corridor, 'mine plugging a doorway');
        for (const gt of cells(g, (ch) => 'zDbX'.includes(ch)))
          assert.ok(Math.max(Math.abs(x - gt.x), Math.abs(y - gt.y)) > 2, 'mine beside a gate');
      }
    }
  }
});

test('generated patrols pace mine-free straight lines on open ground, not inside buildings', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const g = generateExpedition('risky', seed);
    assert.ok(g.ascii.patrols.length >= 1, 'risky should field a patrol');
    for (const p of g.ascii.patrols) {
      const [a, b] = p.route;
      assert.ok(a.x === b.x || a.y === b.y, 'straight beat');
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++)
        for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
          assert.notEqual(g.ascii.rows[y][x], 'm');
          assert.equal(zoneAt(g, x, y), 'out');
        }
    }
  }
});

test('every region generates valid, solvable maps', async () => {
  const { REGIONS } = await import('../dist/gen/difficulty.js');
  const { solveLevel } = await import('../dist/solver/solve.js');
  for (const region of Object.keys(REGIONS)) {
    for (const tier of ['safe', 'scouting']) {
      const g = generateExpedition(tier, 5, region);
      assert.equal(g.data.region, region);
      const won = solveLevel(g.data);
      assert.equal(won.reason, 'won', `${region} ${tier}`);
      assert.equal(won.damage, 0);
    }
  }
});

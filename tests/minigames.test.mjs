import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../dist/gen/rng.js';
import { LockpickSession } from '../dist/minigames/lockpick.js';
import { HackingSession, ROW_COUNT } from '../dist/minigames/hacking.js';
import { generateExpedition } from '../dist/gen/generate.js';
import { Level } from '../dist/core/level.js';
import { solveLevel } from '../dist/solver/solve.js';

// ───────────── lockpicking ─────────────

function turn(s, seconds = 4) {
  s.grip(true);
  s.lever = 1;
  let ev = 'none';
  for (let t = 0; t < seconds && !s.finished; t += 0.016) ev = s.step(0.016) === 'none' ? ev : s.step(0.0) && ev;
  return ev;
}

test('aiming at the sweet spot and pulling the lever opens the lock', () => {
  for (let level = 1; level <= 6; level++) {
    const s = LockpickSession.generate(level, new Rng(level));
    s.pickAngle = s.sweet;
    s.grip(true);
    s.lever = 1;
    let ev = 'none';
    for (let i = 0; i < 400 && !s.finished; i++) {
      const e = s.step(0.016);
      if (e !== 'none') ev = e;
    }
    assert.equal(ev, 'opened', `level ${level}`);
    assert.ok(s.success && s.finished && !s.snapped);
  }
});

test('over-pulling at the wrong angle snaps the single pick and jams the lock for good', () => {
  const s = LockpickSession.generate(3, new Rng(5));
  s.pickAngle = Math.max(-90, Math.min(90, s.sweet + 80 > 90 ? s.sweet - 80 : s.sweet + 80));
  s.grip(true);
  s.lever = 1;
  let ev = 'none';
  for (let i = 0; i < 2000 && !s.finished; i++) {
    const e = s.step(0.016);
    if (e !== 'none') ev = e;
  }
  assert.equal(ev, 'snapped');
  assert.ok(s.snapped && s.finished && !s.success);
  assert.equal(s.step(0.016), 'none'); // there is no second pick
  s.rotate(10);
  assert.equal(s.lever, 0);
});

test('a gentle partial pull never strains the pick', () => {
  const s = LockpickSession.generate(4, new Rng(9));
  s.pickAngle = s.sweet + 40;
  s.grip(true);
  s.lever = Math.min(0.2, s.maxTurn * 0.9);
  for (let i = 0; i < 300; i++) s.step(0.016);
  assert.equal(s.stress, 0);
});

test('harder locks have a narrower sweet spot', () => {
  const tol = [1, 2, 3, 4, 5, 6].map((l) => LockpickSession.generate(l, new Rng(1)).tolerance);
  for (let i = 1; i < tol.length; i++) assert.ok(tol[i] < tol[i - 1]);
});

// ───────────── terminal ─────────────

const wordPos = (s, text) => {
  const t = s.tokens.find((k) => k.kind === 'word' && k.text === text);
  return [t.row, t.start];
};
const enter = (s, text) => {
  const [r, c] = wordPos(s, text);
  s.tap(r, c);
  s.tap(r, c);
};

test('entering the password opens the terminal', () => {
  for (let level = 1; level <= 7; level++) {
    const s = HackingSession.generate(level, new Rng(level));
    assert.equal(s.rows.length, ROW_COUNT);
    assert.equal(s.password.length, level + 3);
    enter(s, s.password);
    assert.ok(s.finished && s.success && s.flawless);
  }
});

test('running out of attempts locks the terminal for good', () => {
  const s = HackingSession.generate(3, new Rng(4));
  const wrong = s.tokens.filter((t) => t.kind === 'word' && t.text !== s.password).map((t) => t.text);
  for (let i = 0; i < s.maxAttempts; i++) enter(s, wrong[i]);
  assert.ok(s.finished && !s.success);
  assert.equal(s.attempts, 0);
  s.tap(...wordPos(s, s.password));
  s.tap(...wordPos(s, s.password));
  assert.equal(s.success, false); // locked out: the right word no longer works
});

test('likeness clues count matching letters in place', () => {
  const s = HackingSession.generate(2, new Rng(2));
  const decoy = s.tokens.find((t) => t.kind === 'word' && t.text !== s.password).text;
  enter(s, decoy);
  assert.equal(s.tried.get(decoy), [...decoy].filter((ch, i) => ch === s.password[i]).length);
});

test('exploit brackets either remove a dud or restore attempts', () => {
  const s = HackingSession.generate(3, new Rng(7));
  const wrong = s.tokens.find((t) => t.kind === 'word' && t.text !== s.password).text;
  enter(s, wrong);
  assert.equal(s.attempts, s.maxAttempts - 1);
  const duds = s.dudIndexes.length;
  const b = s.tokens.find((t) => t.kind === 'bracket' && !t.removed);
  s.tap(b.row, b.start);
  s.tap(b.row, b.start);
  assert.ok(s.dudIndexes.length < duds || s.attempts === s.maxAttempts);
});

// ───────────── vaults on generated maps ─────────────

const withVault = (tier) => {
  for (let seed = 1; seed < 200; seed++) {
    const g = generateExpedition(tier, seed);
    if (g.data.vaults.length) return g;
  }
  throw new Error('no vault found');
};

test('vaults are sealed rooms with loot, a door and no mines or clues inside', () => {
  let seen = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = generateExpedition('scouting', seed);
    for (const v of g.data.vaults) {
      seen++;
      assert.equal(v.status, 'sealed');
      assert.ok(['lock', 'terminal'].includes(v.kind));
      const door = g.data.cells[v.door.y * g.data.width + v.door.x];
      assert.equal(door.object, 'vaultDoor');
      assert.ok(v.interior.length >= 4);
      let loot = 0;
      const lv = new Level(g.data);
      for (const p of v.interior) {
        const c = g.data.cells[p.y * g.data.width + p.x];
        assert.equal(c.object, null);
        assert.equal(lv.cell(p.x, p.y).clue, 0);
        if (c.pickup) loot++;
        assert.ok(['scrap', 'food', 'materials', null].includes(c.pickup));
      }
      assert.ok(loot >= 1);
    }
  }
  assert.ok(seen >= 6);
});

test('maps with vaults are still solved without a hit and the solver never needs the vault', () => {
  for (const tier of ['scouting', 'risky']) {
    const g = withVault(tier);
    const r = solveLevel(g.data);
    assert.equal(r.reason, 'won');
    assert.equal(r.damage, 0);
  }
});

function standBesideDoor(level, v) {
  const d = v.door;
  const spot = [[0, 1], [0, -1], [1, 0], [-1, 0]]
    .map(([dx, dy]) => ({ x: d.x + dx, y: d.y + dy }))
    .find((p) => level.inBounds(p.x, p.y) && level.cell(p.x, p.y).terrain === 'floor' && !level.cell(p.x, p.y).object && !v.interior.some((q) => q.x === p.x && q.y === p.y));
  level.player = spot;
  for (const c of level.cells) c.revealed = true;
  level.cell(d.x, d.y).revealed = true;
}
const settle = (l) => { for (let i = 0; i < 600 && l.isMoving(); i++) l.update(0.05); };

test('tapping a vault door opens its minigame and pauses the game', () => {
  const g = withVault('scouting');
  const l = new Level(g.data);
  const v = l.vaults[0];
  standBesideDoor(l, v);
  l.tap(v.door.x, v.door.y);
  settle(l);
  assert.equal(l.minigame?.id, v.id);
  assert.ok(l.drainEvents().some((e) => e.type === 'minigame'));
  const t = l.time;
  l.update(1);
  assert.equal(l.time, t); // paused while the minigame is up
});

test('ignoring the minigame leaves the vault as it was and it can be tried again', () => {
  const l = new Level(withVault('scouting').data);
  const v = l.vaults[0];
  standBesideDoor(l, v);
  l.tap(v.door.x, v.door.y); settle(l);
  l.resolveMinigame('ignored');
  assert.equal(v.status, 'sealed');
  l.tap(v.door.x, v.door.y); settle(l);
  assert.ok(l.minigame);
});

test('failing locks the vault for good: the door stays shut and cannot be retried', () => {
  const l = new Level(withVault('scouting').data);
  const v = l.vaults[0];
  standBesideDoor(l, v);
  l.tap(v.door.x, v.door.y); settle(l);
  l.resolveMinigame('failed');
  assert.equal(v.status, 'lockedOut');
  assert.equal(l.cell(v.door.x, v.door.y).object, 'vaultDoor');
  l.drainEvents();
  l.tap(v.door.x, v.door.y); settle(l);
  assert.equal(l.minigame, null);
  assert.ok(l.drainEvents().some((e) => e.type === 'message' && e.key === 'vaultLocked'));
});

test('succeeding opens the door and reveals the loot, which can be walked in and collected', () => {
  const l = new Level(withVault('scouting').data);
  const v = l.vaults[0];
  for (const c of l.cells) c.revealed = false;
  standBesideDoor(l, v);
  for (const c of l.cells) c.revealed = false;
  l.cell(l.player.x, l.player.y).revealed = true;
  l.tap(v.door.x, v.door.y); settle(l);
  l.resolveMinigame('success');
  assert.equal(v.status, 'open');
  assert.equal(l.cell(v.door.x, v.door.y).object, null);
  for (const p of v.interior) assert.ok(l.cell(p.x, p.y).revealed);
  const before = { ...l.loot };
  const target = v.interior.find((p) => l.cell(p.x, p.y).pickup);
  l.tap(target.x, target.y);
  for (let i = 0; i < 600 && l.isMoving(); i++) l.update(0.05);
  const after = l.loot;
  assert.ok(after.scrap + after.food + after.materials > before.scrap + before.food + before.materials);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../dist/night/night.js';
import * as B from '../dist/core/base.js';
import { Level } from '../dist/core/level.js';
import { generateExpedition } from '../dist/gen/generate.js';

test('night zombie kinds appear only later', () => {
  const early = N.kindChances(1);
  const late = N.kindChances(20);
  assert.ok(JSON.stringify(early) !== JSON.stringify(late));
  assert.ok(Object.keys(N.ZOMBIE_KINDS).length >= 3);
});

test('level snapshot survives JSON and restores state', () => {
  const data = generateExpedition('scouting', 7, 'wasteland').data;
  const a = new Level(data);
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = new Level(generateExpedition('scouting', 7, 'wasteland').data);
  b.restore(snap);
  assert.deepEqual(JSON.parse(JSON.stringify(b.snapshot())), snap);
});

test('save code round trip (base64 of serialize)', () => {
  const s = B.serialize(B.newBase());
  const back = B.deserialize(Buffer.from(Buffer.from(s).toString('base64'), 'base64').toString());
  assert.ok(back);
  assert.equal(B.deserialize('nonsense'), null);
});

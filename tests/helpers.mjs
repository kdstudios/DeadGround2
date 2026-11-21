import { Level } from '../dist/core/level.js';
import { parseLevel } from '../dist/levels/parse.js';
import { expedition1 } from '../dist/levels/expedition1.js';

/** Build a Level from ASCII rows (see src/levels/parse.ts for the legend). */
export function make(rows, patrols = []) {
  return new Level(parseLevel({ name: 'test', rows, patrols }));
}

export function makeExpedition({ patrols = true } = {}) {
  return new Level(parseLevel({ ...expedition1, patrols: patrols ? expedition1.patrols : [] }));
}

/** Advance the simulation by `seconds`. */
export function run(level, seconds, dt = 0.05) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) level.update(dt);
}

/** Run until the player stops moving (or a safety limit is hit). */
export function settle(level, maxSeconds = 60) {
  for (let t = 0; t < maxSeconds && (level.isMoving() || t === 0); t += 0.05) level.update(0.05);
}

export function tapAndSettle(level, x, y) {
  level.tap(x, y);
  settle(level);
}

export function events(level, type) {
  return level.drainEvents().filter((e) => e.type === type);
}

export function flagAllMines(level) {
  for (let y = 0; y < level.height; y++)
    for (let x = 0; x < level.width; x++)
      if (level.cell(x, y).object === 'mine') level.toggleFlag(x, y);
}

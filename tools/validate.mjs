// Batch-validate the generator: node tools/validate.mjs [seedsPerTier] [firstSeed]
// Every generated map must be won by the logic-only solver with zero hits, and a second solver run with
// the manhole sealed must collect every item on the map. Run `npm run build` first.
import { generateExpedition } from '../dist/gen/generate.js';
import { solveLevel } from '../dist/solver/solve.js';
import { parseLevel } from '../dist/levels/parse.js';

const REGION = process.argv[4] ?? 'wasteland';
const per = Number(process.argv[2] ?? 100);
// STORY=1 generates every Scouting / Risky map with both campaign story items and checks they are collected too
const STORY = process.env.STORY === '1' ? ['transmitter', 'researcher'] : [];
const first = Number(process.argv[3] ?? 1);
let bad = 0;
for (const tier of ['safe', 'scouting', 'risky']) {
  const n = tier === 'risky' ? Math.max(1, Math.round(per / 3)) : per;
  let ms = 0, worst = 0, mines = 0, floor = 0, guesses = 0;
  for (let seed = first; seed < first + n; seed++) {
    const t = Date.now();
    const g = generateExpedition(tier, seed, REGION, tier === 'safe' ? [] : STORY);
    const dt = Date.now() - t;
    ms += dt;
    worst = Math.max(worst, dt);
    const won = solveLevel(g.data);
    const full = solveLevel(parseLevel({ name: 'sealed', rows: g.ascii.rows.map((r) => r.replace('E', '#')) }));
    const left = full.level.cells.filter((c) => c.pickup).length;
    if (won.reason !== 'won' || won.damage > 0 || full.damage > 0 || left > 0) {
      bad++;
      console.log(`FAIL ${tier}#${seed}: ${won.reason}, hits ${won.damage}/${full.damage}, ${left} items stranded`);
    }
    mines += g.info.mines;
    floor += g.data.cells.filter((c) => c.terrain === 'floor').length;
    guesses += won.damage + full.damage;
  }
  console.log(
    `${tier.padEnd(8)} ${n} maps  all valid: ${bad === 0}  avg ${(ms / n).toFixed(0)} ms (worst ${worst})  ` +
      `mines ${(100 * mines / floor).toFixed(1)}% of floor  forced guesses ${guesses}`,
  );
}
process.exit(bad ? 1 : 0);

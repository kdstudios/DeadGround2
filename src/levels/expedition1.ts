import { parseLevel, type AsciiLevel } from './parse.js';

/**
 * Hand-built Phase 1 test expedition. Covers every Phase 1 mechanic:
 *
 *  - Start (bottom-left) -> exit manhole (top-right), several ways to get there:
 *      A) Down the long south corridor, across the east yard and up through the
 *         gap guarded by the patrolling SWAT zombie (time it, or bomb it).
 *      B) Pick up ammo near the start, shoot the zombie in the north-west gate,
 *         cross the north-west room and leave through its east gap.
 *  - Warehouse (loot + explosive + shield) can be entered by:
 *      key door (key is in the north-west room), crowbar on the south barricade
 *      (crowbar is near the start) or a bomb on the cracked east wall
 *      (second explosive is in the east yard).
 *  - Mines are scattered at roughly classic Minesweeper density (~12% of open floor),
 *    never orthogonally adjacent, with gates, doors and the patrol route kept clear.
 *    The fog only opens a few tiles around the avatar, so the numbers do the work.
 */
export const expedition1: AsciiLevel = {
  name: 'Expedition 1 - Dead Ground',
  rows: [
    '##############################',
    '#....m.f...m#.......m..t....E#',
    '#.k.....m...#..m......m......#',
    '#m..........#...sm...........#',
    '#......m..m.#...m.m....m.....#',
    '#.m..............m........m..#',
    '#...f.......#m.........m.....#',
    '#.......m..m#.....m.........m#',
    '######z##################.####',
    '#.......m....#########m......#',
    '#.m.........m#.....m.#s......#',
    '#...m.....m..#..s.e..#....m..#',
    '#m..r........#.h.....#.....a.#',
    '#.m..m...m...D.m.....X.......#',
    '#..m....m..m.#..p...t#....m..#',
    '#..a.........#.......#.m.....#',
    '#........c.m.#.s.....#......e#',
    '#.S..........####b####m..m.m.#',
    '#.........m...............m..#',
    '##############################',
  ],
  patrols: [
    // Armoured SWAT zombie pacing the gap into the north half.
    { route: [{ x: 25, y: 8 }, { x: 25, y: 13 }], speed: 2 },
  ],
};

export const expedition1Data = () => parseLevel(expedition1);

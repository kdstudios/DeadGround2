# DeadGround

*Minesweeper Adventure meets the zombie apocalypse.* Explore a fog-covered grid, read the
numbers, dodge hidden mines, shoot zombies, open doors, and find the open manhole.

**Status: Phase 5 — content and polish (in progress)**.

## Run it

Needs Node 20+ (no other dependencies to play; TypeScript is only used to compile).

```bash
npm install        # installs TypeScript
npm start          # compiles, then serves http://localhost:8080
npm run dev        # compile in watch mode + server (refresh the browser after edits)
npm test           # compile + run the engine tests
```

Open the folder in VS Code and run the same commands from its terminal.

### GitHub Pages

Push to a GitHub repo with a `main` branch, then in *Settings → Pages* choose
**GitHub Actions**. `.github/workflows/pages.yml` builds, runs the tests and publishes the
game, which then plays in any browser (phones included).

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Move | click a tile | tap a tile (auto-pathfinds around anything *known* to be dangerous) |
| Flag a suspected mine | right-click, or `F` flag mode | long-press, or the flag button |
| Look around | drag | drag |
| Interact | tap the zombie / planks / door — you walk up and use the right item automatically | same |
| Explosive / map | `B` / `M` or the slot: first press previews the 3×3 area, press again (or tap the area) to confirm; tap elsewhere to cancel | same |
| Menu | `Esc` | Menu button |

## Rules implemented

- **Fog of war:** unexplored tiles are dirt. Stepping reveals tiles Minesweeper-style - empty tiles open up and
  numbered tiles form the border - but only within `fogRadius` tiles of the avatar (default 3, in
  `src/core/config.ts`), so the fog only ever clears near you. Mines stay hidden until they go off.
- **Clues:** the orange number on a tile counts the mines in the 8 surrounding tiles. Numbers don't
  change when a mine goes off.
- **Movement:** 8 directions - diagonals are allowed (but can't cut the corner of a wall, door or barricade)
  and take proportionally longer. Every tap prefers a route made only of tiles you already know are safe
  (revealed, not flagged, not a known hazard), even if that's longer. Tapping a hidden tile more than one
  square away walks the known route to the nearest known tile beside it, then makes the final step onto it.
  Only if no known route exists does it cut through the fog, where hidden mines and zombies can still
  catch you.
- **Health:** 4 hearts (max 5). Mine −1, standard zombie bump −1, SWAT zombie −2. A shield absorbs one
  hit of any kind. Hearts at 0 ends the expedition. Medkits heal 1.
- **Standard zombie:** stationary. Tap it → player walks up and spends 1 ammo to kill it.
- **Armoured SWAT zombie:** patrols a fixed route in real time, hidden under fog until its tile is
  revealed. Contact hurts (with a short cooldown). Ammo can't kill it; an explosive can.
- **Crowbar:** removes one plank barricade (auto-used when you tap the planks).
- **Key:** opens one locked door. **Explosive:** destroys cracked walls and planks, kills zombies and
  SWAT in the 3×3 around you, safely detonates mines there — but never opens locked doors.
- **Map fragment:** reveals the 3×3 around you; hidden mines in it are shown as known hazards.
- **Exit:** walk onto the open manhole. Only scrap/food/materials are banked; tools don't carry over.

## Project layout

```
src/core/      Pure game rules - no DOM, fully unit-tested
  config.ts      every balance number (hearts, damage, speeds...)
  defs.ts        data-driven object & pickup definitions (add new ones here)
  level.ts       Level state: fog, clues, movement, hazards, items, patrols
  pathfind.ts    BFS pathfinder
src/levels/    ASCII level format + the hand-built expedition
src/render/    Canvas renderer + sprite lookup (reads core state, never changes it)
src/ui/        DOM HUD
src/main.ts    game loop, input, menus
assets/        sprites/ + manifest.json + style.css
art/atlas2/    your atlas sheets (source for tools/build_sprites.py)
tools/         static server, sprite builder (python + Pillow)
tests/         node:test suites run against the compiled output
```

Rendering is fully separate from the rules: the renderer only reads `Level` state and listens to its
events, so art changes never touch gameplay code.

## Art

v08: outdoor ground tiles are seamless and feather into neighbouring ground; the map boundary uses a darker wall (`bwall*`); furniture (`furniture` group) is walkable flavour on building floors; the flag is red; the exit is an ajar manhole with glowing bouncing EXIT text once revealed.

All art comes from the five atlas sheets in `art/atlas2/` (terrain, ruins, urban, loot, chars).
`python3 tools/build_sprites.py` (Pillow, numpy, scipy) slices them into `assets/sprites/*.png` and writes
`assets/manifest.json`, including named **groups** the renderer picks from:

| Group | Used for |
|---|---|
| `ground_dirt` / `ground_grass` / `ground_dark` / `ground_misc` / `ground_paved` | open wasteland, in smooth patches, freely rotated per cell |
| `floor_in` | building floors - every room gets its own |
| `wall`, `ruinwall` | auto-tiled 2.5D walls (16 neighbour variants each): building walls and the fence |
| `prop_out` | blocking rubble and junk on open ground (rubble, sandbags, barriers, crates, barrels, tyres, bushes...) |
| `fog` | covered tiles |
| `decor`, `buildings` | scenery beyond the map edge; the skyline of houses and a watchtower along the top |

Characters are `player_/zombie_/swat_` + `down|up|left|right` + `_0..3` (4-frame walk cycles).
Items are `item_*`, doors / planks / cracked wall are overlays `ov_*` drawn on the wall tile.

To swap a sprite, drop a PNG with the same name into `assets/sprites/`; to add a new ground tile or prop,
add the file and list its name in the right group in `assets/manifest.json` (or add it to the picks in
`build_sprites.py` and re-run). `src/render/visuals.ts` holds the ground / floor / prop selection rules.

## Designing levels

Levels are ASCII — see `src/levels/expedition1.ts` and the legend in `src/levels/parse.ts`.
Tip: keep mines at roughly classic density (10-15% of open floor), avoid putting two orthogonally
next to each other, and keep gates, doors and patrol routes mine-free. Phase 2 will place mines
automatically and verify that every map can be solved by logic.

## Roadmap

1. ✅ Exploration prototype
2. ✅ Procedural generator + solver/validator (every map provably solvable)
3. ✅ Safehouse, survivors, food, day/night, save/load
4. ✅ Night base defence (casual, grid-based, tap-to-move)
5. 🔶 Content & polish (regions, sound, effects, tips done; more content to come)


## Phase 2 - random expeditions (guess-free)

**New Game** now offers three runs, each a freshly generated map (random seed). Every map is an open
**wasteland you can minesweep around outside**, with buildings standing in it:

| Run | Map | Buildings | Outside | Sealed doorways (zombie / locked door / planks / cracked wall) | SWAT patrols |
|---|---|---|---|---|---|
| Safe (easy) | 22x16 | 1 small single-room house | open yard, a few rubble piles | 1 (planks or a zombie in the doorway) | 0 |
| Scouting (normal) | 34x24 | 2 houses, 2-3 rooms each | bigger yard, **a ruined fence** with one gated gap before the exit | 4 | 1 |
| Risky (hard) | 48x32 | 4 buildings, 3-5 rooms each | sprawling, fence with a gated gap | 7 | 2 |

Mines are scattered both outside and inside (roughly 4-7% of floor once made guess-free), loot piles
are about two thirds inside the buildings and a third out in the open, and bigger runs pay bigger piles.
(Tuning lives in `src/gen/difficulty.ts`. The densities are targets: the generator thins mines where
needed to keep the map solvable and rejects a layout that would end up under half the target.)

How a map is made (`src/gen/generate.ts`):
1. Open ground inside a boundary wall. The start is on the west edge and the manhole on the east side.
2. On Scouting/Risky a ruined fence runs top to bottom with a single gap, and the exit is beyond it.
3. Buildings are placed with clear space around them. Each has an outer wall, one entrance (sometimes a
   second on another side) and, on harder runs, partition walls splitting it into rooms joined by doorways.
   Rubble piles are scattered outside, always leaving the ground fully connected.
4. Some doorways (the fence gap, building entrances, doorways between rooms) are sealed with a zombie,
   locked door, plank barricade or cracked wall. The matching tool (ammo, key, crowbar, explosive) is
   always placed somewhere reachable *before* its gate - often inside another building - and without
   needing another gate of the same kind, so a tool can never be wasted into a dead end.
5. Mines go outside and inside: never touching each other (not even diagonally), never in a doorway, never
   near the start, exit or a gate.
6. The **logic solver** (`src/solver/`) plays the map in the real game engine using only what a player can
   see (revealed tiles, clue numbers, visible objects). It never guesses. It plays twice: once to reach the
   manhole, and once more with the manhole sealed so it has to clear the whole map and collect every item.
   If it gets stuck, mines on the stuck frontier are removed and it tries again. Maps it can't finish with
   zero hits are discarded.
7. SWAT patrols are added last on mine-free straight runs of open ground outside (never inside buildings),
   with spare explosives to deal with them.

Every returned map is therefore finishable by pure deduction without taking damage, with every item
collectable. `npm run validate` runs the batch check over hundreds of seeds (`node tools/validate.mjs
[seedsPerTier] [firstSeed]`). Same difficulty + seed always gives the same map.

Retry replays the same map; after a win, "New expedition" rolls a new one. The hand-built Expedition 1
is still available as a test map.

Not yet decided (Phase 3): loot only being kept if you escape alive, and how it feeds the safehouse.


## Phase 3 - safehouse and survival

- **Loop:** safehouse -> expedition -> escape -> safehouse -> night. New Game starts a fresh base; Continue resumes the autosave (localStorage).
- **Stamina:** 6 per day. Safe costs 1, Scouting 2, Risky 3 (spent on departure). At 0 (or whenever you choose) you rest and night falls.
- **Death:** everything found and everything carried is lost (stamina is still spent). Abandoning a run counts as dying.
- **Night:** the garden grows food, then you and each survivor eat 1 food. Short on food: a survivor leaves (never you). Zombie attacks arrive in Phase 4.
- **Survivors:** stranded in buildings on Scouting (1) and Risky (2) maps; reaching them recruits them if you escape. Each has a random role with one passive perk (engineer, medic, farmer, soldier, scavenger).
- **Facilities (3 levels):** Storage (resource cap), Garden (food), Workshop (craft ammo/explosive/shield/map into the kit packed for the next run; unused kit returns if you escape), Barricades and Watchtower (stored for Phase 4).
- All numbers live in `src/core/base.ts`; rules are pure and covered by `tests/base.test.mjs`.


## Phase 4 - night defence

Resting ends the day: the safehouse is attacked (or **Skip night** for a quiet one, no salvage, no risk).
- **Grid scene** with the same art and tap-to-move. Zombies walk the grid to the **core** (the safehouse door), chewing through **barricaded gates** on the way.
- **Arrows are free and slow**: your survivor auto-fires at the nearest zombie; survivors stationed on **towers** do too. Tap a tower during prep to choose its archer (or Auto-assign). Tap a damaged gate to walk over and repair it (1 material per +3 HP).
- **Upgrades:** Watchtower = tower slots (1 + level) and range, Armoury = fire rate (+25%/lvl) and damage (+1/lvl), Barricades = gate strength. Roles: soldiers fire faster; a stationed medic mends the core; a stationed engineer patches gates.
- **Stakes:** win = salvage 1 scrap per 4 kills (broken gates are rebuilt by morning). Lose = a quarter of your stock is raided; the save and survivors are safe.
- Tuning is in `TUNING` in `src/night/night.ts`; rules are pure and tested in `tests/night.test.mjs` (including simulated nights).


## Phase 5 - content and polish (so far)

- **Regions:** pick Wasteland, Overgrown suburbs (grassy, less junk and loot) or Industrial yard (scorched ground, more junk and loot) when you set out. Regions only change ground look and the rubble/loot counts, so every map is still validated guess-free (`node tools/validate.mjs 30 1 forest`).
- **Sound:** synthesized Web Audio effects (no asset files) for pickups, hits, mines, doors, bombs, arrows, gates, repairs and results. Toggle in Options.
- **Night effects:** arrow-hit particles and damage numbers, gate-smash dust and screen shake, a red flash when the core is bitten.
- **Tutorial / QoL:** a dismissible safehouse tips banner (re-enable in Options), and a night that is interrupted by a reload resumes with the same seed.


## Minigames: lockpicking and terminal hacking (ported from Wasteland Terminal)

Only the two minigames (rules, physics and art) were taken from the other game; nothing else.
- **Vaults:** maps can contain sealed vault rooms out in the open (Safe: sometimes one, Scouting: 1-2, Risky: 2-3). The door carries a **lock** or a **terminal**, picked at random, with a difficulty that scales with the run. Tap the door while standing beside it. The minigame is **optional**: IGNORE leaves it as it was.
- **Reward:** opening the door reveals the room and its loot (a storeroom of materials and scrap, a pantry of food, or a scrap cache). Loot is banked like any other.
- **Single attempt, no lockpick items:** the lock gives you one pick; if its strain hits 100% it snaps and the lock jams for good. The terminal gives 4 attempts (3 on the hardest); run out and it locks you out for good. A failed vault stays shut for the rest of the run (no damage, no retry).
- **Lock rules:** drag the lock to aim the pick, pull the lever to turn; the cylinder only turns as far as the angle allows, and over-pulling strains the pick. **Terminal rules:** tap a word to highlight and again to enter it; the clue is how many letters match in place; bracket pairs are exploits (remove a decoy or restore attempts).
- **Guess-free maps still hold:** the vault is walled in before the solver validates the map (door counted as wall), nothing inside is required, and any candidate spot that changes solvability is discarded. Interiors contain no mines and read as clue 0.
- Code: `src/minigames/` (pure rules, tested in `tests/minigames.test.mjs`), `src/ui/minigames.ts` (screens), vault generation in `src/gen/generate.ts`, vault engine rules in `src/core/level.ts`. Art: `art/atlas2/minigame.*` cut by `tools/build_sprites.py`.


## Touch controls and fixes (v14)

- **Hold a hidden square** for a split second: **Reveal** appears above it and **Flag** (or **Unflag**) below it. Slide your finger up or down to choose, release to confirm, release in the middle to cancel. Dragging before the hold still pans the map. Right-click still flags on desktop.
- **Rotating a phone** now re-fits the canvas on the next frame (and on orientationchange / visualViewport resize), so the picture no longer stretches and taps line up.
- **Terminal minigame:** the whole guess history stays in a scrollable log (swipe or wheel), auto-scrolling to the newest line.

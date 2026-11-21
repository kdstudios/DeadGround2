import {
  EXPEDITION_COST,
  SAVE_KEY,
  craft,
  departExpedition,
  deserialize,
  applyNight,
  endDay,
  loadout,
  newBase,
  returnHome,
  serialize,
  upgrade,
  ROLES,
  type BaseState,
} from './core/base.js';
import { CONFIG } from './core/config.js';
import { Level } from './core/level.js';
import { REGIONS, type Difficulty, type Region } from './gen/difficulty.js';
import { generateExpedition } from './gen/generate.js';
import { expedition1Data } from './levels/expedition1.js';
import { Renderer } from './render/renderer.js';
import { SpriteStore } from './render/sprites.js';
import { Hud } from './ui/hud.js';
import { sfx } from './audio/sfx.js';
import { MinigameOverlay } from './ui/minigames.js';
import { renderSafehouse } from './ui/safehouse.js';
import type { GameEvent } from './core/types.js';
import { Night } from './night/night.js';
import { NightRenderer } from './render/nightRenderer.js';
import { towerSlotsUnlocked } from './night/night.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const TIPS_KEY = 'deadground.tips';
const LONG_PRESS_MS = 420;

class Game {
  level: Level | null = null;
  flagMode = false;
  readonly renderer: Renderer;
  private hud = new Hud();
  private last = performance.now();
  private resultsTimer = 0;
  private resultsShown = false;
  /** The persistent safehouse (null until New Game / Continue). */
  base: BaseState | null = deserialize(localStorage.getItem(SAVE_KEY));
  private kit: ReturnType<typeof loadout> | undefined;
  night: Night | null = null;
  region: Region = ((): Region => {
    const r = localStorage.getItem('deadground.region') as Region | null;
    return r && r in REGIONS ? r : 'wasteland';
  })();
  private nightRenderer: NightRenderer;
  private minigames: MinigameOverlay;
  private nightDone = false;

  constructor(
    private canvas: HTMLCanvasElement,
    sprites: SpriteStore,
  ) {
    this.renderer = new Renderer(canvas, sprites);
    this.nightRenderer = new NightRenderer(canvas, sprites);
    this.minigames = new MinigameOverlay(sprites, $('minigame'));
    this.bindInput();
    this.bindUi();
    requestAnimationFrame((t) => this.frame(t));
  }

  /** What is being played, so Retry can replay the same map and Next can roll a new one. */
  private run: { kind: 'test' } | { kind: 'gen'; difficulty: Difficulty; seed: number; region: Region } = { kind: 'test' };

  /** Start a freshly generated expedition (random seed unless one is given). */
  startGenerated(difficulty: Difficulty, seed = Math.floor(Math.random() * 1_000_000) + 1, region: Region = this.region): void {
    if (this.base) {
      // the supplies packed in the safehouse go out with the player; the stamina is spent right away
      const kit = loadout(this.base);
      if (!departExpedition(this.base, difficulty)) return;
      this.kit = kit;
      this.persist();
    } else this.kit = undefined;
    this.run = { kind: 'gen', difficulty, seed, region };
    // Generation (and its guess-free check) can take a moment on Risky: show a message first.
    const note = $('loading');
    note.textContent = 'Surveying the wasteland…';
    note.hidden = false;
    window.setTimeout(() => {
      this.start();
      note.hidden = true;
    }, 30);
  }

  start(): void {
    this.level = new Level(
      this.run.kind === 'gen' ? generateExpedition(this.run.difficulty, this.run.seed, this.run.region).data : expedition1Data(),
      this.run.kind === 'gen' ? this.kit : undefined,
    );
    $('btn-restart').hidden = this.run.kind === 'gen';
    this.renderer.recenter();
    this.flagMode = false;
    this.resultsShown = false;
    window.clearTimeout(this.resultsTimer);
    this.renderer.resetCamera();
    this.renderer.resize();
    this.hud.setLevelName(this.level.name);
    this.hud.show(true);
    for (const id of ['menu', 'results', 'options', 'choose', 'safehouse', 'night']) $(id).hidden = true;
    if (localStorage.getItem(TIPS_KEY) !== '0') {
      this.hud.toast('Tap to move · hold (or right-click) to flag a suspected mine · find the open manhole', 5000);
    }
  }

  showMenu(): void {
    this.hud.show(false);
    this.level = null;
    for (const id of ['results', 'options', 'choose', 'safehouse', 'night']) $(id).hidden = true;
    ($('m-continue') as HTMLButtonElement).disabled = !this.base;
    $('menu').hidden = false;
  }

  private persist(): void {
    if (this.base) localStorage.setItem(SAVE_KEY, serialize(this.base));
  }

  // ───────────── safehouse ─────────────

  showSafehouse(): void {
    const b = this.base;
    if (!b) return this.showMenu();
    this.hud.show(false);
    this.level = null;
    for (const id of ['menu', 'results', 'options', 'choose', 'night']) $(id).hidden = true;
    renderSafehouse($('safehouse'), b, {
      expedition: () => this.showChoose(),
      sleep: () => this.sleep(),
      upgrade: (f) => {
        if (upgrade(b, f)) {
          sfx.play('upgrade');
          this.persist();
        }
        this.showSafehouse();
      },
      craft: (k) => {
        if (craft(b, k)) {
          sfx.play('repair');
          this.persist();
        }
        this.showSafehouse();
      },
      menu: () => this.showMenu(),
      tips: localStorage.getItem('deadground.hometips') !== '1',
      hideTips: () => {
        localStorage.setItem('deadground.hometips', '1');
        this.showSafehouse();
      },
    });
    if (b.pendingNight && !this.night) return this.sleep(b.pendingNight.seed); // a reload mid-night resumes it
    $('safehouse').hidden = false;
  }

  private showChoose(): void {
    const b = this.base;
    $('safehouse').hidden = true;
    $('choose').hidden = false;
    document.querySelectorAll<HTMLButtonElement>('.diff').forEach((btn) => {
      const cost = EXPEDITION_COST[btn.dataset.diff as Difficulty];
      const ok = !b || b.stamina >= cost;
      btn.disabled = !ok;
      btn.classList.toggle('off', !ok);
    });
    this.renderRegions();
    $('c-stamina').textContent = b
      ? `Stamina ${b.stamina} left today. Safe costs 1, Scouting 2, Risky 3. Harder runs pay more.`
      : 'Every expedition is a freshly generated map. Harder runs pay more loot.';
  }

  /** Rest until night: the safehouse is attacked unless the player skips it. */
  private renderRegions(): void {
    const box = $('c-regions');
    box.innerHTML = (Object.keys(REGIONS) as Region[])
      .map((r) => `<button class="reg ${r === this.region ? 'on' : ''}" data-region="${r}" title="${REGIONS[r].blurb}">${REGIONS[r].label}</button>`)
      .join('');
    $('c-region-note').textContent = REGIONS[this.region].blurb;
    box.querySelectorAll<HTMLElement>('.reg').forEach((b) =>
      b.addEventListener('click', () => {
        this.region = b.dataset.region as Region;
        localStorage.setItem('deadground.region', this.region);
        this.renderRegions();
      }),
    );
  }

  private sleep(seed = Math.floor(Math.random() * 1_000_000) + 1): void {
    const b = this.base;
    if (!b) return;
    b.pendingNight = { seed };
    this.persist();
    $('safehouse').hidden = true;
    this.night = new Night({
      day: b.day,
      seed,
      survivors: b.survivors.map((s) => ({ ...s })),
      facilities: { ...b.facilities },
      materials: b.stock.materials,
    });
    this.nightDone = false;
    this.hud.show(false);
    $('nhud').hidden = false;
    $('n-start').hidden = false;
    $('n-auto').hidden = false;
    this.nightHud();
  }

  private nightHud(): void {
    const n = this.night;
    if (!n) return;
    const open = towerSlotsUnlocked(this.base?.facilities.watchtower ?? 0);
    $('n-info').textContent =
      n.phase === 'prep'
        ? `Night ${n.setup.day} · ${n.total} zombies coming`
        : `Zombies ${n.zombiesLeft}/${n.total} · Core ${n.coreHp}/14 · Materials ${n.materials}`;
    $('n-hint').textContent =
      n.phase === 'prep'
        ? `Tap a tower to choose its archer (${open} tower${open === 1 ? '' : 's'} built). Tap to move. Tap a damaged gate to repair it (1 material).`
        : 'Tap to move · tap a gate to repair · archers fire on their own';
  }

  private frameNight(dt: number): void {
    const n = this.night!;
    const top = $('nhud').querySelector('.ntop')!.getBoundingClientRect();
    const bottom = $('nhud').querySelector('.nbottom')!.getBoundingClientRect();
    const hintBottom = $('n-hint').getBoundingClientRect().bottom;
    this.nightRenderer.setInsets(Math.max(top.bottom, hintBottom) + 6, Math.max(0, window.innerHeight - bottom.top) + 6);
    n.update(dt);
    const ev = n.drainEvents();
    this.nightRenderer.handleEvents(ev);
    for (const e of ev) {
      const s = { shot: 'arrow', hit: 'hit', kill: 'kill', gateHit: 'gateHit', gateBreak: 'gateBreak', coreHit: 'coreHit', repair: 'repair', spawn: null } as const;
      const name = s[e.type];
      if (name) sfx.play(name);
    }
    this.nightRenderer.render(n, dt);
    this.nightHud();
    if ((n.phase === 'won' || n.phase === 'lost') && !this.nightDone) {
      this.nightDone = true;
      window.setTimeout(() => this.finishNight(false), 900);
    }
  }

  /** Resolve the night (defended or skipped), then the usual food and morning report. */
  private finishNight(skipped: boolean): void {
    const b = this.base;
    const n = this.night;
    if (!b || !n) return;
    const r = n.result();
    let defence = 'The barricades held through a quiet night.';
    if (!skipped) {
      const out = applyNight(b, { won: r.won, killed: r.killed, materialsSpent: r.materialsSpent });
      if (r.won) {
        defence = `You held the safehouse: ${r.killed} zombies down, core at ${r.coreHp}/14.` + (r.barricadesLost ? ` ${r.barricadesLost} gate(s) were broken and rebuilt by morning.` : '') + (out.salvage ? ` Salvaged ${out.salvage} scrap.` : '') + (r.materialsSpent ? ` Spent ${r.materialsSpent} materials on repairs.` : '');
      } else {
        defence = `The zombies broke in and raided the stores: lost ${out.lost.scrap} scrap, ${out.lost.food} food, ${out.lost.materials} materials. You and your survivors got away.`;
      }
    }
    this.night = null;
    $('nhud').hidden = true;
    b.pendingNight = null;
    sfx.play(skipped || r.won ? 'win' : 'lose');
    const rep = endDay(b);
    this.persist();
    $('n-title').textContent = `Night ${rep.day}`;
    const lines = [
      defence,
      rep.grown ? `The garden gave ${rep.grown} food.` : '',
      `Everyone ate: ${rep.eaten} of ${rep.needed} food.`,
      rep.left.length ? `Short of food, ${rep.left.map((s) => `${s.name} (${ROLES[s.role].label})`).join(' and ')} left in the dark.` : '',
      rep.starving && !rep.left.length ? 'You went hungry. Find food.' : '',
      `Day ${b.day} begins. Stamina restored.`,
    ].filter(Boolean);
    $('n-body').textContent = lines.join('\n');
    $('night').hidden = false;
  }

  /** Leave an expedition for the safehouse; if it is not over, this counts as a failed run. */
  private abandon(): void {
    const l = this.level;
    if (l && this.base && this.run.kind === 'gen' && l.status === 'playing') {
      if (!window.confirm('Abandon this expedition? Everything you found is lost.')) return;
      returnHome(this.base, { ...l.results(), status: 'failed' });
      this.persist();
      this.resultsShown = true;
    }
    if (this.base) this.showSafehouse();
    else this.showMenu();
  }

  private playEvents(events: GameEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'pickup': sfx.play(e.id === 'survivor' ? 'rescue' : 'pickup'); break;
        case 'damage': sfx.play(e.absorbed ? 'shield' : 'hurt'); break;
        case 'mineTriggered': sfx.play('mine'); break;
        case 'zombieKilled': case 'swatKilled': sfx.play('kill'); break;
        case 'obstacleRemoved': sfx.play('door'); break;
        case 'explosion': sfx.play('bomb'); break;
        case 'vaultOpened': sfx.play('door'); break;
        case 'vaultLocked': sfx.play('alarm'); break;
        case 'won': sfx.play('win'); break;
        case 'failed': sfx.play('lose'); break;
        default: break;
      }
    }
  }

  // ───────────── frame loop ─────────────

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const level = this.level;
    if (level) {
      this.measureHud();
      level.update(dt);
      const events = level.drainEvents();
      this.renderer.handleEvents(level, events);
      this.playEvents(events);
      if (level.minigame && !this.minigames.isOpen) {
        const v = level.minigame;
        this.minigames.open(v, (outcome) => level.resolveMinigame(outcome));
      }
      for (const e of events) if (e.type === 'message') this.hud.toastMessage(e.key);
      this.renderer.render(level, dt, this.flagMode);
      this.hud.update(level, this.flagMode);
      if (level.status !== 'playing' && !this.resultsShown) {
        this.resultsShown = true;
        this.resultsTimer = window.setTimeout(() => this.showResults(level), level.status === 'won' ? 600 : 900);
      }
    } else if (this.night) {
      this.frameNight(dt);
    } else {
      this.renderer.resize();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Tell the renderer how much of the canvas the HUD bars cover so the player is never hidden behind them. */
  private measureHud(): void {
    const top = $('topbar').getBoundingClientRect();
    const bottom = $('bottombar').getBoundingClientRect();
    this.renderer.setInsets(Math.max(0, top.bottom), Math.max(0, window.innerHeight - bottom.top));
  }

  private showResults(level: Level): void {
    const r = level.results();
    const won = r.status === 'won';
    $('r-title').textContent = won ? 'You escaped!' : 'You didn’t make it';
    $('r-sub').textContent = won ? `${level.name} complete` : this.base && this.run.kind === 'gen' ? 'The wasteland claimed you. Everything you found is lost.' : 'The wasteland claimed you. Try again.';
    const gen = this.base && this.run.kind === 'gen';
    let extra = '';
    if (gen && this.base) {
      const rep = returnHome(this.base, r);
      this.persist();
      if (won) {
        const lostAny = rep.lost.scrap + rep.lost.food + rep.lost.materials;
        if (rep.recruited.length) extra += rep.recruited.map((s) => `${s.name} the ${ROLES[s.role].label} joined the safehouse.`).join('\n') + '\n';
        if (lostAny) extra += `Storage full: ${lostAny} resources left behind.`;
      }
    }
    $('r-extra').textContent = extra;
    const mm = Math.floor(r.timeSeconds / 60);
    const ss = String(Math.floor(r.timeSeconds % 60)).padStart(2, '0');
    $('r-time').textContent = `${mm}:${ss}`;
    $('r-hearts').textContent = `${r.heartsLeft} / ${CONFIG.maxHearts}`;
    // Loot only counts if the player got out alive.
    $('r-scrap').textContent = won ? String(r.loot.scrap) : '—';
    $('r-food').textContent = won ? String(r.loot.food) : '—';
    $('r-materials').textContent = won ? String(r.loot.materials) : '—';
    $('r-again').textContent = gen ? 'Return to the safehouse' : won ? 'Play again' : 'Retry this map';
    $('r-menu').hidden = !!gen;
    $('results').hidden = false;
  }

  // ───────────── input ─────────────

  private bindInput(): void {
    const c = this.canvas;
    let downAt = 0;
    let downPos = { x: 0, y: 0 };
    let longTimer = 0;
    let longFired = false;
    let dragging = false;
    let lastPos = { x: 0, y: 0 };

    const nightTap = (e: PointerEvent): void => {
      const rect = c.getBoundingClientRect();
      const cell = this.night && this.nightRenderer.screenToCell(this.night, e.clientX - rect.left, e.clientY - rect.top);
      if (cell) this.night!.tap(cell.x, cell.y);
    };
    c.addEventListener('pointerup', (e) => {
      if (this.night && e.button !== 2) nightTap(e);
    });

    const cellAt = (e: PointerEvent) => {
      const rect = c.getBoundingClientRect();
      return this.level ? this.renderer.screenToCell(this.level, e.clientX - rect.left, e.clientY - rect.top) : null;
    };

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      if (!this.level) return;
      if (e.button === 2) {
        const cell = cellAt(e);
        if (cell) this.level.toggleFlag(cell.x, cell.y);
        return;
      }
      downAt = performance.now();
      downPos = { x: e.clientX, y: e.clientY };
      lastPos = { ...downPos };
      dragging = false;
      longFired = false;
      window.clearTimeout(longTimer);
      longTimer = window.setTimeout(() => {
        const cell = cellAt(e);
        if (cell && this.level) {
          this.level.toggleFlag(cell.x, cell.y);
          longFired = true;
          navigator.vibrate?.(20);
        }
      }, LONG_PRESS_MS);
    });

    c.addEventListener('pointermove', (e) => {
      if (!downAt) return;
      if (!dragging && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 12) {
        dragging = true; // it is a camera drag, not a tap
        window.clearTimeout(longTimer);
      }
      if (dragging) {
        this.renderer.panBy(e.clientX - lastPos.x, e.clientY - lastPos.y);
      }
      lastPos = { x: e.clientX, y: e.clientY };
    });

    c.addEventListener('pointerup', (e) => {
      window.clearTimeout(longTimer);
      if (!this.level || e.button === 2 || longFired || !downAt) return;
      downAt = 0;
      if (dragging) return;
      const cell = cellAt(e);
      if (!cell) return;
      if (this.flagMode) this.level.toggleFlag(cell.x, cell.y);
      else this.level.tap(cell.x, cell.y);
    });
    c.addEventListener('pointercancel', () => {
      window.clearTimeout(longTimer);
      downAt = 0;
    });

    window.addEventListener('keydown', (e) => {
      const l = this.level;
      if (!l) return;
      if (e.key === 'Escape') {
        if (l.pending) l.cancelUse();
        else this.abandon();
      } else if (e.key === 'f' || e.key === 'F') this.toggleFlagMode();
      else if (e.key === 'b' || e.key === 'B') l.pressItem('explosive');
      else if (e.key === 'm' || e.key === 'M') l.pressItem('map');
    });
  }

  private toggleFlagMode(): void {
    this.flagMode = !this.flagMode;
    if (this.flagMode) this.level?.cancelUse();
  }

  private bindUi(): void {
    $('m-new').addEventListener('click', () => {
      if (this.base && !window.confirm('Start a new game? Your saved safehouse will be erased.')) return;
      this.base = newBase();
      this.persist();
      this.showSafehouse();
    });
    $('m-continue').addEventListener('click', () => this.showSafehouse());
    $('n-ok').addEventListener('click', () => this.showSafehouse());
    $('n-start').addEventListener('click', () => {
      this.night?.start();
      $('n-start').hidden = true;
      $('n-auto').hidden = true;
    });
    $('n-auto').addEventListener('click', () => this.night?.autoAssign());
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) sfx.play('click');
    });
    $('n-skip').addEventListener('click', () => this.finishNight(true));
    document.querySelectorAll<HTMLElement>('.diff').forEach((b) =>
      b.addEventListener('click', () => this.startGenerated(b.dataset.diff as Difficulty)),
    );
    $('c-test').addEventListener('click', () => {
      this.run = { kind: 'test' };
      this.start();
    });
    $('c-back').addEventListener('click', () => {
      $('choose').hidden = true;
      if (this.base) this.showSafehouse();
      else this.showMenu();
    });
    $('m-options').addEventListener('click', () => {
      ($('opt-tips') as HTMLInputElement).checked = localStorage.getItem(TIPS_KEY) !== '0';
      ($('opt-sound') as HTMLInputElement).checked = !sfx.muted;
      $('menu').hidden = true;
      $('options').hidden = false;
    });
    $('o-back').addEventListener('click', () => {
      localStorage.setItem(TIPS_KEY, ($('opt-tips') as HTMLInputElement).checked ? '1' : '0');
      sfx.setMuted(!($('opt-sound') as HTMLInputElement).checked);
      $('options').hidden = true;
      $('menu').hidden = false;
    });
    $('o-reset-tips').addEventListener('click', () => {
      localStorage.removeItem('deadground.hometips');
      ($('o-reset-tips') as HTMLButtonElement).textContent = 'Tips will show again ✓';
    });
    $('btn-menu').addEventListener('click', () => this.abandon());
    $('btn-restart').addEventListener('click', () => this.start());
    $('r-again').addEventListener('click', () => {
      // After a win, roll a new map of the same difficulty; after a loss, retry the same one.
      if (this.run.kind === 'gen' && this.base) this.showSafehouse();
      else this.start();
    });
    $('r-menu').addEventListener('click', () => this.showMenu());
    $('slot-bomb').addEventListener('click', () => {
      this.flagMode = false;
      this.level?.pressItem('explosive');
    });
    $('slot-map').addEventListener('click', () => {
      this.flagMode = false;
      this.level?.pressItem('map');
    });
    $('slot-flag').addEventListener('click', () => this.toggleFlagMode());
  }
}

async function boot(): Promise<void> {
  const sprites = new SpriteStore();
  try {
    await sprites.load();
  } catch (err) {
    $('loading').textContent = `Could not load sprites: ${(err as Error).message}`;
    return;
  }
  const game = new Game($('game') as HTMLCanvasElement, sprites);
  (window as unknown as { __dg: Game }).__dg = game; // debug hook (inspect / screenshot from the console)
  // Handy for debugging / automated checks from the browser console.
  (window as unknown as { __dg: Game }).__dg = game;
  $('loading').hidden = true;
  game.showMenu();
}

void boot();

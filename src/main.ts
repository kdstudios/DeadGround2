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
import { generateAsync } from './gen/async.js';
import type { LevelData } from './core/level.js';
import type { LevelSnapshot } from './core/level.js';
import { REGIONS, type Difficulty, type Region } from './gen/difficulty.js';
import { expedition1Data } from './levels/expedition1.js';
import { Renderer } from './render/renderer.js';
import { SpriteStore } from './render/sprites.js';
import { Hud } from './ui/hud.js';
import { sfx } from './audio/sfx.js';
import { MinigameOverlay } from './ui/minigames.js';
import { renderSafehouse } from './ui/safehouse.js';
import type { GameEvent, StoryKey } from './core/types.js';
import { Night } from './night/night.js';
import { ProgressionService } from './progress/service.js';
import type { MissionCategory, ProgEvent } from './progress/types.js';
import { Notices, rewardText } from './ui/notices.js';
import { renderMissions } from './ui/missions.js';
import { renderProfile } from './ui/profile.js';
import { NightRenderer } from './render/nightRenderer.js';
import { towerSlotsUnlocked } from './night/night.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const TIPS_KEY = 'deadground.tips';
const LONG_PRESS_MS = 260;
/** How far (px) a held finger must slide up or down to choose Reveal or Flag. */
const RADIAL_PICK_PX = 34;

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
  /** True while a dialog is open over an expedition: the world stands still. */
  private paused = false;
  private confirmResolve: ((ok: boolean) => void) | null = null;
  /** Level-ups, achievements and mission notices (non-blocking). */
  private notices = new Notices($('notices'));
  private svc: ProgressionService | null = null;
  private svcBase: BaseState | null = null;
  private missionsTab: MissionCategory = 'daily';

  /**
   * The progression service for the current save. It is rebuilt whenever the save object is replaced (New Game, import),
   * and persists the save itself after every change.
   */
  private get prog(): ProgressionService | null {
    const b = this.base;
    if (!b) return null;
    if (!this.svc || this.svcBase !== b) {
      this.svcBase = b;
      this.svc = new ProgressionService(b, () => this.persist(), { listener: (n) => this.notices.handle(n) });
    }
    return this.svc;
  }

  /** Report a gameplay event to progression. Practice and Quick Play runs never reach this (nothing is saved there). */
  private report(ev: ProgEvent): { xp: number } {
    return this.prog?.handle(ev) ?? { xp: 0 };
  }

  /** Themed replacement for window.confirm(). Resolves true on confirm. */
  confirmDialog(title: string, text: string, yes = 'Confirm', no = 'Cancel'): Promise<boolean> {
    this.confirmResolve?.(false);
    $('cf-title').textContent = title;
    $('cf-text').textContent = text;
    $('cf-yes').textContent = yes;
    $('cf-no').textContent = no;
    $('confirm').hidden = false;
    this.paused = true;
    return new Promise((resolve) => {
      this.confirmResolve = resolve;
    });
  }

  private closeConfirm(ok: boolean): void {
    $('confirm').hidden = true;
    this.paused = false;
    const r = this.confirmResolve;
    this.confirmResolve = null;
    r?.(ok);
  }

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
  private run: { kind: 'test' } | { kind: 'gen' | 'quick'; difficulty: Difficulty; seed: number; region: Region; runId?: string; story?: StoryKey[] } = { kind: 'test' };

  /** Start a freshly generated expedition (random seed unless one is given). */
  startGenerated(difficulty: Difficulty, seed = Math.floor(Math.random() * 1_000_000) + 1, region: Region = this.region): void {
    if (this.base) {
      // the supplies packed in the safehouse go out with the player; the stamina is spent right away
      const kit = loadout(this.base);
      if (!departExpedition(this.base, difficulty)) return;
      this.kit = kit;
      this.persist();
    } else this.kit = undefined;
    // while a campaign step asks for a story item, this map is generated with it inside a building
    const story = this.prog?.storyItemsFor(difficulty) ?? [];
    this.run = { kind: 'gen', difficulty, seed, region, runId: `${Date.now().toString(36)}-${seed}`, story };
    this.launch();
  }

  /** The generated map for the current run (kept so Restart reuses it). */
  private saveTimer = 0;
  private mapData: LevelData | null = null;
  private pendingSnap: LevelSnapshot | null = null;

  /** Generate the map in a worker (Risky can take seconds), then start. */
  /** Keep a snapshot of the expedition in the save so a reload or closed tab does not lose the run. */
  private autosaveExpedition(dt: number, force = false): void {
    const l = this.level;
    const b = this.base;
    if (!l || !b || this.run.kind !== 'gen') return;
    if (l.status !== 'playing') {
      if (b.expedition) {
        b.expedition = null; // the run is decided: it can no longer be resumed
        this.persist();
      }
      return;
    }
    this.saveTimer += dt;
    if (!force && this.saveTimer < 2) return;
    this.saveTimer = 0;
    b.expedition = { difficulty: this.run.difficulty, seed: this.run.seed, region: this.run.region, runId: this.run.runId, story: this.run.story, snap: l.snapshot() };
    this.persist();
  }

  private launch(): void {
    if (this.run.kind === 'test') return this.start();
    const note = $('loading');
    note.textContent = 'Surveying the wasteland…';
    note.hidden = false;
    const r = this.run;
    void generateAsync(r.difficulty, r.seed, r.region, r.kind === 'gen' ? r.story : undefined).then((d) => {
      this.mapData = d;
      this.start();
      note.hidden = true;
    });
  }

  /** Quick Play: a throwaway expedition in a random region. Nothing is spent, banked or saved. */
  startQuick(difficulty: Difficulty): void {
    const regions = Object.keys(REGIONS) as Region[];
    this.kit = undefined;
    this.run = { kind: 'quick', difficulty, seed: Math.floor(Math.random() * 1_000_000) + 1, region: regions[Math.floor(Math.random() * regions.length)]! };
    this.launch();
  }

  /** Pick an interrupted expedition back up (the page was reloaded or closed mid-run). */
  private resumeExpedition(): void {
    const e = this.base?.expedition;
    if (!e) return;
    this.kit = undefined;
    this.pendingSnap = e.snap as LevelSnapshot;
    this.run = { kind: 'gen', difficulty: e.difficulty, seed: e.seed, region: e.region as Region, runId: e.runId ?? `v20-${e.seed}-${e.difficulty}`, story: e.story };
    this.launch();
  }

  start(): void {
    this.level = new Level(
      this.run.kind === 'test' ? expedition1Data() : this.mapData!,
      this.run.kind === 'gen' ? this.kit : undefined,
    );
    if (this.pendingSnap) {
      if (!this.level.restore(this.pendingSnap)) this.level = new Level(this.mapData!, undefined);
      this.pendingSnap = null;
    }
    this.saveTimer = 0;
    if (this.run.kind === 'gen') this.autosaveExpedition(0, true);
    $('btn-restart').hidden = this.run.kind === 'gen';
    this.renderer.recenter();
    this.flagMode = false;
    this.resultsShown = false;
    window.clearTimeout(this.resultsTimer);
    this.renderer.resetCamera();
    this.renderer.resize();
    this.hud.setLevelName(this.level.name);
    this.hud.show(true);
    for (const id of ['menu', 'results', 'options', 'choose', 'safehouse', 'night', 'quick', 'missions', 'profile']) $(id).hidden = true;
    if (localStorage.getItem(TIPS_KEY) !== '0') {
      this.hud.toast('Tap to move · hold a square, then slide up to reveal or down to flag (right-click also flags) · find the open manhole', 5000);
    }
  }

  showMenu(): void {
    this.hud.show(false);
    this.level = null;
    for (const id of ['results', 'options', 'choose', 'safehouse', 'night', 'quick', 'load', 'how', 'missions', 'profile']) $(id).hidden = true;
    ($('m-load') as HTMLButtonElement).disabled = false;
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
    for (const id of ['menu', 'results', 'options', 'choose', 'night', 'missions', 'profile']) $(id).hidden = true;
    const prog = this.prog!;
    prog.refresh(); // a new day or week may have begun since the last visit
    const lv = prog.level();
    renderSafehouse($('safehouse'), b, {
      missions: () => this.showMissions(),
      profile: () => this.showProfile(),
      prog: { level: lv.level, pct: lv.pct, into: lv.into, need: lv.need, maxed: lv.maxed, unclaimed: prog.unclaimed() },
      expedition: () => this.showChoose(),
      sleep: () => this.sleep(),
      upgrade: (f) => {
        if (upgrade(b, f)) {
          sfx.play('upgrade');
          this.persist();
          this.report({ type: 'facilityUpgraded', facility: f, level: b.facilities[f] });
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
    if (b.expedition && !this.level) return this.resumeExpedition(); // a reload mid-expedition resumes it
    if (b.pendingNight && !this.night) return this.sleep(b.pendingNight.seed); // a reload mid-night resumes it
    $('safehouse').hidden = false;
  }

  showMissions(): void {
    const prog = this.prog;
    if (!prog) return this.showMenu();
    prog.refresh();
    for (const id of ['safehouse', 'profile']) $(id).hidden = true;
    renderMissions($('missions'), prog, {
      tab: this.missionsTab,
      setTab: (c) => {
        this.missionsTab = c;
        this.showMissions();
      },
      claim: (id) => {
        const r = prog.claim(id);
        if (r.ok) {
          sfx.play('claim');
          const lost = r.lost && Object.keys(r.lost).length ? ` (storage full: ${rewardText(r.lost)} lost)` : '';
          this.notices.info('Reward claimed', `${rewardText(r.reward ?? {})}${lost}`);
        }
        this.showMissions();
      },
      back: () => this.showSafehouse(),
    });
    $('missions').hidden = false;
  }

  showProfile(): void {
    const prog = this.prog;
    if (!prog) return this.showMenu();
    prog.refresh();
    $('safehouse').hidden = true;
    renderProfile($('profile'), prog, () => this.showSafehouse());
    $('profile').hidden = false;
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
    this.renderStoryHint();
    $('c-stamina').textContent = b
      ? `Stamina ${b.stamina} left today. Safe costs 1, Scouting 2, Risky 3. Harder runs pay more.`
      : 'Every expedition is a freshly generated map. Harder runs pay more loot.';
  }

  /** Tell the player when a campaign objective can be found out there (Scouting and Risky only). */
  private renderStoryHint(): void {
    const items = this.prog?.storyItemsFor('scouting') ?? [];
    const el = $('c-story');
    const names = items.map((k) => (k === 'transmitter' ? 'a military radio transmitter' : 'a member of the missing research team'));
    el.textContent = names.length ? `Campaign: ${names.join(' and ')} may be inside a building on Scouting and Risky expeditions.` : '';
    el.hidden = !names.length;
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
    const nightId = `night:${b.day}:${b.pendingNight?.seed ?? 0}`;
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
    const nightXp = this.report({ type: 'nightEnded', id: nightId, won: r.won, skipped, killed: r.killed }).xp;
    this.report({ type: 'dayReached', day: b.day });
    $('n-title').textContent = `Night ${rep.day}`;
    const lines = [
      defence,
      rep.grown ? `The garden gave ${rep.grown} food.` : '',
      `Everyone ate: ${rep.eaten} of ${rep.needed} food.`,
      rep.left.length ? `Short of food, ${rep.left.map((s) => `${s.name} (${ROLES[s.role].label})`).join(' and ')} left in the dark.` : '',
      rep.starving && !rep.left.length ? 'You went hungry. Find food.' : '',
      `Day ${b.day} begins. Stamina restored.`,
      nightXp > 0 ? `+${nightXp} XP` : '',
    ].filter(Boolean);
    $('n-body').textContent = lines.join('\n');
    $('night').hidden = false;
  }

  /** Leave an expedition for the safehouse; if it is not over, this counts as a failed run. */
  private async abandon(): Promise<void> {
    const l = this.level;
    if (this.run.kind !== 'gen') return this.showMenu(); // practice runs cost nothing to leave
    if (l && this.base && l.status === 'playing') {
      if (!(await this.confirmDialog('Abandon expedition?', 'Everything you found is lost, and the stamina is still spent.', 'Abandon', 'Keep going'))) return;
      if (this.level !== l || l.status !== 'playing' || !this.base) return;
      this.base.expedition = null;
      returnHome(this.base, { ...l.results(), status: 'failed' });
      this.persist();
      this.reportExpedition(l, false, 0, 0);
      this.resultsShown = true;
    }
    if (this.base) this.showSafehouse();
    else this.showMenu();
  }

  /** An expedition has been decided (escaped, died or abandoned): pay out progression exactly once. */
  private reportExpedition(level: Level, escaped: boolean, rescued: number, scrap: number): { xp: number } {
    const run = this.run;
    if (run.kind !== 'gen') return { xp: 0 };
    return this.report({
      type: 'expeditionEnded',
      id: `exp:${run.runId ?? run.seed}`,
      difficulty: run.difficulty,
      region: run.region,
      escaped,
      damageTaken: level.damageTaken,
      rescued: escaped ? rescued : 0,
      scrap: escaped ? scrap : 0,
      story: escaped ? { ...level.story } : { transmitter: 0, researcher: 0 },
    });
  }

  /**
   * Kills and vaults are credited as they happen. Each credit is followed at once by a save of the expedition snapshot,
   * so what was credited and what a reload resumes can never disagree (no re-killing the same zombie after a reload).
   */
  private reportLevelEvents(events: GameEvent[]): void {
    const run = this.run;
    if (run.kind !== 'gen' || !this.base) return;
    let any = false;
    for (const e of events) {
      if (e.type === 'zombieKilled' || e.type === 'swatKilled') {
        this.report({ type: 'zombieKilled', amount: 1 });
        any = true;
      } else if (e.type === 'vaultOpened') {
        this.report({ type: 'vaultOpened', id: `vault:${run.runId ?? run.seed}:${e.vault}` });
        any = true;
      }
    }
    if (any) this.autosaveExpedition(0, true);
  }

  private playEvents(events: GameEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'pickup': sfx.play(e.id === 'survivor' || e.id === 'researcher' ? 'rescue' : 'pickup'); break;
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
      this.autosaveExpedition(dt);
      if (!this.paused) level.update(dt);
      const events = level.drainEvents();
      this.renderer.handleEvents(level, events);
      this.playEvents(events);
      this.reportLevelEvents(events);
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
    let xpLine = '';
    if (gen && this.base) {
      this.base.expedition = null;
      const rep = returnHome(this.base, r);
      this.persist();
      const xp = this.reportExpedition(level, won, rep.recruited.length, rep.gained.scrap + rep.lost.scrap).xp;
      if (xp > 0) xpLine = `+${xp} XP`;
      if (won) {
        if (level.story.transmitter) extra += 'Radio transmitter recovered.\n';
        if (level.story.researcher) extra += `${level.story.researcher} research-team member${level.story.researcher === 1 ? '' : 's'} brought home.\n`;
        const lostAny = rep.lost.scrap + rep.lost.food + rep.lost.materials;
        if (rep.recruited.length) extra += rep.recruited.map((s) => `${s.name} the ${ROLES[s.role].label} joined the safehouse.`).join('\n') + '\n';
        if (lostAny) extra += `Storage full: ${lostAny} resources left behind.`;
      }
    }
    $('r-extra').textContent = extra;
    $('r-xp').textContent = xpLine;
    $('r-xp').hidden = !xpLine;
    const mm = Math.floor(r.timeSeconds / 60);
    const ss = String(Math.floor(r.timeSeconds % 60)).padStart(2, '0');
    $('r-time').textContent = `${mm}:${ss}`;
    $('r-hearts').textContent = `${r.heartsLeft} / ${CONFIG.maxHearts}`;
    // Loot only counts if the player got out alive.
    $('r-scrap').textContent = won ? String(r.loot.scrap) : '—';
    $('r-food').textContent = won ? String(r.loot.food) : '—';
    $('r-materials').textContent = won ? String(r.loot.materials) : '—';
    const quick = this.run.kind === 'quick';
    if (quick) $('r-sub').textContent = `${level.name} · Quick Play: nothing was saved`;
    $('r-again').textContent = gen ? 'Return to the safehouse' : quick ? (won ? 'Another quick game' : 'Retry this map') : won ? 'Play again' : 'Retry this map';
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
    // Hold on a hidden square: Reveal appears above it (slide up) and Flag/Unflag below it (slide down).
    let radial: { x: number; y: number; choice: 'up' | 'down' | null } | null = null;
    const radialEl = $('radial');
    const upEl = radialEl.querySelector<HTMLElement>('.up')!;
    const downEl = radialEl.querySelector<HTMLElement>('.dn')!;
    const hideRadial = (): void => {
      radial = null;
      radialEl.hidden = true;
    };

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
        const l = this.level;
        if (!cell || !l || dragging) return;
        const cc = l.cell(cell.x, cell.y);
        if (cc.revealed) return; // nothing to choose on a square you can already see
        longFired = true;
        navigator.vibrate?.(20);
        const rect = c.getBoundingClientRect();
        const tl = this.renderer.cellToScreen(cell.x, cell.y);
        radial = { x: cell.x, y: cell.y, choice: null };
        radialEl.style.left = `${rect.left + tl.x + this.renderer.tileSize / 2}px`;
        radialEl.style.top = `${rect.top + tl.y + this.renderer.tileSize / 2}px`;
        const cy = rect.top + tl.y + this.renderer.tileSize / 2;
        const gap = Math.round(this.renderer.tileSize * 0.5 + 34);
        // keep both choices on screen even for squares at the edge
        radialEl.style.setProperty('--gap-up', `${Math.max(34, Math.min(gap, cy - 34))}px`);
        radialEl.style.setProperty('--gap-dn', `${Math.max(34, Math.min(gap, window.innerHeight - cy - 34))}px`);
        downEl.textContent = cc.flagged ? 'Unflag ▼' : 'Flag ▼';
        upEl.classList.remove('pick');
        downEl.classList.remove('pick');
        radialEl.hidden = false;
      }, LONG_PRESS_MS);
    });

    c.addEventListener('pointermove', (e) => {
      if (!downAt) return;
      if (radial) {
        const dy = e.clientY - downPos.y;
        radial.choice = dy < -RADIAL_PICK_PX ? 'up' : dy > RADIAL_PICK_PX ? 'down' : null;
        upEl.classList.toggle('pick', radial.choice === 'up');
        downEl.classList.toggle('pick', radial.choice === 'down');
        return;
      }
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
      if (radial) {
        const r = radial;
        hideRadial();
        downAt = 0;
        if (this.level && e.button !== 2) {
          if (r.choice === 'up') this.level.tap(r.x, r.y);
          else if (r.choice === 'down') this.level.toggleFlag(r.x, r.y);
        }
        return;
      }
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
      hideRadial();
      downAt = 0;
    });

    window.addEventListener('keydown', (e) => {
      if (this.confirmResolve) {
        if (e.key === 'Escape') this.closeConfirm(false);
        return;
      }
      const l = this.level;
      if (!l) return;
      if (e.key === 'Escape') {
        if (l.pending) l.cancelUse();
        else void this.abandon();
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
    $('cf-yes').addEventListener('click', () => this.closeConfirm(true));
    $('cf-no').addEventListener('click', () => this.closeConfirm(false));
    $('m-new').addEventListener('click', async () => {
      if (this.base && !(await this.confirmDialog('Start a new game?', 'Your saved safehouse will be erased.', 'Erase and start'))) return;
      this.base = newBase();
      this.persist();
      this.showSafehouse();
    });
    const flush = (): void => this.autosaveExpedition(0, true);
    document.addEventListener('visibilitychange', () => document.hidden && flush());
    window.addEventListener('pagehide', flush);
    $('m-how').addEventListener('click', () => {
      $('menu').hidden = true;
      $('how').hidden = false;
    });
    $('how-back').addEventListener('click', () => this.showMenu());
    $('m-load').addEventListener('click', () => {
      const b = this.base;
      $('l-summary').textContent = b
        ? `Saved game: Day ${b.day}, ${b.survivors.length} survivor${b.survivors.length === 1 ? '' : 's'}, ${b.stock.scrap} scrap.`
        : 'No saved game on this device yet. You can restore one from a save code below.';
      ($('l-load') as HTMLButtonElement).disabled = !b;
      ($('l-code') as HTMLTextAreaElement).value = '';
      $('l-msg').textContent = '';
      $('menu').hidden = true;
      $('load').hidden = false;
    });
    $('l-back').addEventListener('click', () => this.showMenu());
    $('l-load').addEventListener('click', () => this.showSafehouse());
    $('l-export').addEventListener('click', () => {
      const code = this.base ? btoa(serialize(this.base)) : '';
      const box = $('l-code') as HTMLTextAreaElement;
      box.value = code;
      if (!code) return void ($('l-msg').textContent = 'Nothing to export yet.');
      box.select();
      void navigator.clipboard?.writeText(code).then(
        () => ($('l-msg').textContent = 'Copied. Keep it somewhere safe.'),
        () => ($('l-msg').textContent = 'Select the code above and copy it.'),
      );
    });
    $('l-import').addEventListener('click', async () => {
      const text = ($('l-code') as HTMLTextAreaElement).value.trim();
      let b: BaseState | null = null;
      try {
        b = deserialize(atob(text));
      } catch {
        b = null;
      }
      if (!b) return void ($('l-msg').textContent = 'That code is not a valid save.');
      if (this.base && !(await this.confirmDialog('Replace your save?', 'Your current saved game will be overwritten by this code.', 'Replace'))) return;
      this.base = b;
      this.persist();
      this.showSafehouse();
    });
    $('m-quick').addEventListener('click', () => {
      $('menu').hidden = true;
      $('quick').hidden = false;
    });
    $('q-back').addEventListener('click', () => {
      $('quick').hidden = true;
      $('menu').hidden = false;
    });
    document.querySelectorAll<HTMLElement>('.qdiff').forEach((b) => b.addEventListener('click', () => this.startQuick(b.dataset.diff as Difficulty)));
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
    $('btn-menu').addEventListener('click', () => void this.abandon());
    $('btn-restart').addEventListener('click', () => this.start());
    $('r-again').addEventListener('click', () => {
      // After a win, roll a new map of the same difficulty; after a loss, retry the same one.
      if (this.run.kind === 'gen' && this.base) this.showSafehouse();
      else if (this.run.kind === 'quick' && this.level?.status === 'won') this.startQuick(this.run.difficulty);
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

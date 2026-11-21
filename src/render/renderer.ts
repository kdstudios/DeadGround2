import { OBJECTS } from '../core/defs.js';
import type { Level } from '../core/level.js';
import type { Cell, GameEvent, PickupId, Pos } from '../core/types.js';
import type { SpriteStore } from './sprites.js';
import { buildVisuals, hash, type Visuals } from './visuals.js';

interface Dust {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
}
interface Float {
  text: string;
  x: number;
  y: number;
  t: number;
  color: string;
}

const PICKUP_SPRITE: Record<PickupId, string> = {
  scrap: 'item_scrap',
  food: 'item_food',
  materials: 'item_materials',
  ammo: 'item_ammo',
  key: 'item_key',
  crowbar: 'item_crowbar',
  explosive: 'item_explosive',
  shield: 'item_shield',
  medkit: 'item_medkit',
  map: 'item_map',
  survivor: 'player_down_0',
};

const PICKUP_LABEL: Record<PickupId, string> = {
  scrap: 'scrap',
  food: 'food',
  materials: 'materials',
  ammo: 'ammo',
  key: 'key',
  crowbar: 'crowbar',
  explosive: 'explosive',
  shield: 'shield',
  medkit: 'health',
  map: 'map',
  survivor: 'survivor rescued',
};

const FADE_SECONDS = 0.28;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  /** Pixels per cell on screen. */
  tile = 64;
  private cam = { x: 0, y: 0 };
  private camReady = false;
  private clock = 0;
  private dust: Dust[] = [];
  private floats: Float[] = [];
  private revealStart = new Map<number, number>();
  private visCache = new WeakMap<Level, Visuals>();
  private vis: Visuals | null = null;
  private flash = 0;
  private shake = 0;
  /** Pixels at the top/bottom of the canvas covered by HUD bars; the camera centres on what is left. */
  private insetTop = 0;
  private insetBottom = 0;
  /** Free-look offset (in cells) from dragging; eases back to zero while the player walks. */
  private pan = { x: 0, y: 0 };

  constructor(
    private canvas: HTMLCanvasElement,
    private sprites: SpriteStore,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.cssW = this.canvas.clientWidth;
    this.cssH = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(this.cssW * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.cssH * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.tile = Math.max(44, Math.min(84, Math.min(this.cssW, this.cssH) / 8));
  }

  get tileSize(): number {
    return this.tile;
  }

  setInsets(top: number, bottom: number): void {
    this.insetTop = top;
    this.insetBottom = bottom;
  }

  /** Vertical screen position of the camera centre (middle of the un-covered area). */
  private get centreY(): number {
    return this.insetTop + (this.cssH - this.insetTop - this.insetBottom) / 2;
  }

  /** Top-left of a cell in CSS pixels (for tests / tooltips). */
  cellToScreen(x: number, y: number): Pos {
    return {
      x: (x - 0.5 - this.cam.x) * this.tile + this.cssW / 2,
      y: (y - 0.5 - this.cam.y) * this.tile + this.centreY,
    };
  }

  /** Drag the camera by a screen-space delta (CSS px). */
  panBy(dxPx: number, dyPx: number): void {
    this.pan.x -= dxPx / this.tile;
    this.pan.y -= dyPx / this.tile;
  }

  recenter(): void {
    this.pan = { x: 0, y: 0 };
  }

  resetCamera(): void {
    this.pan = { x: 0, y: 0 };
    this.camReady = false;
    this.dust = [];
    this.floats = [];
    this.revealStart.clear();
    this.flash = 0;
  }

  /** Screen (CSS px relative to canvas) -> grid cell. */
  screenToCell(level: Level, sx: number, sy: number): Pos | null {
    const x = Math.floor((sx - this.cssW / 2) / this.tile + this.cam.x + 0.5);
    const y = Math.floor((sy - this.centreY) / this.tile + this.cam.y + 0.5);
    return level.inBounds(x, y) ? { x, y } : null;
  }

  /** Feed game events to visual effects. */
  handleEvents(level: Level, events: GameEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'revealed':
          for (const c of e.cells) this.revealStart.set(c.y * level.width + c.x, this.clock);
          break;
        case 'pickup':
          this.float(`+${e.amount} ${PICKUP_LABEL[e.id]}`, e.at, e.id === 'medkit' ? '#ff7a7a' : '#ffe27a');
          break;
        case 'damage':
          this.float(e.absorbed ? 'Shield!' : `-${e.amount}`, e.at, e.absorbed ? '#7ac8ff' : '#ff5a4a');
          if (!e.absorbed) {
            this.flash = 0.45;
            this.shake = 0.3;
          }
          this.puff(e.at, 8);
          break;
        case 'mineTriggered':
          this.puff(e.at, 16);
          break;
        case 'zombieKilled':
        case 'swatKilled':
          this.puff(e.at, 12);
          break;
        case 'obstacleRemoved':
          this.puff(e.at, 12);
          break;
        case 'explosion':
          this.puff(e.at, 40, e.radius + 0.8);
          this.shake = 0.5;
          break;
        case 'mapUsed':
          this.float('Map revealed', e.at, '#ffe27a');
          break;
        default:
          break;
      }
    }
  }

  private float(text: string, at: Pos, color: string): void {
    this.floats.push({ text, x: at.x, y: at.y - 0.4, t: 0, color });
  }

  private puff(at: Pos, n: number, spread = 0.7): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * spread * 1.5;
      this.dust.push({
        x: at.x + (Math.random() - 0.5) * spread,
        y: at.y + (Math.random() - 0.5) * spread,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 0.3,
        life: 0,
        max: 0.5 + Math.random() * 0.5,
        r: 0.12 + Math.random() * 0.2,
      });
    }
  }

  // ───────────────────────── frame ─────────────────────────

  /** True if the canvas box or pixel ratio changed since the last resize (rotation events can fire before layout settles). */
  private sizeStale(): boolean {
    return (
      this.canvas.clientWidth !== this.cssW ||
      this.canvas.clientHeight !== this.cssH ||
      this.canvas.width !== Math.max(1, Math.floor(this.cssW * (window.devicePixelRatio || 1)))
    );
  }

  render(level: Level, dt: number, flagMode: boolean): void {
    if (this.sizeStale()) this.resize();
    this.clock += dt;
    const ctx = this.ctx;
    const T = this.tile;
    ctx.imageSmoothingEnabled = false;

    // Camera follows the player smoothly, can be dragged (free-look), and is clamped to the map.
    const pp = level.playerRenderPos();
    if (level.isMoving()) {
      const f = Math.pow(0.02, dt); // free-look eases back once the player sets off
      this.pan.x *= f;
      this.pan.y *= f;
    }
    const halfW = this.cssW / 2 / T;
    const halfH = (this.cssH - this.insetTop - this.insetBottom) / 2 / T;
    const vis = (this.vis = this.visualsFor(level));
    // The camera may drift a little past the map edge to show the scenery (and the skyline along the top).
    const clampAxis = (v: number, size: number, half: number, before: number, after: number) => {
      const lo = -0.5 - before;
      const hi = size - 0.5 + after;
      return hi - lo <= half * 2 ? (lo + hi) / 2 : Math.min(Math.max(v, lo + half), hi - half);
    };
    const tx = clampAxis(pp.x + this.pan.x, level.width, halfW, vis.margin.side, vis.margin.side);
    const ty = clampAxis(pp.y + this.pan.y, level.height, halfH, vis.margin.top, vis.margin.bottom);
    this.pan.x = tx - pp.x; // never let free-look wind up beyond the map edge
    this.pan.y = ty - pp.y;
    if (!this.camReady) {
      this.cam.x = tx;
      this.cam.y = ty;
      this.camReady = true;
    } else {
      const k = 1 - Math.pow(0.001, dt);
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (ty - this.cam.y) * k;
    }
    const cx = this.cam.x;
    const cy = this.cam.y;

    let shakeX = 0;
    let shakeY = 0;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      shakeX = (Math.random() - 0.5) * 10 * this.shake;
      shakeY = (Math.random() - 0.5) * 10 * this.shake;
    }

    ctx.fillStyle = '#0b0f0c';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.save();
    ctx.translate(shakeX, shakeY);

    const sx = (x: number) => (x - 0.5 - cx) * T + this.cssW / 2; // left edge of cell x
    const sy = (y: number) => (y - 0.5 - cy) * T + this.centreY;
    const x0 = Math.max(0, Math.floor(cx - halfW - 1));
    const x1 = Math.min(level.width - 1, Math.ceil(cx + halfW + 1));
    const fullHalfH = this.cssH / 2 / T + 1;
    const y0 = Math.max(0, Math.floor(cy - fullHalfH - 1));
    const y1 = Math.min(level.height - 1, Math.ceil(cy + fullHalfH + 1));

    // 0) Scenery beyond the map edge
    this.drawBackdrop(level, vis, sx, sy, {
      x0: Math.floor(cx - halfW - 1),
      x1: Math.ceil(cx + halfW + 1),
      y0: Math.floor(cy - fullHalfH - 1),
      y1: Math.ceil(cy + fullHalfH + 1),
    });

    // 1) Ground layer
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = level.cell(x, y);
        this.drawGround(level, c, x, y, sx(x), sy(y));
      }
    }

    // 2) Depth shading where explored floor meets walls / fog
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = level.cell(x, y);
        if (c.terrain === 'wall' || !c.revealed) continue;
        const above = y > 0 ? level.cell(x, y - 1) : null;
        if (above && (above.terrain === 'wall' || !above.revealed)) {
          const g = ctx.createLinearGradient(0, sy(y), 0, sy(y) + T * 0.4);
          g.addColorStop(0, 'rgba(0,0,0,0.55)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fillRect(sx(x), sy(y), T, T * 0.4);
        }
        const left = x > 0 ? level.cell(x - 1, y) : null;
        if (left && (left.terrain === 'wall' || !left.revealed)) {
          const g = ctx.createLinearGradient(sx(x), 0, sx(x) + T * 0.25, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.35)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fillRect(sx(x), sy(y), T * 0.25, T);
        }
      }
    }

    // 3) Objects, pickups, flags and clues, row by row so tall sprites overlap correctly,
    //    with the player and patrols slotted into their rows (Y-sorting).
    const ents: { y: number; draw: () => void }[] = [];
    for (const p of level.patrols) {
      if (!p.alive || !level.patrolVisible(p)) continue;
      ents.push({ y: p.y, draw: () => this.drawSwat(level, sx(p.x), sy(p.y), p.id) });
    }
    ents.push({ y: pp.y, draw: () => this.drawPlayer(level, sx(pp.x), sy(pp.y)) });
    ents.sort((a, b) => a.y - b.y);
    let ei = 0;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.drawCellContents(level, level.cell(x, y), x, y, sx(x), sy(y));
      while (ei < ents.length && ents[ei]!.y < y + 0.5) ents[ei++]!.draw();
    }
    while (ei < ents.length) ents[ei++]!.draw();

    // 4) Destination marker
    const path = level.pathPreview();
    const last = path[path.length - 1];
    if (last) {
      ctx.strokeStyle = 'rgba(255,230,120,0.9)';
      ctx.lineWidth = 2;
      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 8);
      ctx.strokeRect(sx(last.x) + 6 - pulse * 2, sy(last.y) + 6 - pulse * 2, T - 12 + pulse * 4, T - 12 + pulse * 4);
    }

    // 5) Area-item preview (3x3 around the player), like the reference game
    if (level.pending) {
      const icon = this.sprites.get(level.pending.item === 'explosive' ? 'item_explosive' : 'item_map');
      for (const c of level.pending.cells) {
        ctx.fillStyle = 'rgba(255,220,60,0.18)';
        ctx.fillRect(sx(c.x), sy(c.y), T, T);
        ctx.strokeStyle = '#ffd83c';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx(c.x) + 1, sy(c.y) + 1, T - 2, T - 2);
        if (icon) ctx.drawImage(icon, sx(c.x) + T * 0.2, sy(c.y) + T * 0.2, T * 0.6, T * 0.6);
      }
    }

    // 6) Effects
    this.drawEffects(sx, sy, dt);
    ctx.restore();

    if (flagMode) {
      ctx.strokeStyle = 'rgba(255,90,70,0.9)';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, this.cssW - 4, this.cssH - 4);
    }
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt);
      ctx.fillStyle = `rgba(200,20,10,${this.flash * 0.6})`;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
  }

  // ───────────────────────── pieces ─────────────────────────

  private visualsFor(level: Level): Visuals {
    let v = this.visCache.get(level);
    if (!v) {
      v = buildVisuals(level, this.sprites.groups, (n) => {
        const im = this.sprites.images.get(n);
        return im ? { w: im.width, h: im.height } : null;
      });
      this.visCache.set(level, v);
    }
    return v;
  }

  /** Draw a square tile, optionally rotated by quarter turns (ground tiles are freely rotated). */
  private tileImg(name: string, rot: number, px: number, py: number, alpha = 1): boolean {
    const im = this.sprites.get(name);
    if (!im) return false;
    const ctx = this.ctx;
    const T = this.tile + 0.75; // a hair of overlap hides seams between tiles
    if (alpha !== 1) ctx.globalAlpha = alpha;
    if (rot === 0) ctx.drawImage(im, px, py, T, T);
    else {
      ctx.save();
      ctx.translate(px + T / 2, py + T / 2);
      ctx.rotate((rot * Math.PI) / 2);
      ctx.drawImage(im, -T / 2, -T / 2, T, T);
      ctx.restore();
    }
    if (alpha !== 1) ctx.globalAlpha = 1;
    return true;
  }

  /** Is this cell part of a solid wall line (so neighbouring wall tiles join up with it)? */
  private wallish(level: Level, x: number, y: number): boolean {
    if (!level.inBounds(x, y)) return true;
    const c = level.cell(x, y);
    if (c.terrain === 'wall') return level.zones?.[y * level.width + x] !== 'ruin';
    return c.object !== null && OBJECTS[c.object].solid === true;
  }

  private wallName(level: Level, x: number, y: number): string {
    const m =
      (this.wallish(level, x, y - 1) ? 1 : 0) |
      (this.wallish(level, x + 1, y) ? 2 : 0) |
      (this.wallish(level, x, y + 1) ? 4 : 0) |
      (this.wallish(level, x - 1, y) ? 8 : 0);
    const fence =
      level.zones?.[y * level.width + x] === 'fence' ||
      [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => level.inBounds(x + dx!, y + dy!) && level.zones?.[(y + dy!) * level.width + x + dx!] === 'fence');
    const edge = x === 0 || y === 0 || x === level.width - 1 || y === level.height - 1;
    return `${fence ? 'ruinwall' : edge ? 'bwall' : 'wall'}${m}`;
  }

  /** Scenery beyond the map edge: ground, the skyline, scrub. Drawn first so the map covers its overlap. */
  private drawBackdrop(level: Level, vis: Visuals, sx: (x: number) => number, sy: (y: number) => number, view: { x0: number; x1: number; y0: number; y1: number }): void {
    const ctx = this.ctx;
    const T = this.tile;
    const m = vis.margin;
    const bx0 = Math.max(Math.floor(-m.side - 1), view.x0);
    const bx1 = Math.min(Math.ceil(level.width + m.side), view.x1);
    const by0 = Math.max(Math.floor(-m.top - 1), view.y0);
    const by1 = Math.min(Math.ceil(level.height + m.bottom), view.y1);
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        if (level.inBounds(x, y)) continue;
        const g = vis.groundFor(level, x, y);
        if (!this.tileImg(g.name, g.rot, sx(x), sy(y))) {
          ctx.fillStyle = '#4a3b28';
          ctx.fillRect(sx(x), sy(y), T, T);
        }
      }
    }
    const k = T / 64;
    for (const d of vis.decor) {
      const im = this.sprites.get(d.name);
      if (!im) continue;
      const w = im.width * k;
      const h = im.height * k;
      const px = sx(d.x) + T / 2 - w / 2;
      const py = sy(d.y) + T / 2 - h;
      if (px > this.cssW || px + w < 0 || py > this.cssH || py + h < 0) continue;
      ctx.drawImage(im, px, py, w, h);
    }
  }

  private img(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, w: number, h: number, alpha = 1): boolean {
    const im = this.sprites.get(name);
    if (!im) return false;
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(im, x, y, w, h);
    if (alpha !== 1) ctx.globalAlpha = 1;
    return true;
  }

  /** Ground for a cell, with the edges feathered into differing neighbouring outdoor ground (cached per cell). */
  private blendCache = new Map<Level, Map<number, HTMLCanvasElement | null>>();

  private groundCell(level: Level, x: number, y: number, px: number, py: number): boolean {
    const vis = this.vis!;
    const g = vis.groundFor(level, x, y);
    const g2 = this.sprites.groups;
    const open = new Set([...(g2.ground_dirt ?? []), ...(g2.ground_dark ?? []), ...(g2.ground_grass ?? []), ...(g2.ground_misc ?? [])]);
    if (!open.has(g.name)) return this.tileImg(g.name, g.rot, px, py);
    let cache = this.blendCache.get(level);
    if (!cache) this.blendCache.set(level, (cache = new Map()));
    const key = y * 4096 + x;
    let cv = cache.get(key);
    if (cv === undefined) {
      const nb: { dx: number; dy: number; name: string; rot: number }[] = [];
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const n = vis.groundFor(level, x + dx, y + dy);
        if (n.name !== g.name && open.has(n.name)) nb.push({ dx, dy, ...n });
      }
      if (!nb.length) cv = null;
      else {
        const S = 64;
        cv = document.createElement('canvas');
        cv.width = cv.height = S;
        const c2 = cv.getContext('2d')!;
        const put = (c: CanvasRenderingContext2D, name: string, rot: number): void => {
          const im = this.sprites.get(name);
          if (!im) return;
          c.save();
          c.translate(S / 2, S / 2);
          c.rotate((rot * Math.PI) / 2);
          c.drawImage(im, -S / 2, -S / 2, S, S);
          c.restore();
        };
        put(c2, g.name, g.rot);
        for (const n of nb) {
          const lay = document.createElement('canvas');
          lay.width = lay.height = S;
          const l = lay.getContext('2d')!;
          put(l, n.name, n.rot);
          // alpha ramp: 0.5 at the shared edge fading to 0 well inside the cell
          const reach = S * 0.5;
          const gr = l.createLinearGradient(n.dx === 1 ? S : n.dx === -1 ? 0 : 0, n.dy === 1 ? S : n.dy === -1 ? 0 : 0,
            n.dx === 1 ? S - reach : n.dx === -1 ? reach : 0, n.dy === 1 ? S - reach : n.dy === -1 ? reach : 0);
          gr.addColorStop(0, 'rgba(0,0,0,0.5)');
          gr.addColorStop(1, 'rgba(0,0,0,0)');
          l.globalCompositeOperation = 'destination-in';
          l.fillStyle = gr;
          l.fillRect(0, 0, S, S);
          c2.drawImage(lay, 0, 0);
        }
      }
      cache.set(key, cv);
    }
    if (!cv) return this.tileImg(g.name, g.rot, px, py);
    const T = this.tile + 0.75;
    this.ctx.drawImage(cv, px, py, T, T);
    return true;
  }

  private drawGround(level: Level, c: Cell, x: number, y: number, px: number, py: number): void {
    const ctx = this.ctx;
    const T = this.tile;
    const vis = this.vis!;
    const idx = y * level.width + x;
    const zone = level.zones?.[idx];
    const solidObject = c.object !== null && OBJECTS[c.object].solid === true;

    if (c.terrain === 'wall' && zone === 'ruin') {
      // rubble / junk blocking open ground: ground underneath, the prop is drawn with the cell contents
      this.groundCell(level, x, y, px, py);
      return;
    }
    if (c.terrain === 'wall' || solidObject) {
      // walls and sealed doorways (door / planks / cracked wall) stand on a wall tile
      if (!this.img(ctx, this.wallName(level, x, y), px, py, T + 0.75, T + 0.75)) {
        ctx.fillStyle = '#667';
        ctx.fillRect(px, py, T, T);
      }
      return;
    }
    if (c.revealed) {
      if (!this.groundCell(level, x, y, px, py)) {
        ctx.fillStyle = '#4a3b28';
        ctx.fillRect(px, py, T, T);
      }
    } else {
      const f = vis.fogAt(x, y);
      if (!f || !this.tileImg(f, 0, px, py)) {
        ctx.fillStyle = '#2a2622';
        ctx.fillRect(px, py, T, T);
      }
    }
    // Fade the cover away when a cell has just been revealed.
    const t0 = this.revealStart.get(idx);
    if (t0 !== undefined) {
      const p = (this.clock - t0) / FADE_SECONDS;
      if (p >= 1) this.revealStart.delete(idx);
      else if (c.revealed) {
        const f = vis.fogAt(x, y);
        if (f) this.tileImg(f, 0, px, py, 1 - p);
      }
    }
  }

  private drawCellContents(level: Level, c: Cell, x: number, y: number, px: number, py: number): void {
    const ctx = this.ctx;
    const T = this.tile;
    const k = T / 64;
    if (c.terrain === 'wall') {
      if (level.zones?.[y * level.width + x] === 'ruin') {
        const name = this.vis?.propAt(x, y);
        const im = name ? this.sprites.get(name) : null;
        if (im) {
          const w = im.width * k;
          const h = im.height * k;
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.beginPath();
          ctx.ellipse(px + T / 2, py + T * 0.9, w * 0.42, T * 0.1, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.drawImage(im, px + (T - w) / 2, py + T * 0.96 - h, w, h);
        }
      }
      return;
    }

    // Furniture: walkable flavour on building floors, against a wall (never hides clues: drawn faint under them).
    if (c.revealed && level.zones?.[y * level.width + x] === 'in' && !c.object && !c.pickup) {
      const fl = this.sprites.groups.furniture;
      if (fl?.length && hash(x, y, 77) < 0.22 && [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => level.inBounds(x + dx!, y + dy!) && level.cell(x + dx!, y + dy!).terrain === 'wall')) {
        const im = this.sprites.get(fl[Math.floor(hash(x, y, 78) * fl.length)]!);
        if (im) {
          const w = im.width * k * 0.8;
          const h = im.height * k * 0.8;
          ctx.globalAlpha = c.clue > 0 ? 0.35 : 0.9;
          ctx.drawImage(im, px + (T - w) / 2, py + T * 0.95 - h, w, h);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Flags sit on fog.
    if (c.flagged && !c.revealed) this.img(ctx, 'ui_flag', px + T * 0.1, py + T * 0.05, T * 0.8, T * 0.8);

    if (c.object && level.objectVisible(c)) {
      switch (c.object) {
        case 'mine':
          this.img(ctx, c.triggered ? 'obj_crater' : 'obj_mine', px, py, T, T);
          break;
        case 'zombie': {
          const frame = Math.floor(this.clock * 3 + hash(x, y, 5) * 4) % 4;
          this.shadow(px + T / 2, py + T * 0.93, 0.28);
          this.img(ctx, `zombie_down_${frame}`, px, py + Math.sin(this.clock * 3 + x * 1.7 + y) * 1.2 * k, T, T);
          break;
        }
        case 'door':
        case 'barricade': {
          const im = this.sprites.get(c.object === 'door' ? 'ov_door' : 'ov_barricade');
          if (im) {
            const w = im.width * k;
            const h = im.height * k;
            ctx.drawImage(im, px + (T - w) / 2, py + T - h - 1.5 * k, w, h);
          }
          break;
        }
        case 'crackedWall':
          this.img(ctx, 'ov_crack', px, py, T, T);
          break;
        case 'vaultDoor': {
          const v = level.vaultAt(x, y);
          const door = this.sprites.get('ov_door');
          const dead = v?.status === 'lockedOut';
          if (door) {
            const w = door.width * k;
            const h = door.height * k;
            ctx.drawImage(door, px + (T - w) / 2, py + T - h - 1.5 * k, w, h);
          }
          // a lock or terminal icon on the door, glowing until it has been tried
          const icon = this.sprites.get(v?.kind === 'terminal' ? 'mg_icon_term' : 'mg_icon_lock');
          if (icon) {
            const pu = 0.5 + 0.5 * Math.sin(this.clock * 3 + x);
            if (!dead) {
              const g = ctx.createRadialGradient(px + T / 2, py + T * 0.45, 2, px + T / 2, py + T * 0.45, T * 0.55);
              g.addColorStop(0, `rgba(80,255,130,${0.3 + pu * 0.25})`);
              g.addColorStop(1, 'rgba(80,255,130,0)');
              ctx.fillStyle = g;
              ctx.fillRect(px - T * 0.2, py - T * 0.2, T * 1.4, T * 1.4);
            }
            const iw = icon.width * k * 0.9;
            const ih = icon.height * k * 0.9;
            ctx.globalAlpha = dead ? 0.55 : 1;
            ctx.drawImage(icon, px + (T - iw) / 2, py + T * 0.42 - ih / 2, iw, ih);
            ctx.globalAlpha = 1;
          }
          if (dead) {
            ctx.strokeStyle = '#ff3b30';
            ctx.lineWidth = Math.max(2, T * 0.07);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(px + T * 0.28, py + T * 0.28);
            ctx.lineTo(px + T * 0.72, py + T * 0.72);
            ctx.moveTo(px + T * 0.72, py + T * 0.28);
            ctx.lineTo(px + T * 0.28, py + T * 0.72);
            ctx.stroke();
          }
          break;
        }
        case 'exit': {
          const pu = 0.5 + 0.5 * Math.sin(this.clock * 3);
          const g = ctx.createRadialGradient(px + T * 0.5, py + T * 0.6, 2, px + T * 0.5, py + T * 0.6, T * (0.7 + pu * 0.15));
          g.addColorStop(0, `rgba(120,255,150,${0.35 + pu * 0.25})`);
          g.addColorStop(1, 'rgba(120,255,150,0)');
          ctx.fillStyle = g;
          ctx.fillRect(px - T * 0.4, py - T * 0.4, T * 1.8, T * 1.8);
          this.img(ctx, 'obj_exit', px, py, T, T);
          const by = py - T * 0.18 - Math.abs(Math.sin(this.clock * 4)) * T * 0.22;
          ctx.save();
          ctx.font = `bold ${Math.round(T * 0.34)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = Math.max(2, T * 0.07);
          ctx.strokeStyle = 'rgba(0,30,10,0.9)';
          ctx.shadowColor = '#5dff8a';
          ctx.shadowBlur = 8 + pu * 10;
          ctx.strokeText('EXIT', px + T / 2, by);
          ctx.fillStyle = '#caffd6';
          ctx.fillText('EXIT', px + T / 2, by);
          ctx.restore();
          break;
        }
        default:
          this.img(ctx, `obj_${c.object}`, px, py, T, T);
      }
    }

    if (c.revealed && c.pickup) {
      const bob = Math.sin(this.clock * 4 + x * 2 + y * 3) * 2 * k;
      this.img(ctx, PICKUP_SPRITE[c.pickup], px + T * 0.18, py + T * 0.18 + bob, T * 0.64, T * 0.64);
    }

    // Minesweeper clue number on explored floor (small in the corner if an item shares the cell).
    if (c.revealed && c.clue > 0 && !c.pickup && !(c.object && c.object !== 'exit')) {
      this.drawClue(c.clue, px + T / 2, py + T / 2);
    } else if (c.revealed && c.clue > 0 && c.pickup && !c.object) {
      // number is shown small in the corner when an item shares the cell
      this.drawClue(c.clue, px + T * 0.22, py + T * 0.28, 0.45);
    }
  }

  private drawClue(n: number, cx: number, cy: number, scale = 1): void {
    const ctx = this.ctx;
    const size = this.tile * 0.62 * scale;
    ctx.font = `bold ${size}px "Trebuchet MS", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, size * 0.14);
    ctx.strokeStyle = 'rgba(40,10,0,0.9)';
    ctx.strokeText(String(n), cx, cy + 1);
    const g = ctx.createLinearGradient(0, cy - size / 2, 0, cy + size / 2);
    g.addColorStop(0, '#ffd23a');
    g.addColorStop(1, '#ff6a1a');
    ctx.fillStyle = g;
    ctx.fillText(String(n), cx, cy + 1);
  }

  private shadow(cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.tile * r, this.tile * r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayer(level: Level, px: number, py: number): void {
    const T = this.tile;
    const k = T / 64;
    const moving = level.isMoving();
    // 4-frame walk cycle per direction; standing still holds frame 0 with a slight breath
    const frame = moving ? Math.floor(this.clock / 0.1) % 4 : 0;
    const bob = moving ? Math.abs(Math.sin(this.clock * 24)) * 1.2 * k : Math.sin(this.clock * 2) * 0.5 * k;
    this.shadow(px + T / 2, py + T * 0.93, 0.24);
    if (!this.img(this.ctx, `player_${level.facing}_${frame}`, px, py - bob, T, T)) {
      this.ctx.fillStyle = '#4a8';
      this.ctx.fillRect(px + T * 0.3, py + T * 0.2, T * 0.4, T * 0.7);
    }
  }

  private drawSwat(level: Level, px: number, py: number, id: number): void {
    const T = this.tile;
    const k = T / 64;
    const p = level.patrols.find((q) => q.id === id);
    let dir = 'down';
    if (p) {
      const t = p.route[p.target]!;
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : dy < 0 ? 'up' : 'down';
    }
    const frame = Math.floor(this.clock / 0.16 + id) % 4;
    this.shadow(px + T / 2, py + T * 0.93, 0.3);
    const bob = Math.abs(Math.sin(this.clock * 12 + id)) * 1.4 * k;
    if (!this.img(this.ctx, `swat_${dir}_${frame}`, px, py - bob, T, T)) {
      this.ctx.fillStyle = '#a33';
      this.ctx.fillRect(px + T * 0.25, py, T * 0.5, T);
    }
  }

  private drawEffects(sx: (x: number) => number, sy: (y: number) => number, dt: number): void {
    const ctx = this.ctx;
    const T = this.tile;
    for (const d of this.dust) {
      d.life += dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vx *= 0.96;
      d.vy *= 0.96;
      const a = Math.max(0, 1 - d.life / d.max);
      ctx.fillStyle = `rgba(150,130,100,${a * 0.6})`;
      ctx.beginPath();
      ctx.arc(sx(d.x) + T / 2, sy(d.y) + T / 2, d.r * T * (1 + d.life), 0, Math.PI * 2);
      ctx.fill();
    }
    this.dust = this.dust.filter((d) => d.life < d.max);

    ctx.font = `bold ${Math.round(T * 0.3)}px "Trebuchet MS", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      f.t += dt;
      const a = Math.max(0, 1 - f.t / 1.1);
      const yy = sy(f.y) + T / 2 - f.t * T * 0.8;
      ctx.globalAlpha = a;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(f.text, sx(f.x) + T / 2, yy);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, sx(f.x) + T / 2, yy);
      ctx.globalAlpha = 1;
    }
    this.floats = this.floats.filter((f) => f.t < 1.1);
  }
}


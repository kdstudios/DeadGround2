import { hash, noise } from './visuals.js';
import type { Night, NightEvent } from '../night/night.js';
import { NIGHT_MAP, TUNING } from '../night/night.js';
import type { SpriteStore } from './sprites.js';

const DIRS = { up: 'up', down: 'down', left: 'left', right: 'right' } as const;

/** Draws the night defence scene on the shared game canvas, using the same ground, wall and character art. */
export class NightRenderer {
  private ctx: CanvasRenderingContext2D;
  private tile = 48;
  private ox = 0;
  private oy = 0;
  private cssW = 0;
  private cssH = 0;
  private clock = 0;
  private parts: { x: number; y: number; vx: number; vy: number; life: number; max: number; col: string; r: number }[] = [];
  private texts: { x: number; y: number; text: string; life: number; col: string }[] = [];
  private shake = 0;
  private flash = 0;
  private top = 70;
  private bottom = 90;

  constructor(
    private canvas: HTMLCanvasElement,
    private sprites: SpriteStore,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Turn night events into particles, floating numbers and screen shake (cell units). */
  handleEvents(events: NightEvent[]): void {
    const puff = (x: number, y: number, n: number, col: string, speed = 1.6): void => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = (0.3 + Math.random()) * speed;
        this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.4, life: 0.5, max: 0.5, col, r: 1 + Math.random() * 2 });
      }
    };
    for (const e of events) {
      switch (e.type) {
        case 'hit':
          puff(e.at.x, e.at.y, 4, '#b33a2a');
          this.texts.push({ x: e.at.x, y: e.at.y - 0.4, text: `-${e.dmg}`, life: 0.7, col: '#ffd0c0' });
          break;
        case 'kill':
          puff(e.at.x, e.at.y, 12, '#7a8a6a', 2.2);
          break;
        case 'gateHit':
          puff(e.at.x, e.at.y, 5, '#9a7440');
          break;
        case 'gateBreak':
          puff(e.at.x, e.at.y, 22, '#9a7440', 2.6);
          this.shake = 0.35;
          break;
        case 'coreHit':
          this.flash = 0.35;
          this.shake = 0.25;
          this.texts.push({ x: e.at.x, y: e.at.y - 0.8, text: '-1', life: 0.8, col: '#ff7a6a' });
          break;
        case 'repair':
          puff(e.at.x, e.at.y, 6, '#ffe27a', 1.1);
          this.texts.push({ x: e.at.x, y: e.at.y - 0.6, text: '+HP', life: 0.8, col: '#9de66a' });
          break;
        default:
          break;
      }
    }
  }

  setInsets(top: number, bottom: number): void {
    this.top = top;
    this.bottom = bottom;
  }

  private layout(n: Night): void {
    const dpr = window.devicePixelRatio || 1;
    this.cssW = this.canvas.clientWidth;
    this.cssH = this.canvas.clientHeight;
    const w = Math.max(1, Math.floor(this.cssW * dpr));
    const h = Math.max(1, Math.floor(this.cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // fit the compound (plus a little margin) into the area between the HUD bars
    const availH = Math.max(120, this.cssH - this.top - this.bottom);
    this.tile = Math.max(20, Math.min(64, Math.floor(Math.min(this.cssW / n.width, availH / n.height))));
    this.ox = Math.floor((this.cssW - n.width * this.tile) / 2);
    this.oy = Math.floor(this.top + (availH - n.height * this.tile) / 2);
  }

  /** Screen (CSS px relative to the canvas) -> grid cell. */
  screenToCell(n: Night, sx: number, sy: number): { x: number; y: number } | null {
    const x = Math.floor((sx - this.ox) / this.tile);
    const y = Math.floor((sy - this.oy) / this.tile);
    return x >= 0 && y >= 0 && x < n.width && y < n.height ? { x, y } : null;
  }

  private sx(x: number): number {
    return this.ox + x * this.tile;
  }
  private sy(y: number): number {
    return this.oy + y * this.tile;
  }

  private img(name: string, x: number, y: number, w: number, h: number): void {
    const im = this.sprites.get(name);
    if (im) this.ctx.drawImage(im, x, y, w, h);
  }

  private wallish(x: number, y: number): boolean {
    if (x < 0 || y < 0 || y >= NIGHT_MAP.length || x >= NIGHT_MAP[0]!.length) return false;
    const c = NIGHT_MAP[y]![x];
    return c === '#' || c === 'B';
  }

  render(n: Night, dt: number): void {
    this.clock += dt;
    this.layout(n);
    const ctx = this.ctx;
    const T = this.tile;
    ctx.save();
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      ctx.translate((Math.random() - 0.5) * 12 * this.shake, (Math.random() - 0.5) * 12 * this.shake);
    }
    const g = this.sprites.groups;
    ctx.fillStyle = '#0a0e0b';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const dirt = (g.ground_dirt ?? []).filter((_, i) => [0, 2, 4, 7].includes(i));
    const grass = (g.ground_grass ?? []).filter((_, i) => [0, 1, 3].includes(i));
    const pave = g.ground_paved?.[0] ?? dirt[0]!;

    // ground (pavement inside the compound), then walls and gates
    for (let y = 0; y < n.height; y++)
      for (let x = 0; x < n.width; x++) {
        const inside = x > 8 && x < 18 && y > 3 && y < 11;
        const wild = noise(x / 4.5, y / 4.5, 21) < 0.34;
        const pool = wild ? grass : dirt;
        const name = inside ? pave : pool[Math.floor(hash(x, y, 9) * pool.length)]!;
        const im = this.sprites.get(name);
        if (im) {
          const rot = Math.floor(hash(x, y, 4) * 4);
          const px = this.sx(x), py = this.sy(y);
          ctx.save();
          ctx.translate(px + T / 2, py + T / 2);
          ctx.rotate((rot * Math.PI) / 2);
          ctx.drawImage(im, -T / 2 - 0.4, -T / 2 - 0.4, T + 0.8, T + 0.8);
          ctx.restore();
        }
      }
    for (let y = 0; y < n.height; y++)
      for (let x = 0; x < n.width; x++) {
        const c = NIGHT_MAP[y]![x];
        if (c !== '#' && c !== 'B') continue;
        const bar = n.barricadeAt(x, y);
        if (bar && bar.hp <= 0) continue; // broken gate: open ground
        const mask =
          (this.wallish(x, y - 1) ? 1 : 0) | (this.wallish(x + 1, y) ? 2 : 0) | (this.wallish(x, y + 1) ? 4 : 0) | (this.wallish(x - 1, y) ? 8 : 0);
        this.img(`wall${mask}`, this.sx(x), this.sy(y), T + 0.8, T + 0.8);
      }

    // gate planks with health bars
    for (const b of n.barricades) {
      if (b.hp <= 0) continue;
      const im = this.sprites.get('ov_barricade');
      if (im) {
        const k = T / 64;
        ctx.drawImage(im, this.sx(b.x) + (T - im.width * k) / 2, this.sy(b.y) + T - im.height * k - 1, im.width * k, im.height * k);
      }
      if (b.hp < b.max) this.bar(this.sx(b.x), this.sy(b.y) - 2, T, b.hp / b.max, '#d9a03a');
    }

    // core (the safehouse door)
    const cx = this.sx(n.core.x), cy = this.sy(n.core.y);
    ctx.fillStyle = 'rgba(255,200,90,0.16)';
    ctx.beginPath();
    ctx.arc(cx + T / 2, cy + T / 2, T * (0.9 + 0.05 * Math.sin(this.clock * 2)), 0, Math.PI * 2);
    ctx.fill();
    const door = this.sprites.get('ov_door');
    if (door) {
      const k = T / 64;
      ctx.drawImage(door, cx + (T - door.width * k) / 2, cy + T - door.height * k - 1, door.width * k, door.height * k);
    }
    this.bar(cx - T * 0.15, cy - 5, T * 1.3, n.coreHp / TUNING.coreHp, n.coreHp / TUNING.coreHp > 0.4 ? '#6fd36f' : '#e0503c');

    // towers
    for (const t of n.towers) {
      const px = this.sx(t.x), py = this.sy(t.y);
      if (!t.unlocked) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(px + 3, py + 3, T - 6, T - 6);
        ctx.setLineDash([]);
        continue;
      }
      this.tower(px, py);
      const s = n.survivorOn(t);
      if (s) {
        const k = T / 64;
        this.img('player_down_0', px + T * 0.1, py - T * 0.42, 64 * k * 0.8, 64 * k * 0.8);
        ctx.font = `bold ${Math.round(T * 0.22)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 3;
        ctx.strokeText(s.name, px + T / 2, py + T * 0.98);
        ctx.fillText(s.name, px + T / 2, py + T * 0.98);
      } else if (n.phase === 'prep') {
        ctx.font = `bold ${Math.round(T * 0.5)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,230,140,0.9)';
        ctx.fillText('+', px + T / 2, py + T * 0.62);
      }
    }

    // zombies and the player, sorted by row
    const ents: { y: number; draw: () => void }[] = [];
    for (const z of n.zombies) {
      ents.push({
        y: z.y,
        draw: () => {
          const frame = Math.floor(this.clock * 3 + z.id) % 4;
          const px = this.sx(z.x) - T * 0.0, py = this.sy(z.y) - T * 0.2;
          this.shadow(this.sx(z.x) + T / 2, this.sy(z.y) + T * 0.9);
          if (z.hit > 0) ctx.filter = 'brightness(2.2)';
          this.img(`zombie_${DIRS[z.dir]}_${frame}`, px, py, T, T);
          ctx.filter = 'none';
          if (z.hp < 3) this.bar(this.sx(z.x) + T * 0.2, this.sy(z.y) - T * 0.2, T * 0.6, z.hp / 3, '#e0503c', 4);
        },
      });
    }
    const p = n.player;
    ents.push({
      y: p.y,
      draw: () => {
        const frame = n.playerMoving ? Math.floor(this.clock / 0.1) % 4 : 0;
        this.shadow(this.sx(p.x) + T / 2, this.sy(p.y) + T * 0.9);
        this.img(`player_${n.playerDir}_${frame}`, this.sx(p.x), this.sy(p.y) - T * 0.2, T, T);
      },
    });
    ents.sort((a, b) => a.y - b.y).forEach((e) => e.draw());

    // arrows
    ctx.lineCap = 'round';
    for (const a of n.arrows) {
      const z = n.zombies.find((q) => q.id === a.target);
      if (!z) continue;
      const ang = Math.atan2(z.y - a.y, z.x - a.x);
      const x = this.sx(a.x) + T / 2, y = this.sy(a.y) + T / 2 - T * 0.1;
      const L = T * 0.35;
      ctx.strokeStyle = '#d8c79a';
      ctx.lineWidth = Math.max(2, T * 0.05);
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(ang) * L, y - Math.sin(ang) * L);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = '#e8e4d0';
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, T * 0.05), 0, Math.PI * 2);
      ctx.fill();
    }

    // particles and floating numbers
    for (const p of this.parts) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 2.2 * dt;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.col;
      ctx.fillRect(this.sx(p.x) + T / 2, this.sy(p.y) + T / 2, p.r, p.r);
    }
    ctx.globalAlpha = 1;
    this.parts = this.parts.filter((p) => p.life > 0);
    ctx.font = `bold ${Math.round(T * 0.3)}px sans-serif`;
    ctx.textAlign = 'center';
    for (const t of this.texts) {
      t.life -= dt;
      t.y -= dt * 0.7;
      ctx.globalAlpha = Math.max(0, Math.min(1, t.life * 2));
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(t.text, this.sx(t.x) + T / 2, this.sy(t.y) + T / 2);
      ctx.fillStyle = t.col;
      ctx.fillText(t.text, this.sx(t.x) + T / 2, this.sy(t.y) + T / 2);
    }
    ctx.globalAlpha = 1;
    this.texts = this.texts.filter((t) => t.life > 0);

    // night
    ctx.fillStyle = 'rgba(8,14,38,0.34)';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    // keep the core, door and towers readable: a warm glow around the core on top of the tint
    const grd = ctx.createRadialGradient(cx + T / 2, cy + T / 2, T * 0.3, cx + T / 2, cy + T / 2, T * 3.2);
    grd.addColorStop(0, 'rgba(255,190,90,0.22)');
    grd.addColorStop(1, 'rgba(255,190,90,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.restore();
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt);
      ctx.fillStyle = `rgba(200,20,10,${this.flash * 0.5})`;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
  }

  private bar(x: number, y: number, w: number, f: number, col: string, h = 5): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = col;
    ctx.fillRect(x, y, Math.max(0, Math.min(1, f)) * w, h);
  }

  private shadow(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x, y, this.tile * 0.28, this.tile * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /** A little wooden lookout platform. */
  private tower(px: number, py: number): void {
    const ctx = this.ctx;
    const T = this.tile;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(px + T * 0.12, py + T * 0.78, T * 0.8, T * 0.14);
    ctx.fillStyle = '#4a3320';
    ctx.fillRect(px + T * 0.14, py + T * 0.5, T * 0.1, T * 0.44);
    ctx.fillRect(px + T * 0.76, py + T * 0.5, T * 0.1, T * 0.44);
    ctx.fillStyle = '#7b5a36';
    ctx.fillRect(px + T * 0.08, py + T * 0.42, T * 0.84, T * 0.18);
    ctx.fillStyle = '#a07a4a';
    ctx.fillRect(px + T * 0.08, py + T * 0.42, T * 0.84, T * 0.05);
    ctx.strokeStyle = '#2a1c10';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px + T * 0.08, py + T * 0.42, T * 0.84, T * 0.18);
  }
}

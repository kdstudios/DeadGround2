import { Rng } from '../gen/rng.js';
import { sfx } from '../audio/sfx.js';
import type { Vault } from '../core/types.js';
import { LockpickSession } from '../minigames/lockpick.js';
import { HackingSession, ROW_WIDTH, ROWS_PER_COLUMN } from '../minigames/hacking.js';
import type { SpriteStore } from '../render/sprites.js';

export type MinigameOutcome = 'success' | 'failed' | 'ignored';

const GREEN = '#39ff6a';
const DIM = '#2bb052';
const AMBER = '#ffb000';
const RED = '#ff3b30';
const LOOT = '#c8ff3a';
const BG = '#030704';

/** Plate sprite per lock level, and where each plate's keyhole sits (px in the sprite). */
const PLATE_BY_LEVEL = ['mg_plate0', 'mg_plate1', 'mg_plate2', 'mg_plate3', 'mg_plate4', 'mg_plate4'];
const KEYHOLE: Record<string, [number, number]> = {
  mg_plate0: [52, 133],
  mg_plate1: [83, 135],
  mg_plate2: [78, 135],
  mg_plate3: [83, 130],
  mg_plate4: [111, 130],
};

/**
 * The lock and terminal minigames, ported from the Wasteland Terminal game: a green-phosphor full-screen
 * panel. Either one is optional (IGNORE), and each is a single attempt: a snapped pick or a locked-out
 * terminal means the vault stays shut for good.
 */
export class MinigameOverlay {
  private root: HTMLElement;
  private raf = 0;
  private last = 0;
  private tintCache = new Map<string, HTMLCanvasElement>();
  isOpen = false;

  constructor(
    private sprites: SpriteStore,
    root: HTMLElement,
  ) {
    this.root = root;
  }

  open(v: Vault, done: (o: MinigameOutcome) => void): void {
    this.isOpen = true;
    this.root.hidden = false;
    const rng = new Rng(v.seed);
    if (v.kind === 'lock') this.lockPrompt(LockpickSession.generate(v.level, rng), done);
    else this.termPrompt(HackingSession.generate(v.level, rng), done);
  }

  private close(o: MinigameOutcome, done: (o: MinigameOutcome) => void): void {
    cancelAnimationFrame(this.raf);
    this.root.hidden = true;
    this.root.innerHTML = '';
    this.isOpen = false;
    done(o);
  }

  // ───────────── shared helpers ─────────────

  private img(name: string): HTMLImageElement | null {
    return this.sprites.get(name);
  }

  /** Map a sprite's brightness onto the phosphor colour, keeping some of its own colours. */
  private tint(name: string, color: string, keep = 0.5, gain = 1): CanvasImageSource | null {
    const key = `${name}|${color}|${keep}|${gain}`;
    const hit = this.tintCache.get(key);
    if (hit) return hit;
    const im = this.img(name);
    if (!im) return null;
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    const x = c.getContext('2d')!;
    x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height);
    const t = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = 0.2126 * d.data[i]! + 0.7152 * d.data[i + 1]! + 0.0722 * d.data[i + 2]!;
      for (let k = 0; k < 3; k++) {
        const own = d.data[i + k]!;
        const mono = (lum * t[k]!) / 255;
        d.data[i + k] = Math.min(255, (own * keep + mono * (1 - keep)) * gain);
      }
    }
    x.putImageData(d, 0, 0);
    this.tintCache.set(key, c);
    return c;
  }

  private shell(inner: string): void {
    this.root.innerHTML = `<div class="mg-panel">${inner}</div>`;
  }

  private btn(label: string, cls = ''): string {
    return `<button class="mg-btn ${cls}" data-act="${label}">[${label}]</button>`;
  }

  private clickBtn(label: string, fn: () => void): void {
    this.root.querySelector<HTMLElement>(`[data-act="${label}"]`)?.addEventListener('click', () => {
      sfx.play('click');
      fn();
    });
  }

  private imageHtml(name: string, h: number): string {
    const im = this.img(name);
    return im ? `<img class="mg-art" src="${im.src}" style="height:${h}px" alt="">` : '';
  }

  // ───────────── lockpicking ─────────────

  private lockPrompt(s: LockpickSession, done: (o: MinigameOutcome) => void): void {
    this.shell(`
      <div class="mg-h amber">LOCKED STRONGROOM DETECTED</div>
      <div class="mg-l">LOCK: ${s.lockName}</div>
      <div class="mg-l">YOU HAVE ONE LOCKPICK. IF IT SNAPS, THE LOCK JAMS FOR GOOD.</div>
      ${this.imageHtml('mg_chest', 150)}
      <div class="mg-row">${this.btn('PICK LOCK')}${this.btn('IGNORE', 'amber')}</div>
      <div class="mg-l small">Optional. Success opens the door to the room beyond.</div>`);
    this.clickBtn('PICK LOCK', () => this.lockPlay(s, done));
    this.clickBtn('IGNORE', () => this.close('ignored', done));
  }

  private lockPlay(s: LockpickSession, done: (o: MinigameOutcome) => void): void {
    this.shell(`
      <div class="mg-h" id="mg-title">LOCK: ${s.lockName}</div>
      <div class="mg-l" id="mg-hp"></div>
      <div class="mg-l small">DRAG THE LOCK: AIM &nbsp;//&nbsp; PULL THE LEVER: TURN. OVER-PULLING STRAINS THE PICK.</div>
      <canvas id="mg-lock" class="mg-canvas"></canvas>
      <div id="mg-lever" class="mg-lever"><div id="mg-fill"></div><div id="mg-hint">◀ PULL LEVER TO TURN</div><div id="mg-handle">|||</div></div>
      <div class="mg-row" id="mg-end" hidden><div id="mg-result" class="mg-h"></div>${this.btn('CONTINUE')}</div>`);
    const canvas = this.root.querySelector<HTMLCanvasElement>('#mg-lock')!;
    const lever = this.root.querySelector<HTMLElement>('#mg-lever')!;
    const handle = this.root.querySelector<HTMLElement>('#mg-handle')!;
    const fill = this.root.querySelector<HTMLElement>('#mg-fill')!;
    const hint = this.root.querySelector<HTMLElement>('#mg-hint')!;
    const hp = this.root.querySelector<HTMLElement>('#mg-hp')!;
    const HANDLE = 56;

    // aim: horizontal drag anywhere on the lock
    let aim: { x: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      aim = { x: e.clientX };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!aim) return;
      const before = s.pickAngle;
      s.rotate((e.clientX - aim.x) * 0.5);
      aim.x = e.clientX;
      if (Math.abs(s.pickAngle - before) > 0.01 && Math.floor(s.pickAngle / 4) !== Math.floor(before / 4)) sfx.play('tick');
    });
    const endAim = (): void => {
      aim = null;
    };
    canvas.addEventListener('pointerup', endAim);
    canvas.addEventListener('pointercancel', endAim);

    // lever: drag the handle left
    let lastX = 0;
    lever.addEventListener('pointerdown', (e) => {
      lastX = e.clientX;
      s.grip(true);
      lever.setPointerCapture(e.pointerId);
    });
    lever.addEventListener('pointermove', (e) => {
      if (!s.gripping) return;
      const travel = Math.max(1, lever.clientWidth - HANDLE);
      s.dragLever(-(e.clientX - lastX) / travel);
      lastX = e.clientX;
    });
    const release = (): void => s.grip(false);
    lever.addEventListener('pointerup', release);
    lever.addEventListener('pointercancel', release);

    let snapT = -1; // seconds since the pick snapped (animation)
    let clickAcc = 0;
    const endBar = this.root.querySelector<HTMLElement>('#mg-end')!;
    const resultEl = this.root.querySelector<HTMLElement>('#mg-result')!;
    const finishBtn = (): void => {
      endBar.hidden = false;
      lever.style.display = 'none';
      resultEl.textContent = s.success ? 'LOCK OPENED' : 'PICK SNAPPED. LOCK JAMMED';
      resultEl.className = 'mg-h ' + (s.success ? 'loot' : 'red');
      this.clickBtn('CONTINUE', () => this.close(s.success ? 'success' : 'failed', done));
    };
    let finished = false;

    this.last = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      const ev = s.step(dt);
      if (s.blocked) {
        clickAcc += dt;
        if (clickAcc > 0.13) {
          clickAcc = 0;
          sfx.play('tick');
        }
      }
      if (ev === 'snapped') {
        snapT = 0;
        sfx.play('snap');
        navigator.vibrate?.(60);
      }
      if (ev === 'opened') {
        sfx.play('confirm');
        navigator.vibrate?.(40);
      }
      if (snapT >= 0) snapT += dt;
      if (s.finished && !finished) {
        finished = true;
        finishBtn();
      }
      // lever and readouts
      const travel = Math.max(1, lever.clientWidth - HANDLE);
      const left = travel * (1 - s.lever);
      handle.style.left = `${left}px`;
      fill.style.left = `${left}px`;
      const col = s.blocked ? (s.stress > 0.6 ? RED : AMBER) : GREEN;
      fill.style.background = col + '40';
      handle.style.background = s.gripping ? col : DIM;
      hint.style.display = s.lever < 0.02 ? '' : 'none';
      hp.textContent = `PICK HP: ${Math.round((1 - Math.min(1, s.stress)) * 100)}%`;
      hp.style.color = s.stress > 0.6 ? RED : GREEN;
      this.drawLock(canvas, s, snapT);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private drawLock(canvas: HTMLCanvasElement, s: LockpickSession, snapT: number): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    const plateName = PLATE_BY_LEVEL[Math.min(Math.max(s.level - 1, 0), 5)]!;
    const plate = this.tint(plateName, GREEN, 0.5);
    const cyl = this.tint('mg_cylinder', GREEN, 0.5);
    const pick = this.tint('mg_pick', s.stress > 0.6 ? RED : AMBER, 0.55);
    if (!plate || !cyl || !pick) return;
    const kh = KEYHOLE[plateName]!;
    const pl = this.img(plateName)!;
    const sc = Math.min((h - 10) / 335, (w - 10) / 400);
    if (sc < 0.15) return;
    const cx = w / 2;
    const cy = 6 + kh[1] * sc;

    // gauge: the pick's range, ticks every 15 degrees
    ctx.strokeStyle = DIM;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const ra = 185 * sc;
    ctx.beginPath();
    ctx.arc(cx, cy, ra, 0, Math.PI);
    ctx.stroke();
    for (let k = -6; k <= 6; k++) {
      const a = Math.PI / 2 - (k * Math.PI) / 12;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * ra * 0.95, cy + Math.sin(a) * ra * 0.95);
      ctx.lineTo(cx + Math.cos(a) * ra * 1.05, cy + Math.sin(a) * ra * 1.05);
      ctx.stroke();
    }

    ctx.drawImage(plate, cx - kh[0] * sc, cy - kh[1] * sc, pl.width * sc, pl.height * sc);
    if (s.finished && s.success) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 120 * sc);
      g.addColorStop(0, LOOT + '59');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - 130 * sc, cy - 130 * sc, 260 * sc, 260 * sc);
    }

    // cylinder turns with progress
    const cw = this.img('mg_cylinder')!;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-s.progress * Math.PI) / 2);
    ctx.drawImage(cyl, (-cw.width * sc) / 2, (-cw.height * sc) / 2, cw.width * sc, cw.height * sc);
    ctx.restore();

    // the pick pivots about its tip in the keyhole; shakes when over-pulled; gone once snapped
    const t = performance.now();
    if (!s.snapped) {
      const shake = s.blocked ? { x: Math.sin(t * 0.09), y: Math.cos(t * 0.13) } : { x: 0, y: 0 };
      const mag = (1 + s.stress * 4) * sc * 1.6;
      const pw = this.img('mg_pick')!;
      ctx.save();
      ctx.translate(cx + shake.x * mag, cy + shake.y * mag);
      ctx.rotate((-s.pickAngle * Math.PI) / 180);
      ctx.drawImage(pick, (-pw.width * sc) / 2, 0, pw.width * sc, pw.height * sc);
      ctx.restore();
    } else if (snapT >= 0 && snapT < 0.85) {
      const broken = this.tint('mg_pickbroken', RED, 0.4);
      const bw = this.img('mg_pickbroken')!;
      if (broken) {
        const u = snapT / 0.85;
        ctx.save();
        ctx.globalAlpha = 1 - u;
        ctx.translate(cx, cy + (95 + 150 * u * u) * sc);
        ctx.rotate(u * 1.3);
        ctx.drawImage(broken, -bw.width * sc * 0.4, -bw.height * sc * 0.4, bw.width * sc * 0.8, bw.height * sc * 0.8);
        ctx.restore();
      }
    }
  }

  // ───────────── terminal hacking ─────────────

  private termPrompt(s: HackingSession, done: (o: MinigameOutcome) => void): void {
    this.shell(`
      <div class="mg-h amber">SECURITY TERMINAL DETECTED</div>
      <div class="mg-l">SECURITY LEVEL: ${s.level}</div>
      <div class="mg-l">TYPE: ${s.typeName}</div>
      <div class="mg-l">YOU GET ${s.maxAttempts} ATTEMPTS. RUN OUT AND YOU ARE LOCKED OUT FOR GOOD.</div>
      ${this.imageHtml(s.level % 2 === 0 ? 'mg_desk' : 'mg_computer', 150)}
      <div class="mg-row">${this.btn('HACK')}${this.btn('IGNORE', 'amber')}</div>
      <div class="mg-l small">Optional. Success opens the door to the room beyond.</div>`);
    this.clickBtn('HACK', () => this.termPlay(s, done));
    this.clickBtn('IGNORE', () => this.close('ignored', done));
  }

  private termPlay(s: HackingSession, done: (o: MinigameOutcome) => void): void {
    this.shell(`
      <div class="mg-h" id="th-title">SEC LV ${s.level}&nbsp;&nbsp; ENTER PASSWORD NOW</div>
      <div class="mg-h" id="th-att"></div>
      <canvas id="mg-grid" class="mg-grid"></canvas>
      <div class="mg-l" id="th-prompt"></div>
      <pre class="mg-log" id="th-log"></pre>
      <div class="mg-row" id="mg-end" hidden><div id="mg-result" class="mg-h"></div>${this.btn('CONTINUE')}</div>`);
    const canvas = this.root.querySelector<HTMLCanvasElement>('#mg-grid')!;
    const att = this.root.querySelector<HTMLElement>('#th-att')!;
    const prompt = this.root.querySelector<HTMLElement>('#th-prompt')!;
    const log = this.root.querySelector<HTMLElement>('#th-log')!;
    const end = this.root.querySelector<HTMLElement>('#mg-end')!;
    const result = this.root.querySelector<HTMLElement>('#mg-result')!;
    const COLS = 37;
    const LEFT = 5;
    const RIGHT = 25;
    let cellW = 10;
    let cellH = 16;
    let fs = 12;
    let lastLog = 0;
    let lastSel: number | null = null;
    let over = false;

    const layout = (): void => {
      const maxW = Math.min(this.root.clientWidth - 24, 760);
      const maxH = Math.max(160, window.innerHeight - 270);
      cellW = maxW / COLS;
      fs = Math.max(6, Math.min(18, cellW / 0.6));
      cellH = Math.min(fs * 1.55, maxH / ROWS_PER_COLUMN);
      fs = Math.min(fs, cellH / 1.1);
      cellW = Math.min(cellW, fs / 0.55);
      canvas.style.width = `${cellW * COLS}px`;
      canvas.style.height = `${cellH * ROWS_PER_COLUMN}px`;
    };
    layout();
    window.addEventListener('resize', layout);

    canvas.addEventListener('pointerup', (e) => {
      if (s.finished) return;
      const r = canvas.getBoundingClientRect();
      const line = Math.floor((e.clientY - r.top) / cellH);
      const col = Math.floor((e.clientX - r.left) / cellW);
      const wasLog = s.log.length;
      const before = s.selected;
      if (line >= 0 && line < ROWS_PER_COLUMN) {
        if (col >= LEFT && col < LEFT + ROW_WIDTH) s.tap(line, col - LEFT);
        else if (col >= RIGHT && col < RIGHT + ROW_WIDTH) s.tap(line + ROWS_PER_COLUMN, col - RIGHT);
        else s.tap(-1, -1);
      } else s.tap(-1, -1);
      sfx.play(s.selected !== before || s.log.length === wasLog ? 'click' : 'tick');
      const added = s.log.slice(wasLog).join('\n');
      if (added.includes('DENIED')) sfx.play('deny');
      if (added.includes('GRANTED')) sfx.play('confirm');
      if (added.includes('LOCKED OUT')) sfx.play('alarm');
      if (added.includes('EXPLOIT')) sfx.play('pickup');
    });

    const loop = (): void => {
      layout();
      this.drawGrid(canvas, s, fs, cellW, cellH, LEFT, RIGHT);
      att.textContent = `ATTEMPTS: ${'■ '.repeat(Math.max(0, s.attempts))}${'□ '.repeat(s.maxAttempts - Math.max(0, s.attempts))}`;
      att.style.color = s.attempts <= 1 ? RED : GREEN;
      const cur = s.selected === null ? null : s.tokens[s.selected]!;
      if (s.selected !== lastSel) {
        lastSel = s.selected;
      }
      prompt.textContent = `> ${cur ? s.rows[cur.row]!.slice(cur.start, cur.end) : ''}▌`;
      if (s.log.length !== lastLog) {
        lastLog = s.log.length;
        log.textContent = s.log.slice(-4).join('\n');
      }
      if (s.finished && !over) {
        over = true;
        end.hidden = false;
        result.textContent = s.success ? (s.flawless ? 'ACCESS GRANTED - FLAWLESS' : 'ACCESS GRANTED') : 'TERMINAL LOCKED OUT';
        result.className = 'mg-h ' + (s.success ? 'loot' : 'red');
        window.removeEventListener('resize', layout);
        this.clickBtn('CONTINUE', () => this.close(s.success ? 'success' : 'failed', done));
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private drawGrid(canvas: HTMLCanvasElement, s: HackingSession, fs: number, cellW: number, cellH: number, LEFT: number, RIGHT: number): void {
    const dpr = window.devicePixelRatio || 1;
    const w = cellW * 37;
    const h = cellH * ROWS_PER_COLUMN;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${fs}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cur = s.selected === null ? null : s.tokens[s.selected]!;
    if (cur) {
      const right = cur.row >= ROWS_PER_COLUMN;
      ctx.fillStyle = GREEN;
      ctx.fillRect(((right ? RIGHT : LEFT) + cur.start) * cellW, (cur.row % ROWS_PER_COLUMN) * cellH, (cur.end - cur.start) * cellW, cellH);
    }
    for (let line = 0; line < ROWS_PER_COLUMN; line++) {
      for (let side = 0; side < 2; side++) {
        const row = line + side * ROWS_PER_COLUMN;
        const base = side === 0 ? LEFT : RIGHT;
        const addr = (0xf4a0 + row * 12).toString(16).toUpperCase().padStart(4, '0');
        ctx.fillStyle = DIM;
        for (let i = 0; i < 4; i++) ctx.fillText(addr[i]!, (base - 5 + i + 0.5) * cellW, (line + 0.52) * cellH);
        const text = s.rows[row]!;
        for (let c = 0; c < text.length; c++) {
          const hi = !!cur && cur.row === row && c >= cur.start && c < cur.end;
          ctx.fillStyle = hi ? BG : GREEN;
          ctx.fillText(text[c]!, (base + c + 0.5) * cellW, (line + 0.52) * cellH);
        }
      }
    }
  }
}

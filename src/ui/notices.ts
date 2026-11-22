import type { Notice, Reward } from '../progress/types.js';
import { sfx } from '../audio/sfx.js';

const MAX_VISIBLE = 4;
const LIFETIME_MS = 4200;
/** XP gains arriving within this window merge into one chip. */
const XP_MERGE_MS = 1600;

export const rewardText = (r: Reward): string =>
  [r.xp ? `${r.xp} XP` : '', r.scrap ? `${r.scrap} scrap` : '', r.food ? `${r.food} food` : '', r.materials ? `${r.materials} materials` : ''].filter(Boolean).join(' · ');

/**
 * Non-blocking notifications for progression: level-ups, achievements, finished missions, XP.
 * Cards stack at the top of the screen, never take input, and fade by themselves, so play is never interrupted.
 */
export class Notices {
  private readonly root: HTMLElement;
  private xpChip: { el: HTMLElement; total: number; at: number; timer: number } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  handle(n: Notice): void {
    switch (n.type) {
      case 'xp':
        return this.xp(n.amount, n.reason);
      case 'levelUp':
        sfx.play('levelup');
        return this.card('level', `Level ${n.level}`, n.reward ? `Operator promoted · supply drop: ${rewardText(n.reward)}` : 'Operator promoted', 6000);
      case 'achievement':
        sfx.play('achievement');
        return this.card('ach', `Achievement: ${n.name}`, rewardText(n.reward));
      case 'missionDone':
        return this.card('mission', 'Mission complete', `${n.name}. Claim it in Missions.`);
      case 'missionAutoClaimed':
        return this.card('mission', 'Mission paid out', `${n.name}: ${rewardText(n.reward)} (the period ended)`);
      case 'veteran':
        return this.card('ach', 'Service record recognised', `${n.achievements} achievement${n.achievements === 1 ? '' : 's'} credited for what you had already built. You are level ${n.level}.`, 7000);
    }
  }

  info(title: string, text: string): void {
    this.card('mission', title, text);
  }

  private xp(amount: number, reason: string): void {
    if (document.getElementById('results')?.hidden === false) return; // the results card already shows the XP earned
    const now = performance.now();
    const c = this.xpChip;
    if (c && now - c.at < XP_MERGE_MS && c.el.isConnected) {
      c.total += amount;
      c.at = now;
      c.el.querySelector('b')!.textContent = `+${c.total} XP`;
      window.clearTimeout(c.timer);
      c.timer = window.setTimeout(() => this.remove(c.el), 2400);
      return;
    }
    const el = this.make('xp', `+${amount} XP`, reason);
    this.xpChip = { el, total: amount, at: now, timer: window.setTimeout(() => this.remove(el), 2400) };
  }

  private card(kind: string, title: string, text: string, ms = LIFETIME_MS): void {
    const el = this.make(kind, title, text);
    window.setTimeout(() => this.remove(el), ms);
  }

  private make(kind: string, title: string, text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `notice ${kind}`;
    const b = document.createElement('b');
    b.textContent = title;
    const s = document.createElement('span');
    s.textContent = text;
    el.append(b, s);
    this.root.appendChild(el);
    while (this.root.children.length > MAX_VISIBLE) this.root.firstElementChild?.remove();
    requestAnimationFrame(() => el.classList.add('in'));
    return el;
  }

  private remove(el: HTMLElement): void {
    el.classList.remove('in');
    window.setTimeout(() => el.remove(), 350);
  }
}

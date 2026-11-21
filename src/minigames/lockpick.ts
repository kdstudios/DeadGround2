import { Rng } from '../gen/rng.js';

/**
 * Lockpicking rules and physics (ported from the Wasteland Terminal minigame).
 *
 * The pick angle runs -90..90 degrees (0 = straight down). One hidden "sweet spot" angle opens the lock.
 * The player pulls a lever (0..1): the cylinder follows the lever but only as far as the current angle
 * allows (close to the sweet spot = a long turn, far = barely any). Pulling the lever PAST what the lock
 * allows strains the pick, harder over-pulls strain it much faster. You get ONE pick: when its strain
 * reaches 1 it snaps and the lock is jammed for good.
 */
export type LockEvent = 'none' | 'snapped' | 'opened';

export const LOCK_NAMES = ['BASIC', 'RESIDENTIAL', 'MILITARY', 'VAULT', 'LEGENDARY', 'BLACKSITE'] as const;

const FOLLOW = 4.0; // cylinder catches up to the lever (per second)
const RETURN_SPEED = 5.0; // cylinder springs back (per second)
const LEVER_RETURN = 3.0; // released lever springs back (per second)
const STRAIN_SCALE = 2.2;
const STRAIN_POWER = 1.5;
const TOL = [14.0, 10.0, 7.0, 4.5, 3.2, 2.2];
const SPREAD = [70.0, 55.0, 42.0, 30.0, 24.0, 18.0];
const RATE = [0.5, 0.7, 0.95, 1.25, 1.5, 1.8];

export class LockpickSession {
  pickAngle = 0;
  lever = 0; // 0 = released, 1 = pulled fully
  progress = 0; // 0..1 cylinder turn
  stress = 0; // 0..1, the pick snaps at 1
  gripping = false;
  blocked = false;
  finished = false;
  success = false;
  /** True once the single pick has broken. */
  snapped = false;

  private constructor(
    readonly level: number,
    readonly sweet: number,
    readonly tolerance: number,
    readonly spread: number,
    readonly stressRate: number,
  ) {}

  static generate(level: number, rng: Rng): LockpickSession {
    const l = Math.min(6, Math.max(1, level));
    return new LockpickSession(l, rng.next() * 140 - 70, TOL[l - 1]!, SPREAD[l - 1]!, RATE[l - 1]!);
  }

  get lockName(): string {
    return LOCK_NAMES[this.level - 1]!;
  }

  /** How far the cylinder may turn at the current pick angle (1.0 = opens). */
  get maxTurn(): number {
    const d = Math.abs(this.pickAngle - this.sweet);
    if (d <= this.tolerance) return 1.0;
    const f = Math.min(1.0, Math.max(0.0, (d - this.tolerance) / this.spread));
    return 0.55 * (1 - f);
  }

  /** Aim the pick. Not possible while tension is on the lever. */
  rotate(degrees: number): void {
    if (this.finished || this.lever > 0.04) return;
    this.pickAngle = Math.min(90, Math.max(-90, this.pickAngle + degrees));
  }

  grip(v: boolean): void {
    if (!this.finished) this.gripping = v;
  }

  /** Move the lever by a fraction of its travel (positive = pulled further). */
  dragLever(d: number): void {
    if (this.finished || !this.gripping) return;
    this.lever = Math.min(1, Math.max(0, this.lever + d));
  }

  step(dt: number): LockEvent {
    if (this.finished) return 'none';
    if (!this.gripping && this.lever > 0) this.lever = Math.max(0, this.lever - LEVER_RETURN * dt);

    const limit = this.maxTurn;
    const target = Math.min(this.lever, limit);
    if (this.progress < target) this.progress = Math.min(target, this.progress + FOLLOW * dt);
    else if (this.progress > target) this.progress = Math.max(target, this.progress - RETURN_SPEED * dt);

    if (limit >= 1.0 && this.progress >= 0.999) {
      this.progress = 1;
      this.finished = true;
      this.success = true;
      this.gripping = false;
      this.blocked = false;
      return 'opened';
    }
    const excess = this.lever - limit;
    this.blocked = excess > 0.03;
    if (this.blocked) this.stress += this.stressRate * STRAIN_SCALE * Math.pow(excess, STRAIN_POWER) * dt;
    if (this.stress >= 1.0) {
      this.stress = 1;
      this.snapped = true;
      this.finished = true;
      this.success = false;
      this.lever = 0;
      this.gripping = false;
      this.blocked = false;
      return 'snapped';
    }
    return 'none';
  }
}

import { Rng } from '../gen/rng.js';

/** Terminal hacking rules (ported from the Wasteland Terminal minigame): find the password among decoys. */
export type TokenKind = 'word' | 'bracket';

export interface HackToken {
  kind: TokenKind;
  row: number;
  start: number;
  end: number; // exclusive
  text: string;
  removed: boolean;
}

export const ROWS_PER_COLUMN = 16;
export const ROW_COUNT = 32; // two columns of 16 rows
export const ROW_WIDTH = 12;

export const likenessOf = (a: string, b: string): number => {
  let n = 0;
  for (let i = 0; i < a.length && i < b.length; i++) if (a[i] === b[i]) n++;
  return n;
};

const isLetter = (ch: string): boolean => ch >= 'A' && ch <= 'Z';
const OPEN = ['(', '[', '{', '<'];
const CLOSE = [')', ']', '}', '>'];
const SYMBOLS = '!@#$%^&*_+-=|;:,./?~';

const POOL: Record<number, string[]> = {
  4: ['CORE', 'DOOR', 'FUEL', 'GATE', 'HACK', 'LOCK', 'SAFE', 'WIRE', 'VENT', 'BOLT', 'CODE', 'DUST', 'RUST', 'GRID', 'BURN', 'WIND', 'SAND', 'BONE', 'GEAR', 'HULL', 'PIPE', 'TANK', 'MINE', 'CAMP', 'ROAD', 'WALL', 'FIRE', 'FLUX', 'BASE', 'DEAD', 'HEAT', 'ARMS'],
  5: ['POWER', 'METAL', 'WATER', 'STEEL', 'RADIO', 'SIREN', 'TOWER', 'GUARD', 'ALARM', 'SCRAP', 'FLARE', 'WASTE', 'VAULT', 'CABLE', 'DRONE', 'ROBOT', 'BLAST', 'SHELL', 'FLAME', 'SMOKE', 'STORM', 'RUINS', 'CRATE', 'RELAY', 'PANEL', 'VALVE', 'CHAIN', 'BLADE', 'ARMOR', 'ASHES'],
  6: ['SYSTEM', 'MARKET', 'TARGET', 'MASTER', 'BUNKER', 'SIGNAL', 'ACCESS', 'SHIELD', 'ENGINE', 'LOCKER', 'FILTER', 'SENSOR', 'DEBRIS', 'ROCKET', 'TUNNEL', 'CANYON', 'MUTANT', 'RAIDER', 'HUNTER', 'BARREL', 'BATTLE', 'BULLET', 'ARMORY', 'VAULTS', 'PLATES', 'DEFEND', 'ESCAPE'],
  7: ['CIRCUIT', 'REACTOR', 'BARRIER', 'MONITOR', 'NETWORK', 'BATTERY', 'MACHINE', 'CONSOLE', 'WARHEAD', 'FACTORY', 'SHELTER', 'CHASSIS', 'DEFENSE', 'SCANNER', 'WEAPONS', 'SURVIVE', 'ARSENAL', 'BULLETS', 'LANTERN', 'MISSILE', 'PATROLS', 'TRACKER', 'WARRIOR', 'WRECKED', 'OUTPOST'],
  8: ['ARMOURED', 'BACKDOOR', 'BULKHEAD', 'CHAMBERS', 'CHECKSUM', 'CIRCUITS', 'DEFENDER', 'DETONATE', 'DISPATCH', 'ELECTRIC', 'EVACUATE', 'FIREWALL', 'FORTRESS', 'HOSTILES', 'ISOLATED', 'LOCKDOWN', 'MAINTAIN', 'MILITARY', 'OPERATOR', 'OVERRIDE', 'PASSWORD', 'PROTOCOL', 'SALVAGED', 'SCAVENGE', 'SECURITY', 'SENTINEL', 'SHELTERS', 'SHUTDOWN', 'STANDARD', 'SURVIVOR', 'TERMINAL'],
  9: ['ABANDONED', 'ARTILLERY', 'BARRICADE', 'BASEMENTS', 'BLACKOUTS', 'BROADCAST', 'CARTRIDGE', 'CHEMICALS', 'COMMANDER', 'CONTAINER', 'EMERGENCY', 'EXPLOSIVE', 'FIREPOWER', 'GENERATOR', 'HAZARDOUS', 'MECHANISM', 'MUNITIONS', 'OPERATION', 'OVERSIGHT', 'PERIMETER', 'RADIATION', 'RESERVOIR', 'SCAVENGER', 'STRONGBOX', 'SURVIVORS', 'TERMINALS', 'TRANSPORT', 'WASTELAND'],
  10: ['AMMUNITION', 'BARRICADES', 'COMMANDERS', 'COMPOUNDED', 'DEPARTMENT', 'EXPEDITION', 'EXPLOSIVES', 'FIREWALLED', 'FORTIFYING', 'GENERATORS', 'MAINFRAMES', 'OVERSEEING', 'PROCESSORS', 'QUARANTINE', 'REFINERIES', 'REINFORCED', 'SCAVENGERS', 'SURVEILLED', 'WAREHOUSES', 'WASTELANDS'],
};

export const TERMINAL_NAMES = ['ROADSIDE KIOSK', 'SHOP TERMINAL', 'DEPOT CONSOLE', 'MILITARY TERMINAL', 'CORPORATE MAINFRAME', 'GOVERNMENT NODE', 'BLACKSITE CORE'] as const;

const filler = (rng: Rng): string => SYMBOLS[rng.int(SYMBOLS.length)]!;
const junk = (rng: Rng): string => (rng.next() < 0.13 ? '([{<)]}>'[rng.int(8)]! : filler(rng));

/** An opener pairs with the first later closer of the same type on the same row, with no letters between. */
function findBrackets(rows: string[]): HackToken[] {
  const out: HackToken[] = [];
  rows.forEach((s, r) => {
    for (let i = 0; i < s.length; i++) {
      const k = OPEN.indexOf(s[i]!);
      if (k < 0) continue;
      for (let j = i + 1; j < s.length; j++) {
        if (isLetter(s[j]!)) break;
        if (s[j] === CLOSE[k]) {
          out.push({ kind: 'bracket', row: r, start: i, end: j + 1, text: s.slice(i, j + 1), removed: false });
          break;
        }
      }
    }
  });
  return out;
}

export class HackingSession {
  selected: number | null = null;
  finished = false;
  success = false;
  flawless = false;
  readonly tried = new Map<string, number>();
  attempts: number;
  /** Lines for the console box (newest last). */
  log: string[] = [];

  private constructor(
    readonly level: number,
    readonly password: string,
    readonly maxAttempts: number,
    readonly rows: string[],
    readonly tokens: HackToken[],
    private rng: Rng,
  ) {
    this.attempts = maxAttempts;
  }

  get typeName(): string {
    return TERMINAL_NAMES[this.level - 1]!;
  }

  static generate(level: number, rng: Rng, attempts = 4): HackingSession {
    const lv = Math.min(7, Math.max(1, level));
    const length = lv + 3;
    const pool = rng.shuffle([...POOL[length]!]);
    const password = pool.pop()!;
    const need = Math.min(18, Math.max(5, 9 + 2 * lv));
    const close = pool.filter((w) => likenessOf(w, password) > 0);
    const far = pool.filter((w) => likenessOf(w, password) === 0);
    const chosen: string[] = close.slice(0, Math.ceil(need * 0.6));
    for (const w of [...far, ...close.slice(chosen.length)]) {
      if (chosen.length >= need) break;
      chosen.push(w);
    }
    const words = rng.shuffle([...chosen, password]);

    const grid: string[][] = Array.from({ length: ROW_COUNT }, () => Array.from({ length: ROW_WIDTH }, () => junk(rng)));
    const order = rng.shuffle(Array.from({ length: ROW_COUNT }, (_, i) => i));
    const tokens: HackToken[] = [];
    words.forEach((w, i) => {
      const r = order[i]!;
      const s = rng.int(ROW_WIDTH - w.length + 1);
      for (let k = 0; k < w.length; k++) grid[r]![s + k] = w[k]!;
      tokens.push({ kind: 'word', row: r, start: s, end: s + w.length, text: w, removed: false });
    });

    const asRows = (): string[] => grid.map((r) => r.join(''));
    let pairs = findBrackets(asRows());
    for (let tries = 0; pairs.length < 6 && tries < 120; tries++) {
      const r = rng.int(ROW_COUNT);
      const c = rng.int(ROW_WIDTH - 3);
      if ([0, 1, 2, 3].some((k) => isLetter(grid[r]![c + k]!))) continue;
      const k = rng.int(4);
      grid[r]![c] = OPEN[k]!;
      grid[r]![c + 1] = filler(rng);
      grid[r]![c + 2] = filler(rng);
      grid[r]![c + 3] = CLOSE[k]!;
      pairs = findBrackets(asRows());
    }
    tokens.push(...pairs);
    // one more attempt less on the hardest terminals, like the original
    return new HackingSession(lv, password, Math.max(3, attempts - (lv >= 6 ? 1 : 0)), asRows(), tokens, rng);
  }

  likeness(guess: string): number {
    return likenessOf(guess, this.password);
  }

  /** Words win over brackets; among brackets the shortest span wins; a word one cell away counts (finger slop). */
  tokenAt(r: number, c: number): number | null {
    let best: number | null = null;
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (t.removed || t.row !== r || c < t.start || c >= t.end) continue;
      if (t.kind === 'word') return i;
      if (best === null || t.end - t.start < this.tokens[best]!.end - this.tokens[best]!.start) best = i;
    }
    if (best !== null) return best;
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (t.kind === 'word' && !t.removed && t.row === r && c >= t.start - 1 && c <= t.end) return i;
    }
    return null;
  }

  /** Replace a token's characters with dots (used exploits, removed words). */
  removeToken(i: number): void {
    const t = this.tokens[i]!;
    t.removed = true;
    this.rows[t.row] = this.rows[t.row]!.slice(0, t.start) + '.'.repeat(t.end - t.start) + this.rows[t.row]!.slice(t.end);
    if (t.kind === 'bracket') {
      for (const o of this.tokens) {
        if (!o.removed && o.kind === 'bracket' && o.row === t.row && o.start < t.end && t.start < o.end) o.removed = true;
      }
    }
    if (this.selected !== null && this.tokens[this.selected]!.removed) this.selected = null;
  }

  get dudIndexes(): number[] {
    return this.tokens.flatMap((t, i) => (t.kind === 'word' && !t.removed && t.text !== this.password ? [i] : []));
  }

  /** First tap highlights a token, a second tap on it enters it. Tapping noise clears the highlight. */
  tap(row: number, col: number): void {
    if (this.finished) return;
    const i = this.tokenAt(row, col);
    if (i === null) {
      this.selected = null;
      return;
    }
    if (this.selected === i) {
      this.selected = null;
      if (this.tokens[i]!.kind === 'word') this.guess(i);
      else this.bracket(i);
    } else this.selected = i;
  }

  private guess(i: number): void {
    const word = this.tokens[i]!.text;
    this.log.push(`> PASSWORD SELECTED: ${word}`);
    if (word === this.password) {
      this.finished = true;
      this.success = true;
      this.flawless = this.tried.size === 0;
      this.log.push('> ACCESS GRANTED');
      return;
    }
    const m = this.likeness(word);
    this.tried.set(word, m);
    this.attempts--;
    this.removeToken(i);
    this.log.push(`MATCHING CHARACTERS: ${m}/${word.length}`);
    this.log.push(`> ENTRY DENIED. ATTEMPTS LEFT: ${this.attempts}`);
    if (this.attempts <= 0) {
      this.finished = true;
      this.log.push('> TERMINAL LOCKED. LOCKED OUT.');
    }
  }

  private bracket(i: number): void {
    const t = this.tokens[i]!;
    const shown = this.rows[t.row]!.slice(t.start, t.end);
    this.removeToken(i);
    this.log.push(`> EXPLOIT RUN: ${shown}`);
    const duds = this.dudIndexes;
    const options = [...(duds.length ? [0] : []), ...(this.attempts < this.maxAttempts ? [1] : [])];
    if (!options.length) {
      this.log.push('> NO EFFECT');
      return;
    }
    if (options[this.rng.int(options.length)] === 0) {
      this.removeToken(duds[this.rng.int(duds.length)]!);
      this.log.push('> DUD REMOVED');
    } else {
      this.attempts = this.maxAttempts;
      this.log.push('> ATTEMPTS RESTORED');
    }
  }
}

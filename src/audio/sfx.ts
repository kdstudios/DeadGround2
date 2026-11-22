/**
 * Tiny synthesized sound effects (Web Audio, no asset files). Nothing plays until the first user gesture
 * (browser rule); a mute switch is stored in localStorage.
 */
const KEY = 'deadground.sound';

export type Sfx =
  | 'click' | 'step' | 'pickup' | 'rescue' | 'hurt' | 'shield' | 'mine' | 'shoot' | 'zombie' | 'door' | 'bomb' | 'win' | 'lose'
  | 'snap' | 'deny' | 'confirm' | 'tick' | 'alarm'
  | 'arrow' | 'hit' | 'kill' | 'gateHit' | 'gateBreak' | 'repair' | 'coreHit' | 'upgrade'
  | 'levelup' | 'achievement' | 'claim';

class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = localStorage.getItem(KEY) === '0';
  private last = new Map<string, number>();

  setMuted(m: boolean): void {
    this.muted = m;
    localStorage.setItem(KEY, m ? '0' : '1');
  }

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0): void {
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, lowpass = 2000, delay = 0): void {
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime + delay;
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = c.createBufferSource();
    s.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lowpass;
    const g = c.createGain();
    g.gain.value = vol;
    s.connect(f).connect(g).connect(this.master!);
    s.start(t);
  }

  play(name: Sfx): void {
    if (this.muted) return;
    // rate-limit rapid repeats so a busy night is not a wall of noise
    const now = performance.now();
    if (now - (this.last.get(name) ?? 0) < 70) return;
    this.last.set(name, now);
    switch (name) {
      case 'click': return this.tone(520, 0.06, 'square', 0.12);
      case 'step': return this.noise(0.04, 0.05, 700);
      case 'pickup': this.tone(660, 0.08, 'triangle', 0.25); return this.tone(990, 0.12, 'triangle', 0.25, undefined, 0.07);
      case 'rescue': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.28, undefined, i * 0.1)); return;
      case 'hurt': this.tone(200, 0.25, 'sawtooth', 0.3, 70); return this.noise(0.15, 0.2, 900);
      case 'shield': return this.tone(900, 0.2, 'sine', 0.3, 300);
      case 'mine': this.noise(0.5, 0.7, 1200); return this.tone(90, 0.4, 'sine', 0.5, 35);
      case 'bomb': this.noise(0.6, 0.8, 1500); return this.tone(70, 0.5, 'sine', 0.6, 30);
      case 'shoot': this.noise(0.1, 0.35, 3000); return this.tone(300, 0.1, 'square', 0.15, 120);
      case 'zombie': return this.tone(140, 0.3, 'sawtooth', 0.15, 80);
      case 'door': this.noise(0.18, 0.4, 500); return this.tone(110, 0.15, 'square', 0.2, 60);
      case 'win': [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.3, undefined, i * 0.14)); return;
      case 'lose': [330, 262, 196, 131].forEach((f, i) => this.tone(f, 0.35, 'sawtooth', 0.22, undefined, i * 0.2)); return;
      case 'snap': this.noise(0.12, 0.5, 5000); return this.tone(1800, 0.12, 'square', 0.25, 400);
      case 'deny': return this.tone(180, 0.22, 'sawtooth', 0.28, 110);
      case 'confirm': this.tone(740, 0.1, 'triangle', 0.3); return this.tone(1100, 0.18, 'triangle', 0.3, undefined, 0.09);
      case 'tick': return this.tone(1400, 0.025, 'square', 0.08);
      case 'alarm': [0, 0.28, 0.56].forEach((d) => this.tone(520, 0.2, 'square', 0.25, 380, d)); return;
      case 'arrow': this.noise(0.07, 0.12, 4000); return this.tone(900, 0.07, 'triangle', 0.08, 400);
      case 'hit': return this.tone(180, 0.07, 'square', 0.18, 90);
      case 'kill': this.tone(150, 0.2, 'sawtooth', 0.2, 50); return this.noise(0.1, 0.15, 800);
      case 'gateHit': return this.noise(0.1, 0.3, 600);
      case 'gateBreak': this.noise(0.45, 0.6, 900); return this.tone(80, 0.3, 'square', 0.3, 40);
      case 'repair': this.tone(420, 0.06, 'square', 0.18); return this.tone(560, 0.06, 'square', 0.18, undefined, 0.08);
      case 'coreHit': return this.tone(120, 0.25, 'sawtooth', 0.28, 60);
      case 'levelup': [392, 494, 587, 784, 988].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.28, undefined, i * 0.09)); return;
      case 'achievement': this.tone(660, 0.12, 'triangle', 0.26); return this.tone(880, 0.22, 'triangle', 0.26, undefined, 0.1);
      case 'claim': this.tone(500, 0.07, 'square', 0.16); return this.tone(750, 0.12, 'triangle', 0.26, undefined, 0.07);
      case 'upgrade': [440, 554, 659].forEach((f, i) => this.tone(f, 0.15, 'triangle', 0.25, undefined, i * 0.09)); return;
    }
  }
}

export const sfx = new Audio();

import { CONFIG } from '../core/config.js';
import type { Level } from '../core/level.js';
import type { MessageKey } from '../core/types.js';

const MESSAGES: Record<MessageKey, string> = {
  needAmmo: 'You need ammunition to shoot that zombie.',
  needKey: 'Locked. You need a key.',
  needCrowbar: 'Boarded up. You need a crowbar.',
  needExplosive: 'Cracked wall. Use an explosive.',
  noPath: "Can't get there from here.",
  knownHazard: "That's a known hazard.",
  flagged: 'Flagged tile. Hold it (or right-click) to remove the flag.',
  noneLeft: 'None left.',
  vaultLocked: 'The lock is jammed for good. Nothing more to do here.',
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
};

export class Hud {
  private root = $('hud');
  private hearts = $('hearts');
  private cache = new Map<string, string>();
  private toastTimer = 0;

  show(show: boolean): void {
    this.root.hidden = !show;
  }

  setLevelName(name: string): void {
    $('level-name').textContent = name;
  }

  toastMessage(key: MessageKey): void {
    this.toast(MESSAGES[key]);
  }

  toast(text: string, ms = 2200): void {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
  }

  private set(id: string, value: string | number): void {
    const v = String(value);
    if (this.cache.get(id) === v) return;
    this.cache.set(id, v);
    $(id).textContent = v;
  }

  update(level: Level, flagMode: boolean): void {
    const heartsKey = `${level.hearts}`;
    if (this.cache.get('hearts') !== heartsKey) {
      this.cache.set('hearts', heartsKey);
      this.hearts.innerHTML = '';
      for (let i = 0; i < CONFIG.maxHearts; i++) {
        const img = document.createElement('img');
        img.src = 'assets/sprites/ui_heart.png';
        img.alt = '';
        if (i >= level.hearts) img.className = 'empty';
        this.hearts.appendChild(img);
      }
    }
    this.set('shield', level.shield);
    this.set('keys', level.inventory.key);
    this.set('ammo', level.inventory.ammo);
    this.set('crowbar', level.inventory.crowbar);
    this.set('bomb', level.inventory.explosive);
    this.set('map', level.inventory.map);
    this.set('loot-scrap', level.loot.scrap);
    this.set('loot-food', level.loot.food);
    this.set('loot-materials', level.loot.materials);

    $('slot-crowbar').classList.toggle('empty', level.inventory.crowbar === 0);
    $('slot-bomb').classList.toggle('empty', level.inventory.explosive === 0);
    $('slot-map').classList.toggle('empty', level.inventory.map === 0);
    $('slot-bomb').classList.toggle('active', level.pending?.item === 'explosive');
    $('slot-map').classList.toggle('active', level.pending?.item === 'map');
    $('slot-flag').classList.toggle('flagon', flagMode);
  }
}

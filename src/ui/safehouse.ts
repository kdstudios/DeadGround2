import {
  CRAFT,
  EXPEDITION_COST,
  FACILITIES,
  KIT_CAP,
  ROLES,
  STAMINA_PER_DAY,
  canAfford,
  craftCost,
  foodNeeded,
  gardenYield,
  storageCap,
  upgradeCost,
  type BaseState,
  type Cost,
  type CraftItem,
  type Facility,
} from '../core/base.js';

export interface SafehouseActions {
  expedition(): void;
  sleep(): void;
  upgrade(f: Facility): void;
  craft(item: CraftItem): void;
  menu(): void;
  /** Show the first-run tips banner. */
  tips: boolean;
  hideTips(): void;
}

const icon = (n: string): string => `<img src="assets/sprites/${n}.png" alt="">`;
const costText = (c: Cost): string =>
  (Object.entries(c) as [string, number][]).map(([k, v]) => `${v} ${k}`).join(' + ');

/** Re-render the safehouse hub from the saved state. */
export function renderSafehouse(root: HTMLElement, s: BaseState, act: SafehouseActions): void {
  const cap = storageCap(s.facilities.storage);
  const need = foodNeeded(s);
  const nights = need > 0 ? Math.floor((s.stock.food + gardenYield(s.facilities.garden)) / need) : 0;
  const pips = Array.from({ length: STAMINA_PER_DAY }, (_, i) => `<i class="${i < s.stamina ? 'on' : ''}"></i>`).join('');
  const cheapest = Math.min(...Object.values(EXPEDITION_COST));

  const facilityCards = (Object.keys(FACILITIES) as Facility[])
    .map((f) => {
      const d = FACILITIES[f];
      const lvl = s.facilities[f];
      const maxed = lvl >= d.max;
      const cost = upgradeCost(s, f);
      const ok = !maxed && canAfford(s, cost);
      const verb = f === 'workshop' && lvl === 0 ? 'Build' : 'Upgrade';
      return `<div class="fac">
        <div class="fac-h"><b>${d.label}</b><span class="lvl">${lvl === 0 && f !== 'workshop' ? 'Lv 0' : 'Lv ' + lvl}</span></div>
        <div class="fac-b">${d.blurb}</div>
        <div class="fac-n">${d.levelNote(lvl)}</div>
        <button class="act" data-up="${f}" ${ok ? '' : 'disabled'}>${maxed ? 'Maxed' : `${verb} · ${costText(cost)}`}</button>
      </div>`;
    })
    .join('');

  const workshop =
    s.facilities.workshop < 1
      ? `<p class="dim">Build the Workshop to craft supplies for your next expedition.</p>`
      : `<div class="craft">${(Object.keys(CRAFT) as CraftItem[])
          .map((k) => {
            const cost = craftCost(s, k);
            const limit = k === 'shield' ? 3 : KIT_CAP;
            const ok = canAfford(s, cost) && s.kit[k] < limit;
            return `<button class="act" data-craft="${k}" ${ok ? '' : 'disabled'}>${icon('item_' + k)}<span>${CRAFT[k].label}<small>${costText(cost)}</small></span></button>`;
          })
          .join('')}</div>`;

  const survivors = s.survivors.length
    ? s.survivors.map((v) => `<li><b>${v.name}</b> · ${ROLES[v.role].label}<small>${ROLES[v.role].perk}</small></li>`).join('')
    : `<li class="dim">No survivors yet. Rescue them from buildings on Scouting and Risky expeditions.</li>`;

  root.innerHTML = `
  <div class="sh-wrap">
    <div class="sh-top">
      <button class="chip" id="sh-menu">&#9776; Menu</button>
      <h2>Safehouse &middot; Day ${s.day}</h2>
      <div class="stam" title="Stamina: ${s.stamina} / ${STAMINA_PER_DAY}"><span>Stamina</span>${pips}</div>
    </div>
    ${act.tips ? `<div class="tipbox"><b>How the safehouse works</b>
      <ul><li>Each day you have <b>stamina</b>: Safe costs 1, Scouting 2, Risky 3. Harder runs pay more.</li>
      <li>Escape with loot to bank it; die and you lose what you found. Rescue survivors for passive perks.</li>
      <li>When stamina is spent (or you choose), <b>night falls</b>: defend the safehouse with arrows. Everyone eats 1 food.</li>
      <li>Spend scrap and materials on facilities. Armoury, Watchtower and Barricades make nights easier.</li></ul>
      <button class="act" id="sh-tips-ok">Got it</button></div>` : ''}
    <div class="sh-res">
      <div class="stat">${icon('item_scrap')}<span>${s.stock.scrap}<em>/${cap}</em></span></div>
      <div class="stat">${icon('item_food')}<span>${s.stock.food}<em>/${cap}</em></span></div>
      <div class="stat">${icon('item_materials')}<span>${s.stock.materials}<em>/${cap}</em></span></div>
      <div class="kit" title="Packed for the next expedition">
        ${(['ammo', 'explosive', 'shield', 'map'] as const).map((k) => `<span>${icon('item_' + k)}${s.kit[k]}</span>`).join('')}
      </div>
    </div>
    <p class="food-note ${nights < 1 ? 'warn' : ''}">Tonight everyone eats ${need} food (you + ${s.survivors.length} survivor${s.survivors.length === 1 ? '' : 's'}). Food lasts about ${nights} night${nights === 1 ? '' : 's'}.</p>
    <div class="sh-main">
      <section><h3>Survivors</h3><ul class="surv">${survivors}</ul></section>
      <section><h3>Workshop</h3>${workshop}</section>
    </div>
    <h3>Facilities</h3>
    <div class="facs">${facilityCards}</div>
    <div class="sh-go">
      <button class="big" id="sh-exp" ${s.stamina >= cheapest ? '' : 'disabled'}>Go on an expedition</button>
      <button class="big ghost" id="sh-sleep">${s.stamina >= cheapest ? 'Rest until night' : 'Night falls — sleep'}</button>
    </div>
  </div>`;

  root.querySelector('#sh-tips-ok')?.addEventListener('click', act.hideTips);
  root.querySelector('#sh-exp')!.addEventListener('click', act.expedition);
  root.querySelector('#sh-sleep')!.addEventListener('click', act.sleep);
  root.querySelector('#sh-menu')!.addEventListener('click', act.menu);
  root.querySelectorAll<HTMLElement>('[data-up]').forEach((b) => b.addEventListener('click', () => act.upgrade(b.dataset.up as Facility)));
  root.querySelectorAll<HTMLElement>('[data-craft]').forEach((b) => b.addEventListener('click', () => act.craft(b.dataset.craft as CraftItem)));
}

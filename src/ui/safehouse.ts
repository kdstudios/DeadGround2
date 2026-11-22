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
import { facilityIcon } from './art.js';

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
const RES_ICON: Record<string, string> = { scrap: 'item_scrap', food: 'item_food', materials: 'item_materials' };
/** A price as little resource icons with numbers, e.g. [scrap] 6 [materials] 4. */
const costHtml = (c: Cost): string =>
  (Object.entries(c) as [string, number][]).map(([k, v]) => `<span class="cost" title="${k}">${icon(RES_ICON[k] ?? 'item_scrap')}${v}</span>`).join('');

const LINES: [string, string][] = [
  ["Tremble, but work through it. We'll make it.", 'Your safehouse is a place to recover, plan and prepare for what’s next.'],
  ['Check the walls before you check the horizon.', 'Everything out there wants in. Everything in here is worth keeping.'],
  ['Scrap today, walls tomorrow.', 'Every piece you bring home is one less gap in the barricade.'],
  ['Stay quiet. Stay fed. Stay alive.', 'The wasteland rewards the careful and buries the brave.'],
  ['Read the numbers twice.', 'A clue is only as good as the nerve it takes to trust it.'],
];

/** The survivor's line under the header: reacts to the state of the base, otherwise rotates by day. */
function advice(s: BaseState, nights: number, canGo: boolean): [string, string] {
  if (nights < 1) return ["We’re almost out of food.", 'Bring some home or the hungry will leave in the dark. Keep the garden growing.'];
  if (!canGo) return ['Nothing left in the tank.', 'Rest until night. The barricades need us more than the wasteland does today.'];
  if (s.survivors.length === 0 && s.day > 2) return ['It’s quiet. Too quiet.', 'Buildings on Scouting and Risky runs hide survivors who need rescuing.'];
  return LINES[(s.day - 1) % LINES.length]!;
}

/** Re-render the safehouse hub from the saved state. */
export function renderSafehouse(root: HTMLElement, s: BaseState, act: SafehouseActions): void {
  const cap = storageCap(s.facilities.storage);
  const need = foodNeeded(s);
  const nights = need > 0 ? Math.floor((s.stock.food + gardenYield(s.facilities.garden)) / need) : 0;
  const cheapest = Math.min(...Object.values(EXPEDITION_COST));
  const canGo = s.stamina >= cheapest;
  const pips = Array.from({ length: STAMINA_PER_DAY }, (_, i) => `<i class="${i < s.stamina ? (s.stamina <= 2 ? 'low' : 'on') : ''}"></i>`).join('');
  const [line, sub] = advice(s, nights, canGo);

  const facilityCards = (Object.keys(FACILITIES) as Facility[])
    .map((f) => {
      const d = FACILITIES[f];
      const lvl = s.facilities[f];
      const maxed = lvl >= d.max;
      const cost = upgradeCost(s, f);
      const ok = !maxed && canAfford(s, cost);
      const verb = f === 'workshop' && lvl === 0 ? 'Build' : 'Upgrade';
      return `<div class="fac">
        <div class="fac-ico"><img src="${facilityIcon(f)}" alt=""></div>
        <div class="fac-info">
          <div class="fac-h"><b>${d.label}</b><span class="lvl">Lv ${lvl}</span></div>
          <div class="fac-b">${d.blurb}</div>
          <div class="fac-n">${d.levelNote(lvl)}</div>
        </div>
        <button class="act" data-up="${f}" ${ok ? '' : 'disabled'}>${maxed ? 'Maxed' : `${verb} ${costHtml(cost)}`}</button>
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
            return `<button class="act" data-craft="${k}" ${ok ? '' : 'disabled'}>${icon('item_' + k)}<span>${CRAFT[k].label}<small>${costHtml(cost)}</small></span></button>`;
          })
          .join('')}</div>`;

  const survivors = s.survivors.length
    ? s.survivors.map((v) => `<li><b>${v.name}</b> &middot; ${ROLES[v.role].label}<small>${ROLES[v.role].perk}</small></li>`).join('')
    : `<li><span class="dim" style="margin:0">No survivors yet. Rescue them from buildings on Scouting and Risky expeditions.</span></li>`;

  const resChip = (k: 'scrap' | 'food' | 'materials', label: string): string =>
    `<div class="res ${s.stock[k] >= cap ? 'full' : ''}" title="${label}">${icon('item_' + k)}<b>${s.stock[k]}</b><em>/${cap}</em><span class="res-l">${label}</span></div>`;

  root.innerHTML = `
  <div class="sh">
    <aside class="sh-left"><img class="lantern" src="assets/ui/lantern.png" alt=""><div class="banner-wrap"><img class="banner" src="assets/ui/banner.png" alt=""></div></aside>

    <header class="hdr">
      <i class="hdr-l"></i>
      <div class="hdr-m">
        <div class="hdr-t"><h2>Safehouse</h2><p>Day <b>${s.day}</b> &middot; Stay safe, survivor.</p></div>
        <div class="stam" title="Stamina: ${s.stamina} / ${STAMINA_PER_DAY}"><span>Stamina</span>${pips}</div>
        <button class="chip menu-btn" id="sh-menu" aria-label="Menu" title="Menu">Menu</button>
      </div>
      <i class="hdr-r"></i>
    </header>

    <div class="sh-res">${resChip('scrap', 'Scrap')}${resChip('food', 'Food')}${resChip('materials', 'Materials')}</div>

    <aside class="sh-brief">
      <div class="side plate">
        <h3 class="plate-h">Daily brief</h3>
        <div class="brief-rows">
          <div class="brief-row"><span>Stamina</span><b>${s.stamina} / ${STAMINA_PER_DAY}</b></div>
          <div class="brief-row ${nights < 1 ? 'warn' : ''}"><span>Tonight everyone eats</span><b>${need} food</b></div>
          <div class="brief-row ${nights < 1 ? 'warn' : ''}"><span>Food lasts about</span><b>${nights} night${nights === 1 ? '' : 's'}</b></div>
          <div class="brief-row"><span>Safehouse</span><b>${1 + s.survivors.length} survivor${s.survivors.length ? 's' : ''}</b></div>
          <div class="brief-h">Packed for next expedition</div>
          <div class="kit" title="Packed for the next expedition">
            ${(['ammo', 'explosive', 'shield', 'map'] as const).map((k) => `<span title="${k}">${icon('item_' + k)}<b>${s.kit[k]}</b></span>`).join('')}
          </div>
        </div>
      </div>
      <img class="radio" src="assets/ui/radio.png" alt="">
    </aside>

    <div class="sh-note">
      <div class="strip"><b>${line}</b><i>${sub}</i></div>
      ${act.tips ? `<div class="paper tipbox"><b>How the safehouse works</b>
        <ul><li>Each day you have <b>stamina</b>: Safe costs 1, Scouting 2, Risky 3. Harder runs pay more.</li>
        <li>Escape with loot to bank it; die and you lose what you found. Rescue survivors for passive perks.</li>
        <li>When stamina is spent (or you choose), <b>night falls</b>: defend the safehouse with arrows. Everyone eats 1 food.</li>
        <li>Spend scrap and materials on facilities. Armoury, Watchtower and Barricades make nights easier.</li></ul>
        <button class="act" id="sh-tips-ok">Got it</button></div>` : ''}
    </div>

    <div class="sh-main">
      <div class="sh-cols">
        <section class="plate blk"><h3>Survivors <small>${s.survivors.length}</small></h3><ul class="surv">${survivors}</ul></section>
        <section class="plate blk"><h3>Workshop</h3>${workshop}</section>
      </div>
      <h3 class="sec">Facilities</h3>
      <div class="facs">${facilityCards}</div>
      <div class="sh-go">
        <button class="cta" id="sh-exp" ${canGo ? '' : 'disabled'}><span><span class="cta-t">Go on an expedition</span><small>Risk it all for valuable supplies.</small></span></button>
        <button class="pill-btn" id="sh-sleep">${canGo ? 'Rest until night' : 'Night falls — sleep'}</button>
      </div>
    </div>
  </div>`;

  root.querySelector('#sh-tips-ok')?.addEventListener('click', act.hideTips);
  root.querySelector('#sh-exp')!.addEventListener('click', act.expedition);
  root.querySelector('#sh-sleep')!.addEventListener('click', act.sleep);
  root.querySelector('#sh-menu')!.addEventListener('click', act.menu);
  root.querySelectorAll<HTMLElement>('[data-up]').forEach((b) => b.addEventListener('click', () => act.upgrade(b.dataset.up as Facility)));
  root.querySelectorAll<HTMLElement>('[data-craft]').forEach((b) => b.addEventListener('click', () => act.craft(b.dataset.craft as CraftItem)));
}

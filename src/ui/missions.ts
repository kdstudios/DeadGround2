import { formatCountdown } from '../progress/time.js';
import type { ProgressionService, MissionView } from '../progress/service.js';
import type { MissionCategory, Reward } from '../progress/types.js';

export interface MissionsActions {
  tab: MissionCategory;
  setTab(c: MissionCategory): void;
  claim(id: string): void;
  back(): void;
}

const TABS: { id: MissionCategory; label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'campaign', label: 'Campaign' },
];

const icon = (n: string): string => `<img src="assets/sprites/${n}.png" alt="">`;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function rewardHtml(r: Reward): string {
  const bits: string[] = [];
  if (r.xp) bits.push(`<span class="rw xp"><b>${r.xp}</b> XP</span>`);
  if (r.scrap) bits.push(`<span class="rw">${icon('item_scrap')}${r.scrap}</span>`);
  if (r.food) bits.push(`<span class="rw">${icon('item_food')}${r.food}</span>`);
  if (r.materials) bits.push(`<span class="rw">${icon('item_materials')}${r.materials}</span>`);
  return bits.join('');
}

export const barHtml = (value: number, max: number, cls = ''): string => {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<div class="bar ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${value}"><i style="width:${pct}%"></i></div>`;
};

function card(m: MissionView): string {
  const state = m.claimed ? 'claimed' : m.done && m.unlocked ? 'ready' : !m.unlocked ? 'locked' : 'open';
  const tag = state === 'claimed' ? 'Complete' : state === 'ready' ? 'Ready' : state === 'locked' ? 'Locked' : 'Active';
  const action =
    state === 'ready'
      ? `<button class="act claim" data-claim="${m.def.id}">Claim reward</button>`
      : state === 'claimed'
        ? `<button class="act" disabled>Claimed</button>`
        : `<button class="act" disabled>${state === 'locked' ? 'Locked' : 'In progress'}</button>`;
  return `<article class="mis ${state}" data-mission="${m.def.id}">
    <header><h4>${esc(m.def.name)}</h4><span class="tag">${tag}</span></header>
    <p>${esc(m.def.desc)}</p>
    ${state === 'locked' ? `<p class="lock">${esc(m.lockedReason ?? 'Locked')}</p>` : `${barHtml(m.progress, m.target, state === 'claimed' || state === 'ready' ? 'full' : '')}<div class="bar-n">${m.progress} / ${m.target}</div>`}
    <footer><div class="rws" title="Reward">${rewardHtml(m.def.reward)}</div>${action}</footer>
  </article>`;
}

export function renderMissions(root: HTMLElement, svc: ProgressionService, act: MissionsActions): void {
  const list = svc.missions(act.tab);
  const lvl = svc.level();
  const reset =
    act.tab === 'daily' ? `New orders in ${formatCountdown(svc.msToDailyReset())}` : act.tab === 'weekly' ? `New orders in ${formatCountdown(svc.msToWeeklyReset())}` : 'Permanent objectives: they never reset';
  const readyBy = (c: MissionCategory): number => svc.missions(c).filter((m) => m.done && !m.claimed && m.unlocked).length;
  const doneN = list.filter((m) => m.claimed).length;

  root.innerHTML = `
  <div class="ops">
    <header class="hdr">
      <i class="hdr-l"></i><i class="hdr-badge"></i>
      <div class="hdr-m">
        <div class="hdr-t"><h2>Operations</h2><p>Operator level <b>${lvl.level}</b> &middot; ${svc.unclaimed()} reward${svc.unclaimed() === 1 ? '' : 's'} waiting</p></div>
        <button class="chip back-btn" id="ops-back">Back</button>
      </div>
      <i class="hdr-r"></i>
    </header>
    <div class="regs ops-tabs" role="tablist">
      ${TABS.map((t) => `<button class="reg ${t.id === act.tab ? 'on' : ''}" role="tab" aria-selected="${t.id === act.tab}" data-tab="${t.id}">${t.label}${readyBy(t.id) ? ` <em class="pip">${readyBy(t.id)}</em>` : ''}</button>`).join('')}
    </div>
    <div class="ops-meta"><span>${reset}</span><span>${doneN} / ${list.length} complete</span></div>
    <div class="mis-list">${list.map(card).join('')}</div>
  </div>`;

  root.querySelector('#ops-back')!.addEventListener('click', act.back);
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => act.setTab(b.dataset.tab as MissionCategory)));
  root.querySelectorAll<HTMLElement>('[data-claim]').forEach((b) => b.addEventListener('click', () => act.claim(b.dataset.claim!)));
}

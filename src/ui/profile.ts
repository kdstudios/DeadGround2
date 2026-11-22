import type { ProgressionService } from '../progress/service.js';
import { barHtml, rewardHtml } from './missions.js';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const n = (x: number): string => x.toLocaleString('en-GB');

const CATEGORY_LABEL = { combat: 'Combat', exploration: 'Exploration', base: 'Safehouse', survival: 'Survival' } as const;

export function renderProfile(root: HTMLElement, svc: ProgressionService, back: () => void): void {
  const p = svc.profile();
  const lv = p.level;
  const s = p.stats;
  const rate = p.successRate === null ? '—' : `${Math.round(p.successRate * 100)}%`;
  const xpLine = lv.maxed ? `Maximum level reached &middot; ${n(lv.total)} XP` : `${n(lv.into)} / ${n(lv.need)} XP to level ${lv.level + 1} &middot; ${n(lv.total)} total`;
  const rows: [string, string][] = [
    ['Expeditions', n(s.expeditions)],
    ['Successful escapes', n(s.escapes)],
    ['Failed expeditions', n(s.failures)],
    ['Success rate', rate],
    ['Zombies killed', n(s.zombies)],
    ['Survivors rescued', n(s.survivors)],
    ['Vaults opened', n(s.vaults)],
    ['Nights survived', n(s.nights)],
    ['Night defences won', n(s.defences)],
    ['Facilities upgraded', n(s.upgrades)],
    ['Scrap recovered', n(s.scrap)],
    ['Days survived', n(p.daysSurvived)],
    ['Missions completed', n(p.missionsCompleted)],
    ['Achievements', `${p.achievementsDone} / ${p.achievementsTotal} (${p.achievementPct}%)`],
  ];
  const ach = svc.achievements();
  root.innerHTML = `
  <div class="ops">
    <header class="hdr">
      <i class="hdr-l"></i><i class="hdr-badge"></i>
      <div class="hdr-m">
        <div class="hdr-t"><h2>Operator profile</h2><p>Level <b>${lv.level}</b> &middot; Day <b>${p.day}</b> &middot; ${p.achievementPct}% of achievements</p></div>
        <button class="chip back-btn" id="pf-back">Back</button>
      </div>
      <i class="hdr-r"></i>
    </header>

    <section class="plate lvl-card">
      <div class="lvl-num" aria-label="Level ${lv.level}"><small>Level</small><b>${lv.level}</b></div>
      <div class="lvl-bar">
        ${barHtml(lv.into, Math.max(1, lv.need || lv.into || 1), 'xp' + (lv.maxed ? ' full' : ''))}
        <div class="bar-n">${xpLine}</div>
      </div>
    </section>

    <section class="plate blk">
      <h3>Service record</h3>
      <dl class="stat-grid">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    </section>

    <h3 class="sec">Achievements <small class="sec-n">${p.achievementsDone} / ${p.achievementsTotal}</small></h3>
    <div class="ach-list">${ach
      .map(
        (a) => `<article class="ach ${a.done ? 'done' : ''} ${a.unlocked ? '' : 'locked'}">
        <header><h4>${esc(a.def.name)}</h4><span class="tag">${a.done ? 'Done' : a.unlocked ? CATEGORY_LABEL[a.def.category] : 'Locked'}</span></header>
        <p>${esc(a.def.desc)}</p>
        ${a.unlocked ? `${barHtml(a.progress, a.target, a.done ? 'full' : '')}<div class="bar-n">${n(a.progress)} / ${n(a.target)}</div>` : `<p class="lock">${esc(a.lockedReason ?? 'Locked')}</p>`}
        <div class="rws" title="Reward">${rewardHtml(a.def.reward)}</div>
      </article>`,
      )
      .join('')}</div>
  </div>`;
  root.querySelector('#pf-back')!.addEventListener('click', back);
}

/**
 * Date-based reset logic for daily and weekly missions.
 *
 * Periods are whole UTC days (daily) and Monday-based UTC weeks (weekly). The "effective now" used for resets is
 * max(system clock, highest clock ever seen): setting the clock back never re-opens a finished day or week, and the
 * period index of a board only ever moves forward. Moving the clock *forward* can still bring the next set of missions
 * early (a purely local game cannot tell that apart from time passing); rewards are small XP, so the exploit is shallow.
 */
export const DAY_MS = 86_400_000;

export const dayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

/** Weeks start on Monday (the Unix epoch, day 0, was a Thursday). */
export const weekIndex = (ms: number): number => Math.floor((dayIndex(ms) + 3) / 7);

/** Milliseconds until the next UTC midnight / next Monday 00:00 UTC. */
export const msToNextDay = (ms: number): number => (dayIndex(ms) + 1) * DAY_MS - ms;
export const msToNextWeek = (ms: number): number => (weekIndex(ms) + 1) * 7 * DAY_MS - 3 * DAY_MS - ms;

export function formatCountdown(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

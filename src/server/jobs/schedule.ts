/**
 * Timezone-aware scheduling helpers built on Intl (no external tz database needed).
 * Wall-clock times are converted to UTC per occurrence, so schedules keep their
 * local time across daylight-saving transitions. A wall time that does not exist
 * (spring-forward gap) runs at the equivalent instant one hour later.
 */

export interface WeeklySchedule {
  /** "HH:MM", 24h, in the rule's timezone. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. Empty = every day. */
  weekdays?: number[];
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function wallClock(instant: Date, tz: string) {
  const parts = Object.fromEntries(fmt(tz).formatToParts(instant).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
}

/** Offset (ms) of `tz` from UTC at `instant`: local = utc + offset. */
export function tzOffset(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(instant.getTime() / 1000) * 1000;
}

export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = tzOffset(new Date(guess), tz);
  let result = guess - off1;
  const off2 = tzOffset(new Date(result), tz);
  if (off2 !== off1) result = guess - off2;
  return new Date(result);
}

export function computeNextRun(schedule: WeeklySchedule, tz: string, from: Date): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(schedule.time ?? '');
  if (!match) return null;
  const h = Number(match[1]);
  const mi = Number(match[2]);
  if (h > 23 || mi > 59) return null;
  const days = schedule.weekdays?.length ? new Set(schedule.weekdays) : null;
  const today = wallClock(from, tz);
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    if (days && !days.has(date.getUTCDay())) continue;
    const at = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, mi, tz);
    if (at.getTime() > from.getTime()) return at;
  }
  return null;
}

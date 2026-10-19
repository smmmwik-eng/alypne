import { differenceInCalendarDays, format, formatDistanceToNowStrict, isSameYear } from 'date-fns';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function relativeTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = Date.now() - d.getTime();
  if (diff < 45_000 && diff > -45_000) return 'just now';
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

export function shortDate(iso: string | Date | null | undefined, withTime = false): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const base = isSameYear(d, new Date()) ? 'MMM d' : 'MMM d, yyyy';
  return format(d, withTime ? `${base}, h:mm a` : base);
}

export function fullDate(iso: string | Date): string {
  return format(typeof iso === 'string' ? new Date(iso) : iso, "EEE, MMM d yyyy 'at' h:mm a");
}

export type DueState = 'none' | 'done' | 'overdue' | 'today' | 'soon' | 'later';
export function dueState(dueAt: string | null, completedAt: string | null): DueState {
  if (!dueAt) return 'none';
  if (completedAt) return 'done';
  const d = new Date(dueAt);
  if (d.getTime() < Date.now()) return 'overdue';
  const days = differenceInCalendarDays(d, new Date());
  if (days === 0) return 'today';
  if (days <= 2) return 'soon';
  return 'later';
}

/** <input type="datetime-local"> value in the browser's local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** Deterministic pleasant colour for avatars without images. */
export function colorFor(seed: string): string {
  const palette = ['#8b7cf6', '#38bdf8', '#34d399', '#fb923c', '#f472b6', '#facc15', '#2dd4bf', '#a3e635', '#e879f9', '#f87171'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export function pluralize(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';

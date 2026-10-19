import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BoardData, CardSummary } from '@/lib/types';
import { dueState } from '@/lib/format';

export interface BoardFilters {
  q: string;
  labels: string[];
  members: string[]; // user ids, or 'none' for unassigned
  due: '' | 'overdue' | 'today' | 'week' | 'none';
  priority: string[];
  type: '' | 'task' | 'bug';
  status: '' | 'open' | 'done';
  release: string;
  specialisation: string;
}

export const emptyFilters: BoardFilters = { q: '', labels: [], members: [], due: '', priority: [], type: '', status: '', release: '', specialisation: '' };

/** Filters live in the URL so filtered board links are shareable. */
export function useBoardFilters(): [BoardFilters, (f: Partial<BoardFilters>) => void, () => void, number] {
  const [params, setParams] = useSearchParams();
  const filters = useMemo<BoardFilters>(
    () => ({
      q: params.get('q') ?? '',
      labels: params.get('labels')?.split(',').filter(Boolean) ?? [],
      members: params.get('members')?.split(',').filter(Boolean) ?? [],
      due: (params.get('due') as BoardFilters['due']) ?? '',
      priority: params.get('priority')?.split(',').filter(Boolean) ?? [],
      type: (params.get('type') as BoardFilters['type']) ?? '',
      status: (params.get('status') as BoardFilters['status']) ?? '',
      release: params.get('release') ?? '',
      specialisation: params.get('spec') ?? '',
    }),
    [params],
  );
  const update = (f: Partial<BoardFilters>) => {
    const next = new URLSearchParams(params);
    const merged = { ...filters, ...f };
    const set = (k: string, v: string) => (v ? next.set(k, v) : next.delete(k));
    set('q', merged.q);
    set('labels', merged.labels.join(','));
    set('members', merged.members.join(','));
    set('due', merged.due);
    set('priority', merged.priority.join(','));
    set('type', merged.type);
    set('status', merged.status);
    set('release', merged.release);
    set('spec', merged.specialisation);
    setParams(next, { replace: true });
  };
  const clear = () => update(emptyFilters);
  const count = filters.labels.length + filters.members.length + filters.priority.length + (filters.q ? 1 : 0) + (filters.due ? 1 : 0) + (filters.type ? 1 : 0) + (filters.status ? 1 : 0) + (filters.release ? 1 : 0) + (filters.specialisation ? 1 : 0);
  return [filters, update, clear, count];
}

export function applyFilters(cards: CardSummary[], f: BoardFilters, specMembers?: Set<string>): CardSummary[] {
  const q = f.q.trim().toLowerCase();
  const weekEnd = Date.now() + 7 * 86400_000;
  return cards.filter((c) => {
    if (q && !c.title.toLowerCase().includes(q) && !String(c.number).includes(q.replace(/^\D+-/, ''))) return false;
    if (f.labels.length && !f.labels.some((l) => c.labelIds.includes(l))) return false;
    if (f.members.length) {
      const wantsNone = f.members.includes('none');
      const ok = f.members.some((m) => m !== 'none' && c.assigneeIds.includes(m)) || (wantsNone && c.assigneeIds.length === 0);
      if (!ok) return false;
    }
    if (f.priority.length && !f.priority.includes(c.priority)) return false;
    if (f.type && c.type !== f.type) return false;
    if (f.status === 'open' && c.completedAt) return false;
    if (f.status === 'done' && !c.completedAt) return false;
    if (f.release && c.releaseId !== f.release) return false;
    if (f.due) {
      const s = dueState(c.dueAt, c.completedAt);
      if (f.due === 'none' && c.dueAt) return false;
      if (f.due === 'overdue' && s !== 'overdue') return false;
      if (f.due === 'today' && s !== 'today') return false;
      if (f.due === 'week' && (!c.dueAt || c.completedAt || new Date(c.dueAt).getTime() > weekEnd)) return false;
    }
    if (specMembers && !c.assigneeIds.some((a) => specMembers.has(a))) return false;
    return true;
  });
}

export function cardKeyOf(board: BoardData['board'], c: { number: number }) {
  return `${board.key}-${c.number}`;
}

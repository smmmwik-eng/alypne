import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, errorMessage, ApiError } from '@/lib/api';
import type { BoardData, CardSummary, List } from '@/lib/types';
import { useToast } from '@/components/ui';

/**
 * Board mutations with optimistic cache updates. Each action snapshots the
 * cached board, applies the change locally, calls the API and rolls back
 * (with a toast) if the server rejects it.
 */
export function useBoardActions(boardId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMemo(() => {
    const key = ['board', boardId];
    const snapshot = () => qc.getQueryData<BoardData>(key);
    const set = (fn: (b: BoardData) => BoardData) => qc.setQueryData<BoardData>(key, (old) => (old ? fn(old) : old));
    const refresh = () => qc.invalidateQueries({ queryKey: key });
    async function run<T>(optimistic: ((b: BoardData) => BoardData) | null, call: () => Promise<T>, opts: { success?: string; refreshAfter?: boolean } = {}): Promise<T | undefined> {
      const prev = snapshot();
      if (optimistic) set(optimistic);
      try {
        const res = await call();
        if (opts.success) toast.success(opts.success);
        if (opts.refreshAfter !== false) refresh();
        return res;
      } catch (e) {
        if (prev) qc.setQueryData(key, prev);
        toast.error(e instanceof ApiError && e.status === 409 ? 'Someone else changed this at the same time. The board has been refreshed.' : errorMessage(e));
        refresh();
        return undefined;
      }
    }
    const patchCard = (id: string, patch: Partial<CardSummary>) => (b: BoardData) => ({ ...b, cards: b.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

    return {
      refresh,
      createCard: (listId: string, title: string, index?: number) =>
        run(
          (b) => {
            const temp: CardSummary = {
              id: `temp-${crypto.randomUUID()}`,
              boardId,
              listId,
              number: 0,
              type: 'task',
              title,
              position: Number.MAX_SAFE_INTEGER,
              priority: 'none',
              startAt: null,
              dueAt: null,
              completedAt: null,
              coverColor: null,
              coverAttachmentId: null,
              releaseId: null,
              milestoneId: null,
              archivedAt: null,
              createdById: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              version: 1,
              hasDescription: false,
              recurrence: null,
              labelIds: [],
              assigneeIds: [],
              checklist: { total: 0, done: 0 },
              commentCount: 0,
              attachmentCount: 0,
              voteCount: 0,
              blockedByCount: 0,
              customFields: {},
              bug: null,
            };
            return { ...b, cards: [...b.cards, temp] };
          },
          () => api.post<{ card: CardSummary }>('/cards', { boardId, listId, title, index }, { idempotent: true }),
        ),
      moveCard: (cardId: string, listId: string, index: number, ordered: CardSummary[]) =>
        run(
          (b) => {
            // `ordered` is the destination list after the drop; give cards ascending positions locally.
            const pos = new Map(ordered.map((c, i) => [c.id, i]));
            return { ...b, cards: b.cards.map((c) => (c.id === cardId ? { ...c, listId, position: pos.get(c.id) ?? c.position } : c.listId === listId && pos.has(c.id) ? { ...c, position: pos.get(c.id)! } : c)) };
          },
          () => api.post(`/cards/${cardId}/move`, { listId, index }),
        ),
      moveList: (listId: string, index: number, orderedIds: string[]) =>
        run(
          (b) => {
            const pos = new Map(orderedIds.map((id, i) => [id, i]));
            return { ...b, lists: [...b.lists].map((l) => ({ ...l, position: pos.get(l.id) ?? l.position })).sort((a, b2) => a.position - b2.position) };
          },
          () => api.post(`/lists/${listId}/move`, { index }),
        ),
      updateCard: (id: string, patch: Partial<CardSummary> & Record<string, unknown>) => run(patchCard(id, patch as Partial<CardSummary>), () => api.patch(`/cards/${id}`, patch)),
      toggleComplete: (c: CardSummary) => run(patchCard(c.id, { completedAt: c.completedAt ? null : new Date().toISOString() }), () => api.patch(`/cards/${c.id}`, { completed: !c.completedAt })),
      archiveCard: (id: string) => run((b) => ({ ...b, cards: b.cards.filter((c) => c.id !== id) }), () => api.post(`/cards/${id}/archive`, { archived: true })),
      toggleLabel: (c: CardSummary, labelId: string) => {
        const has = c.labelIds.includes(labelId);
        return run(patchCard(c.id, { labelIds: has ? c.labelIds.filter((l) => l !== labelId) : [...c.labelIds, labelId] }), () => (has ? api.del(`/cards/${c.id}/labels/${labelId}`) : api.post(`/cards/${c.id}/labels`, { labelId })));
      },
      toggleAssignee: (c: CardSummary, userId: string) => {
        const has = c.assigneeIds.includes(userId);
        return run(patchCard(c.id, { assigneeIds: has ? c.assigneeIds.filter((l) => l !== userId) : [...c.assigneeIds, userId] }), () => (has ? api.del(`/cards/${c.id}/assignees/${userId}`) : api.post(`/cards/${c.id}/assignees`, { userId })));
      },
      createList: (name: string) => run((b) => ({ ...b, lists: [...b.lists, { id: `temp-${crypto.randomUUID()}`, boardId, name, position: Number.MAX_SAFE_INTEGER, stageId: null, color: null, wipLimit: null, collapsed: false, archivedAt: null }] }), () => api.post(`/boards/${boardId}/lists`, { name })),
      updateList: (id: string, patch: Partial<List>) => run((b) => ({ ...b, lists: b.lists.map((l) => (l.id === id ? { ...l, ...patch } : l)) }), () => api.patch(`/lists/${id}`, patch)),
      archiveList: (id: string) => run((b) => ({ ...b, lists: b.lists.filter((l) => l.id !== id), cards: b.cards.filter((c) => c.listId !== id) }), () => api.post(`/lists/${id}/archive`, { archived: true }), { success: 'List archived' }),
      bulk: (cardIds: string[], action: Record<string, unknown>) =>
        run(null, () => api.post<{ succeeded: number; failed: number }>('/cards/bulk', { cardIds, action })).then((r) => {
          if (r) r.failed ? toast.error(`${r.succeeded} updated, ${r.failed} failed`) : toast.success(`${r.succeeded} card${r.succeeded === 1 ? '' : 's'} updated`);
          return r;
        }),
      run,
    };
  }, [boardId, qc, toast]);
}

export type BoardActions = ReturnType<typeof useBoardActions>;

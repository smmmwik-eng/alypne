import { useQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import type { BoardData, CardDetail, User, WorkspaceDetail, WorkspaceSummary } from './types';
import { useToast } from '@/components/ui';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null; mailConfigured: boolean; requireEmailVerification: boolean }>('/auth/me'),
    staleTime: 60_000,
  });
}

export function useWorkspaces(enabled = true) {
  return useQuery({ queryKey: ['workspaces'], queryFn: () => api.get<{ workspaces: WorkspaceSummary[] }>('/workspaces').then((r) => r.workspaces), enabled });
}

export function useWorkspace(id: string | undefined) {
  return useQuery({ queryKey: ['workspace', id], queryFn: () => api.get<WorkspaceDetail>(`/workspaces/${id}`), enabled: !!id });
}

export function useBoard(id: string | undefined) {
  return useQuery({ queryKey: ['board', id], queryFn: () => api.get<BoardData>(`/boards/${id}`), enabled: !!id, staleTime: 5_000 });
}

export function useCard(id: string | undefined) {
  return useQuery({ queryKey: ['card', id], queryFn: () => api.get<CardDetail>(`/cards/${id}`), enabled: !!id });
}

export function useUnreadCount(enabled: boolean) {
  return useQuery({ queryKey: ['notifications', 'count'], queryFn: () => api.get<{ unread: number }>('/notifications/unread-count').then((r) => r.unread), enabled, refetchInterval: 120_000 });
}

/**
 * Mutation helper with toast on error and query invalidation on success.
 * `optimistic` updates cached data immediately and rolls back on failure.
 */
export function useAction<TVars, TRes = any>(
  fn: (vars: TVars) => Promise<TRes>,
  opts: {
    invalidate?: QueryKey[] | ((vars: TVars, res: TRes) => QueryKey[]);
    success?: string | ((res: TRes, vars: TVars) => string | undefined);
    optimistic?: { key: QueryKey; update: (old: any, vars: TVars) => any };
    onSuccess?: (res: TRes, vars: TVars) => void;
    onError?: (e: unknown, vars: TVars) => void;
    silentError?: boolean;
  } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onMutate: async (vars: TVars) => {
      if (!opts.optimistic) return undefined;
      await qc.cancelQueries({ queryKey: opts.optimistic.key });
      const prev = qc.getQueryData(opts.optimistic.key);
      qc.setQueryData(opts.optimistic.key, (old: any) => (old ? opts.optimistic!.update(old, vars) : old));
      return { prev };
    },
    onError: (e, vars, ctx: any) => {
      if (opts.optimistic && ctx?.prev !== undefined) qc.setQueryData(opts.optimistic.key, ctx.prev);
      if (!opts.silentError) toast.error(errorMessage(e));
      opts.onError?.(e, vars);
    },
    onSuccess: (res, vars) => {
      const msg = typeof opts.success === 'function' ? opts.success(res, vars) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars);
    },
    onSettled: (res, _e, vars) => {
      const keys = typeof opts.invalidate === 'function' ? (res !== undefined ? opts.invalidate(vars, res as TRes) : []) : (opts.invalidate ?? []);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      if (opts.optimistic) qc.invalidateQueries({ queryKey: opts.optimistic.key });
    },
  });
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  return [v, set];
}

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · Alypne`;
  }, [title]);
}

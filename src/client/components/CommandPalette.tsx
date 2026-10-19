import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, Bug, FileText, Gamepad2, Inbox, LayoutGrid, Plus, Rocket, Search, Settings, Tag, MessageSquare, CornerDownLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { useDebounced, useLocalStorage } from '@/lib/hooks';
import { cn } from '@/lib/format';
import { Spinner } from './ui';
import { useCurrentWorkspace } from './AppLayout';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q, 180);
  const navigate = useNavigate();
  const { workspaceId } = useCurrentWorkspace();
  const [recentSearches, setRecent] = useLocalStorage<string[]>('alypne-recent-searches', []);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const results = useQuery({
    queryKey: ['palette', debounced],
    queryFn: () => api.get(`/search?q=${encodeURIComponent(debounced)}&limit=8&types=cards,boards,projects,releases,labels,comments`),
    enabled: open && debounced.trim().length > 1,
    staleTime: 10_000,
  });

  const go = (path: string) => {
    if (q.trim().length > 1) setRecent([q.trim(), ...recentSearches.filter((r) => r !== q.trim())].slice(0, 6));
    onClose();
    navigate(path);
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const term = q.trim().toLowerCase();
    const data = results.data;
    if (data && term.length > 1) {
      for (const b of data.boards ?? []) out.push({ id: `b${b.id}`, group: 'Boards', label: b.name, hint: b.workspaceName, icon: <LayoutGrid />, run: () => go(`/b/${b.id}`) });
      const keyOf = new Map<string, string>((data.cards?.boards ?? []).map((b: any) => [b.id, b.key]));
      for (const c of data.cards?.items ?? []) out.push({ id: `c${c.id}`, group: 'Cards', label: c.title, hint: `${keyOf.get(c.boardId) ?? ''}-${c.number}`, icon: c.type === 'bug' ? <Bug /> : <FileText />, run: () => go(`/b/${c.boardId}/c/${c.id}`) });
      for (const p of data.projects ?? []) out.push({ id: `p${p.id}`, group: 'Projects', label: p.name, hint: p.stage, icon: <Gamepad2 />, run: () => go(`/w/${p.workspaceId}/projects/${p.id}`) });
      for (const r of data.releases ?? []) out.push({ id: `r${r.id}`, group: 'Releases', label: `${r.name}${r.version ? ` ${r.version}` : ''}`, hint: r.status, icon: <Rocket />, run: () => go(`/w/${r.workspaceId}/releases/${r.id}`) });
      for (const l of data.labels ?? []) out.push({ id: `l${l.id}`, group: 'Labels', label: l.name, hint: `${l.boardName} · ${l.cardCount} cards`, icon: <Tag style={{ color: l.color }} />, run: () => go(`/b/${l.boardId}?labels=${l.id}`) });
      for (const m of data.comments ?? []) out.push({ id: `m${m.id}`, group: 'Comments', label: m.body.slice(0, 80), hint: m.cardTitle, icon: <MessageSquare />, run: () => go(`/b/${m.boardId}/c/${m.cardId}`) });
      out.push({ id: 'all', group: 'Search', label: `See all results for “${q.trim()}”`, icon: <Search />, run: () => go(`/app/search?q=${encodeURIComponent(q.trim())}`) });
    }
    const actions: Item[] = [
      { id: 'a-inbox', group: 'Go to', label: 'My tasks', icon: <Inbox />, run: () => go('/app/inbox') },
      { id: 'a-notif', group: 'Go to', label: 'Notifications', icon: <Bell />, run: () => go('/app/notifications') },
      ...(workspaceId
        ? [
            { id: 'a-boards', group: 'Go to', label: 'Boards', icon: <LayoutGrid />, run: () => go(`/w/${workspaceId}`) },
            { id: 'a-bugs', group: 'Go to', label: 'Bug tracker', icon: <Bug />, run: () => go(`/w/${workspaceId}/bugs`) },
            { id: 'a-rel', group: 'Go to', label: 'Releases', icon: <Rocket />, run: () => go(`/w/${workspaceId}/releases`) },
            { id: 'a-new-board', group: 'Create', label: 'New board', icon: <Plus />, run: () => go(`/w/${workspaceId}?new=1`) },
            { id: 'a-new-project', group: 'Create', label: 'New game project', icon: <Plus />, run: () => go(`/w/${workspaceId}/projects?new=1`) },
            { id: 'a-new-release', group: 'Create', label: 'New release', icon: <Plus />, run: () => go(`/w/${workspaceId}/releases?new=1`) },
          ]
        : []),
      { id: 'a-settings', group: 'Go to', label: 'Settings', icon: <Settings />, run: () => go('/app/settings/profile') },
    ];
    const filteredActions = term ? actions.filter((a) => a.label.toLowerCase().includes(term)) : actions;
    if (!term) {
      for (const r of recentSearches) out.push({ id: `recent-${r}`, group: 'Recent searches', label: r, icon: <Search />, run: () => setQ(r) });
    }
    return [...out, ...filteredActions];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.data, q, workspaceId, recentSearches]);

  useEffect(() => setActive(0), [items.length]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-3 pt-[12vh]" role="presentation">
      <div className="fixed inset-0 bg-[var(--overlay)] animate-fade-in" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-pop animate-pop-in">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 text-faint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search or jump to…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `pi-${items[active].id}` : undefined}
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                items[active]?.run();
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
          {results.isFetching && <Spinner />}
        </div>
        <div ref={listRef} id="palette-list" role="listbox" className="max-h-[52vh] overflow-y-auto p-1.5">
          {items.length === 0 && <div className="px-3 py-8 text-center text-sm text-muted">{debounced.trim().length > 1 && !results.isFetching ? 'No results' : 'Type to search'}</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{header}</div>}
                <button
                  id={`pi-${it.id}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={it.run}
                  className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]', i === active ? 'bg-surface-2 text-fg' : 'text-muted')}
                >
                  <span className="flex size-4 items-center justify-center text-faint [&>svg]:size-4">{it.icon}</span>
                  <span className="flex-1 truncate text-fg">{it.label}</span>
                  {it.hint && <span className="shrink-0 truncate text-[11px] text-faint">{it.hint}</span>}
                  {i === active && <CornerDownLeft className="size-3.5 text-faint" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <ArrowRight className="ml-auto size-3" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

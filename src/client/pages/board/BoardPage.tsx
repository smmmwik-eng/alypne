import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Columns3, Filter, Globe, GanttChartSquare, Lock, MoreHorizontal, Star, Table2, Users, Workflow, X, Bookmark, Trash2, Eye } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useBoard, useMe, useDocumentTitle, useAction } from '@/lib/hooks';
import { useBoardRealtime } from '@/lib/realtime';
import type { CardSummary } from '@/lib/types';
import { cn } from '@/lib/format';
import { PRIORITIES, PRIORITY_META, boardRoleAtLeast } from '@shared/constants';
import { AvatarStack, Badge, Button, Checkbox, EmptyState, InlineEdit, Input, MenuItem, MenuLabel, MenuSeparator, Popover, Select, Skeleton, Tabs, usePopover, useToast } from '@/components/ui';
import { boardBackground, useSyncWorkspace } from '@/components/AppLayout';
import { applyFilters, useBoardFilters, emptyFilters, type BoardFilters } from './filters';
import { useBoardActions } from './useBoardActions';
import { BoardView } from './BoardView';
import { TableView } from './TableView';
import { CalendarView } from './CalendarView';
import { TimelineView } from './TimelineView';
import { CardModal } from './card/CardModal';
import { BoardDrawer, type DrawerPanel } from './BoardDrawer';
import { useWorkspace } from '@/lib/hooks';

type View = 'board' | 'table' | 'calendar' | 'timeline';

export function BoardPage() {
  const { boardId = '', cardId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const q = useBoard(boardId);
  const data = q.data;
  useSyncWorkspace(data?.board.workspaceId);
  useBoardRealtime(boardId, me.data?.user?.id);
  useDocumentTitle(data?.board.name);
  const actions = useBoardActions(boardId);
  const [filters, setFilters, clearFilters, filterCount] = useBoardFilters();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [drawer, setDrawer] = useState<DrawerPanel | null>(() => (params.get('panel') as DrawerPanel) ?? null);
  const [composerSignal, setComposerSignal] = useState(0);
  const view = (params.get('view') as View) || 'board';
  const ws = useWorkspace(data?.board.workspaceId);
  const toast = useToast();

  const setView = useCallback(
    (v: View) => {
      const next = new URLSearchParams(params);
      if (v === 'board') next.delete('view');
      else next.set('view', v);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const specMembers = useMemo(() => {
    if (!filters.specialisation || !ws.data) return undefined;
    return new Set(ws.data.members.filter((m) => m.specialisationIds.includes(filters.specialisation)).map((m) => m.userId));
  }, [filters.specialisation, ws.data]);

  const visible = useMemo(() => (data ? applyFilters(data.cards, filters, specMembers) : []), [data, filters, specMembers]);
  const canEdit = !!data && !!me.data?.user && boardRoleAtLeast(data.role, 'member') && !data.board.archivedAt;
  const isAdmin = !!data && data.role === 'admin';

  const openCard = useCallback((c: CardSummary) => navigate({ pathname: `/b/${boardId}/c/${c.id}`, search: params.toString() }), [navigate, boardId, params]);
  const closeCard = useCallback(() => navigate({ pathname: `/b/${boardId}`, search: params.toString() }), [navigate, boardId, params]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (cardId || t.closest('input,textarea,select,[contenteditable=true],[role=dialog]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f') setFiltersOpen((o) => !o);
      else if (e.key === 'q' && me.data?.user) setFilters({ members: filters.members.includes(me.data.user.id) ? [] : [me.data.user.id] });
      else if (e.key === 'n' && canEdit) {
        setView('board');
        setComposerSignal((s) => s + 1);
      } else if (['1', '2', '3', '4'].includes(e.key)) setView((['board', 'table', 'calendar', 'timeline'] as View[])[Number(e.key) - 1]);
      else if (e.key === 'Escape' && filterCount) clearFilters();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cardId, canEdit, filters.members, filterCount, me.data?.user, setFilters, clearFilters, setView]);

  const favorite = useAction((v: boolean) => api.post(`/boards/${boardId}/favorite`, { favorite: v }), { invalidate: [['board', boardId], ['favorites']] });

  if (q.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-14 items-center gap-3 border-b border-line px-4">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex gap-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-72 w-[284px]" />
          ))}
        </div>
      </div>
    );
  }
  if (q.isError || !data) {
    const nf = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="p-8">
        <EmptyState title={nf ? 'Board not found' : 'Could not load this board'} description={nf ? "It may have been deleted, or you don't have access. Ask a board admin to add you." : 'Check your connection and try again.'} action={<Button onClick={() => (nf ? navigate('/app') : q.refetch())}>{nf ? 'Go home' : 'Retry'}</Button>} />
      </div>
    );
  }

  const b = data.board;
  const visIcon = b.visibility === 'private' ? <Lock className="size-3.5" /> : b.visibility === 'public' ? <Globe className="size-3.5" /> : <Users className="size-3.5" />;

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: boardBackground(b.background) }}>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-black/20 px-3 py-2 backdrop-blur-sm md:px-4 [[data-theme=light]_&]:bg-white/60">
        <div className="flex min-w-0 items-center gap-2">
          <InlineEdit value={b.name} onSave={(name) => actions.run(null, () => api.patch(`/boards/${boardId}`, { name }))} disabled={!isAdmin} ariaLabel="board name" className="truncate px-1.5 py-0.5 text-[15px] font-semibold" inputClassName="text-[15px] font-semibold py-0.5" />
          {me.data?.user && (
            <button onClick={() => favorite.mutate(!b.favorite)} aria-label={b.favorite ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={b.favorite} className="rounded-md p-1 text-muted hover:bg-white/10 hover:text-fg focus-ring">
              <Star className={cn('size-4', b.favorite && 'fill-warning text-warning')} />
            </button>
          )}
          <button onClick={() => isAdmin && setDrawer('settings')} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted capitalize hover:bg-white/10 hover:text-fg" title="Visibility">
            {visIcon}
            <span className="hidden sm:inline">{b.visibility}</span>
          </button>
          {data.project && (
            <Link to={`/w/${b.workspaceId}/projects/${data.project.id}`} className="hidden rounded-md px-1.5 py-1 text-[12px] text-muted hover:bg-white/10 hover:text-fg md:inline">
              {data.project.name}
            </Link>
          )}
          {b.archivedAt && <Badge tone="warning">Closed</Badge>}
          {data.role === 'observer' && (
            <Badge>
              <Eye className="size-3" /> View only
            </Badge>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Tabs
            value={view}
            onChange={setView}
            tabs={[
              { value: 'board', label: <span className="hidden sm:inline">Board</span>, icon: <Columns3 className="size-3.5" /> },
              { value: 'table', label: <span className="hidden sm:inline">Table</span>, icon: <Table2 className="size-3.5" /> },
              { value: 'calendar', label: <span className="hidden sm:inline">Calendar</span>, icon: <CalendarDays className="size-3.5" /> },
              { value: 'timeline', label: <span className="hidden sm:inline">Timeline</span>, icon: <GanttChartSquare className="size-3.5" /> },
            ]}
          />
          <FilterButton filters={filters} setFilters={setFilters} clear={clearFilters} count={filterCount} open={filtersOpen} setOpen={setFiltersOpen} data={data} wsSpecs={ws.data?.specialisations ?? []} myId={me.data?.user?.id} boardId={boardId} />
          <button onClick={() => setDrawer('members')} className="rounded-lg p-0.5 hover:bg-white/10 focus-ring" aria-label="Board members">
            <AvatarStack people={data.members.slice(0, 5)} size={24} max={4} />
          </button>
          {me.data?.user && (
            <Button size="sm" variant="ghost" icon={<Workflow className="size-4" />} onClick={() => setDrawer('automation')} className="text-fg">
              <span className="hidden lg:inline">Automation</span>
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" onClick={() => setDrawer('menu')} aria-label="Board menu" className="text-fg">
            <MoreHorizontal className="size-4" />
          </Button>
        </div>
      </div>
      {filterCount > 0 && (
        <div className="flex items-center gap-2 border-b border-white/[0.06] bg-accent-soft px-4 py-1.5 text-[12px]">
          <Filter className="size-3.5 text-accent" />
          Showing {visible.length} of {data.cards.length} cards
          <button onClick={clearFilters} className="ml-1 font-medium text-accent hover:underline">
            Clear filters
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {view === 'board' && <BoardView data={data} visibleCards={visible} filtered={filterCount > 0} actions={actions} canEdit={canEdit} onOpenCard={openCard} composerSignal={composerSignal} />}
        {view === 'table' && <TableView data={data} cards={visible} actions={actions} canEdit={canEdit} onOpenCard={openCard} />}
        {view === 'calendar' && <CalendarView data={data} cards={visible} actions={actions} canEdit={canEdit} onOpenCard={openCard} />}
        {view === 'timeline' && <TimelineView data={data} cards={visible} actions={actions} canEdit={canEdit} onOpenCard={openCard} />}
      </div>
      {cardId && <CardModal key={cardId} cardId={cardId} board={data} onClose={closeCard} />}
      {drawer && <BoardDrawer panel={drawer} setPanel={setDrawer} data={data} onClose={() => setDrawer(null)} isAdmin={isAdmin} canEdit={canEdit} onToast={toast} />}
    </div>
  );
}

function FilterButton({ filters, setFilters, clear, count, open, setOpen, data, wsSpecs, myId, boardId }: { filters: BoardFilters; setFilters: (f: Partial<BoardFilters>) => void; clear: () => void; count: number; open: boolean; setOpen: (o: boolean) => void; data: any; wsSpecs: { id: string; name: string; color: string }[]; myId?: string; boardId: string }) {
  const p = usePopover();
  const toast = useToast();
  const [viewName, setViewName] = useState('');
  const saved = useQuery({ queryKey: ['views', boardId], queryFn: () => api.get(`/me/views?boardId=${boardId}`).then((r) => r.views as any[]), enabled: open && !!myId });
  const toggle = (key: 'labels' | 'members' | 'priority', v: string) => setFilters({ [key]: filters[key].includes(v) ? filters[key].filter((x) => x !== v) : [...filters[key], v] });
  return (
    <>
      <Button ref={p.anchorRef as any} size="sm" variant={count ? 'primary' : 'ghost'} icon={<Filter className="size-3.5" />} onClick={() => setOpen(!open)} className={count ? '' : 'text-fg'} aria-expanded={open}>
        <span className="hidden sm:inline">Filters</span>
        {count > 0 && <span className="rounded bg-white/20 px-1 text-[11px]">{count}</span>}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={p.anchorRef} align="end" width={320}>
        <div className="space-y-3 p-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Filter cards</span>
            <button onClick={() => setOpen(false)} className="rounded p-1 text-faint hover:text-fg" aria-label="Close filters">
              <X className="size-3.5" />
            </button>
          </div>
          <Input value={filters.q} onChange={(e) => setFilters({ q: e.target.value })} placeholder="Keyword or card number" autoFocus />
          <div>
            <div className="mb-1 text-xs text-muted">Members</div>
            <div className="space-y-0.5">
              {myId && <Checkbox checked={filters.members.includes(myId)} onChange={() => toggle('members', myId)} label="Cards assigned to me" />}
              <Checkbox checked={filters.members.includes('none')} onChange={() => toggle('members', 'none')} label="No members" />
              {data.members
                .filter((m: any) => m.id !== myId)
                .slice(0, 12)
                .map((m: any) => (
                  <Checkbox key={m.id} checked={filters.members.includes(m.id)} onChange={() => toggle('members', m.id)} label={m.displayName} />
                ))}
            </div>
          </div>
          {wsSpecs.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-muted">Team specialisation</div>
              <Select value={filters.specialisation} onChange={(e) => setFilters({ specialisation: e.target.value })} className="h-8">
                <option value="">Any</option>
                {wsSpecs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <div className="mb-1 text-xs text-muted">Labels</div>
            <div className="flex flex-wrap gap-1">
              {data.labels.map((l: any) => (
                <button key={l.id} onClick={() => toggle('labels', l.id)} aria-pressed={filters.labels.includes(l.id)} className={cn('h-6 rounded px-2 text-[11px] font-semibold text-black/75 transition-opacity', filters.labels.length && !filters.labels.includes(l.id) && 'opacity-40')} style={{ background: l.color }}>
                  {l.name || '  '}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label>
              <span className="mb-1 block text-xs text-muted">Due</span>
              <Select value={filters.due} onChange={(e) => setFilters({ due: e.target.value as any })} className="h-8">
                <option value="">Any</option>
                <option value="overdue">Overdue</option>
                <option value="today">Due today</option>
                <option value="week">Next 7 days</option>
                <option value="none">No due date</option>
              </Select>
            </label>
            <label>
              <span className="mb-1 block text-xs text-muted">Status</span>
              <Select value={filters.status} onChange={(e) => setFilters({ status: e.target.value as any })} className="h-8">
                <option value="">Any</option>
                <option value="open">Open</option>
                <option value="done">Completed</option>
              </Select>
            </label>
            <label>
              <span className="mb-1 block text-xs text-muted">Type</span>
              <Select value={filters.type} onChange={(e) => setFilters({ type: e.target.value as any })} className="h-8">
                <option value="">Any</option>
                <option value="task">Tasks</option>
                <option value="bug">Bugs</option>
              </Select>
            </label>
            <label>
              <span className="mb-1 block text-xs text-muted">Release</span>
              <Select value={filters.release} onChange={(e) => setFilters({ release: e.target.value })} className="h-8">
                <option value="">Any</option>
                {data.releases.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Priority</div>
            <div className="flex flex-wrap gap-1">
              {PRIORITIES.filter((x) => x !== 'none').map((pr) => (
                <button key={pr} onClick={() => toggle('priority', pr)} aria-pressed={filters.priority.includes(pr)} className={cn('inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px]', filters.priority.includes(pr) ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted')}>
                  <span className="size-1.5 rounded-full" style={{ background: PRIORITY_META[pr].color }} />
                  {PRIORITY_META[pr].label}
                </button>
              ))}
            </div>
          </div>
          {myId && (
            <div className="border-t border-line pt-2">
              <MenuLabel>Saved filters</MenuLabel>
              {saved.data?.map((v) => (
                <div key={v.id} className="flex items-center gap-1">
                  <MenuItem icon={<Bookmark />} onClick={() => setFilters({ ...emptyFilters, ...(v.filters as Partial<BoardFilters>) })}>
                    {v.name}
                  </MenuItem>
                  <button
                    aria-label={`Delete saved filter ${v.name}`}
                    className="rounded p-1 text-faint hover:text-danger"
                    onClick={async () => {
                      await api.del(`/me/views/${v.id}`);
                      saved.refetch();
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
              {count > 0 && (
                <form
                  className="mt-1 flex gap-1"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!viewName.trim()) return;
                    await api.post('/me/views', { name: viewName.trim(), view: 'board', boardId, filters });
                    setViewName('');
                    saved.refetch();
                    toast.success('Filter saved');
                  }}
                >
                  <Input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Save current filter as…" className="h-8" />
                  <Button type="submit" size="sm" disabled={!viewName.trim()}>
                    Save
                  </Button>
                </form>
              )}
            </div>
          )}
          {count > 0 && (
            <>
              <MenuSeparator />
              <Button size="sm" variant="ghost" className="w-full justify-center" onClick={clear}>
                Clear all filters
              </Button>
            </>
          )}
        </div>
      </Popover>
    </>
  );
}

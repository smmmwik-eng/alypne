import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Bug, Columns3, Archive, CheckCircle2, X } from 'lucide-react';
import type { BoardData, CardSummary } from '@/lib/types';
import { cn, fromLocalInput, toLocalInput } from '@/lib/format';
import { PRIORITIES, PRIORITY_META } from '@shared/constants';
import { AvatarStack, Button, Checkbox, EmptyState, Popover, Select, usePopover, InlineEdit, MenuLabel } from '@/components/ui';
import { useLocalStorage } from '@/lib/hooks';
import type { BoardActions } from './useBoardActions';
import { DueBadge } from './CardTile';

type SortKey = 'key' | 'title' | 'list' | 'priority' | 'due' | 'start' | 'updated' | 'checklist';
const BASE_COLUMNS = ['list', 'priority', 'assignees', 'labels', 'start', 'due', 'checklist', 'release'] as const;
type BaseCol = (typeof BASE_COLUMNS)[number];
const COL_LABEL: Record<BaseCol, string> = { list: 'List', priority: 'Priority', assignees: 'Members', labels: 'Labels', start: 'Start', due: 'Due', checklist: 'Checklist', release: 'Release' };

export function TableView({ data, cards, actions, canEdit, onOpenCard }: { data: BoardData; cards: CardSummary[]; actions: BoardActions; canEdit: boolean; onOpenCard: (c: CardSummary) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'list', dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useLocalStorage<string[]>(`alypne-table-hidden-${data.board.id}`, []);
  const colsPop = usePopover();
  const listIndex = useMemo(() => new Map([...data.lists].sort((a, b) => a.position - b.position).map((l, i) => [l.id, i])), [data.lists]);
  const listName = (id: string) => data.lists.find((l) => l.id === id)?.name ?? '';
  const visibleCols = BASE_COLUMNS.filter((c) => !hidden.includes(c));
  const fields = data.customFields.filter((f) => !hidden.includes(`cf:${f.id}`));

  const rows = useMemo(() => {
    const val = (c: CardSummary): number | string => {
      switch (sort.key) {
        case 'key':
          return c.number;
        case 'title':
          return c.title.toLowerCase();
        case 'list':
          return (listIndex.get(c.listId) ?? 0) * 1e9 + c.position;
        case 'priority':
          return PRIORITY_META[c.priority].rank;
        case 'due':
          return c.dueAt ? new Date(c.dueAt).getTime() : Infinity;
        case 'start':
          return c.startAt ? new Date(c.startAt).getTime() : Infinity;
        case 'updated':
          return new Date(c.updatedAt).getTime();
        case 'checklist':
          return c.checklist.total ? c.checklist.done / c.checklist.total : -1;
      }
    };
    return [...cards].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [cards, sort, listIndex]);

  const toggleSort = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const ids = [...selected].filter((id) => cards.some((c) => c.id === id));

  const Th = ({ k, children, className }: { k?: SortKey; children: React.ReactNode; className?: string }) => (
    <th scope="col" className={cn('sticky top-0 z-10 border-b border-line bg-surface px-2.5 py-2 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-faint uppercase', className)} aria-sort={k && sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      {k ? (
        <button onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 hover:text-fg">
          {children}
          {sort.key === k && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
        </button>
      ) : (
        children
      )}
    </th>
  );

  if (!data.cards.length) return <div className="p-6"><EmptyState title="No cards yet" description="Add cards on the board view, or import from CSV in the board menu." /></div>;

  return (
    <div className="flex h-full flex-col p-3 md:p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] text-muted">{rows.length} cards</span>
        <Button ref={colsPop.anchorRef as any} size="sm" variant="ghost" icon={<Columns3 className="size-3.5" />} onClick={colsPop.toggle} className="ml-auto text-fg">
          Columns
        </Button>
        <Popover open={colsPop.open} onClose={colsPop.close} anchor={colsPop.anchorRef} align="end" width={220}>
          <div className="space-y-1 p-1.5">
            <MenuLabel>Show columns</MenuLabel>
            {BASE_COLUMNS.map((c) => (
              <Checkbox key={c} checked={!hidden.includes(c)} onChange={(v) => setHidden(v ? hidden.filter((h) => h !== c) : [...hidden, c])} label={COL_LABEL[c]} className="flex" />
            ))}
            {data.customFields.length > 0 && <MenuLabel>Custom fields</MenuLabel>}
            {data.customFields.map((f) => (
              <Checkbox key={f.id} checked={!hidden.includes(`cf:${f.id}`)} onChange={(v) => setHidden(v ? hidden.filter((h) => h !== `cf:${f.id}`) : [...hidden, `cf:${f.id}`])} label={f.name} className="flex" />
            ))}
          </div>
        </Popover>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {canEdit && (
                <th className="sticky top-0 z-10 w-9 border-b border-line bg-surface px-2.5">
                  <Checkbox checked={allSelected} onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())} />
                </th>
              )}
              <Th k="key">Key</Th>
              <Th k="title" className="min-w-64">
                Title
              </Th>
              {visibleCols.includes('list') && <Th k="list">List</Th>}
              {visibleCols.includes('priority') && <Th k="priority">Priority</Th>}
              {visibleCols.includes('assignees') && <Th>Members</Th>}
              {visibleCols.includes('labels') && <Th>Labels</Th>}
              {visibleCols.includes('start') && <Th k="start">Start</Th>}
              {visibleCols.includes('due') && <Th k="due">Due</Th>}
              {visibleCols.includes('checklist') && <Th k="checklist">Checklist</Th>}
              {visibleCols.includes('release') && <Th>Release</Th>}
              {fields.map((f) => (
                <Th key={f.id}>{f.name}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={cn('group border-b border-line last:border-0 hover:bg-surface-2/60', selected.has(c.id) && 'bg-accent-soft/50')}>
                {canEdit && (
                  <td className="px-2.5">
                    <Checkbox checked={selected.has(c.id)} onChange={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(c.id); else n.delete(c.id); return n; })} />
                  </td>
                )}
                <td className="px-2.5 py-1.5 font-mono text-[11px] whitespace-nowrap text-faint">
                  <button onClick={() => onOpenCard(c)} className="hover:text-fg hover:underline">
                    {data.board.key}-{c.number}
                  </button>
                </td>
                <td className="px-1.5 py-1">
                  <div className="flex items-center gap-1.5">
                    {c.completedAt && <CheckCircle2 className="size-3.5 shrink-0 text-success" />}
                    {c.type === 'bug' && <Bug className="size-3.5 shrink-0 text-danger" />}
                    <InlineEdit value={c.title} onSave={(title) => actions.updateCard(c.id, { title })} disabled={!canEdit} className="w-full truncate px-1 py-0.5" inputClassName="py-0.5" ariaLabel="title" />
                    <button onClick={() => onOpenCard(c)} className="shrink-0 rounded px-1.5 text-[11px] text-faint opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg focus:opacity-100">
                      Open
                    </button>
                  </div>
                </td>
                {visibleCols.includes('list') && (
                  <td className="px-1.5 py-1">
                    {canEdit ? (
                      <select value={c.listId} onChange={(e) => actions.moveCard(c.id, e.target.value, 0, [])} className="h-7 max-w-40 rounded-md border border-transparent bg-transparent px-1 text-[13px] hover:border-line focus:border-accent focus:outline-none" aria-label="List">
                        {[...data.lists].sort((a, b) => a.position - b.position).map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      listName(c.listId)
                    )}
                  </td>
                )}
                {visibleCols.includes('priority') && (
                  <td className="px-1.5 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: PRIORITY_META[c.priority].color }} />
                      <select disabled={!canEdit} value={c.priority} onChange={(e) => actions.updateCard(c.id, { priority: e.target.value as any })} className="h-7 rounded-md border border-transparent bg-transparent px-1 text-[13px] hover:border-line focus:border-accent focus:outline-none disabled:opacity-100" aria-label="Priority">
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_META[p].label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                )}
                {visibleCols.includes('assignees') && (
                  <td className="px-2.5 py-1">
                    <AvatarStack people={data.members.filter((m) => c.assigneeIds.includes(m.id))} size={22} max={3} />
                  </td>
                )}
                {visibleCols.includes('labels') && (
                  <td className="px-2.5 py-1">
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {data.labels
                        .filter((l) => c.labelIds.includes(l.id))
                        .map((l) => (
                          <span key={l.id} className="rounded px-1.5 text-[10.5px] leading-[18px] font-semibold text-black/75" style={{ background: l.color }}>
                            {l.name || ' '}
                          </span>
                        ))}
                    </div>
                  </td>
                )}
                {visibleCols.includes('start') && (
                  <td className="px-1.5 py-1">
                    <input type="datetime-local" disabled={!canEdit} value={toLocalInput(c.startAt)} onChange={(e) => actions.updateCard(c.id, { startAt: fromLocalInput(e.target.value) })} className="h-7 rounded-md border border-transparent bg-transparent px-1 text-[12px] text-muted hover:border-line focus:border-accent focus:outline-none" aria-label="Start date" />
                  </td>
                )}
                {visibleCols.includes('due') && (
                  <td className="px-1.5 py-1">
                    <div className="flex items-center gap-1">
                      <DueBadge dueAt={c.dueAt} completedAt={c.completedAt} />
                      <input type="datetime-local" disabled={!canEdit} value={toLocalInput(c.dueAt)} onChange={(e) => actions.updateCard(c.id, { dueAt: fromLocalInput(e.target.value) })} className="h-7 w-7 cursor-pointer rounded-md border border-transparent bg-transparent text-[12px] text-transparent hover:border-line focus:w-auto focus:border-accent focus:text-fg focus:outline-none" aria-label="Due date" title="Change due date" />
                    </div>
                  </td>
                )}
                {visibleCols.includes('checklist') && <td className="px-2.5 py-1 text-[12px] whitespace-nowrap text-muted">{c.checklist.total ? `${c.checklist.done}/${c.checklist.total}` : '—'}</td>}
                {visibleCols.includes('release') && <td className="px-2.5 py-1 text-[12px] whitespace-nowrap text-muted">{data.releases.find((r) => r.id === c.releaseId)?.name ?? '—'}</td>}
                {fields.map((f) => {
                  const v = c.customFields[f.id];
                  const text = v === undefined || v === null ? '—' : f.type === 'dropdown' ? (f.options.find((o) => o.id === v)?.label ?? '—') : f.type === 'checkbox' ? (v ? '✓' : '—') : f.type === 'date' ? new Date(String(v)).toLocaleDateString() : f.type === 'user' ? (data.members.find((m) => m.id === v)?.displayName ?? '—') : String(v);
                  return (
                    <td key={f.id} className="max-w-48 truncate px-2.5 py-1 text-[12px] text-muted">
                      {f.type === 'url' && v ? (
                        <a href={String(v)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                          link
                        </a>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="p-6 text-center text-sm text-muted">No cards match the current filters.</p>}
      </div>
      {canEdit && ids.length > 0 && <BulkBar ids={ids} data={data} actions={actions} onDone={() => setSelected(new Set())} />}
    </div>
  );
}

function BulkBar({ ids, data, actions, onDone }: { ids: string[]; data: BoardData; actions: BoardActions; onDone: () => void }) {
  const run = async (action: Record<string, unknown>) => {
    await actions.bulk(ids, action);
    onDone();
  };
  const sel = (label: string, opts: [string, string][], make: (v: string) => Record<string, unknown>) => (
    <Select aria-label={label} value="" onChange={(e) => e.target.value && run(make(e.target.value))} className="h-8 w-auto min-w-28 text-[12px]">
      <option value="">{label}</option>
      {opts.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </Select>
  );
  return (
    <div className="fixed inset-x-3 bottom-4 z-30 mx-auto flex max-w-4xl flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface px-3 py-2 shadow-pop animate-slide-up" role="region" aria-label="Bulk actions">
      <span className="text-[13px] font-medium">{ids.length} selected</span>
      {sel('Move to…', [...data.lists].sort((a, b) => a.position - b.position).map((l) => [l.id, l.name]), (v) => ({ type: 'move', listId: v }))}
      {sel('Priority…', PRIORITIES.map((p) => [p, PRIORITY_META[p].label]), (v) => ({ type: 'setPriority', priority: v }))}
      {sel('Add label…', data.labels.map((l) => [l.id, l.name || l.color]), (v) => ({ type: 'addLabel', labelId: v }))}
      {sel('Assign…', data.members.filter((m) => m.role !== 'observer').map((m) => [m.id, m.displayName]), (v) => ({ type: 'assign', userId: v }))}
      {data.releases.length > 0 && sel('Release…', [['', 'None'], ...data.releases.map((r) => [r.id, r.name] as [string, string])].filter(([v]) => v) as [string, string][], (v) => ({ type: 'setRelease', releaseId: v }))}
      <Button size="sm" icon={<CheckCircle2 className="size-3.5" />} onClick={() => run({ type: 'complete', completed: true })}>
        Complete
      </Button>
      <Button size="sm" icon={<Archive className="size-3.5" />} onClick={() => run({ type: 'archive' })}>
        Archive
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onDone} aria-label="Clear selection" className="ml-auto">
        <X className="size-4" />
      </Button>
    </div>
  );
}

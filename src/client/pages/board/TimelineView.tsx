import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, differenceInCalendarDays, format, startOfDay, startOfWeek, isSameMonth } from 'date-fns';
import { Flag, Rocket, ZoomIn, ZoomOut, Crosshair } from 'lucide-react';
import type { BoardData, CardSummary } from '@/lib/types';
import { cn, dueState } from '@/lib/format';
import { Button, Select } from '@/components/ui';
import type { BoardActions } from './useBoardActions';

const ROW_H = 34;
const LABEL_W = 220;
const ZOOMS = [6, 14, 28, 44];

type GroupBy = 'list' | 'release' | 'assignee';

interface Row {
  type: 'group' | 'card';
  key: string;
  label: string;
  card?: CardSummary;
}

const barTone: Record<string, string> = {
  overdue: 'bg-danger/80',
  today: 'bg-warning/85',
  soon: 'bg-warning/85',
  done: 'bg-success/70',
  later: 'bg-accent/85',
  none: 'bg-accent/85',
};

export function TimelineView({ data, cards, actions, canEdit, onOpenCard }: { data: BoardData; cards: CardSummary[]; actions: BoardActions; canEdit: boolean; onOpenCard: (c: CardSummary) => void }) {
  const [zoomIdx, setZoomIdx] = useState(2);
  const [groupBy, setGroupBy] = useState<GroupBy>('list');
  const dayW = ZOOMS[zoomIdx];
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'start' | 'end'; x0: number; delta: number } | null>(null);

  const scheduled = cards.filter((c) => c.startAt || c.dueAt);
  const unscheduledCount = cards.length - scheduled.length;

  const span = (c: CardSummary) => {
    const s = startOfDay(new Date(c.startAt ?? c.dueAt!));
    const e = startOfDay(new Date(c.dueAt ?? c.startAt!));
    return { s, e: e < s ? s : e };
  };

  const [rangeStart, totalDays] = useMemo(() => {
    const today = startOfDay(new Date());
    let min = addDays(today, -14);
    let max = addDays(today, 42);
    for (const c of scheduled) {
      const { s, e } = span(c);
      if (s < min) min = addDays(s, -7);
      if (e > max) max = addDays(e, 14);
    }
    for (const m of data.milestones) {
      const d = startOfDay(new Date(m.date));
      if (d < min) min = addDays(d, -7);
      if (d > max) max = addDays(d, 14);
    }
    const start = startOfWeek(min, { weekStartsOn: 1 });
    return [start, differenceInCalendarDays(max, start) + 1] as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduled, data.milestones]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const push = (key: string, label: string, list: CardSummary[]) => {
      if (!list.length) return;
      out.push({ type: 'group', key: `g-${key}`, label });
      for (const c of list.sort((a, b) => span(a).s.getTime() - span(b).s.getTime())) out.push({ type: 'card', key: c.id, label: c.title, card: c });
    };
    if (groupBy === 'list') for (const l of [...data.lists].sort((a, b) => a.position - b.position)) push(l.id, l.name, scheduled.filter((c) => c.listId === l.id));
    if (groupBy === 'release') {
      for (const r of data.releases) push(r.id, `${r.name} ${r.version}`, scheduled.filter((c) => c.releaseId === r.id));
      push('none', 'No release', scheduled.filter((c) => !c.releaseId));
    }
    if (groupBy === 'assignee') {
      for (const m of data.members) push(m.id, m.displayName, scheduled.filter((c) => c.assigneeIds.includes(m.id)));
      push('none', 'Unassigned', scheduled.filter((c) => !c.assigneeIds.length));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduled, groupBy, data.lists, data.releases, data.members]);

  const x = (d: Date) => differenceInCalendarDays(d, rangeStart) * dayW;
  const todayX = x(startOfDay(new Date()));

  useEffect(() => {
    scroller.current?.scrollTo({ left: Math.max(0, todayX - 200) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayW]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => setDrag((d) => (d ? { ...d, delta: Math.round((e.clientX - d.x0) / dayW) } : d));
    const onUp = () => {
      setDrag((d) => {
        if (d && d.delta !== 0) {
          const c = cards.find((x2) => x2.id === d.id);
          if (c) {
            const shift = (iso: string | null, n: number) => (iso ? addDays(new Date(iso), n).toISOString() : null);
            if (d.mode === 'move') actions.updateCard(c.id, { startAt: shift(c.startAt, d.delta), dueAt: shift(c.dueAt, d.delta) });
            if (d.mode === 'end') {
              const next = shift(c.dueAt ?? c.startAt, d.delta)!;
              if (!c.startAt || new Date(next) >= new Date(c.startAt)) actions.updateCard(c.id, { dueAt: next, ...(c.startAt ? {} : { startAt: c.dueAt }) });
            }
            if (d.mode === 'start') {
              const next = shift(c.startAt ?? c.dueAt, d.delta)!;
              if (!c.dueAt || new Date(next) <= new Date(c.dueAt)) actions.updateCard(c.id, { startAt: next });
            }
          }
        }
        return null;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, dayW, cards, actions]);

  const rowIndex = new Map(rows.map((r, i) => [r.key, i]));
  const geom = (c: CardSummary) => {
    let { s, e } = span(c);
    if (drag?.id === c.id) {
      if (drag.mode === 'move' || drag.mode === 'start') s = addDays(s, drag.delta);
      if (drag.mode === 'move' || drag.mode === 'end') e = addDays(e, drag.delta);
      if (e < s) e = s;
    }
    return { left: x(s), width: Math.max(dayW, (differenceInCalendarDays(e, s) + 1) * dayW) };
  };

  const width = totalDays * dayW;
  const height = rows.length * ROW_H;
  const headerDays = Array.from({ length: totalDays }, (_, i) => addDays(rangeStart, i));

  return (
    <div className="flex h-full flex-col p-3 md:p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted">
          {scheduled.length} scheduled
          {unscheduledCount > 0 && ` · ${unscheduledCount} without dates (set start/due dates to see them here)`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} className="h-8 text-[12px]" aria-label="Group by">
            <option value="list">Group by list</option>
            <option value="release">Group by release</option>
            <option value="assignee">Group by member</option>
          </Select>
          <Button size="icon-sm" variant="ghost" onClick={() => setZoomIdx(Math.max(0, zoomIdx - 1))} aria-label="Zoom out" disabled={zoomIdx === 0} className="text-fg">
            <ZoomOut className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => setZoomIdx(Math.min(ZOOMS.length - 1, zoomIdx + 1))} aria-label="Zoom in" disabled={zoomIdx === ZOOMS.length - 1} className="text-fg">
            <ZoomIn className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" icon={<Crosshair className="size-3.5" />} onClick={() => scroller.current?.scrollTo({ left: Math.max(0, todayX - 200), behavior: 'smooth' })} className="text-fg">
            Today
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-surface">
        <div className="shrink-0 border-r border-line" style={{ width: LABEL_W }}>
          <div className="h-12 border-b border-line" />
          <div className="overflow-hidden" style={{ height: `calc(100% - 3rem)` }} id="tl-labels">
            {rows.map((r) =>
              r.type === 'group' ? (
                <div key={r.key} className="flex items-center bg-surface-2/60 px-3 text-[11px] font-semibold tracking-wide text-muted uppercase" style={{ height: ROW_H }}>
                  <span className="truncate">{r.label}</span>
                </div>
              ) : (
                <button key={r.key} onClick={() => onOpenCard(r.card!)} className="flex w-full items-center gap-2 px-3 text-left text-[12.5px] hover:bg-surface-2" style={{ height: ROW_H }}>
                  <span className="font-mono text-[10px] text-faint">{r.card!.number}</span>
                  <span className={cn('truncate', r.card!.completedAt && 'text-faint line-through')}>{r.label}</span>
                </button>
              ),
            )}
          </div>
        </div>
        <div
          ref={scroller}
          className="relative min-w-0 flex-1 overflow-auto"
          onScroll={(e) => {
            const el = document.getElementById('tl-labels');
            if (el) el.scrollTop = (e.target as HTMLDivElement).scrollTop;
          }}
        >
          <div style={{ width, minHeight: '100%' }} className="relative">
            <div className="sticky top-0 z-20 h-12 border-b border-line bg-surface">
              <div className="relative h-6">
                {headerDays.map((d) =>
                  d.getDate() === 1 || d.getTime() === rangeStart.getTime() ? (
                    <span key={`m${d.toISOString()}`} className="absolute top-1 pl-1.5 text-[11px] font-semibold whitespace-nowrap" style={{ left: x(d) }}>
                      {format(d, 'MMMM yyyy')}
                    </span>
                  ) : null,
                )}
              </div>
              <div className="relative h-6">
                {headerDays.map((d) =>
                  dayW >= 14 || d.getDay() === 1 ? (
                    <span key={d.toISOString()} className={cn('absolute top-0.5 text-center text-[10px] text-faint', d.getDay() === 0 || d.getDay() === 6 ? 'opacity-60' : '')} style={{ left: x(d), width: dayW >= 14 ? dayW : dayW * 7 }}>
                      {dayW >= 28 ? format(d, 'EEE d') : dayW >= 14 ? format(d, 'd') : format(d, 'MMM d')}
                    </span>
                  ) : null,
                )}
              </div>
            </div>
            <div className="relative" style={{ height }}>
              {/* weekend shading and grid */}
              {headerDays.map((d) =>
                d.getDay() === 0 || d.getDay() === 6 ? <div key={`w${d.toISOString()}`} className="absolute inset-y-0 bg-surface-2/50" style={{ left: x(d), width: dayW }} /> : d.getDay() === 1 ? <div key={`l${d.toISOString()}`} className={cn('absolute inset-y-0 w-px', isSameMonth(d, addDays(d, -1)) ? 'bg-line/60' : 'bg-line')} style={{ left: x(d) }} /> : null,
              )}
              {rows.map((r, i) => (r.type === 'group' ? <div key={r.key} className="absolute inset-x-0 bg-surface-2/40" style={{ top: i * ROW_H, height: ROW_H }} /> : null))}
              {/* today */}
              <div className="absolute inset-y-0 z-10 w-0.5 bg-danger/70" style={{ left: todayX + dayW / 2 }} aria-hidden />
              {/* milestones & releases */}
              {data.milestones.map((m) => (
                <div key={m.id} className="absolute inset-y-0 z-10 border-l border-dashed border-accent/70" style={{ left: x(startOfDay(new Date(m.date))) + dayW / 2 }}>
                  <span className="absolute top-1 left-1 flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-accent-fg">
                    <Flag className="size-2.5" /> {m.name}
                  </span>
                </div>
              ))}
              {data.releases
                .filter((r) => r.plannedDate)
                .map((r) => (
                  <div key={r.id} className="absolute inset-y-0 z-10 border-l-2 border-success/70" style={{ left: x(startOfDay(new Date(r.plannedDate!))) + dayW / 2 }}>
                    <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-success px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-black/80">
                      <Rocket className="size-2.5" /> {r.name}
                    </span>
                  </div>
                ))}
              {/* dependency arrows */}
              <svg className="pointer-events-none absolute inset-0 z-10" width={width} height={height} aria-hidden>
                <defs>
                  <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" />
                  </marker>
                </defs>
                {data.dependencies.map((dep) => {
                  const a = cards.find((c) => c.id === dep.from);
                  const b = cards.find((c) => c.id === dep.to);
                  const ia = rowIndex.get(dep.from);
                  const ib = rowIndex.get(dep.to);
                  if (!a || !b || ia === undefined || ib === undefined || !(a.startAt || a.dueAt) || !(b.startAt || b.dueAt)) return null;
                  const ga = geom(a);
                  const gb = geom(b);
                  const x1 = ga.left + ga.width;
                  const y1 = ia * ROW_H + ROW_H / 2;
                  const x2 = gb.left;
                  const y2 = ib * ROW_H + ROW_H / 2;
                  const mid = Math.max(x1 + 10, x2 - 10);
                  return <path key={`${dep.from}-${dep.to}`} d={`M${x1},${y1} H${mid} V${y2} H${x2 - 2}`} fill="none" stroke="var(--danger)" strokeOpacity={0.7} strokeWidth={1.5} markerEnd="url(#arrow)" />;
                })}
              </svg>
              {rows.map((r, i) => {
                if (r.type !== 'card') return null;
                const c = r.card!;
                const g = geom(c);
                const label = data.labels.find((l) => c.labelIds.includes(l.id));
                return (
                  <div key={r.key} className="absolute z-20" style={{ top: i * ROW_H + 5, left: g.left, width: g.width, height: ROW_H - 10 }}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${c.title}, ${c.startAt ? format(new Date(c.startAt), 'MMM d') : ''} to ${c.dueAt ? format(new Date(c.dueAt), 'MMM d') : ''}`}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenCard(c)}
                      onClick={() => !drag && onOpenCard(c)}
                      onPointerDown={(e) => {
                        if (!canEdit || e.button !== 0) return;
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        const edge = e.clientX - rect.left < 8 ? 'start' : rect.right - e.clientX < 8 ? 'end' : 'move';
                        e.preventDefault();
                        setDrag({ id: c.id, mode: edge, x0: e.clientX, delta: 0 });
                      }}
                      className={cn('group relative flex h-full items-center gap-1.5 overflow-hidden rounded-md px-2 text-[11.5px] font-medium text-white shadow-sm focus-ring', barTone[dueState(c.dueAt, c.completedAt)], canEdit && 'cursor-grab active:cursor-grabbing', drag?.id === c.id && 'ring-2 ring-fg')}
                      title={c.title}
                    >
                      {canEdit && <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />}
                      {label && <span className="size-1.5 shrink-0 rounded-full" style={{ background: label.color }} />}
                      <span className="truncate">{c.title}</span>
                      {canEdit && <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {!rows.length && <p className="absolute inset-x-0 top-24 text-center text-sm text-muted">No cards with dates. Add start or due dates to plan them on the timeline.</p>}
        </div>
      </div>
    </div>
  );
}

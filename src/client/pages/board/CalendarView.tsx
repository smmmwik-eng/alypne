import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { addDays, addMonths, addWeeks, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight, Flag, Rocket, Bug, CheckCircle2 } from 'lucide-react';
import type { BoardData, CardSummary } from '@/lib/types';
import { cn, dueState } from '@/lib/format';
import { Button, Checkbox, Tabs } from '@/components/ui';
import type { BoardActions } from './useBoardActions';

const stateClass: Record<string, string> = {
  overdue: 'border-l-danger',
  today: 'border-l-warning',
  soon: 'border-l-warning',
  done: 'border-l-success opacity-70',
  later: 'border-l-accent',
  none: 'border-l-line-strong',
};

function Chip({ card, data, onOpen, kind, canEdit }: { card: CardSummary; data: BoardData; onOpen: (c: CardSummary) => void; kind: 'due' | 'start'; canEdit: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `${kind}:${card.id}`, disabled: !canEdit, data: { card, kind } });
  const label = data.labels.find((l) => card.labelIds.includes(l.id));
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(card)}
      className={cn('flex w-full items-center gap-1 truncate rounded border-l-2 bg-card px-1.5 py-0.5 text-left text-[11.5px] shadow-sm hover:bg-card-hover focus-ring', kind === 'start' ? 'border-l-info border-dashed text-muted' : stateClass[dueState(card.dueAt, card.completedAt)], isDragging && 'opacity-30')}
      title={`${card.title}${kind === 'start' ? ' (starts)' : ''}`}
    >
      {card.completedAt ? <CheckCircle2 className="size-3 shrink-0 text-success" /> : card.type === 'bug' ? <Bug className="size-3 shrink-0 text-danger" /> : label ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: label.color }} /> : null}
      <span className="truncate">{card.title}</span>
    </button>
  );
}

function DayCell({ day, children, muted, compact }: { day: Date; children: React.ReactNode; muted: boolean; compact: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${format(day, 'yyyy-MM-dd')}` });
  return (
    <div ref={setNodeRef} className={cn('flex flex-col gap-0.5 border-r border-b border-line p-1', compact ? 'min-h-[104px]' : 'min-h-[340px]', muted && 'bg-surface-2/30', isOver && 'bg-accent-soft')}>
      <div className={cn('mb-0.5 flex size-6 items-center justify-center self-end rounded-full text-[11px]', isToday(day) ? 'bg-accent font-semibold text-accent-fg' : muted ? 'text-faint' : 'text-muted')}>{format(day, 'd')}</div>
      {children}
    </div>
  );
}

export function CalendarView({ data, cards, actions, canEdit, onOpenCard }: { data: BoardData; cards: CardSummary[]; actions: BoardActions; canEdit: boolean; onOpenCard: (c: CardSummary) => void }) {
  const [mode, setMode] = useState<'month' | 'week'>(() => (window.innerWidth < 640 ? 'week' : 'month'));
  const [cursor, setCursor] = useState(new Date());
  const [showStart, setShowStart] = useState(true);
  const [dragging, setDragging] = useState<CardSummary | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }), useSensor(KeyboardSensor));

  const days = useMemo(() => {
    const start = mode === 'month' ? startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }) : startOfWeek(cursor, { weekStartsOn: 1 });
    const end = mode === 'month' ? endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) : endOfWeek(cursor, { weekStartsOn: 1 });
    const out: Date[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
  }, [cursor, mode]);

  const unscheduled = cards.filter((c) => !c.dueAt && !c.completedAt);

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const over = e.over ? String(e.over.id) : null;
    const info = e.active.data.current as { card: CardSummary; kind: 'due' | 'start' } | undefined;
    if (!over || !info) return;
    if (!over.startsWith('day:')) return;
    const [y, m, d] = over.slice(4).split('-').map(Number);
    const prev = info.kind === 'due' ? info.card.dueAt : info.card.startAt;
    const base = prev ? new Date(prev) : null;
    const next = new Date(y, m - 1, d, base ? base.getHours() : 17, base ? base.getMinutes() : 0);
    if (base && isSameDay(base, next)) return;
    if (info.kind === 'due') {
      // Keep the duration when moving the due date of a card that also has a start date.
      const patch: Record<string, string | null> = { dueAt: next.toISOString() };
      if (info.card.startAt && info.card.dueAt) {
        const dur = new Date(info.card.dueAt).getTime() - new Date(info.card.startAt).getTime();
        patch.startAt = new Date(next.getTime() - dur).toISOString();
      } else if (info.card.startAt && new Date(info.card.startAt) > next) patch.startAt = null;
      actions.updateCard(info.card.id, patch);
    } else {
      if (info.card.dueAt && next > new Date(info.card.dueAt)) return;
      actions.updateCard(info.card.id, { startAt: next.toISOString() });
    }
  };

  const markers = (day: Date) => [
    ...data.milestones.filter((m) => isSameDay(new Date(m.date), day)).map((m) => ({ id: m.id, icon: <Flag className="size-3" />, label: m.name })),
    ...data.releases.filter((r) => r.plannedDate && isSameDay(new Date(r.plannedDate), day)).map((r) => ({ id: r.id, icon: <Rocket className="size-3" />, label: `${r.name} ${r.version}` })),
  ];

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setDragging((e.active.data.current as any)?.card ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="flex h-full min-h-0 flex-col gap-3 p-3 md:flex-row md:p-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <h2 className="min-w-36 text-sm font-semibold">{mode === 'month' ? format(cursor, 'MMMM yyyy') : `${format(days[0], 'MMM d')} – ${format(days[6], 'MMM d, yyyy')}`}</h2>
            <div className="flex items-center gap-1">
              <Button size="icon-sm" variant="ghost" onClick={() => setCursor(mode === 'month' ? addMonths(cursor, -1) : addWeeks(cursor, -1))} aria-label="Previous">
                <ChevronLeft className="size-4" />
              </Button>
              <Button size="xs" onClick={() => setCursor(new Date())}>
                Today
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => setCursor(mode === 'month' ? addMonths(cursor, 1) : addWeeks(cursor, 1))} aria-label="Next">
                <ChevronRight className="size-4" />
              </Button>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <Checkbox checked={showStart} onChange={setShowStart} label={<span className="text-[12px]">Start dates</span>} />
              <Tabs value={mode} onChange={setMode} tabs={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} />
            </div>
          </div>
          <div className="grid grid-cols-7 border-b border-line text-center text-[11px] font-medium text-faint uppercase">
            {days.slice(0, 7).map((d) => (
              <div key={d.toISOString()} className="py-1.5">
                {format(d, 'EEE')}
              </div>
            ))}
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto">
            {days.map((day) => {
              const due = cards.filter((c) => c.dueAt && isSameDay(new Date(c.dueAt), day));
              const starts = showStart ? cards.filter((c) => c.startAt && isSameDay(new Date(c.startAt), day) && !(c.dueAt && isSameDay(new Date(c.dueAt), day))) : [];
              const limit = mode === 'month' ? 4 : 50;
              const all = [...due.map((c) => ({ c, k: 'due' as const })), ...starts.map((c) => ({ c, k: 'start' as const }))];
              return (
                <DayCell key={day.toISOString()} day={day} muted={mode === 'month' && !isSameMonth(day, cursor)} compact={mode === 'month'}>
                  {markers(day).map((m) => (
                    <span key={m.id} className="flex items-center gap-1 truncate rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent">
                      {m.icon}
                      <span className="truncate">{m.label}</span>
                    </span>
                  ))}
                  {all.slice(0, limit).map(({ c, k }) => (
                    <Chip key={`${k}${c.id}`} card={c} data={data} onOpen={onOpenCard} kind={k} canEdit={canEdit} />
                  ))}
                  {all.length > limit && (
                    <button onClick={() => (setMode('week'), setCursor(day))} className="px-1 text-left text-[11px] text-muted hover:text-fg">
                      +{all.length - limit} more
                    </button>
                  )}
                </DayCell>
              );
            })}
          </div>
        </div>
        <UnscheduledPanel cards={unscheduled} data={data} onOpen={onOpenCard} canEdit={canEdit} />
      </div>
      <DragOverlay>{dragging ? <div className="w-44 rounded bg-card px-2 py-1 text-[12px] shadow-pop">{dragging.title}</div> : null}</DragOverlay>
    </DndContext>
  );
}

function UnscheduledPanel({ cards, data, onOpen, canEdit }: { cards: CardSummary[]; data: BoardData; onOpen: (c: CardSummary) => void; canEdit: boolean }) {
  return (
    <aside className="flex max-h-60 shrink-0 flex-col rounded-xl border border-line bg-surface md:max-h-none md:w-60">
      <div className="border-b border-line px-3 py-2">
        <h3 className="text-[13px] font-semibold">No due date</h3>
        <p className="text-[11px] text-faint">{canEdit ? 'Drag a card onto a day to schedule it.' : `${cards.length} open cards`}</p>
      </div>
      <div className="space-y-1 overflow-y-auto p-2">
        {cards.map((c) => (
          <Chip key={c.id} card={c} data={data} onOpen={onOpen} kind="due" canEdit={canEdit} />
        ))}
        {!cards.length && <p className="py-4 text-center text-[12px] text-faint">Every open card is scheduled.</p>}
      </div>
    </aside>
  );
}

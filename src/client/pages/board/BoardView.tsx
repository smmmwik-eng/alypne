import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  MeasuringStrategy,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Archive, ArrowDownUp, ChevronsLeftRight, Copy, GripVertical, MoreHorizontal, Plus, Gauge, ArrowRightLeft, X, Workflow } from 'lucide-react';
import type { BoardData, CardSummary, List } from '@/lib/types';
import { cn } from '@/lib/format';
import { api, errorMessage } from '@/lib/api';
import { Button, InlineEdit, MenuItem, MenuLabel, MenuSeparator, Popover, Select, Textarea, Input, usePopover, useToast, ConfirmDialog } from '@/components/ui';
import { CardTile } from './CardTile';
import type { BoardActions } from './useBoardActions';
import { PopoverTitle } from './pickers';

type Columns = Record<string, string[]>;

function buildColumns(lists: List[], cards: CardSummary[]): Columns {
  const cols: Columns = {};
  for (const l of lists) cols[l.id] = [];
  for (const c of [...cards].sort((a, b) => a.position - b.position)) if (cols[c.listId]) cols[c.listId].push(c.id);
  return cols;
}

interface Props {
  data: BoardData;
  visibleCards: CardSummary[];
  filtered: boolean;
  actions: BoardActions;
  canEdit: boolean;
  onOpenCard: (c: CardSummary) => void;
  composerSignal: number;
}

export function BoardView({ data, visibleCards, filtered, actions, canEdit, onOpenCard, composerSignal }: Props) {
  const lists = useMemo(() => [...data.lists].sort((a, b) => a.position - b.position), [data.lists]);
  const cardsById = useMemo(() => new Map(data.cards.map((c) => [c.id, c])), [data.cards]);
  const visibleIds = useMemo(() => new Set(visibleCards.map((c) => c.id)), [visibleCards]);
  const [columns, setColumns] = useState<Columns>(() => buildColumns(lists, visibleCards));
  const [listOrder, setListOrder] = useState<string[]>(() => lists.map((l) => l.id));
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragFrom = useRef<string | null>(null);

  // Sync from server data whenever we're not mid-drag.
  useEffect(() => {
    if (activeId) return;
    setColumns(buildColumns(lists, visibleCards));
    setListOrder(lists.map((l) => l.id));
  }, [lists, visibleCards, activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const findList = (id: string): string | null => {
    if (id.startsWith('list:')) return id.slice(5);
    if (id.startsWith('drop:')) return id.slice(5);
    for (const [lid, ids] of Object.entries(columns)) if (ids.includes(id)) return lid;
    return null;
  };

  const collision: CollisionDetection = (args) => {
    const id = String(args.active.id);
    if (id.startsWith('list:')) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((d) => String(d.id).startsWith('list:')) });
    return closestCorners({ ...args, droppableContainers: args.droppableContainers.filter((d) => !String(d.id).startsWith('list:')) });
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    dragFrom.current = id.startsWith('list:') ? null : findList(id);
  };

  const onDragOver = (e: DragOverEvent) => {
    const a = String(e.active.id);
    if (a.startsWith('list:') || !e.over) return;
    const over = String(e.over.id);
    const from = findList(a);
    const to = findList(over);
    if (!from || !to || from === to) return;
    setColumns((cols) => {
      const fromIds = cols[from].filter((x) => x !== a);
      const toIds = [...cols[to]];
      const overIndex = toIds.indexOf(over);
      const insertAt = overIndex >= 0 ? overIndex : toIds.length;
      toIds.splice(insertAt, 0, a);
      return { ...cols, [from]: fromIds, [to]: toIds };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const a = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    setActiveId(null);
    if (!over) {
      setColumns(buildColumns(lists, visibleCards));
      return;
    }
    if (a.startsWith('list:')) {
      if (a === over) return;
      const oldIndex = listOrder.indexOf(a.slice(5));
      const newIndex = listOrder.indexOf(over.slice(5));
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(listOrder, oldIndex, newIndex);
      setListOrder(next);
      actions.moveList(a.slice(5), newIndex, next);
      return;
    }
    const to = findList(over) ?? findList(a);
    if (!to) return;
    let ids = columns[to];
    const oldIndex = ids.indexOf(a);
    const overIndex = ids.indexOf(over);
    if (overIndex >= 0 && oldIndex !== overIndex) ids = arrayMove(ids, oldIndex, overIndex);
    setColumns((cols) => ({ ...cols, [to]: ids }));
    const card = cardsById.get(a);
    if (!card) return;
    const finalIndexVisible = ids.indexOf(a);
    // Translate an index among visible (filtered) cards into an index among all cards in that list.
    const allInList = data.cards.filter((c) => c.listId === to && c.id !== a).sort((x, y) => x.position - y.position);
    const visibleBefore = ids.slice(0, finalIndexVisible).filter((id) => id !== a);
    const anchor = visibleBefore[visibleBefore.length - 1];
    const serverIndex = anchor ? allInList.findIndex((c) => c.id === anchor) + 1 : filtered ? allInList.findIndex((c) => visibleIds.has(c.id)) : 0;
    const unchanged = dragFrom.current === to && oldIndex === finalIndexVisible;
    if (unchanged && card.listId === to) return;
    const ordered = ids.map((id) => cardsById.get(id)).filter((x): x is CardSummary => !!x);
    actions.moveCard(a, to, Math.max(0, serverIndex), ordered);
  };

  const activeCard = activeId && !activeId.startsWith('list:') ? cardsById.get(activeId) : null;
  const activeList = activeId?.startsWith('list:') ? lists.find((l) => l.id === activeId.slice(5)) : null;
  const orderedLists = listOrder.map((id) => lists.find((l) => l.id === id)).filter((l): l is List => !!l);

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}>
      <div className="flex h-full snap-x snap-mandatory items-start gap-3 overflow-x-auto px-3 pt-3 pb-4 md:snap-none md:px-4" role="list" aria-label="Lists">
        <SortableContext items={orderedLists.map((l) => `list:${l.id}`)} strategy={horizontalListSortingStrategy} disabled={!canEdit}>
          {orderedLists.map((list, i) => (
            <SortableList
              key={list.id}
              list={list}
              data={data}
              cardIds={columns[list.id] ?? []}
              cardsById={cardsById}
              actions={actions}
              canEdit={canEdit}
              onOpenCard={onOpenCard}
              activeId={activeId}
              totalCount={data.cards.filter((c) => c.listId === list.id).length}
              openComposer={i === 0 ? composerSignal : 0}
            />
          ))}
        </SortableContext>
        {canEdit && <AddList actions={actions} />}
        <div className="w-1 shrink-0" />
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' }}>
        {activeCard ? (
          <div className="w-[272px]">
            <CardTile card={activeCard} board={data} onOpen={() => {}} canEdit={false} overlay />
          </div>
        ) : activeList ? (
          <div className="w-[272px] rotate-1 rounded-xl border border-line-strong bg-list p-3 opacity-90 shadow-pop">
            <div className="text-[13px] font-semibold">{activeList.name}</div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableCard({ card, data, actions, canEdit, onOpenCard }: { card: CardSummary; data: BoardData; actions: BoardActions; canEdit: boolean; onOpenCard: (c: CardSummary) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, disabled: !canEdit || card.id.startsWith('temp-') });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} {...attributes} {...listeners} role="listitem" aria-roledescription="Draggable card" className="touch-manipulation outline-none">
      <CardTile card={card} board={data} onOpen={onOpenCard} actions={actions} canEdit={canEdit} dragging={isDragging} />
    </div>
  );
}

function SortableList({ list, data, cardIds, cardsById, actions, canEdit, onOpenCard, activeId, totalCount, openComposer }: { list: List; data: BoardData; cardIds: string[]; cardsById: Map<string, CardSummary>; actions: BoardActions; canEdit: boolean; onOpenCard: (c: CardSummary) => void; activeId: string | null; totalCount: number; openComposer: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `list:${list.id}`, disabled: !canEdit });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `drop:${list.id}` });
  const stage = data.stages.find((s) => s.id === list.stageId);
  const overLimit = list.wipLimit !== null && totalCount > list.wipLimit;
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (openComposer) setComposing(true);
  }, [openComposer]);

  if (list.collapsed) {
    return (
      <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('flex h-auto w-10 shrink-0 snap-start flex-col items-center gap-2 rounded-xl border border-line bg-list py-3', isDragging && 'opacity-40')}>
        <button onClick={() => actions.updateList(list.id, { collapsed: false })} aria-label={`Expand ${list.name}`} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
          <ChevronsLeftRight className="size-3.5" />
        </button>
        <span className="text-[13px] font-semibold [writing-mode:vertical-rl]">{list.name}</span>
        <span className="text-[11px] text-faint">{totalCount}</span>
      </div>
    );
  }

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('flex max-h-full w-[min(85vw,284px)] shrink-0 snap-start flex-col rounded-xl border border-line bg-list md:w-[284px]', isDragging && 'opacity-40')}
      aria-label={`List ${list.name}`}
    >
      <header className="group/list flex items-center gap-1.5 px-2 pt-2 pb-1">
        {canEdit && (
          <button {...attributes} {...listeners} aria-label={`Drag list ${list.name}`} className="cursor-grab rounded p-0.5 text-faint opacity-0 transition-opacity group-hover/list:opacity-100 hover:text-fg focus:opacity-100 active:cursor-grabbing focus-ring">
            <GripVertical className="size-3.5" />
          </button>
        )}
        {stage && <span className="size-2 shrink-0 rounded-full" style={{ background: stage.color }} title={`Stage: ${stage.name}`} />}
        <div className="min-w-0 flex-1">
          <InlineEdit value={list.name} onSave={(name) => actions.updateList(list.id, { name })} disabled={!canEdit} ariaLabel="list name" className="block w-full truncate px-1 py-0.5 text-[13px] font-semibold" inputClassName="text-[13px] font-semibold py-0.5" />
        </div>
        <span className={cn('rounded px-1.5 text-[11px] tabular-nums', overLimit ? 'bg-danger-soft font-semibold text-danger' : 'text-faint')} title={list.wipLimit ? `WIP limit ${list.wipLimit}` : undefined}>
          {totalCount}
          {list.wipLimit ? `/${list.wipLimit}` : ''}
        </span>
        {canEdit && <ListMenu list={list} data={data} actions={actions} onAddCard={() => setComposing(true)} />}
      </header>
      <div ref={setDropRef} className={cn('flex min-h-2 flex-col gap-1.5 overflow-y-auto px-2 pb-1', isOver && cardIds.length === 0 && 'rounded-lg bg-accent-soft/40')}>
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {cardIds.map((id) => {
            const c = cardsById.get(id);
            return c ? <SortableCard key={id} card={c} data={data} actions={actions} canEdit={canEdit} onOpenCard={onOpenCard} /> : null;
          })}
        </SortableContext>
        {cardIds.length === 0 && !activeId && !composing && <p className="py-2 text-center text-xs text-faint">{totalCount ? 'No cards match the filters' : 'No cards yet'}</p>}
      </div>
      {canEdit && (composing ? <CardComposer listId={list.id} actions={actions} onClose={() => setComposing(false)} /> : (
        <button onClick={() => setComposing(true)} className="m-2 mt-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-ring">
          <Plus className="size-3.5" /> Add a card
        </button>
      ))}
    </section>
  );
}

function CardComposer({ listId, actions, onClose }: { listId: string; actions: BoardActions; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    const t = title.trim();
    if (!t) return;
    actions.createCard(listId, t);
    setTitle('');
    ref.current?.focus();
  };
  return (
    <div className="m-2 mt-1 space-y-1.5">
      <Textarea
        ref={ref}
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Card title… (Enter to add, Shift+Enter for new line)"
        rows={2}
        className="min-h-0 text-[13px]"
        aria-label="New card title"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="primary" onClick={submit} disabled={!title.trim()}>
          Add card
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Cancel">
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function AddList({ actions }: { actions: BoardActions }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex w-[284px] shrink-0 items-center gap-2 rounded-xl border border-dashed border-line-strong bg-list/50 px-3 py-2.5 text-[13px] text-muted transition-colors hover:bg-list hover:text-fg focus-ring">
        <Plus className="size-4" /> Add another list
      </button>
    );
  }
  return (
    <form
      className="w-[284px] shrink-0 space-y-2 rounded-xl border border-line bg-list p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        actions.createList(name.trim());
        setName('');
      }}
    >
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="List name" aria-label="List name" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>
          Add list
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => setOpen(false)} aria-label="Cancel">
          <X className="size-4" />
        </Button>
      </div>
    </form>
  );
}

function ListMenu({ list, data, actions, onAddCard }: { list: List; data: BoardData; actions: BoardActions; onAddCard: () => void }) {
  const p = usePopover();
  const [panel, setPanel] = useState<null | 'stage' | 'wip' | 'copy' | 'move' | 'moveCards' | 'sort'>(null);
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState<null | 'archiveCards'>(null);
  const toast = useToast();
  const close = () => {
    p.close();
    setPanel(null);
  };
  const call = async (fn: () => Promise<any>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      actions.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    close();
  };
  const otherLists = data.lists.filter((l) => l.id !== list.id);
  return (
    <>
      <button ref={p.anchorRef as any} onClick={p.toggle} aria-label={`List actions for ${list.name}`} aria-haspopup="menu" className="rounded-md p-1 text-faint hover:bg-surface-2 hover:text-fg focus-ring">
        <MoreHorizontal className="size-4" />
      </button>
      <Popover open={p.open} onClose={close} anchor={p.anchorRef} align="start" width={250}>
        {panel === null && (
          <div role="menu">
            <MenuLabel>List actions</MenuLabel>
            <MenuItem icon={<Plus />} onClick={() => (close(), onAddCard())}>
              Add card
            </MenuItem>
            <MenuItem icon={<Copy />} onClick={() => (setValue(`${list.name} (copy)`), setPanel('copy'))}>
              Copy list
            </MenuItem>
            <MenuItem icon={<ArrowRightLeft />} onClick={() => setPanel('move')}>
              Move list to another board
            </MenuItem>
            <MenuItem icon={<ArrowDownUp />} onClick={() => setPanel('sort')}>
              Sort cards by…
            </MenuItem>
            <MenuItem icon={<ArrowRightLeft />} onClick={() => setPanel('moveCards')} disabled={!otherLists.length}>
              Move all cards to…
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Workflow />} onClick={() => setPanel('stage')}>
              Workflow stage
            </MenuItem>
            <MenuItem icon={<Gauge />} onClick={() => (setValue(list.wipLimit ? String(list.wipLimit) : ''), setPanel('wip'))}>
              WIP limit
            </MenuItem>
            <MenuItem icon={<ChevronsLeftRight />} onClick={() => (close(), actions.updateList(list.id, { collapsed: true }))}>
              Collapse list
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Archive />} onClick={() => (close(), setConfirm('archiveCards'))}>
              Archive all cards in list
            </MenuItem>
            <MenuItem icon={<Archive />} danger onClick={() => (close(), actions.archiveList(list.id))}>
              Archive list
            </MenuItem>
          </div>
        )}
        {panel === 'stage' && (
          <div className="p-1">
            <PopoverTitle onClose={close}>Workflow stage</PopoverTitle>
            <p className="mb-2 px-1.5 text-xs text-faint">Cards moved into a “done” stage are marked complete automatically.</p>
            <MenuItem onClick={() => (close(), actions.updateList(list.id, { stageId: null }))} active={!list.stageId}>
              No stage
            </MenuItem>
            {data.stages.map((s) => (
              <MenuItem key={s.id} icon={<span className="size-2.5 rounded-full" style={{ background: s.color }} />} onClick={() => (close(), actions.updateList(list.id, { stageId: s.id }))} active={list.stageId === s.id}>
                {s.name} <span className="text-faint">· {s.category.replace('_', ' ')}</span>
              </MenuItem>
            ))}
          </div>
        )}
        {panel === 'wip' && (
          <form
            className="space-y-2 p-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              close();
              actions.updateList(list.id, { wipLimit: value ? Math.max(1, Number(value)) : null });
            }}
          >
            <PopoverTitle onClose={close}>Work-in-progress limit</PopoverTitle>
            <Input type="number" min={1} max={999} value={value} onChange={(e) => setValue(e.target.value)} placeholder="No limit" autoFocus />
            <Button type="submit" size="sm" variant="primary" className="w-full justify-center">
              Save
            </Button>
          </form>
        )}
        {panel === 'copy' && (
          <form
            className="space-y-2 p-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              call(() => api.post(`/lists/${list.id}/copy`, { name: value }), 'List copied');
            }}
          >
            <PopoverTitle onClose={close}>Copy list</PopoverTitle>
            <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            <Button type="submit" size="sm" variant="primary" className="w-full justify-center" disabled={!value.trim()}>
              Create list
            </Button>
          </form>
        )}
        {panel === 'sort' && (
          <div className="p-1">
            <PopoverTitle onClose={close}>Sort cards</PopoverTitle>
            {(
              [
                ['dueAt', 'Due date (soonest first)'],
                ['priority', 'Priority (highest first)'],
                ['createdAt', 'Date created (oldest first)'],
                ['title', 'Card name (A–Z)'],
              ] as const
            ).map(([by, label]) => (
              <MenuItem key={by} onClick={() => call(() => api.post(`/lists/${list.id}/sort`, { by }), 'List sorted')}>
                {label}
              </MenuItem>
            ))}
          </div>
        )}
        {panel === 'moveCards' && (
          <div className="p-1">
            <PopoverTitle onClose={close}>Move all cards to</PopoverTitle>
            {otherLists.map((l) => (
              <MenuItem key={l.id} onClick={() => call(() => api.post(`/lists/${list.id}/move-cards`, { toListId: l.id }), 'Cards moved')}>
                {l.name}
              </MenuItem>
            ))}
          </div>
        )}
        {panel === 'move' && <MoveListPanel list={list} data={data} onClose={close} onMove={(boardId) => call(() => api.post(`/lists/${list.id}/move`, { boardId, index: 0 }), 'List moved')} />}
      </Popover>
      <ConfirmDialog
        open={confirm === 'archiveCards'}
        onClose={() => setConfirm(null)}
        title="Archive all cards in this list?"
        description="Every card in this list will be archived. You can restore them from the board's archived items."
        confirmLabel="Archive cards"
        onConfirm={() => {
          setConfirm(null);
          call(() => api.post(`/lists/${list.id}/archive-cards`), 'Cards archived');
        }}
      />
    </>
  );
}

function MoveListPanel({ data, onClose, onMove }: { list: List; data: BoardData; onClose: () => void; onMove: (boardId: string) => void }) {
  const [boards, setBoards] = useState<any[] | null>(null);
  const [target, setTarget] = useState('');
  useEffect(() => {
    api.get(`/workspaces/${data.board.workspaceId}/boards`).then((r) => setBoards(r.boards.filter((b: any) => b.id !== data.board.id)));
  }, [data.board.workspaceId, data.board.id]);
  return (
    <div className="space-y-2 p-1.5">
      <PopoverTitle onClose={onClose}>Move list to board</PopoverTitle>
      <Select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Choose a board…</option>
        {boards?.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </Select>
      <p className="text-[11px] text-faint">Labels with the same name and colour carry over; board-specific custom fields do not.</p>
      <Button size="sm" variant="primary" className="w-full justify-center" disabled={!target} onClick={() => onMove(target)}>
        Move list
      </Button>
    </div>
  );
}

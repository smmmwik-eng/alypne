import { useMemo, useState, type ReactNode } from 'react';
import { Check, Pencil, Plus, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import type { BoardData, CardSummary } from '@/lib/types';
import { cn, fromLocalInput, toLocalInput } from '@/lib/format';
import { LABEL_COLORS, PRIORITIES, PRIORITY_META, type Priority } from '@shared/constants';
import { Avatar, Button, ColorSwatches, Field, Input, MenuItem, Select, useToast } from '@/components/ui';
import { errorMessage } from '@/lib/api';

export function PickerSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative mb-1.5">
      <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
      <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-8 w-full rounded-lg border border-line bg-surface-2 pr-2 pl-8 text-[13px] outline-none focus:border-accent" />
    </div>
  );
}

export function LabelPicker({ board, selected, onToggle, canManage }: { board: BoardData; selected: string[]; onToggle: (id: string) => void; canManage: boolean }) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ id?: string; name: string; color: string } | null>(null);
  const toast = useToast();
  const labels = board.labels.filter((l) => l.name.toLowerCase().includes(q.toLowerCase()));
  const save = async () => {
    if (!editing) return;
    try {
      if (editing.id) await api.patch(`/boards/${board.board.id}/labels/${editing.id}`, { name: editing.name, color: editing.color });
      else await api.post(`/boards/${board.board.id}/labels`, { name: editing.name, color: editing.color });
      setEditing(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async () => {
    if (!editing?.id) return;
    try {
      await api.del(`/boards/${board.board.id}/labels/${editing.id}`);
      setEditing(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  if (editing) {
    return (
      <div className="space-y-3 p-1.5">
        <div className="h-8 rounded-md px-2 text-[13px] leading-8 font-medium text-black/80" style={{ background: editing.color }}>
          {editing.name || ' '}
        </div>
        <Field label="Name">
          <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={60} autoFocus />
        </Field>
        <ColorSwatches colors={LABEL_COLORS} value={editing.color} onChange={(c) => setEditing({ ...editing, color: c })} size={26} />
        <div className="flex justify-between gap-2">
          {editing.id ? (
            <Button variant="ghost" size="sm" className="text-danger" onClick={remove}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Back
            </Button>
            <Button size="sm" variant="primary" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <PickerSearch value={q} onChange={setQ} placeholder="Search labels" />
      <div className="space-y-0.5">
        {labels.map((l) => (
          <div key={l.id} className="flex items-center gap-1">
            <button onClick={() => onToggle(l.id)} className="flex flex-1 items-center gap-2 rounded-lg p-1 hover:bg-surface-2 focus-ring" role="menuitemcheckbox" aria-checked={selected.includes(l.id)}>
              <span className={cn('flex size-4 items-center justify-center rounded border', selected.includes(l.id) ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong')}>{selected.includes(l.id) && <Check className="size-3" strokeWidth={3} />}</span>
              <span className="h-7 flex-1 truncate rounded-md px-2 text-left text-[13px] leading-7 font-medium text-black/80" style={{ background: l.color }}>
                {l.name}
              </span>
            </button>
            {canManage && (
              <button className="rounded-md p-1.5 text-faint hover:bg-surface-2 hover:text-fg" aria-label={`Edit label ${l.name}`} onClick={() => setEditing({ id: l.id, name: l.name, color: l.color })}>
                <Pencil className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        {!labels.length && <p className="px-2 py-3 text-center text-xs text-faint">No labels</p>}
      </div>
      {canManage && (
        <Button variant="ghost" size="sm" className="mt-1.5 w-full justify-center" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ name: q, color: LABEL_COLORS[board.labels.length % LABEL_COLORS.length] })}>
          Create a label
        </Button>
      )}
    </div>
  );
}

export function MemberPicker({ board, selected, onToggle }: { board: BoardData; selected: string[]; onToggle: (id: string) => void }) {
  const [q, setQ] = useState('');
  const members = board.members.filter((m) => m.role !== 'observer' && (m.displayName.toLowerCase().includes(q.toLowerCase()) || m.username.toLowerCase().includes(q.toLowerCase())));
  return (
    <div>
      <PickerSearch value={q} onChange={setQ} placeholder="Search members" />
      {members.map((m) => (
        <button key={m.id} onClick={() => onToggle(m.id)} role="menuitemcheckbox" aria-checked={selected.includes(m.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 focus-ring">
          <Avatar name={m.displayName} src={m.avatarUrl} size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{m.displayName}</span>
            <span className="block truncate text-[11px] text-faint">@{m.username}</span>
          </span>
          {selected.includes(m.id) && <Check className="size-4 text-accent" />}
        </button>
      ))}
      {!members.length && <p className="px-2 py-3 text-center text-xs text-faint">No matching members who can edit this board</p>}
    </div>
  );
}

export function PriorityPicker({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  return (
    <div role="menu">
      {[...PRIORITIES].reverse().map((p) => (
        <MenuItem key={p} icon={<span className="size-2.5 rounded-full" style={{ background: PRIORITY_META[p].color }} />} onClick={() => onChange(p)} active={value === p}>
          <span className="flex items-center justify-between">
            {PRIORITY_META[p].label}
            {value === p && <Check className="size-3.5 text-accent" />}
          </span>
        </MenuItem>
      ))}
    </div>
  );
}

const REMINDERS: [number | null, string][] = [
  [null, 'Default (1 day before)'],
  [0, 'At time of due date'],
  [15, '15 minutes before'],
  [60, '1 hour before'],
  [120, '2 hours before'],
  [1440, '1 day before'],
  [2880, '2 days before'],
  [10080, '1 week before'],
];

export function DatesEditor({ startAt, dueAt, reminderMinutes, onSave, onClose }: { startAt: string | null; dueAt: string | null; reminderMinutes?: number | null; onSave: (v: { startAt: string | null; dueAt: string | null; reminderMinutes?: number | null }) => void; onClose: () => void }) {
  const [start, setStart] = useState(toLocalInput(startAt));
  const [due, setDue] = useState(toLocalInput(dueAt));
  const [reminder, setReminder] = useState<number | null>(reminderMinutes ?? null);
  const invalid = start && due && new Date(start) > new Date(due);
  return (
    <div className="space-y-3 p-1.5">
      <Field label="Start date">
        <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
      </Field>
      <Field label="Due date" error={invalid ? 'Start must be before due' : null}>
        <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      {reminderMinutes !== undefined && (
        <Field label="Reminder" hint="Assignees are notified (in-app and email if enabled).">
          <Select value={reminder === null ? '' : String(reminder)} onChange={(e) => setReminder(e.target.value === '' ? null : Number(e.target.value))} disabled={!due}>
            {REMINDERS.map(([v, l]) => (
              <option key={String(v)} value={v === null ? '' : String(v)}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className="text-[11px] text-faint">Times are in your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
      <div className="flex justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onSave({ startAt: null, dueAt: null, ...(reminderMinutes !== undefined ? { reminderMinutes: null } : {}) });
            onClose();
          }}
        >
          Remove dates
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!!invalid}
          onClick={() => {
            onSave({ startAt: fromLocalInput(start), dueAt: fromLocalInput(due), ...(reminderMinutes !== undefined ? { reminderMinutes: reminder } : {}) });
            onClose();
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/** Choose a destination board / list / position: the accessible alternative to drag-and-drop. */
export function MoveTargetPicker({ board, card, mode, onDone, onClose }: { board: BoardData; card: CardSummary; mode: 'move' | 'copy'; onDone: () => void; onClose: () => void }) {
  const [boardId, setBoardId] = useState(board.board.id);
  const [listId, setListId] = useState(card.listId);
  const [title, setTitle] = useState(card.title);
  const [position, setPosition] = useState<number>(-1);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const boards = useQuery({ queryKey: ['boards', board.board.workspaceId], queryFn: () => api.get(`/workspaces/${board.board.workspaceId}/boards`).then((r) => r.boards as any[]) });
  const target = useQuery({ queryKey: ['board', boardId], queryFn: () => api.get<BoardData>(`/boards/${boardId}`), enabled: boardId !== board.board.id });
  const targetData = boardId === board.board.id ? board : target.data;
  const lists = targetData?.lists ?? [];
  const listCards = useMemo(() => (targetData?.cards ?? []).filter((c) => c.listId === listId && c.id !== card.id).sort((a, b) => a.position - b.position), [targetData, listId, card.id]);
  const writable = boards.data ?? [];
  const submit = async () => {
    setBusy(true);
    try {
      const index = position < 0 ? listCards.length : position;
      if (mode === 'move') await api.post(`/cards/${card.id}/move`, { listId, index });
      else await api.post(`/cards/${card.id}/duplicate`, { listId, index, title });
      toast.success(mode === 'move' ? 'Card moved' : 'Card copied');
      onDone();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 p-1.5">
      {mode === 'copy' && (
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      )}
      <Field label="Board">
        <Select
          value={boardId}
          onChange={(e) => {
            setBoardId(e.target.value);
            setListId('');
            setPosition(-1);
          }}
        >
          {writable.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.id === board.board.id ? ' (current)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-[1fr_110px] gap-2">
        <Field label="List">
          <Select value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="" disabled>
              Choose…
            </option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Position">
          <Select value={String(position)} onChange={(e) => setPosition(Number(e.target.value))}>
            {listCards.map((_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
            <option value={-1}>{listCards.length + 1} (bottom)</option>
          </Select>
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!listId} onClick={submit}>
          {mode === 'move' ? 'Move' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

export function PopoverTitle({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="mb-1.5 flex items-center justify-between px-1.5 pt-0.5">
      <span className="text-[13px] font-semibold">{children}</span>
      <button onClick={onClose} className="rounded p-1 text-faint hover:bg-surface-2 hover:text-fg" aria-label="Close">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router-dom';
import {
  AlignLeft,
  Bug,
  CheckSquare,
  Download,
  ExternalLink,
  GitPullRequest,
  GitCommit,
  CircleDot,
  GripVertical,
  Image as ImageIcon,
  Link2,
  Paperclip,
  Plus,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
  Gamepad2,
  Lock,
  Unlock,
  ArrowLeftRight,
  Copy,
  Clock,
  UserPlus,
  Package,
} from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import type { BoardData, CardDetail, Checklist, ChecklistItem, CustomField } from '@/lib/types';
import { cn, formatBytesSafe, fromLocalInput, relativeTime, shortDate, toLocalInput } from './util';
import { Markdown } from '@/lib/markdown';
import { MarkdownEditor } from '@/components/Editor';
import { Avatar, Button, Checkbox, ConfirmDialog, InlineEdit, Input, Popover, Progress, Select, Spinner, Textarea, usePopover, useToast, MenuItem } from '@/components/ui';
import { BUG_REPRO, BUG_RESOLUTIONS, BUG_SEVERITIES, PLATFORMS } from '@shared/constants';
import { MemberPicker, PopoverTitle, PickerSearch } from '../pickers';
import { useDebounced } from '@/lib/hooks';

export function Section({ icon, title, actions, children, id }: { icon: ReactNode; title: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="scroll-mt-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted [&>svg]:size-4">{icon}</span>
        <h3 className="flex-1 text-sm font-semibold">{title}</h3>
        {actions}
      </div>
      <div className="pl-6">{children}</div>
    </section>
  );
}

/* ========================================================== description */

export function DescriptionSection({ detail, board, canEdit, onSaved }: { detail: CardDetail; board: BoardData; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const save = async (v: string) => {
    setSaving(true);
    try {
      await api.patch(`/cards/${detail.card.id}`, { description: v, version: detail.card.version });
      setEditing(false);
      setConflict(null);
      onSaved();
    } catch (e: any) {
      if (e.status === 409) {
        setConflict(v);
        qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      } else toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Section icon={<AlignLeft />} title="Description" actions={canEdit && !editing && detail.card.description ? <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>Edit</Button> : null}>
      {conflict !== null && (
        <div className="mb-2 rounded-lg border border-warning/40 bg-warning-soft p-2.5 text-[13px] text-warning" role="alert">
          Someone else edited this description while you were writing. The latest version is shown below; your draft is kept in the editor so you can merge it.
        </div>
      )}
      {editing || conflict !== null ? (
        <MarkdownEditor key={detail.card.version} value={conflict ?? detail.card.description} onSave={save} onCancel={() => (setEditing(false), setConflict(null))} members={board.members} saving={saving} />
      ) : detail.card.description ? (
        <div onDoubleClick={() => canEdit && setEditing(true)}>
          <Markdown source={detail.card.description} />
        </div>
      ) : canEdit ? (
        <button onClick={() => setEditing(true)} className="w-full rounded-lg bg-surface-2 px-3 py-3 text-left text-sm text-faint hover:bg-surface-3">
          Add a more detailed description…
        </button>
      ) : (
        <p className="text-sm text-faint">No description.</p>
      )}
      {conflict !== null && detail.card.description && (
        <div className="mt-2 rounded-lg border border-line p-2.5">
          <div className="mb-1 text-[11px] font-medium text-faint uppercase">Latest saved version</div>
          <Markdown source={detail.card.description} />
        </div>
      )}
    </Section>
  );
}

/* ======================================================== custom fields */

function FieldInput({ field, value, board, onChange, disabled }: { field: CustomField; value: any; board: BoardData; onChange: (v: any) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(value ?? '');
  switch (field.type) {
    case 'checkbox':
      return <Checkbox checked={!!value} onChange={(v) => onChange(v)} disabled={disabled} />;
    case 'dropdown':
      return (
        <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} className="h-8">
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case 'user':
      return (
        <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} className="h-8">
          <option value="">—</option>
          {board.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </Select>
      );
    case 'date':
      return <Input type="datetime-local" className="h-8" value={toLocalInput(value)} onChange={(e) => onChange(fromLocalInput(e.target.value))} disabled={disabled} />;
    case 'number':
      return <Input type="number" className="h-8" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => String(draft) !== String(value ?? '') && onChange(draft === '' ? null : Number(draft))} disabled={disabled} />;
    case 'url':
      return (
        <div className="flex gap-1">
          <Input type="url" className="h-8" value={draft} placeholder="https://" onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== (value ?? '') && onChange(draft || null)} disabled={disabled} />
          {value && (
            <a href={value} target="_blank" rel="noopener noreferrer" className="flex items-center rounded-lg border border-line px-2 text-muted hover:text-fg" aria-label="Open link">
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      );
    default:
      return <Input className="h-8" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== (value ?? '') && onChange(draft || null)} disabled={disabled} />;
  }
}

export function CustomFieldsSection({ detail, board, canEdit, onChanged }: { detail: CardDetail; board: BoardData; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  if (!board.customFields.length) return null;
  const set = async (f: CustomField, v: any) => {
    try {
      await api.put(`/cards/${detail.card.id}/custom-fields/${f.id}`, { value: v });
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Section icon={<SlidersHorizontal />} title="Custom fields" id="custom-fields">
      <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2">
        {board.customFields.map((f) => (
          <label key={`${f.id}-${detail.card.version}`} className="block">
            <span className="mb-1 block text-xs text-muted">{f.name}</span>
            <FieldInput field={f} value={detail.customFields[f.id]} board={board} onChange={(v) => set(f, v)} disabled={!canEdit} />
          </label>
        ))}
      </div>
    </Section>
  );
}

/* ========================================================== bug details */

export function BugSection({ detail, canEdit, onChanged }: { detail: CardDetail; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const bug = detail.bug;
  if (detail.card.type !== 'bug' || !bug) return null;
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.patch(`/cards/${detail.card.id}/bug`, patch);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const text = (key: 'stepsToReproduce' | 'expectedBehaviour' | 'actualBehaviour', label: string, placeholder: string) => (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <Textarea key={`${key}-${detail.card.version}`} defaultValue={bug[key]} placeholder={placeholder} rows={key === 'stepsToReproduce' ? 4 : 2} disabled={!canEdit} onBlur={(e) => e.target.value !== bug[key] && save({ [key]: e.target.value })} className="text-[13px]" />
    </label>
  );
  return (
    <Section icon={<Bug />} title="Bug report">
      <div className="space-y-3 rounded-xl border border-line bg-surface-2/40 p-3">
        <div className="grid gap-2.5 sm:grid-cols-3">
          <label>
            <span className="mb-1 block text-xs text-muted">Severity</span>
            <Select value={bug.severity} onChange={(e) => save({ severity: e.target.value })} disabled={!canEdit} className="h-8 capitalize">
              {BUG_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span className="mb-1 block text-xs text-muted">Reproduction</span>
            <Select value={bug.reproStatus} onChange={(e) => save({ reproStatus: e.target.value })} disabled={!canEdit} className="h-8">
              {BUG_REPRO.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span className="mb-1 block text-xs text-muted">Resolution</span>
            <Select value={bug.resolution} onChange={(e) => save({ resolution: e.target.value })} disabled={!canEdit} className="h-8">
              {BUG_RESOLUTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div>
          <span className="mb-1 block text-xs text-muted">Platforms</span>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => {
              const on = bug.platforms.includes(p);
              return (
                <button key={p} disabled={!canEdit} onClick={() => save({ platforms: on ? bug.platforms.filter((x) => x !== p) : [...bug.platforms, p] })} aria-pressed={on} className={cn('rounded-full border px-2.5 py-0.5 text-xs transition-colors', on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-surface-2')}>
                  {p}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block max-w-xs">
          <span className="mb-1 block text-xs text-muted">Game version / place version</span>
          <Input key={`gv-${detail.card.version}`} className="h-8" defaultValue={bug.gameVersion} disabled={!canEdit} onBlur={(e) => e.target.value !== bug.gameVersion && save({ gameVersion: e.target.value })} placeholder="e.g. 1.4.2 or place v312" />
        </label>
        {text('stepsToReproduce', 'Steps to reproduce', '1. Join the game\n2. …')}
        <div className="grid gap-2.5 sm:grid-cols-2">
          {text('expectedBehaviour', 'Expected behaviour', 'What should happen')}
          {text('actualBehaviour', 'Actual behaviour', 'What actually happens')}
        </div>
      </div>
    </Section>
  );
}

/* ============================================================ checklists */

function SortableItem({ item, children }: { item: ChecklistItem; children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && 'opacity-50')}>
      {children(
        <button {...attributes} {...listeners} aria-label={`Reorder item ${item.text}`} className="cursor-grab rounded p-0.5 text-faint opacity-0 group-hover/item:opacity-100 hover:text-fg focus:opacity-100 active:cursor-grabbing">
          <GripVertical className="size-3.5" />
        </button>,
      )}
    </div>
  );
}

function ChecklistBlock({ cl, detail, board, canEdit, onChanged }: { cl: Checklist; detail: CardDetail; board: BoardData; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [items, setItems] = useState(cl.items);
  const [lastServer, setLastServer] = useState(cl.items);
  if (lastServer !== cl.items) {
    setLastServer(cl.items);
    setItems(cl.items);
  }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const done = items.filter((i) => i.completedAt).length;
  const pct = items.length ? (done / items.length) * 100 : 0;
  const shown = cl.hideCompleted ? items.filter((i) => !i.completedAt) : items;
  const call = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      toast.error(e.status === 409 ? 'This item was edited by someone else — reloaded the latest version.' : errorMessage(e));
    }
    onChanged();
  };
  const toggle = (it: ChecklistItem) => {
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, completedAt: x.completedAt ? null : new Date().toISOString() } : x)));
    qc.setQueryData(['card', detail.card.id], (old: any) => old);
    call(() => api.patch(`/checklist-items/${it.id}`, { completed: !it.completedAt }));
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const oldI = items.findIndex((i) => i.id === e.active.id);
    const newI = items.findIndex((i) => i.id === e.over!.id);
    setItems(arrayMove(items, oldI, newI));
    call(() => api.post(`/checklist-items/${e.active.id}/move`, { index: newI }));
  };
  const addItems = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    call(() => api.post(`/checklists/${cl.id}/items`, { text: t }));
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <CheckSquare className="-ml-6 size-4 text-muted" />
        <InlineEdit value={cl.title} disabled={!canEdit} onSave={(title) => call(() => api.patch(`/checklists/${cl.id}`, { title }))} className="flex-1 px-1 text-sm font-semibold" inputClassName="text-sm font-semibold" ariaLabel="checklist title" />
        {done > 0 && (
          <Button size="xs" variant="ghost" onClick={() => call(() => api.patch(`/checklists/${cl.id}`, { hideCompleted: !cl.hideCompleted }))}>
            {cl.hideCompleted ? `Show checked (${done})` : 'Hide checked'}
          </Button>
        )}
        {canEdit && (
          <>
            <SaveChecklistTemplate checklistId={cl.id} title={cl.title} />
            <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete checklist">
              <Trash2 className="size-3.5" />
            </Button>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="w-8 text-[11px] text-faint tabular-nums">{Math.round(pct)}%</span>
        <Progress value={pct} />
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shown.map((i) => i.id)} strategy={verticalListSortingStrategy} disabled={!canEdit}>
          <div className="space-y-0.5">
            {shown.map((it) => (
              <SortableItem key={it.id} item={it}>
                {(handle) => <ItemRow item={it} handle={canEdit ? handle : null} board={board} canEdit={canEdit} onToggle={() => toggle(it)} call={call} />}
              </SortableItem>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {canEdit &&
        (adding ? (
          <div className="space-y-1.5">
            <Textarea
              autoFocus
              value={text}
              rows={2}
              onChange={(e) => setText(e.target.value)}
              placeholder="Add an item… paste several lines to add many at once"
              className="text-[13px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  addItems();
                }
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setAdding(false);
                }
              }}
            />
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" onClick={addItems} disabled={!text.trim()}>
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" onClick={() => setAdding(true)} icon={<Plus className="size-3.5" />}>
            Add an item
          </Button>
        ))}
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete “${cl.title}”?`} description="The checklist and all of its items will be removed." danger confirmLabel="Delete checklist" onConfirm={() => (setConfirmDelete(false), call(() => api.del(`/checklists/${cl.id}`)))} />
    </div>
  );
}

function SaveChecklistTemplate({ checklistId, title }: { checklistId: string; title: string }) {
  const toast = useToast();
  return (
    <Button
      size="xs"
      variant="ghost"
      title="Save as checklist template"
      aria-label="Save as checklist template"
      onClick={async () => {
        try {
          await api.post(`/checklists/${checklistId}/save-as-template`, { name: title });
          toast.success('Saved as a checklist template');
        } catch (e) {
          toast.error(errorMessage(e));
        }
      }}
    >
      <Copy className="size-3.5" />
    </Button>
  );
}

function ItemRow({ item, handle, board, canEdit, onToggle, call }: { item: ChecklistItem; handle: ReactNode; board: BoardData; canEdit: boolean; onToggle: () => void; call: (fn: () => Promise<unknown>) => void }) {
  const assignee = board.members.find((m) => m.id === item.assigneeId);
  const assign = usePopover();
  const due = usePopover();
  const [dueDraft, setDueDraft] = useState(toLocalInput(item.dueAt));
  return (
    <div className="group/item -ml-6 flex items-start gap-1.5 rounded-lg py-1 pr-1 pl-1 hover:bg-surface-2">
      <span className="w-4 pt-0.5">{handle}</span>
      <Checkbox checked={!!item.completedAt} onChange={onToggle} disabled={!canEdit} className="pt-0.5" />
      <div className="min-w-0 flex-1">
        <InlineEdit
          value={item.text}
          disabled={!canEdit}
          multiline
          onSave={(text) => call(() => api.patch(`/checklist-items/${item.id}`, { text, version: item.version }))}
          className={cn('w-full px-1 text-[13px] leading-snug', item.completedAt && 'text-faint line-through')}
          inputClassName="text-[13px]"
          ariaLabel="checklist item"
        />
      </div>
      {item.dueAt && <span className={cn('mt-0.5 shrink-0 text-[11px]', !item.completedAt && new Date(item.dueAt) < new Date() ? 'text-danger' : 'text-faint')}>{shortDate(item.dueAt)}</span>}
      {assignee && <Avatar name={assignee.displayName} src={assignee.avatarUrl} size={20} />}
      {canEdit && (
        <div className="flex shrink-0 opacity-0 transition-opacity group-hover/item:opacity-100 focus-within:opacity-100">
          <button ref={due.anchorRef as any} onClick={due.toggle} className="rounded p-1 text-faint hover:text-fg" aria-label="Set item due date">
            <Clock className="size-3.5" />
          </button>
          <button ref={assign.anchorRef as any} onClick={assign.toggle} className="rounded p-1 text-faint hover:text-fg" aria-label="Assign item">
            <UserPlus className="size-3.5" />
          </button>
          <button onClick={() => call(() => api.del(`/checklist-items/${item.id}`))} className="rounded p-1 text-faint hover:text-danger" aria-label="Delete item">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <Popover open={assign.open} onClose={assign.close} anchor={assign.anchorRef} align="end" width={250}>
        <PopoverTitle onClose={assign.close}>Assign item</PopoverTitle>
        <MemberPicker board={board} selected={item.assigneeId ? [item.assigneeId] : []} onToggle={(id) => (assign.close(), call(() => api.patch(`/checklist-items/${item.id}`, { assigneeId: id === item.assigneeId ? null : id })))} />
      </Popover>
      <Popover open={due.open} onClose={due.close} anchor={due.anchorRef} align="end" width={260}>
        <PopoverTitle onClose={due.close}>Item due date</PopoverTitle>
        <div className="space-y-2 p-1.5">
          <Input type="datetime-local" value={dueDraft} onChange={(e) => setDueDraft(e.target.value)} />
          <div className="flex justify-between">
            <Button size="sm" variant="ghost" onClick={() => (due.close(), call(() => api.patch(`/checklist-items/${item.id}`, { dueAt: null })))}>
              Remove
            </Button>
            <Button size="sm" variant="primary" onClick={() => (due.close(), call(() => api.patch(`/checklist-items/${item.id}`, { dueAt: fromLocalInput(dueDraft) })))}>
              Save
            </Button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

export function ChecklistsSection({ detail, board, canEdit, onChanged }: { detail: CardDetail; board: BoardData; canEdit: boolean; onChanged: () => void }) {
  if (!detail.checklists.length) return null;
  return (
    <div className="space-y-5 pl-6" id="checklists">
      {detail.checklists.map((cl) => (
        <ChecklistBlock key={cl.id} cl={cl} detail={detail} board={board} canEdit={canEdit} onChanged={onChanged} />
      ))}
    </div>
  );
}

/** Popover body for adding a checklist (blank, from template, or copied from another card's checklist). */
export function AddChecklistPanel({ cardId, workspaceId, onDone }: { cardId: string; workspaceId: string; onDone: () => void }) {
  const [title, setTitle] = useState('Checklist');
  const [templateId, setTemplateId] = useState('');
  const toast = useToast();
  const templates = useQuery({ queryKey: ['templates', workspaceId, 'checklist'], queryFn: () => api.get(`/workspaces/${workspaceId}/templates?kind=checklist`).then((r) => r.templates as any[]) });
  return (
    <form
      className="space-y-2 p-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post(`/cards/${cardId}/checklists`, templateId ? { templateId } : { title });
          onDone();
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      <label className="block">
        <span className="mb-1 block text-xs text-muted">Title</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!templateId} autoFocus />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-muted">Or start from a template</span>
        <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">None</option>
          {templates.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </label>
      <Button type="submit" size="sm" variant="primary" className="w-full justify-center">
        Add checklist
      </Button>
    </form>
  );
}

/* ========================================================== attachments */

export function AttachmentsSection({ detail, canEdit, onChanged, uploadRef }: { detail: CardDetail; canEdit: boolean; onChanged: () => void; uploadRef: React.RefObject<HTMLInputElement | null> }) {
  const toast = useToast();
  const [uploads, setUploads] = useState<{ name: string; progress: number }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const upload = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const entry = { name: file.name, progress: 0 };
      setUploads((u) => [...u, entry]);
      const fd = new FormData();
      fd.append('file', file);
      try {
        await api.post(`/cards/${detail.card.id}/attachments`, fd, { onProgress: (p) => setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, progress: p } : x))) });
      } catch (e) {
        toast.error(`${file.name}: ${errorMessage(e)}`);
      } finally {
        setUploads((u) => u.filter((x) => x.name !== file.name));
        onChanged();
      }
    }
  };
  const setCover = async (id: string | null) => {
    try {
      await api.patch(`/cards/${detail.card.id}`, { coverAttachmentId: id, ...(id ? { coverColor: null } : {}) });
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Section
      icon={<Paperclip />}
      title="Attachments"
      id="attachments"
      actions={canEdit ? <Button size="xs" variant="ghost" icon={<Upload className="size-3.5" />} onClick={() => uploadRef.current?.click()}>Upload</Button> : null}
    >
      <input ref={uploadRef} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
      <div
        onDragOver={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (canEdit && e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
        className={cn('space-y-2 rounded-xl', dragOver && 'outline-2 outline-dashed outline-accent')}
      >
        {detail.attachments.map((a) => (
          <div key={a.id} className="group/att flex items-center gap-3 rounded-lg border border-line p-2">
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-3">
              {a.isImage ? <img src={a.url} alt="" className="size-full object-cover" loading="lazy" /> : <span className="text-[10px] font-semibold text-muted uppercase">{a.fileName.split('.').pop()}</span>}
            </a>
            <div className="min-w-0 flex-1">
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="block truncate text-[13px] font-medium hover:underline">
                {a.fileName}
              </a>
              <div className="text-[11px] text-faint">
                {formatBytesSafe(a.size)} · {a.uploader ?? 'Someone'} · {relativeTime(a.createdAt)}
                {detail.card.coverAttachmentId === a.id && <span className="ml-1 text-accent">· Cover</span>}
              </div>
            </div>
            <div className="flex items-center gap-0.5">
              <a href={`${a.url}&download=1`} className="rounded p-1.5 text-faint hover:bg-surface-2 hover:text-fg" aria-label={`Download ${a.fileName}`}>
                <Download className="size-3.5" />
              </a>
              {canEdit && a.isImage && (
                <button onClick={() => setCover(detail.card.coverAttachmentId === a.id ? null : a.id)} className="rounded p-1.5 text-faint hover:bg-surface-2 hover:text-fg" title={detail.card.coverAttachmentId === a.id ? 'Remove cover' : 'Make cover'} aria-label="Toggle cover">
                  <ImageIcon className="size-3.5" />
                </button>
              )}
              {canEdit && (
                <button onClick={() => setToDelete(a.id)} className="rounded p-1.5 text-faint hover:bg-surface-2 hover:text-danger" aria-label={`Delete ${a.fileName}`}>
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
        {uploads.map((u) => (
          <div key={u.name} className="rounded-lg border border-line p-2.5">
            <div className="mb-1.5 flex items-center gap-2 text-[13px]">
              <Spinner className="size-3.5" />
              <span className="truncate">{u.name}</span>
              <span className="ml-auto text-[11px] text-faint">{Math.round(u.progress * 100)}%</span>
            </div>
            <Progress value={u.progress * 100} />
          </div>
        ))}
        {!detail.attachments.length && !uploads.length && (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">{canEdit ? 'Drop files here or use Upload. Images, PDFs, video, audio, .rbxm/.rbxl and text files.' : 'No attachments.'}</p>
        )}
      </div>
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete attachment?"
        description="The file will be permanently removed from storage."
        danger
        confirmLabel="Delete"
        onConfirm={async () => {
          const id = toDelete;
          setToDelete(null);
          try {
            await api.del(`/attachments/${id}`);
          } catch (e) {
            toast.error(errorMessage(e));
          }
          onChanged();
        }}
      />
    </Section>
  );
}

/* ================================================= dev links & relations */

const linkIcon = (kind: string, provider: string) => (provider === 'roblox' ? <Gamepad2 className="size-3.5" /> : kind === 'pull_request' ? <GitPullRequest className="size-3.5" /> : kind === 'commit' ? <GitCommit className="size-3.5" /> : kind === 'issue' ? <CircleDot className="size-3.5" /> : <Link2 className="size-3.5" />);

export function LinksSection({ detail, canEdit, onChanged }: { detail: CardDetail; canEdit: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const toast = useToast();
  if (!detail.links.length && !adding) return null;
  const add = async () => {
    try {
      await api.post(`/cards/${detail.card.id}/links`, { url: url.trim() });
      setUrl('');
      setAdding(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Section icon={<Link2 />} title="Development & links" actions={canEdit && !adding ? <Button size="xs" variant="ghost" onClick={() => setAdding(true)} icon={<Plus className="size-3.5" />}>Add</Button> : null}>
      <div className="space-y-1.5">
        {detail.links.map((l) => (
          <div key={l.id} className="group/link flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px]">
            <span className="text-muted">{linkIcon(l.kind, l.provider)}</span>
            <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 flex-1 truncate hover:underline">
              {l.title}
            </a>
            {l.state && <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium uppercase', l.state === 'merged' ? 'bg-accent-soft text-accent' : l.state === 'open' || l.state === 'opened' ? 'bg-success-soft text-success' : 'bg-surface-3 text-muted')}>{l.state}</span>}
            {canEdit && (
              <button onClick={async () => (await api.del(`/cards/${detail.card.id}/links/${l.id}`).catch((e) => toast.error(errorMessage(e))), onChanged())} className="rounded p-0.5 text-faint opacity-0 group-hover/link:opacity-100 hover:text-danger focus:opacity-100" aria-label="Remove link">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        {adding && (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a GitHub/GitLab PR, issue, commit, Roblox or any link" className="h-8" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setAdding(false))} />
            <Button type="submit" size="sm" variant="primary" disabled={!url.trim()}>
              Add
            </Button>
          </form>
        )}
      </div>
    </Section>
  );
}

export function AddLinkPanel({ cardId, onDone }: { cardId: string; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const toast = useToast();
  return (
    <form
      className="space-y-2 p-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post(`/cards/${cardId}/links`, { url: url.trim() });
          onDone();
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/repo/pull/12" />
      <p className="text-[11px] text-faint">GitHub and GitLab links are recognised as PRs, issues or commits. With a GitHub integration, PRs mentioning the card key link automatically.</p>
      <Button type="submit" size="sm" variant="primary" className="w-full justify-center" disabled={!url.trim()}>
        Attach link
      </Button>
    </form>
  );
}

export function RelationsSection({ detail, canEdit, onChanged }: { detail: CardDetail; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  if (!detail.relations.length) return null;
  const byId = new Map(detail.relatedCards.map((c) => [c.id, c]));
  const groups: { label: string; icon: ReactNode; rows: { relId: string; card: (typeof detail.relatedCards)[number] }[] }[] = [
    { label: 'Blocked by', icon: <Lock className="size-3.5 text-danger" />, rows: [] },
    { label: 'Blocks', icon: <Unlock className="size-3.5 text-warning" />, rows: [] },
    { label: 'Related', icon: <ArrowLeftRight className="size-3.5 text-muted" />, rows: [] },
    { label: 'Duplicates', icon: <Copy className="size-3.5 text-muted" />, rows: [] },
  ];
  for (const r of detail.relations) {
    const otherId = r.fromCardId === detail.card.id ? r.toCardId : r.fromCardId;
    const card = byId.get(otherId);
    if (!card) continue;
    const g = r.kind === 'blocks' ? (r.toCardId === detail.card.id ? groups[0] : groups[1]) : r.kind === 'duplicates' ? groups[3] : groups[2];
    g.rows.push({ relId: r.id, card });
  }
  return (
    <Section icon={<ArrowLeftRight />} title="Dependencies & related cards">
      <div className="space-y-3">
        {groups
          .filter((g) => g.rows.length)
          .map((g) => (
            <div key={g.label}>
              <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                {g.icon}
                {g.label}
              </div>
              <div className="space-y-1">
                {g.rows.map(({ relId, card }) => (
                  <div key={relId} className="group/rel flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px]">
                    <span className="font-mono text-[11px] text-faint">
                      {card.boardKey}-{card.number}
                    </span>
                    <Link to={`/b/${card.boardId}/c/${card.id}`} className={cn('min-w-0 flex-1 truncate hover:underline', card.completedAt && 'text-faint line-through')}>
                      {card.title}
                    </Link>
                    {canEdit && (
                      <button onClick={async () => (await api.del(`/cards/${detail.card.id}/relations/${relId}`).catch((e) => toast.error(errorMessage(e))), onChanged())} className="rounded p-0.5 text-faint opacity-0 group-hover/rel:opacity-100 hover:text-danger focus:opacity-100" aria-label="Remove relation">
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
      </div>
    </Section>
  );
}

export function AddRelationPanel({ detail, onDone }: { detail: CardDetail; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'relates' | 'blocks' | 'blocked_by' | 'duplicates'>('blocked_by');
  const debounced = useDebounced(q, 200);
  const toast = useToast();
  const results = useQuery({ queryKey: ['rel-search', debounced], queryFn: () => api.get(`/search?q=${encodeURIComponent(debounced)}&types=cards&limit=8`), enabled: debounced.trim().length > 0 });
  return (
    <div className="p-1">
      <Select value={kind} onChange={(e) => setKind(e.target.value as any)} className="mb-1.5 h-8">
        <option value="blocked_by">This card is blocked by…</option>
        <option value="blocks">This card blocks…</option>
        <option value="relates">Relates to…</option>
        <option value="duplicates">Duplicates…</option>
      </Select>
      <PickerSearch value={q} onChange={setQ} placeholder="Search cards by title or key" />
      {(results.data?.cards?.items ?? [])
        .filter((c: any) => c.id !== detail.card.id)
        .map((c: any) => (
          <MenuItem
            key={c.id}
            onClick={async () => {
              try {
                await api.post(`/cards/${detail.card.id}/relations`, { toCardId: c.id, kind });
                onDone();
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            {c.title}
          </MenuItem>
        ))}
    </div>
  );
}

export function AssetsSection({ detail }: { detail: CardDetail }) {
  if (!detail.assets.length) return null;
  return (
    <Section icon={<Package />} title="Linked assets">
      <div className="flex flex-wrap gap-1.5">
        {detail.assets.map((a) => (
          <span key={a.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[12px]">
            <span className="text-faint capitalize">{a.category}</span>
            {a.name}
            {a.robloxAssetId && <span className="font-mono text-[10px] text-faint">#{a.robloxAssetId}</span>}
          </span>
        ))}
      </div>
    </Section>
  );
}

export function AssetLinkPanel({ detail, workspaceId, onDone }: { detail: CardDetail; workspaceId: string; onDone: () => void }) {
  const [sel, setSel] = useState<string[]>(detail.assets.map((a) => a.id));
  const toast = useToast();
  const assets = useQuery({ queryKey: ['assets', workspaceId], queryFn: () => api.get(`/workspaces/${workspaceId}/assets`).then((r) => r.assets as any[]) });
  return (
    <div className="p-1">
      <div className="max-h-64 overflow-y-auto">
        {assets.data?.map((a) => (
          <label key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-surface-2">
            <Checkbox checked={sel.includes(a.id)} onChange={(v) => setSel(v ? [...sel, a.id] : sel.filter((x) => x !== a.id))} />
            <span className="flex-1 truncate">{a.name}</span>
            <span className="text-[11px] text-faint capitalize">{a.category}</span>
          </label>
        ))}
        {assets.data && !assets.data.length && <p className="p-3 text-center text-xs text-faint">No assets in the register yet. Add them from the Assets page.</p>}
      </div>
      <Button
        size="sm"
        variant="primary"
        className="mt-2 w-full justify-center"
        onClick={async () => {
          try {
            await api.put(`/cards/${detail.card.id}/assets`, { assetIds: sel });
            onDone();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      >
        Save
      </Button>
    </div>
  );
}


import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity as ActivityIcon, Archive, ArrowLeft, Bell, ChevronRight, Copy, Download, FileStack, Printer, Settings, SlidersHorizontal, Tag, Trash2, Upload, Users, Workflow, X, RotateCcw, Plus, GripVertical } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import type { Activity, BoardData, CardSummary } from '@/lib/types';
import { BOARD_BACKGROUNDS, CUSTOM_FIELD_TYPES, LABEL_COLORS } from '@shared/constants';
import { cn } from '@/lib/format';
import { Avatar, Button, Checkbox, ColorSwatches, ConfirmDialog, Field, Input, MenuItem, Select, Spinner, Switch, Textarea } from '@/components/ui';
import { ActivityRow } from '@/components/activityText';
import { AutomationPanel } from '@/components/automation/AutomationPanel';
import { CsvImport } from '@/pages/workspace/Import';

export type DrawerPanel = 'menu' | 'settings' | 'members' | 'labels' | 'fields' | 'archived' | 'activity' | 'automation' | 'export' | 'duplicate' | 'template' | 'import';

const TITLES: Record<DrawerPanel, string> = {
  menu: 'Board menu',
  settings: 'Board settings',
  members: 'Members',
  labels: 'Labels',
  fields: 'Custom fields',
  archived: 'Archived items',
  activity: 'Activity',
  automation: 'Automation',
  export: 'Export & print',
  duplicate: 'Copy board',
  template: 'Save as template',
  import: 'Import cards from CSV',
};

export function BoardDrawer({ panel, setPanel, data, onClose, isAdmin, canEdit, onToast }: { panel: DrawerPanel; setPanel: (p: DrawerPanel) => void; data: BoardData; onClose: () => void; isAdmin: boolean; canEdit: boolean; onToast: { success: (m: string) => void; error: (m: string) => void } }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['board', data.board.id] });
  const wide = panel === 'automation';
  return createPortal(
    <div className="fixed inset-0 z-40" role="presentation">
      <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={TITLES[panel]} className={cn('absolute inset-y-0 right-0 flex w-full flex-col border-l border-line bg-surface shadow-pop animate-slide-up', wide ? 'max-w-3xl' : 'max-w-md')} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          {panel !== 'menu' && (
            <Button variant="ghost" size="icon-sm" onClick={() => setPanel('menu')} aria-label="Back to menu">
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <h2 className="flex-1 text-sm font-semibold">{TITLES[panel]}</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" autoFocus>
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {panel === 'menu' && <MenuPanel setPanel={setPanel} isAdmin={isAdmin} canEdit={canEdit} data={data} />}
          {panel === 'settings' && <SettingsPanel data={data} isAdmin={isAdmin} refresh={refresh} onToast={onToast} />}
          {panel === 'members' && <MembersPanel data={data} isAdmin={isAdmin} refresh={refresh} onToast={onToast} />}
          {panel === 'labels' && <LabelsPanel data={data} canEdit={canEdit} refresh={refresh} onToast={onToast} />}
          {panel === 'fields' && <FieldsPanel data={data} isAdmin={isAdmin} refresh={refresh} onToast={onToast} />}
          {panel === 'archived' && <ArchivedPanel data={data} canEdit={canEdit} isAdmin={isAdmin} refresh={refresh} onToast={onToast} />}
          {panel === 'activity' && <ActivityPanel boardId={data.board.id} />}
          {panel === 'automation' && <AutomationPanel board={data} canEdit={canEdit} />}
          {panel === 'export' && <ExportPanel data={data} />}
          {panel === 'duplicate' && <DuplicatePanel data={data} onToast={onToast} />}
          {panel === 'template' && <TemplatePanel data={data} onToast={onToast} onDone={onClose} />}
          {panel === 'import' && <CsvImport boardId={data.board.id} lists={data.lists} onDone={refresh} />}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function MenuPanel({ setPanel, isAdmin, canEdit, data }: { setPanel: (p: DrawerPanel) => void; isAdmin: boolean; canEdit: boolean; data: BoardData }) {
  const item = (p: DrawerPanel, icon: ReactNode, label: string, show = true, hint?: string) =>
    show && (
      <MenuItem key={p} icon={icon} onClick={() => setPanel(p)}>
        <span className="flex items-center justify-between gap-2">
          <span>
            {label}
            {hint && <span className="ml-1.5 text-faint">{hint}</span>}
          </span>
          <ChevronRight className="size-3.5 text-faint" />
        </span>
      </MenuItem>
    );
  return (
    <div className="space-y-1">
      {item('settings', <Settings />, 'Settings', true, isAdmin ? '' : '(view)')}
      {item('members', <Users />, 'Members', true, String(data.members.length))}
      {item('activity', <ActivityIcon />, 'Activity')}
      {item('automation', <Workflow />, 'Automation')}
      {item('labels', <Tag />, 'Labels', true, String(data.labels.length))}
      {item('fields', <SlidersHorizontal />, 'Custom fields', true, String(data.customFields.length))}
      {item('archived', <Archive />, 'Archived items')}
      <div className="my-2 h-px bg-line" />
      {item('import', <Upload />, 'Import cards from CSV', canEdit)}
      {item('export', <Download />, 'Export & print')}
      {item('duplicate', <Copy />, 'Copy board')}
      {item('template', <FileStack />, 'Save as template', canEdit)}
      <NotificationLevel data={data} />
    </div>
  );
}

function NotificationLevel({ data }: { data: BoardData }) {
  const qc = useQueryClient();
  return (
    <div className="mt-3 rounded-xl border border-line p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
        <Bell className="size-4 text-muted" /> Board notifications
      </div>
      <Select
        value={data.board.notificationLevel}
        onChange={async (e) => {
          await api.post(`/boards/${data.board.id}/notification-level`, { level: e.target.value });
          qc.invalidateQueries({ queryKey: ['board', data.board.id] });
        }}
        className="h-8"
      >
        <option value="participating">Participating (assigned, mentioned, watching)</option>
        <option value="all">All activity on cards I watch</option>
        <option value="none">Muted</option>
      </Select>
      <p className="mt-1.5 text-[11px] text-faint">Watch individual cards from the card panel to follow their updates.</p>
    </div>
  );
}

function SettingsPanel({ data, isAdmin, refresh, onToast }: { data: BoardData; isAdmin: boolean; refresh: () => void; onToast: any }) {
  const b = data.board;
  const [name, setName] = useState(b.name);
  const [description, setDescription] = useState(b.description);
  const [key, setKey] = useState(b.key);
  const [confirm, setConfirm] = useState<null | 'close' | 'delete'>(null);
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ['projects', b.workspaceId], queryFn: () => api.get(`/workspaces/${b.workspaceId}/projects`).then((r) => r.projects as any[]) });
  const save = async (patch: Record<string, unknown>, msg = 'Board updated') => {
    try {
      await api.patch(`/boards/${b.id}`, patch);
      onToast.success(msg);
      refresh();
    } catch (e) {
      onToast.error(errorMessage(e));
    }
  };
  return (
    <div className="space-y-5">
      {!isAdmin && <p className="rounded-lg bg-surface-2 p-3 text-[13px] text-muted">Only board admins can change these settings.</p>}
      <fieldset disabled={!isAdmin} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== b.name && save({ name: name.trim() })} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== b.description && save({ description })} rows={3} />
        </Field>
        <Field label="Card key prefix" hint="Cards are numbered like KEY-12. Mention keys in GitHub PRs/commits to link them.">
          <Input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} onBlur={() => key !== b.key && save({ key })} maxLength={8} className="font-mono" />
        </Field>
        <Field label="Visibility">
          <Select value={b.visibility} onChange={(e) => save({ visibility: e.target.value })}>
            <option value="private">Private — only board members and workspace admins</option>
            <option value="workspace">Workspace — every workspace member</option>
            <option value="public">Public — anyone with the link can view (read-only)</option>
          </Select>
        </Field>
        <Field label="Background">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(BOARD_BACKGROUNDS).map(([k, v]) => (
              <button key={k} type="button" title={v.label} aria-label={v.label} aria-pressed={b.background === k} onClick={() => save({ background: k })} className={cn('h-9 w-14 rounded-md border border-white/10', b.background === k && 'ring-2 ring-fg ring-offset-2 ring-offset-surface')} style={{ background: v.css }} />
            ))}
          </div>
        </Field>
        <Field label="Game project">
          <Select value={b.projectId ?? ''} onChange={(e) => save({ projectId: e.target.value || null })}>
            <option value="">None</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="space-y-3 rounded-xl border border-line p-3">
          <Switch label="Card covers" description="Show cover images and colours on the board." checked={b.settings.cardCovers !== false} onChange={(v) => save({ settings: { cardCovers: v } })} disabled={!isAdmin} />
          <Switch label="Voting" description="Let members vote on cards (useful for feature requests)." checked={!!b.settings.votingEnabled} onChange={(v) => save({ settings: { votingEnabled: v } })} disabled={!isAdmin} />
          <Switch label="Observers can comment" description="Read-only members may still comment." checked={b.settings.commentPermission === 'observers'} onChange={(v) => save({ settings: { commentPermission: v ? 'observers' : 'members' } })} disabled={!isAdmin} />
        </div>
      </fieldset>
      {isAdmin && (
        <div className="space-y-2 rounded-xl border border-danger/30 p-3">
          <h3 className="text-[13px] font-semibold text-danger">Danger zone</h3>
          {b.archivedAt ? (
            <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={async () => (await api.post(`/boards/${b.id}/archive`, { archived: false }), refresh())}>
              Reopen board
            </Button>
          ) : (
            <Button size="sm" icon={<Archive className="size-3.5" />} onClick={() => setConfirm('close')}>
              Close board
            </Button>
          )}
          <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirm('delete')}>
            Delete board permanently
          </Button>
        </div>
      )}
      <ConfirmDialog open={confirm === 'close'} onClose={() => setConfirm(null)} title="Close this board?" description="Closed boards become read-only and are hidden from the workspace. You can reopen them anytime." confirmLabel="Close board" onConfirm={async () => (setConfirm(null), await api.post(`/boards/${b.id}/archive`, { archived: true }), refresh())} />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="Delete board permanently?"
        description="All lists, cards, comments, attachments and automation rules on this board will be deleted. Export it first if you might need the data."
        requireText={b.name}
        danger
        confirmLabel="Delete board"
        onConfirm={async () => {
          try {
            await api.del(`/boards/${b.id}`, { confirmName: b.name });
            onToast.success('Board deleted');
            navigate(`/w/${b.workspaceId}`);
          } catch (e) {
            onToast.error(errorMessage(e));
          }
          setConfirm(null);
        }}
      />
    </div>
  );
}

function MembersPanel({ data, isAdmin, refresh, onToast }: { data: BoardData; isAdmin: boolean; refresh: () => void; onToast: any }) {
  const ws = useQuery({ queryKey: ['workspace', data.board.workspaceId], queryFn: () => api.get(`/workspaces/${data.board.workspaceId}`) });
  const [adding, setAdding] = useState('');
  const memberIds = new Set(data.members.filter((m) => m.explicit).map((m) => m.id));
  const candidates = (ws.data?.members ?? []).filter((m: any) => !memberIds.has(m.userId));
  const setRole = async (userId: string, role: string) => {
    try {
      await api.post(`/boards/${data.board.id}/members`, { userId, role });
      refresh();
    } catch (e) {
      onToast.error(errorMessage(e));
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">
        {data.board.visibility === 'private' ? 'This board is private: only the people below and workspace admins can see it.' : data.board.visibility === 'workspace' ? 'Everyone in the workspace can see this board. Add people explicitly to give them a specific role.' : 'This board is public: anyone with the link can view it. Only members can edit.'}
      </p>
      {isAdmin && (
        <div className="flex gap-2">
          <Select value={adding} onChange={(e) => setAdding(e.target.value)} className="h-9">
            <option value="">Add a workspace member…</option>
            {candidates.map((m: any) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName} (@{m.username})
              </option>
            ))}
          </Select>
          <Button variant="primary" disabled={!adding} onClick={async () => (await setRole(adding, 'member'), setAdding(''))}>
            Add
          </Button>
        </div>
      )}
      <div className="divide-y divide-line rounded-xl border border-line">
        {data.members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 px-3 py-2.5">
            <Avatar name={m.displayName} src={m.avatarUrl} size={30} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{m.displayName}</div>
              <div className="truncate text-[11px] text-faint">
                @{m.username} · workspace {m.wsRole}
                {!m.explicit && ' · via workspace'}
              </div>
            </div>
            {isAdmin && m.wsRole !== 'owner' && m.wsRole !== 'admin' ? (
              <div className="flex items-center gap-1">
                <Select value={m.explicit ? m.role : ''} onChange={(e) => setRole(m.id, e.target.value)} className="h-8 w-28 text-[12px]" aria-label={`Role for ${m.displayName}`}>
                  {!m.explicit && <option value="">{m.role} (inherited)</option>}
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="observer">Observer</option>
                </Select>
                {m.explicit && (
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${m.displayName}`} onClick={async () => (await api.del(`/boards/${data.board.id}/members/${m.id}`).catch((e) => onToast.error(errorMessage(e))), refresh())}>
                    <X className="size-3.5" />
                  </Button>
                )}
              </div>
            ) : (
              <span className="rounded bg-surface-3 px-2 py-0.5 text-[11px] text-muted capitalize">{m.role}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LabelsPanel({ data, canEdit, refresh, onToast }: { data: BoardData; canEdit: boolean; refresh: () => void; onToast: any }) {
  const [edit, setEdit] = useState<{ id?: string; name: string; color: string } | null>(null);
  const counts = new Map<string, number>();
  for (const c of data.cards) for (const l of c.labelIds) counts.set(l, (counts.get(l) ?? 0) + 1);
  const save = async () => {
    if (!edit) return;
    try {
      if (edit.id) await api.patch(`/boards/${data.board.id}/labels/${edit.id}`, { name: edit.name, color: edit.color });
      else await api.post(`/boards/${data.board.id}/labels`, { name: edit.name, color: edit.color });
      setEdit(null);
      refresh();
    } catch (e) {
      onToast.error(errorMessage(e));
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">Renaming a label keeps it on every card. Team specialisations (Scripter, Builder…) work well as labels too.</p>
      {data.labels.map((l) => (
        <div key={l.id} className="flex items-center gap-2">
          <span className="h-8 flex-1 truncate rounded-md px-3 text-[13px] leading-8 font-semibold text-black/75" style={{ background: l.color }}>
            {l.name || '(no name)'}
          </span>
          <span className="w-12 text-right text-[11px] text-faint">{counts.get(l.id) ?? 0} cards</span>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => setEdit({ id: l.id, name: l.name, color: l.color })}>
              Edit
            </Button>
          )}
        </div>
      ))}
      {canEdit && !edit && (
        <Button icon={<Plus className="size-4" />} onClick={() => setEdit({ name: '', color: LABEL_COLORS[data.labels.length % LABEL_COLORS.length] })}>
          New label
        </Button>
      )}
      {edit && (
        <div className="space-y-3 rounded-xl border border-line p-3">
          <Field label="Name">
            <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus maxLength={60} />
          </Field>
          <ColorSwatches colors={LABEL_COLORS} value={edit.color} onChange={(c) => setEdit({ ...edit, color: c })} size={28} />
          <div className="flex justify-between">
            {edit.id ? (
              <Button variant="ghost" size="sm" className="text-danger" onClick={async () => (await api.del(`/boards/${data.board.id}/labels/${edit.id}`), setEdit(null), refresh())}>
                Delete label
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={save}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldsPanel({ data, isAdmin, refresh, onToast }: { data: BoardData; isAdmin: boolean; refresh: () => void; onToast: any }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('text');
  const [options, setOptions] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editOptions, setEditOptions] = useState<{ id?: string; label: string }[]>([]);
  const create = async () => {
    try {
      await api.post(`/boards/${data.board.id}/custom-fields`, { name, type, options: type === 'dropdown' ? options.split('\n').map((s) => s.trim()).filter(Boolean).map((label) => ({ label })) : [] });
      setCreating(false);
      setName('');
      setOptions('');
      refresh();
    } catch (e) {
      onToast.error(errorMessage(e));
    }
  };
  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await api.patch(`/boards/${data.board.id}/custom-fields/${id}`, body);
      refresh();
    } catch (e) {
      onToast.error(errorMessage(e));
    }
  };
  const [confirm, setConfirm] = useState<string | null>(null);
  const sorted = [...data.customFields].sort((a, b) => a.position - b.position);
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">Add structured data to every card — estimates, Roblox asset IDs, platforms, reviewers. Field types can't change after creation, so existing values stay valid.</p>
      {sorted.map((f, i) => (
        <div key={f.id} className="rounded-xl border border-line p-3">
          <div className="flex items-center gap-2">
            <GripVertical className="size-3.5 text-faint" />
            <span className="flex-1 text-[13px] font-medium">{f.name}</span>
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted uppercase">{f.type}</span>
            {isAdmin && (
              <>
                <Button size="icon-sm" variant="ghost" disabled={i === 0} aria-label="Move up" onClick={() => patch(f.id, { position: (sorted[i - 1].position + (sorted[i - 2]?.position ?? sorted[i - 1].position - 2)) / 2 })}>
                  ↑
                </Button>
                <Button size="icon-sm" variant="ghost" disabled={i === sorted.length - 1} aria-label="Move down" onClick={() => patch(f.id, { position: (sorted[i + 1].position + (sorted[i + 2]?.position ?? sorted[i + 1].position + 2)) / 2 })}>
                  ↓
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Delete ${f.name}`} onClick={() => setConfirm(f.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
          </div>
          {isAdmin && (
            <div className="mt-2 flex items-center gap-4 pl-5">
              <Checkbox checked={f.showOnCard} onChange={(v) => patch(f.id, { showOnCard: v })} label={<span className="text-[12px]">Show on card front</span>} />
              {f.type === 'dropdown' && (
                <button className="text-[12px] text-accent hover:underline" onClick={() => (setEditId(editId === f.id ? null : f.id), setEditOptions(f.options.map((o) => ({ id: o.id, label: o.label }))))}>
                  Edit options
                </button>
              )}
            </div>
          )}
          {editId === f.id && (
            <div className="mt-2 space-y-1.5 pl-5">
              {editOptions.map((o, idx) => (
                <div key={o.id ?? idx} className="flex gap-1">
                  <Input className="h-8" value={o.label} onChange={(e) => setEditOptions(editOptions.map((x, j) => (j === idx ? { ...x, label: e.target.value } : x)))} />
                  <Button size="icon-sm" variant="ghost" aria-label="Remove option" onClick={() => setEditOptions(editOptions.filter((_, j) => j !== idx))}>
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
              <div className="flex gap-1.5">
                <Button size="xs" onClick={() => setEditOptions([...editOptions, { label: '' }])}>
                  Add option
                </Button>
                <Button size="xs" variant="primary" onClick={async () => (await patch(f.id, { options: editOptions.filter((o) => o.label.trim()) }), setEditId(null))}>
                  Save options
                </Button>
              </div>
              <p className="text-[11px] text-faint">Removing an option clears it from cards that used it.</p>
            </div>
          )}
        </div>
      ))}
      {isAdmin &&
        (creating ? (
          <div className="space-y-3 rounded-xl border border-line p-3">
            <Field label="Field name">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="Type">
              <Select value={type} onChange={(e) => setType(e.target.value)}>
                {CUSTOM_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t === 'user' ? 'Member' : t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
            {type === 'dropdown' && (
              <Field label="Options" hint="One per line">
                <Textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={3} />
              </Field>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={!name.trim()} onClick={create}>
                Create field
              </Button>
            </div>
          </div>
        ) : (
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New field
          </Button>
        ))}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} title="Delete this custom field?" description="Its values will be removed from every card on the board." danger confirmLabel="Delete field" onConfirm={async () => { await api.del(`/boards/${data.board.id}/custom-fields/${confirm}`).catch((e) => onToast.error(errorMessage(e))); setConfirm(null); refresh(); }} />
    </div>
  );
}

function ArchivedPanel({ data, canEdit, isAdmin, refresh, onToast }: { data: BoardData; canEdit: boolean; isAdmin: boolean; refresh: () => void; onToast: any }) {
  const [tab, setTab] = useState<'cards' | 'lists'>('cards');
  const archived = useQuery({ queryKey: ['archived', data.board.id], queryFn: () => api.get<{ lists: any[]; cards: CardSummary[] }>(`/boards/${data.board.id}/archived`) });
  const [confirm, setConfirm] = useState<{ kind: 'card' | 'list'; id: string } | null>(null);
  const reload = () => {
    archived.refetch();
    refresh();
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      onToast.success(msg);
    } catch (e) {
      onToast.error(errorMessage(e));
    }
    reload();
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        <Button size="sm" variant={tab === 'cards' ? 'primary' : 'ghost'} onClick={() => setTab('cards')}>
          Cards {archived.data && `(${archived.data.cards.length})`}
        </Button>
        <Button size="sm" variant={tab === 'lists' ? 'primary' : 'ghost'} onClick={() => setTab('lists')}>
          Lists {archived.data && `(${archived.data.lists.length})`}
        </Button>
      </div>
      {archived.isLoading && <Spinner />}
      {tab === 'cards' &&
        archived.data?.cards.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px]">{c.title}</span>
            {canEdit && (
              <>
                <Button size="xs" onClick={() => act(() => api.post(`/cards/${c.id}/archive`, { archived: false }), 'Card restored')}>
                  Restore
                </Button>
                <Button size="xs" variant="ghost" className="text-danger" onClick={() => setConfirm({ kind: 'card', id: c.id })}>
                  Delete
                </Button>
              </>
            )}
          </div>
        ))}
      {tab === 'lists' &&
        archived.data?.lists.map((l) => (
          <div key={l.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px]">{l.name}</span>
            {canEdit && (
              <Button size="xs" onClick={() => act(() => api.post(`/lists/${l.id}/archive`, { archived: false }), 'List restored')}>
                Restore
              </Button>
            )}
            {isAdmin && (
              <Button size="xs" variant="ghost" className="text-danger" onClick={() => setConfirm({ kind: 'list', id: l.id })}>
                Delete
              </Button>
            )}
          </div>
        ))}
      {archived.data && (tab === 'cards' ? !archived.data.cards.length : !archived.data.lists.length) && <p className="py-6 text-center text-[13px] text-faint">Nothing archived.</p>}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'list' ? 'Delete list and all its cards?' : 'Delete card permanently?'}
        description="This cannot be undone."
        danger
        confirmLabel="Delete"
        onConfirm={() => {
          const c = confirm!;
          setConfirm(null);
          act(() => (c.kind === 'card' ? api.del(`/cards/${c.id}`) : api.del(`/lists/${c.id}`)), 'Deleted');
        }}
      />
    </div>
  );
}

function ActivityPanel({ boardId }: { boardId: string }) {
  const [pages, setPages] = useState<string[]>(['']);
  return (
    <div className="divide-y divide-line">
      {pages.map((before, i) => (
        <ActivityPage key={before || 'first'} boardId={boardId} before={before} onMore={i === pages.length - 1 ? (b) => setPages([...pages, b]) : undefined} />
      ))}
    </div>
  );
}

function ActivityPage({ boardId, before, onMore }: { boardId: string; before: string; onMore?: (before: string) => void }) {
  const q = useQuery({ queryKey: ['activity', 'board', boardId, before], queryFn: () => api.get<{ activities: Activity[]; nextBefore: string | null }>(`/boards/${boardId}/activity${before ? `?before=${encodeURIComponent(before)}` : ''}`) });
  if (q.isLoading) return <Spinner />;
  return (
    <div>
      {q.data?.activities.map((a) => (
        <ActivityRow key={a.id} a={a} />
      ))}
      {!q.data?.activities.length && !before && <p className="py-6 text-center text-[13px] text-faint">No activity yet.</p>}
      {onMore && q.data?.nextBefore && (
        <Button size="sm" variant="ghost" className="mt-2 w-full justify-center" onClick={() => onMore(q.data!.nextBefore!)}>
          Load more
        </Button>
      )}
    </div>
  );
}

function ExportPanel({ data }: { data: BoardData }) {
  const id = data.board.id;
  return (
    <div className="space-y-3 text-[13px]">
      <p className="text-muted">Your data is always yours. Exports include every card (including archived), checklists, comments and custom fields you can see.</p>
      <a href={`/api/boards/${id}/export.json`} download className="flex items-center gap-3 rounded-xl border border-line p-3 hover:bg-surface-2">
        <Download className="size-4 text-accent" />
        <span>
          <span className="block font-medium">JSON (full board)</span>
          <span className="block text-[12px] text-faint">Machine-readable, re-importable format: alypne.board.v1</span>
        </span>
      </a>
      <a href={`/api/boards/${id}/export.csv`} download className="flex items-center gap-3 rounded-xl border border-line p-3 hover:bg-surface-2">
        <Download className="size-4 text-accent" />
        <span>
          <span className="block font-medium">CSV (tasks)</span>
          <span className="block text-[12px] text-faint">Open in Excel, Google Sheets or Numbers</span>
        </span>
      </a>
      <a href={`/api/boards/${id}/report`} target="_blank" rel="noopener" className="flex items-center gap-3 rounded-xl border border-line p-3 hover:bg-surface-2">
        <Printer className="size-4 text-accent" />
        <span>
          <span className="block font-medium">Printable report</span>
          <span className="block text-[12px] text-faint">Readable summary by list — print or save as PDF</span>
        </span>
      </a>
    </div>
  );
}

function DuplicatePanel({ data, onToast }: { data: BoardData; onToast: any }) {
  const [name, setName] = useState(`${data.board.name} (copy)`);
  const [inc, setInc] = useState({ cards: true, labels: true, customFields: true, members: false, settings: true, automations: true });
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <Field label="New board name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="space-y-2 rounded-xl border border-line p-3">
        {(
          [
            ['cards', 'Cards (with checklists)'],
            ['labels', 'Labels'],
            ['customFields', 'Custom fields'],
            ['members', 'Board members'],
            ['settings', 'Settings (visibility, background, voting)'],
            ['automations', 'Automation rules'],
          ] as const
        ).map(([k, label]) => (
          <Checkbox key={k} checked={inc[k]} onChange={(v) => setInc({ ...inc, [k]: v })} label={label} className="flex" />
        ))}
      </div>
      <Button
        variant="primary"
        loading={busy}
        disabled={!name.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.post(`/boards/${data.board.id}/duplicate`, { name: name.trim(), include: inc });
            onToast.success('Board copied');
            navigate(`/b/${r.id}`);
          } catch (e) {
            onToast.error(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Create copy
      </Button>
    </div>
  );
}

function TemplatePanel({ data, onToast, onDone }: { data: BoardData; onToast: any; onDone: () => void }) {
  const [name, setName] = useState(`${data.board.name} template`);
  const [description, setDescription] = useState('');
  const [includeCards, setIncludeCards] = useState(true);
  const [includeAutomations, setIncludeAutomations] = useState(true);
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">Templates are shared with everyone in the workspace and create real boards when used.</p>
      <Field label="Template name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </Field>
      <Checkbox checked={includeCards} onChange={setIncludeCards} label="Include cards and checklists" className="flex" />
      <Checkbox checked={includeAutomations} onChange={setIncludeAutomations} label="Include automation rules" className="flex" />
      <Button
        variant="primary"
        disabled={!name.trim()}
        onClick={async () => {
          try {
            await api.post(`/boards/${data.board.id}/save-as-template`, { name: name.trim(), description, includeCards, includeAutomations });
            onToast.success('Template saved');
            onDone();
          } catch (e) {
            onToast.error(errorMessage(e));
          }
        }}
      >
        Save template
      </Button>
    </div>
  );
}

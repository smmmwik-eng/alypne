import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Globe, Lock, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { cn } from '@/lib/format';
import { BOARD_BACKGROUNDS } from '@shared/constants';
import { Button, ColorSwatches, Field, Input, Modal, Select, Textarea } from './ui';

const WS_COLORS = ['#8b7cf6', '#38bdf8', '#34d399', '#fb923c', '#f472b6', '#facc15', '#2dd4bf', '#f87171'];

export function CreateWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(WS_COLORS[0]);
  const navigate = useNavigate();
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
    }
  }, [open]);
  const create = useAction((v: { name: string; description: string; color: string }) => api.post<{ id: string }>('/workspaces', v), {
    invalidate: [['workspaces']],
    success: 'Workspace created',
    onSuccess: (r) => {
      onClose();
      try {
        localStorage.setItem('alypne-ws', r.id);
      } catch {
        /* ignore */
      }
      navigate(`/w/${r.id}`);
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a workspace"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate({ name: name.trim(), description, color })}>
            Create workspace
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate({ name: name.trim(), description, color });
        }}
      >
        <p className="text-sm text-muted">A workspace is your studio or group: it holds your team, boards, game projects and releases.</p>
        <Field label="Name" htmlFor="ws-name">
          <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nebula Studios" maxLength={80} autoFocus />
        </Field>
        <Field label="Description" hint="Optional">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
        </Field>
        <Field label="Colour">
          <ColorSwatches colors={WS_COLORS} value={color} onChange={setColor} />
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

export function CreateBoardDialog({ open, onClose, workspaceId, projectId }: { open: boolean; onClose: () => void; workspaceId: string; projectId?: string }) {
  const [name, setName] = useState('');
  const [background, setBackground] = useState('violet');
  const [visibility, setVisibility] = useState<'private' | 'workspace' | 'public'>('workspace');
  const [templateId, setTemplateId] = useState('');
  const [project, setProject] = useState(projectId ?? '');
  const navigate = useNavigate();
  const templates = useQuery({ queryKey: ['templates', workspaceId, 'board'], queryFn: () => api.get(`/workspaces/${workspaceId}/templates?kind=board`).then((r) => r.templates as any[]), enabled: open });
  const projects = useQuery({ queryKey: ['projects', workspaceId], queryFn: () => api.get(`/workspaces/${workspaceId}/projects`).then((r) => r.projects as any[]), enabled: open });
  useEffect(() => {
    if (open) {
      setName('');
      setTemplateId('');
      setProject(projectId ?? '');
    }
  }, [open, projectId]);
  const create = useAction((v: any) => api.post<{ id: string }>('/boards', v), {
    invalidate: [['boards', workspaceId], ['projects', workspaceId]],
    success: 'Board created',
    onSuccess: (r) => {
      onClose();
      navigate(`/b/${r.id}`);
    },
  });
  const submit = () => name.trim() && create.mutate({ workspaceId, name: name.trim(), background, visibility, templateId: templateId || undefined, projectId: project || null });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a board"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={submit}>
            Create board
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="h-24 rounded-xl border border-line p-3" style={{ background: BOARD_BACKGROUNDS[background]?.css }}>
          <div className="flex gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 w-20 rounded-lg bg-black/25 p-1.5">
                <div className="h-2 w-10 rounded bg-white/30" />
                <div className="mt-1.5 h-4 rounded bg-white/15" />
              </div>
            ))}
          </div>
        </div>
        <Field label="Board name" htmlFor="board-name">
          <Input id="board-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Winter Update" maxLength={120} autoFocus />
        </Field>
        <Field label="Background">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(BOARD_BACKGROUNDS).map(([k, v]) => (
              <button key={k} type="button" title={v.label} aria-label={v.label} aria-pressed={background === k} onClick={() => setBackground(k)} className={cn('h-8 w-12 rounded-md border border-white/10 focus-ring', background === k && 'ring-2 ring-fg ring-offset-2 ring-offset-surface')} style={{ background: v.css }} />
            ))}
          </div>
        </Field>
        <Field label="Template">
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Blank board (Backlog → In Progress → Testing → Done)</option>
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.builtIn ? '' : ' (workspace)'}
              </option>
            ))}
          </Select>
        </Field>
        {!!projects.data?.length && (
          <Field label="Game project" hint="Optional — link this board to a project">
            <Select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">No project</option>
              {projects.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Visibility">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['private', <Lock key="l" className="size-4" />, 'Private', 'Board members & admins'],
                ['workspace', <Users key="u" className="size-4" />, 'Workspace', 'Everyone in the workspace'],
                ['public', <Globe key="g" className="size-4" />, 'Public', 'Anyone with the link (read-only)'],
              ] as const
            ).map(([v, icon, label, hint]) => (
              <button key={v} type="button" onClick={() => setVisibility(v)} aria-pressed={visibility === v} className={cn('rounded-lg border p-2.5 text-left transition-colors focus-ring', visibility === v ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}>
                <span className="flex items-center gap-1.5 text-[13px] font-medium">
                  {icon}
                  {label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-tight text-faint">{hint}</span>
              </button>
            ))}
          </div>
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

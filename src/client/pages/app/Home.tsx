import { useState } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bug, Check, Gamepad2, LayoutGrid, Rocket, Users } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useWorkspaces, useMe, useDocumentTitle } from '@/lib/hooks';
import { Button, ColorSwatches, Field, FullPageSpinner, Input, Spinner, useToast } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { cn } from '@/lib/format';

export function HomeRedirect() {
  const ws = useWorkspaces();
  if (ws.isLoading) return <FullPageSpinner />;
  const list = ws.data ?? [];
  if (!list.length) return <Navigate to="/app/onboarding" replace />;
  let last: string | null = null;
  try {
    last = localStorage.getItem('alypne-ws');
  } catch {
    /* ignore */
  }
  const target = list.find((w) => w.id === last) ?? list[0];
  return <Navigate to={`/w/${target.id}/dashboard`} replace />;
}

const COLORS = ['#8b7cf6', '#38bdf8', '#34d399', '#fb923c', '#f472b6', '#facc15'];

export function Onboarding() {
  useDocumentTitle('Get started');
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(me.data?.user ? `${me.data.user.displayName}'s Studio` : '');
  const [color, setColor] = useState(COLORS[0]);
  const [wsId, setWsId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const templates = useQuery({ queryKey: ['templates', wsId, 'board'], queryFn: () => api.get(`/workspaces/${wsId}/templates?kind=board`).then((r) => r.templates as any[]), enabled: !!wsId });

  const createWs = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/workspaces', { name: name.trim(), color });
      setWsId(r.id);
      try {
        localStorage.setItem('alypne-ws', r.id);
      } catch {
        /* ignore */
      }
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      setStep(2);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!wsId) return;
    setBusy(true);
    try {
      if (picked) {
        const t = templates.data?.find((x) => x.id === picked);
        const r = await api.post(`/templates/${picked}/apply`, { workspaceId: wsId, name: t?.name ?? 'My first board' });
        navigate(`/b/${r.boardId}`, { replace: true });
      } else {
        const r = await api.post<{ id: string }>('/boards', { workspaceId: wsId, name: 'My first board' });
        navigate(`/b/${r.id}`, { replace: true });
      }
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-14 items-center justify-between px-5">
        <Logo size={22} />
        <span className="text-xs text-faint">Step {step} of 2</span>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-[6vh] pb-16">
        {step === 1 ? (
          <div className="mx-auto max-w-md">
            <h1 className="text-2xl font-semibold tracking-tight">Set up your studio</h1>
            <p className="mt-1.5 text-sm text-muted">A workspace holds your team, boards, game projects, bugs and releases. You can create more later.</p>
            <form
              className="mt-7 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) createWs();
              }}
            >
              <Field label="Studio or group name" htmlFor="ws">
                <Input id="ws" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
              </Field>
              <Field label="Colour">
                <ColorSwatches colors={COLORS} value={color} onChange={setColor} />
              </Field>
              <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!name.trim()}>
                Continue <ArrowRight className="size-4" />
              </Button>
            </form>
            <div className="mt-10 grid grid-cols-2 gap-3 text-[13px] text-muted">
              {[
                [<LayoutGrid key="a" />, 'Boards, lists & cards'],
                [<Bug key="b" />, 'Bug tracking'],
                [<Rocket key="c" />, 'Release planning'],
                [<Users key="d" />, 'Roles & permissions'],
              ].map(([i, t], k) => (
                <div key={k} className="flex items-center gap-2 [&>svg]:size-4 [&>svg]:text-accent">
                  {i}
                  {t}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Start with a board</h1>
            <p className="mt-1.5 text-sm text-muted">Pick a Roblox-ready template or start blank. Everything is editable.</p>
            {templates.isLoading ? (
              <div className="py-10">
                <Spinner />
              </div>
            ) : (
              <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                <TemplateTile selected={picked === null} onClick={() => setPicked(null)} title="Blank board" description="Backlog, In Progress, Testing and Done." icon={<LayoutGrid className="size-4" />} />
                {templates.data?.map((t) => (
                  <TemplateTile key={t.id} selected={picked === t.id} onClick={() => setPicked(t.id)} title={t.name} description={t.description} icon={<Gamepad2 className="size-4" />} />
                ))}
              </div>
            )}
            <div className="mt-8 flex items-center justify-between">
              <Link to={wsId ? `/w/${wsId}/dashboard` : '/app'} className="text-sm text-muted hover:text-fg">
                Skip for now
              </Link>
              <Button variant="primary" loading={busy} onClick={finish}>
                Create board <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function TemplateTile({ selected, onClick, title, description, icon }: { selected: boolean; onClick: () => void; title: string; description: string; icon: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={selected} className={cn('flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors focus-ring', selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2')}>
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', selected ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-muted')}>{selected ? <Check className="size-4" /> : icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted">{description}</span>
      </span>
    </button>
  );
}

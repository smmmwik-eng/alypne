import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, MailCheck, XCircle } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useMe, useDocumentTitle } from '@/lib/hooks';
import { Button, Field, Input, Spinner } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { WorkspaceIcon } from '@/components/AppLayout';

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,var(--accent-soft),transparent)]" />
      <header className="relative flex h-14 items-center justify-between px-5">
        <Link to="/" aria-label="Alypne home" className="rounded-md focus-ring">
          <Logo size={22} />
        </Link>
        <Link to="/" className="flex items-center gap-1 text-[13px] text-muted hover:text-fg">
          <ArrowLeft className="size-3.5" /> Back to site
        </Link>
      </header>
      <main className="relative flex flex-1 items-start justify-center px-4 pt-[8vh] pb-12">
        <div className="w-full max-w-[380px]">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          <div className="mt-7">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {error}
    </div>
  );
}

function useNext() {
  const [params] = useSearchParams();
  const next = params.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';
}

export function SignIn() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const next = useNext();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post('/auth/signin', { identifier, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your Alypne account."
      footer={
        <>
          New to Alypne?{' '}
          <Link to={`/signup${next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-fg hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <FormError error={error} />
        <Field label="Email or username" htmlFor="identifier">
          <Input id="identifier" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoFocus />
        </Field>
        <Field
          label={
            <span className="flex items-center justify-between">
              Password
              <Link to="/forgot-password" className="text-xs font-normal text-muted hover:text-fg">
                Forgot password?
              </Link>
            </span>
          }
          htmlFor="password"
        >
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!identifier || !password}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

export function SignUp() {
  const [form, setForm] = useState({ email: '', username: '', displayName: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifyNotice, setVerifyNotice] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const next = useNext();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const usernameOk = /^[a-zA-Z0-9_]{3,32}$/.test(form.username);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post<{ verificationRequired: boolean }>('/auth/signup', { ...form, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (res.verificationRequired) {
        setVerifyNotice(true);
        return;
      }
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(next !== '/app' ? next : '/app/onboarding', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  if (verifyNotice) {
    return (
      <AuthShell title="Check your email" subtitle={`We sent a verification link to ${form.email}. Open it to activate your account.`}>
        <MailCheck className="size-10 text-accent" />
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title="Create your account"
      subtitle="Free for every studio. No plans, no paywalls."
      footer={
        <>
          Already have an account?{' '}
          <Link to={`/signin${next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-fg hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <FormError error={error} />
        <Field label="Display name" htmlFor="displayName">
          <Input id="displayName" autoComplete="name" value={form.displayName} onChange={set('displayName')} maxLength={60} required autoFocus />
        </Field>
        <Field label="Username" htmlFor="username" hint="Used for @mentions. Letters, numbers and underscores." error={form.username && !usernameOk ? '3–32 letters, numbers or underscores' : null}>
          <Input id="username" autoComplete="username" value={form.username} onChange={set('username')} maxLength={32} required invalid={!!form.username && !usernameOk} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <Input id="password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} minLength={8} required />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!form.email || !usernameOk || !form.displayName || form.password.length < 8}>
          Create account
        </Button>
        <p className="text-center text-xs text-faint">
          By continuing you agree to the{' '}
          <Link to="/terms" className="underline hover:text-muted">
            Terms
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className="underline hover:text-muted">
            Privacy Policy
          </Link>
          . Alypne never asks for your Roblox password.
        </p>
      </form>
    </AuthShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<null | { mailConfigured: boolean }>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setSent(await api.post('/auth/forgot-password', { email }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new password." footer={<Link to="/signin" className="hover:text-fg">Back to sign in</Link>}>
      {sent ? (
        <div className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <CheckCircle2 className="size-5 text-success" />
          <p>If an account exists for {email}, a reset link is on its way. It expires in 1 hour.</p>
          {!sent.mailConfigured && <p className="text-xs text-warning">This Alypne instance has no email server configured, so the link was written to the server log instead. Ask your administrator.</p>}
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <FormError error={error} />
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!email}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/app', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthShell title="Choose a new password" subtitle="All other sessions will be signed out.">
      {!token ? (
        <FormError error="This link is missing its token. Request a new reset email." />
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <FormError error={error} />
          <Field label="New password" htmlFor="password" hint="At least 8 characters.">
            <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={password.length < 8}>
            Update password
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [msg, setMsg] = useState('');
  const qc = useQueryClient();
  useEffect(() => {
    if (!token) {
      setState('error');
      setMsg('This link is missing its token.');
      return;
    }
    api
      .post('/auth/verify-email', { token })
      .then(() => {
        setState('ok');
        qc.invalidateQueries({ queryKey: ['me'] });
      })
      .catch((e) => {
        setState('error');
        setMsg(errorMessage(e));
      });
  }, [token, qc]);
  return (
    <AuthShell title={state === 'ok' ? 'Email verified' : state === 'error' ? 'Verification failed' : 'Verifying…'}>
      <div className="space-y-4 text-sm">
        {state === 'loading' && <Spinner />}
        {state === 'ok' && (
          <>
            <CheckCircle2 className="size-8 text-success" />
            <p className="text-muted">Thanks — your email address is confirmed.</p>
            <Link to="/app">
              <Button variant="primary">Open Alypne</Button>
            </Link>
          </>
        )}
        {state === 'error' && (
          <>
            <XCircle className="size-8 text-danger" />
            <p className="text-muted">{msg}</p>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export function InvitePage() {
  const { token = '' } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inv = useQuery({ queryKey: ['invite', token], queryFn: () => api.get(`/invitations/${token}`), retry: false });
  const accept = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<{ workspaceId: string }>(`/invitations/${token}/accept`);
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      try {
        localStorage.setItem('alypne-ws', r.workspaceId);
      } catch {
        /* ignore */
      }
      navigate(`/w/${r.workspaceId}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  if (inv.isLoading || me.isLoading) return <AuthShell title="Invitation"><Spinner /></AuthShell>;
  if (inv.isError) return <AuthShell title="Invitation not available" subtitle="This invitation link is invalid, expired, revoked or has already been used. Ask for a new one."><Link to="/app"><Button>Go to Alypne</Button></Link></AuthShell>;
  const i = inv.data.invitation;
  const next = `/invite/${token}`;
  return (
    <AuthShell title={`Join ${i.workspaceName}`} subtitle={`${i.invitedBy ?? 'A teammate'} invited you to join as ${i.role === 'admin' ? 'an admin' : `a ${i.role}`}.`}>
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
          <WorkspaceIcon name={i.workspaceName} color={i.workspaceColor} logo={i.workspaceLogo} size={36} />
          <div>
            <div className="font-semibold">{i.workspaceName}</div>
            <div className="text-xs text-muted capitalize">Role: {i.role}</div>
          </div>
        </div>
        <FormError error={error} />
        {me.data?.user ? (
          <Button variant="primary" className="w-full" loading={loading} onClick={accept}>
            Accept invitation as @{me.data.user.username}
          </Button>
        ) : (
          <div className="grid gap-2">
            <Link to={`/signup?next=${encodeURIComponent(next)}`}>
              <Button variant="primary" className="w-full">
                Create an account to join
              </Button>
            </Link>
            <Link to={`/signin?next=${encodeURIComponent(next)}`}>
              <Button className="w-full">I already have an account</Button>
            </Link>
          </div>
        )}
      </div>
    </AuthShell>
  );
}

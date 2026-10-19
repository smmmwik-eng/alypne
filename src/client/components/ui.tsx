import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  createContext,
  useContext,
  useCallback,
  useMemo,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, X, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import { cn, colorFor, initials } from '@/lib/format';

/* =============================================================== Button */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'light';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border border-line',
  ghost: 'bg-transparent text-muted hover:text-fg hover:bg-surface-2 border border-transparent',
  danger: 'bg-danger text-white hover:opacity-90 border border-transparent',
  outline: 'bg-transparent text-fg border border-line-strong hover:bg-surface-2',
  light: 'bg-fg text-canvas hover:opacity-90 border border-transparent',
};
const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded-md',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-full',
  icon: 'h-9 w-9 rounded-lg justify-center',
  'icon-sm': 'h-7 w-7 rounded-md justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center font-medium whitespace-nowrap transition-colors duration-100 select-none focus-ring disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

/* ================================================================ Inputs */

const fieldBase =
  'w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-faint transition-colors outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-9', invalid && 'border-danger', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, 'py-2 leading-relaxed resize-y min-h-20', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(fieldBase, 'h-9 appearance-none pr-8', className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-faint" />
    </div>
  );
});

export function Field({ label, hint, error, children, htmlFor, className }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-fg">
          {label}
        </label>
      )}
      {children}
      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, className, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; className?: string; id?: string }) {
  return (
    <label className={cn('inline-flex items-center gap-2 select-none', disabled ? 'opacity-50' : 'cursor-pointer', className)}>
      <button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('flex size-4 shrink-0 items-center justify-center rounded border transition-colors focus-ring', checked ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface-2 hover:border-faint')}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </button>
      {label && <span className="text-sm">{label}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled, description }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; description?: ReactNode }) {
  return (
    <label className={cn('flex items-start justify-between gap-4', disabled ? 'opacity-50' : 'cursor-pointer')}>
      {(label || description) && (
        <span>
          {label && <span className="block text-sm font-medium">{label}</span>}
          {description && <span className="block text-xs text-faint">{description}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus-ring', checked ? 'bg-accent' : 'bg-surface-3 border border-line-strong')}
      >
        <span className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </label>
  );
}

/* =============================================================== Display */

export function Avatar({ name, src, size = 24, className, title }: { name: string; src?: string | null; size?: number; className?: string; title?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(9, size * 0.4) };
  if (src && !broken) {
    return <img src={src} alt="" title={title ?? name} onError={() => setBroken(true)} className={cn('shrink-0 rounded-full object-cover ring-1 ring-line', className)} style={style} />;
  }
  return (
    <span title={title ?? name} aria-label={name} className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white/95', className)} style={{ ...style, background: colorFor(name) }}>
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ people, max = 4, size = 24 }: { people: { id: string; displayName: string; avatarUrl: string | null }[]; max?: number; size?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <div className="flex -space-x-1.5">
      {shown.map((p) => (
        <Avatar key={p.id} name={p.displayName} src={p.avatarUrl} size={size} className="ring-2 ring-canvas" />
      ))}
      {rest > 0 && (
        <span className="inline-flex items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-muted ring-2 ring-canvas" style={{ width: size, height: size }}>
          +{rest}
        </span>
      )}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'danger' | 'warning' | 'success' | 'info'; className?: string }) {
  const tones = {
    neutral: 'bg-surface-3 text-muted',
    accent: 'bg-accent-soft text-accent',
    danger: 'bg-danger-soft text-danger',
    warning: 'bg-warning-soft text-warning',
    success: 'bg-success-soft text-success',
    info: 'bg-surface-3 text-info',
  };
  return <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none', tones[tone], className)}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-faint', className)} aria-label="Loading" />;
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Spinner className="size-5" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" />;
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted">{icon}</div>}
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface', className)} {...rest}>
      {children}
    </div>
  );
}

export function PageHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted">{icon}</div>}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; icon?: ReactNode }[]; className?: string }) {
  return (
    <div role="tablist" className={cn('inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5', className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors focus-ring', value === t.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, className, tone = 'accent' }: { value: number; className?: string; tone?: 'accent' | 'success' }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full transition-[width] duration-300', tone === 'success' || v === 100 ? 'bg-success' : 'bg-accent')} style={{ width: `${v}%` }} />
    </div>
  );
}

/* ================================================================= Modal */

export function Modal({ open, onClose, title, children, footer, size = 'md', className, labelledBy }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'; className?: string; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => {
      const target = ref.current?.querySelector<HTMLElement>('[autofocus],input,textarea,select,button');
      target?.focus();
    }, 20);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-6xl' };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-3 sm:p-6 md:pt-[8vh]" role="presentation">
      <div className="fixed inset-0 bg-[var(--overlay)] animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn('relative z-10 w-full rounded-2xl border border-line bg-surface shadow-pop animate-pop-in', widths[size], className)}
      >
        {title && (
          <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
            <h2 id={labelledBy} className="text-[15px] font-semibold">
              {title}
            </h2>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <X className="size-4" />
            </Button>
          </div>
        )}
        <div className={cn(title ? 'p-5' : '')}>{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', danger, requireText, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; requireText?: string; loading?: boolean }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  const ok = !requireText || text.trim() === requireText;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!ok} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        {description}
        {requireText && (
          <Field label={<span className="font-normal text-muted">Type <strong className="text-fg">{requireText}</strong> to confirm</span>}>
            <Input value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/* =============================================================== Popover */

export function usePopover() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  return { open, setOpen, anchorRef, toggle: () => setOpen((o) => !o), close: () => setOpen(false) };
}

/** Anchored floating panel rendered in a portal, flipped/clamped to stay on screen. */
export function Popover({ open, onClose, anchor, children, align = 'start', className, width }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; children: ReactNode; align?: 'start' | 'end'; className?: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const el = ref.current;
    if (!a || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'end' ? a.right - w : a.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = a.bottom + 6;
    if (top + h > window.innerHeight - 8 && a.top - h - 6 > 8) top = a.top - h - 6;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    setPos({ top, left });
  }, [anchor, align]);
  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    const onResize = () => place();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    const ro = new ResizeObserver(() => place());
    if (ref.current) ro.observe(ref.current);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
      ro.disconnect();
    };
  }, [open, onClose, anchor, place]);
  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className={cn('fixed z-[60] rounded-xl border border-line bg-surface p-1.5 shadow-pop animate-pop-in', className)}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxHeight: 'min(70vh, 520px)', overflowY: 'auto' }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({ icon, children, onClick, danger, disabled, shortcut, active }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; shortcut?: string; active?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors focus-ring disabled:opacity-40',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-fg hover:bg-surface-2',
        active && 'bg-surface-2',
      )}
    >
      {icon && <span className={cn('flex size-4 items-center justify-center', danger ? 'text-danger' : 'text-muted')}>{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="text-[11px] text-faint">{shortcut}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-line" role="separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{children}</div>;
}

/** Button + popover menu. */
export function DropdownMenu({ trigger, children, align = 'end', width = 220 }: { trigger: (p: { ref: React.Ref<any>; onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: 'start' | 'end'; width?: number }) {
  const p = usePopover();
  return (
    <>
      {trigger({ ref: p.anchorRef, onClick: p.toggle, 'aria-expanded': p.open, 'aria-haspopup': 'menu' })}
      <Popover open={p.open} onClose={p.close} anchor={p.anchorRef} align={align} width={width}>
        <div role="menu" onClick={(e) => (e.target as HTMLElement).closest('[role=menuitem]') && typeof children !== 'function' && p.close()}>
          {typeof children === 'function' ? children(p.close) : children}
        </div>
      </Popover>
    </>
  );
}

/* ================================================================= Toast */

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  message: string;
  action?: { label: string; onClick: () => void };
}
const ToastCtx = createContext<{ push: (t: Omit<Toast, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.slice(-3), { ...t, id }]);
    window.setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.tone === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-4 z-[80] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite" role="status">
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm shadow-pop animate-slide-up">
              {t.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : t.tone === 'error' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" /> : <Info className="mt-0.5 size-4 shrink-0 text-info" />}
              <span className="flex-1">{t.message}</span>
              {t.action && (
                <button className="shrink-0 text-[13px] font-medium text-accent hover:underline" onClick={t.action.onClick}>
                  {t.action.label}
                </button>
              )}
              <button className="shrink-0 text-faint hover:text-fg" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('ToastProvider missing');
  const push = ctx.push;
  return useMemo(
    () => ({
      success: (message: string, action?: Toast['action']) => push({ tone: 'success', message, action }),
      error: (message: string) => push({ tone: 'error', message }),
      info: (message: string, action?: Toast['action']) => push({ tone: 'info', message, action }),
    }),
    [push],
  );
}

/* ========================================================== Color swatches */

export function ColorSwatches({ colors, value, onChange, size = 24 }: { colors: readonly string[]; value?: string | null; onChange: (c: string) => void; size?: number }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          aria-label={`Colour ${c}`}
          aria-pressed={value === c}
          className={cn('flex items-center justify-center rounded-md transition-transform hover:scale-110 focus-ring', value === c && 'ring-2 ring-fg ring-offset-2 ring-offset-surface')}
          style={{ width: size, height: size, background: c }}
        >
          {value === c && <Check className="size-3.5 text-black/70" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

/** Inline editable text that saves on blur/Enter and cancels on Escape. */
export function InlineEdit({ value, onSave, className, inputClassName, placeholder, disabled, multiline, ariaLabel }: { value: string; onSave: (v: string) => void; className?: string; inputClassName?: string; placeholder?: string; disabled?: boolean; multiline?: boolean; ariaLabel?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== value) onSave(v);
    else setDraft(value);
  };
  if (!editing || disabled) {
    return (
      <button type="button" disabled={disabled} onClick={() => setEditing(true)} aria-label={ariaLabel ? `Edit ${ariaLabel}` : undefined} className={cn('min-w-0 rounded-md text-left focus-ring', !disabled && 'hover:bg-surface-2', className)}>
        {value || <span className="text-faint">{placeholder}</span>}
      </button>
    );
  }
  const common = {
    autoFocus: true,
    value: draft,
    'aria-label': ariaLabel,
    onChange: (e: any) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: any) => {
      if (e.key === 'Enter' && (!multiline || !e.shiftKey)) {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        setDraft(value);
        setEditing(false);
      }
    },
    className: cn('w-full rounded-md border border-accent bg-surface-2 px-1.5 outline-none ring-2 ring-accent-soft', inputClassName),
  };
  return multiline ? <textarea rows={2} {...common} onFocus={(e) => e.currentTarget.select()} /> : <input {...common} onFocus={(e) => e.currentTarget.select()} />;
}

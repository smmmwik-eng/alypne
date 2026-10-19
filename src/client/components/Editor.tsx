import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Bold, Code, Eye, Italic, Link2, List, ListChecks, Pencil, Heading2 } from 'lucide-react';
import { cn } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import { Avatar, Button } from './ui';
import type { MemberLite } from '@/lib/types';

export interface MentionTextareaHandle {
  focus: () => void;
  insert: (before: string, after?: string) => void;
}

/** Textarea with @mention autocomplete for board members. */
export const MentionTextarea = forwardRef<MentionTextareaHandle, { value: string; onChange: (v: string) => void; members: MemberLite[]; placeholder?: string; rows?: number; onSubmit?: () => void; className?: string; autoFocus?: boolean; ariaLabel?: string }>(function MentionTextarea(
  { value, onChange, members, placeholder, rows = 3, onSubmit, className, autoFocus, ariaLabel },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    insert: (before, after = '') => {
      const el = ta.current;
      if (!el) return;
      const { selectionStart: s, selectionEnd: e } = el;
      const sel = value.slice(s, e);
      const next = value.slice(0, s) + before + sel + after + value.slice(e);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(s + before.length, s + before.length + sel.length);
      });
    },
  }));
  const matches = query === null ? [] : members.filter((m) => m.username.toLowerCase().startsWith(query) || m.displayName.toLowerCase().includes(query)).slice(0, 6);
  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|\s)@([a-zA-Z0-9_]{0,32})$/.exec(before);
    setQuery(m ? m[2].toLowerCase() : null);
    setActive(0);
  };
  const choose = (m: MemberLite) => {
    const el = ta.current!;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/@([a-zA-Z0-9_]{0,32})$/, `@${m.username} `);
    const next = before + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };
  return (
    <div className="relative">
      <textarea
        ref={ta}
        value={value}
        rows={rows}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => (a + 1) % matches.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (a - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              choose(matches[active]);
              return;
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setQuery(null);
              return;
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        className={cn('w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent-soft', className)}
      />
      {matches.length > 0 && (
        <div className="absolute top-full left-0 z-20 mt-1 w-64 rounded-xl border border-line bg-surface p-1 shadow-pop" role="listbox">
          {matches.map((m, i) => (
            <button key={m.id} type="button" role="option" aria-selected={i === active} onMouseDown={(e) => (e.preventDefault(), choose(m))} className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]', i === active ? 'bg-surface-2' : '')}>
              <Avatar name={m.displayName} src={m.avatarUrl} size={20} />
              <span className="truncate">{m.displayName}</span>
              <span className="truncate text-faint">@{m.username}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

/** Markdown description editor with formatting toolbar and preview. */
export function MarkdownEditor({ value, onSave, onCancel, members, saving, placeholder }: { value: string; onSave: (v: string) => void; onCancel: () => void; members: MemberLite[]; saving?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  const ref = useRef<MentionTextareaHandle>(null);
  const tools: [React.ReactNode, string, string, string?][] = [
    [<Bold key="b" className="size-3.5" />, 'Bold', '**', '**'],
    [<Italic key="i" className="size-3.5" />, 'Italic', '_', '_'],
    [<Heading2 key="h" className="size-3.5" />, 'Heading', '## ', ''],
    [<List key="l" className="size-3.5" />, 'Bulleted list', '- ', ''],
    [<ListChecks key="c" className="size-3.5" />, 'Task list', '- [ ] ', ''],
    [<Code key="co" className="size-3.5" />, 'Code', '`', '`'],
    [<Link2 key="li" className="size-3.5" />, 'Link', '[', '](https://)'],
  ];
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-0.5 border-b border-line px-1.5 py-1">
        {tools.map(([icon, label, a, b]) => (
          <button key={label} type="button" title={label} aria-label={label} disabled={preview} onClick={() => ref.current?.insert(a, b)} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40">
            {icon}
          </button>
        ))}
        <button type="button" onClick={() => setPreview((p) => !p)} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">
          {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
          {preview ? 'Write' : 'Preview'}
        </button>
      </div>
      <div className="p-2">
        {preview ? (
          <div className="min-h-32 px-1 py-1">{draft.trim() ? <Markdown source={draft} /> : <p className="text-sm text-faint">Nothing to preview</p>}</div>
        ) : (
          <MentionTextarea ref={ref} value={draft} onChange={setDraft} members={members} rows={8} autoFocus placeholder={placeholder ?? 'Add a more detailed description… Markdown and @mentions supported.'} onSubmit={() => onSave(draft)} className="border-0 bg-transparent focus:ring-0" ariaLabel="Description" />
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-2 py-2">
        <Button size="sm" variant="primary" loading={saving} onClick={() => onSave(draft)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto text-[11px] text-faint">Ctrl/⌘ + Enter to save</span>
      </div>
    </div>
  );
}

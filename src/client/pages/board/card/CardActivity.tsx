import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Reply } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import type { Activity, BoardData, CardDetail, Comment } from '@/lib/types';
import { cn, fullDate, relativeTime } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import { useMe } from '@/lib/hooks';
import { MentionTextarea } from '@/components/Editor';
import { ActivityRow } from '@/components/activityText';
import { Avatar, Button, ConfirmDialog, Tabs, useToast } from '@/components/ui';
import { Section } from './CardSections';

function Composer({ board, onSubmit, placeholder, autoFocus, onCancel, initial = '', submitLabel = 'Comment' }: { board: BoardData; onSubmit: (text: string) => Promise<void>; placeholder: string; autoFocus?: boolean; onCancel?: () => void; initial?: string; submitLabel?: string }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(!!autoFocus || !!initial);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(text.trim());
      setText('');
      if (!onCancel) setFocused(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div onFocus={() => setFocused(true)}>
      <MentionTextarea value={text} onChange={setText} members={board.members} placeholder={placeholder} rows={focused ? 3 : 1} onSubmit={submit} autoFocus={autoFocus} ariaLabel={placeholder} className="text-[13px]" />
      {(focused || text) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={!text.trim()}>
            {submitLabel}
          </Button>
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <span className="ml-auto text-[11px] text-faint">Markdown · @mention · Ctrl/⌘+Enter</span>
        </div>
      )}
    </div>
  );
}

function CommentItem({ c, replies, board, canComment, cardId, onChanged, isAdmin }: { c: Comment; replies: Comment[]; board: BoardData; canComment: boolean; cardId: string; onChanged: () => void; isAdmin: boolean }) {
  const me = useMe();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const mine = c.author?.id === me.data?.user?.id;
  return (
    <div className="flex gap-2.5">
      <Avatar name={c.author?.displayName ?? 'Deleted user'} src={c.author?.avatarUrl} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
          <span className="font-medium">{c.author?.displayName ?? 'Deleted user'}</span>
          <span className="text-[11px] text-faint" title={fullDate(c.createdAt)}>
            {relativeTime(c.createdAt)}
            {c.editedAt && ' (edited)'}
          </span>
        </div>
        {c.deleted ? (
          <p className="mt-1 text-[13px] text-faint italic">This comment was deleted.</p>
        ) : editing ? (
          <div className="mt-1">
            <Composer
              board={board}
              initial={c.body}
              autoFocus
              submitLabel="Save"
              placeholder="Edit comment"
              onCancel={() => setEditing(false)}
              onSubmit={async (text) => {
                try {
                  await api.patch(`/comments/${c.id}`, { body: text });
                  setEditing(false);
                  onChanged();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            />
          </div>
        ) : (
          <div className="mt-1 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-[13px]">
            <Markdown source={c.body} />
          </div>
        )}
        {!c.deleted && !editing && (
          <div className="mt-1 flex gap-3 text-[11px] text-faint">
            {canComment && !c.parentId && (
              <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setReplying(true)}>
                <Reply className="size-3" /> Reply
              </button>
            )}
            {mine && (
              <button className="hover:text-fg" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            {(mine || isAdmin) && (
              <button className="hover:text-danger" onClick={() => setConfirm(true)}>
                Delete
              </button>
            )}
          </div>
        )}
        {(replies.length > 0 || replying) && (
          <div className="mt-3 space-y-3 border-l border-line pl-3">
            {replies.map((r) => (
              <CommentItem key={r.id} c={r} replies={[]} board={board} canComment={canComment} cardId={cardId} onChanged={onChanged} isAdmin={isAdmin} />
            ))}
            {replying && (
              <Composer
                board={board}
                autoFocus
                placeholder={`Reply to ${c.author?.displayName ?? 'comment'}…`}
                submitLabel="Reply"
                onCancel={() => setReplying(false)}
                onSubmit={async (text) => {
                  try {
                    await api.post(`/cards/${cardId}/comments`, { body: text, parentId: c.id });
                    setReplying(false);
                    onChanged();
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              />
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete comment?"
        danger
        confirmLabel="Delete"
        onConfirm={async () => {
          setConfirm(false);
          try {
            await api.del(`/comments/${c.id}`);
            onChanged();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </div>
  );
}

export function CardActivity({ detail, board, onChanged }: { detail: CardDetail; board: BoardData; onChanged: () => void }) {
  const [tab, setTab] = useState<'comments' | 'all' | 'history'>('comments');
  const toast = useToast();
  const me = useMe();
  const activity = useQuery({ queryKey: ['activity', 'card', detail.card.id, detail.card.version, detail.comments.length], queryFn: () => api.get<{ activities: Activity[] }>(`/cards/${detail.card.id}/activity`).then((r) => r.activities), enabled: tab !== 'comments' });
  const canComment = !!me.data?.user && (detail.role !== 'observer' || board.board.settings.commentPermission === 'observers') && !board.board.archivedAt;
  const roots = useMemo(() => detail.comments.filter((c) => !c.parentId).reverse(), [detail.comments]);
  const repliesOf = (id: string) => detail.comments.filter((c) => c.parentId === id);
  const feed = useMemo(() => {
    if (tab !== 'all') return [];
    const items: { at: string; node: 'comment' | 'activity'; data: any }[] = [
      ...roots.map((c) => ({ at: c.createdAt, node: 'comment' as const, data: c })),
      ...(activity.data ?? []).filter((a) => a.type !== 'comment.added').map((a) => ({ at: a.createdAt, node: 'activity' as const, data: a })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }, [tab, roots, activity.data]);
  return (
    <Section icon={<MessageSquare />} title="Activity" actions={<Tabs value={tab} onChange={setTab} tabs={[{ value: 'comments', label: `Comments${detail.comments.length ? ` (${detail.comments.filter((c) => !c.deleted).length})` : ''}` }, { value: 'all', label: 'All' }, { value: 'history', label: 'History' }]} />}>
      {canComment && tab !== 'history' && (
        <div className="mb-4">
          <Composer
            board={board}
            placeholder="Write a comment…"
            onSubmit={async (text) => {
              try {
                await api.post(`/cards/${detail.card.id}/comments`, { body: text });
                onChanged();
              } catch (e) {
                toast.error(errorMessage(e));
                throw e;
              }
            }}
          />
        </div>
      )}
      {tab === 'comments' && (
        <div className="space-y-4">
          {roots.map((c) => (
            <CommentItem key={c.id} c={c} replies={repliesOf(c.id)} board={board} canComment={canComment} cardId={detail.card.id} onChanged={onChanged} isAdmin={detail.role === 'admin'} />
          ))}
          {!roots.length && <p className="text-[13px] text-faint">No comments yet.</p>}
        </div>
      )}
      {tab === 'all' && (
        <div className="space-y-3">
          {feed.map((f) =>
            f.node === 'comment' ? (
              <CommentItem key={f.data.id} c={f.data} replies={repliesOf(f.data.id)} board={board} canComment={canComment} cardId={detail.card.id} onChanged={onChanged} isAdmin={detail.role === 'admin'} />
            ) : (
              <ActivityRow key={f.data.id} a={f.data} withCard={false} />
            ),
          )}
        </div>
      )}
      {tab === 'history' && (
        <div className={cn('divide-y divide-line')}>
          {(activity.data ?? []).map((a) => (
            <ActivityRow key={a.id} a={a} withCard={false} />
          ))}
          {activity.data && !activity.data.length && <p className="text-[13px] text-faint">No activity yet.</p>}
        </div>
      )}
    </Section>
  );
}

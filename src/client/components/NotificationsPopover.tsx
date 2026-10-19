import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useUnreadCount } from '@/lib/hooks';
import type { Notification } from '@/lib/types';
import { cn, relativeTime } from '@/lib/format';
import { Avatar, Button, Popover, Spinner, usePopover } from './ui';

export function NotificationRow({ n, onOpen }: { n: Notification; onOpen: (n: Notification) => void }) {
  return (
    <button onClick={() => onOpen(n)} className={cn('flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-2', !n.readAt && 'bg-accent-soft/40')}>
      {n.actor?.displayName ? <Avatar name={n.actor.displayName} src={n.actor.avatarUrl} size={26} /> : <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted"><Bell className="size-3.5" /></span>}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-snug">{n.title}</span>
        {n.body && <span className="mt-0.5 block truncate text-xs text-muted">{n.body}</span>}
        <span className="mt-0.5 block text-[11px] text-faint">{relativeTime(n.createdAt)}</span>
      </span>
      {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
    </button>
  );
}

export function NotificationsPopover() {
  const p = usePopover();
  const count = useUnreadCount(true);
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => api.get<{ notifications: Notification[] }>('/notifications?limit=12'), enabled: p.open });
  const markRead = useAction((ids: string[]) => api.post('/notifications/read', { ids }), { invalidate: [['notifications']], silentError: true });
  const markAll = useAction(() => api.post('/notifications/read-all'), { invalidate: [['notifications']] });
  const open = (n: Notification) => {
    if (!n.readAt) markRead.mutate([n.id]);
    p.close();
    if (n.link) navigate(n.link);
  };
  return (
    <>
      <Button ref={p.anchorRef as any} variant="ghost" size="icon-sm" onClick={p.toggle} aria-label={`Notifications${count.data ? `, ${count.data} unread` : ''}`} className="relative">
        <Bell className="size-4" />
        {!!count.data && <span className="absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-accent-fg">{count.data > 9 ? '9+' : count.data}</span>}
      </Button>
      <Popover open={p.open} onClose={p.close} anchor={p.anchorRef} align="end" width={380}>
        <div className="flex items-center justify-between px-2.5 py-1.5">
          <span className="text-sm font-semibold">Notifications</span>
          <Button variant="ghost" size="xs" icon={<CheckCheck className="size-3.5" />} onClick={() => markAll.mutate(undefined)} disabled={!count.data}>
            Mark all read
          </Button>
        </div>
        {list.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : list.data?.notifications.length ? (
          <div className="space-y-0.5">
            {list.data.notifications.map((n) => (
              <NotificationRow key={n.id} n={n} onOpen={open} />
            ))}
          </div>
        ) : (
          <div className="px-3 py-8 text-center text-sm text-muted">You're all caught up.</div>
        )}
        <div className="mt-1 border-t border-line pt-1.5 text-center">
          <Link to="/app/notifications" onClick={p.close} className="text-[13px] text-accent hover:underline">
            View all notifications
          </Link>
        </div>
      </Popover>
    </>
  );
}

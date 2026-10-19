import { and, inArray, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../deps.js';
import { notifications, users, boardMembers } from '../db/schema.js';
import { newId } from './crypto.js';
import { publishUser } from './realtime.js';
import { boardAccess, workspaceRole } from './access.js';
import { enqueue } from '../jobs/queue.js';
import type { NotificationType } from '../../shared/constants.js';

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string | null;
  workspaceId?: string | null;
  boardId?: string | null;
  cardId?: string | null;
  actorId?: string | null;
  dedupeKey?: string;
}

const DIRECT = new Set<NotificationType>(['mentioned', 'assigned', 'comment_reply', 'invitation']);
const EMAIL_DEFAULT_ON = new Set<NotificationType>(['assigned', 'mentioned', 'due_soon', 'overdue', 'invitation', 'comment_reply']);

export function prefFor(prefs: Record<string, { inApp: boolean; email: boolean }> | null | undefined, type: NotificationType) {
  const p = prefs?.[type];
  return { inApp: p?.inApp ?? true, email: p?.email ?? EMAIL_DEFAULT_ON.has(type) };
}

/**
 * Create notifications for recipients. Recipients are filtered so nobody is told
 * about a board or workspace they cannot access, the actor is never notified of
 * their own action, and `dedupeKey` makes retries idempotent per recipient.
 */
export async function notify(userIds: string[], input: NotificationInput): Promise<number> {
  const recipients = [...new Set(userIds)].filter((u) => u && u !== input.actorId);
  if (!recipients.length) return 0;
  const rows = await db()
    .select({ id: users.id, prefs: users.notificationPrefs, deletedAt: users.deletedAt })
    .from(users)
    .where(inArray(users.id, recipients));
  let created = 0;
  for (const r of rows) {
    if (r.deletedAt) continue;
    if (input.boardId) {
      if (!(await boardAccess(r.id, input.boardId))) continue;
      // Muted boards only deliver direct mentions and assignments.
      if (!DIRECT.has(input.type)) {
        const [bm] = await db().select({ level: boardMembers.notificationLevel }).from(boardMembers).where(and(eq(boardMembers.boardId, input.boardId), eq(boardMembers.userId, r.id)));
        if (bm?.level === 'none') continue;
      }
    } else if (input.workspaceId && input.type !== 'invitation') {
      if (!(await workspaceRole(r.id, input.workspaceId))) continue;
    }
    const pref = prefFor(r.prefs, input.type);
    if (!pref.inApp && !pref.email) continue;
    const id = newId();
    const link = input.link ?? (input.cardId && input.boardId ? `/b/${input.boardId}/c/${input.cardId}` : input.boardId ? `/b/${input.boardId}` : null);
    const res = await db()
      .insert(notifications)
      .values({
        id,
        userId: r.id,
        type: input.type,
        title: input.title.slice(0, 300),
        body: (input.body ?? '').slice(0, 1000),
        link,
        workspaceId: input.workspaceId ?? null,
        boardId: input.boardId ?? null,
        cardId: input.cardId ?? null,
        actorId: input.actorId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        // Email-only preference: keep history but mark read so it doesn't nag in-app.
        readAt: pref.inApp ? null : new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (!res.length) continue;
    created++;
    if (pref.inApp) publishUser(r.id, { type: 'notification', id });
    if (pref.email) await enqueue('notification.email', { notificationId: id }, { dedupeKey: `email:${id}` });
  }
  return created;
}

export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

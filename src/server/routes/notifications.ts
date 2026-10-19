import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { notifications, users } from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { body } from '../lib/request.js';
import { unreadCount } from '../lib/notify.js';
import { publishUser } from '../lib/realtime.js';

export const notificationRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const me = requireUser(c);
    const before = c.req.query('before');
    const unreadOnly = c.req.query('unread') === 'true';
    const limit = Math.min(100, Number(c.req.query('limit') ?? 30) || 30);
    const rows = await db()
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        boardId: notifications.boardId,
        cardId: notifications.cardId,
        actor: { id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl },
      })
      .from(notifications)
      .leftJoin(users, eq(users.id, notifications.actorId))
      .where(and(eq(notifications.userId, me.id), unreadOnly ? isNull(notifications.readAt) : undefined, before ? lt(notifications.createdAt, new Date(before)) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    return c.json({ notifications: rows, unread: await unreadCount(me.id), nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null });
  })
  .get('/unread-count', async (c) => {
    const me = requireUser(c);
    return c.json({ unread: await unreadCount(me.id) });
  })
  .post('/read', async (c) => {
    const me = requireUser(c);
    const { ids, read } = await body(c, z.object({ ids: z.array(z.string()).min(1).max(200), read: z.boolean().default(true) }));
    await db()
      .update(notifications)
      .set({ readAt: read ? deps().now() : null })
      .where(and(eq(notifications.userId, me.id), inArray(notifications.id, ids)));
    publishUser(me.id, { type: 'notification.read' });
    return c.json({ ok: true, unread: await unreadCount(me.id) });
  })
  .post('/read-all', async (c) => {
    const me = requireUser(c);
    await db().update(notifications).set({ readAt: deps().now() }).where(and(eq(notifications.userId, me.id), isNull(notifications.readAt)));
    publishUser(me.id, { type: 'notification.read' });
    return c.json({ ok: true, unread: 0 });
  });

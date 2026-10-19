import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, ne, sql, gte, lte, lt, isNotNull } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import {
  users,
  sessions,
  apiTokens,
  externalAccounts,
  workspaceMembers,
  workspaces,
  boards,
  boardFavorites,
  recentViews,
  cards,
  cardAssignees,
  comments,
  notifications,
  activities,
  savedViews,
  lists,
} from '../db/schema.js';
import { type AppEnv, audit, destroySession, requireUser } from '../lib/auth.js';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { rateLimit } from '../lib/rateLimit.js';
import { isValidTimezone, passwordSchema, usernameSchema } from './auth.js';
import { NOTIFICATION_TYPES } from '../../shared/constants.js';
import { visibleBoardPredicate } from '../lib/access.js';
import { cardSummaries } from '../services/cards.js';
import { classifyUpload, putObject } from '../lib/storage.js';
import { env } from '../env.js';

const prefsSchema = z.partialRecord(z.enum(Object.keys(NOTIFICATION_TYPES) as [string, ...string[]]), z.object({ inApp: z.boolean(), email: z.boolean() }));

export const meRoutes = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    requireUser(c);
    await next();
  })

  .get('/', async (c) => {
    const me = requireUser(c);
    const [u] = await db().select().from(users).where(eq(users.id, me.id));
    const ext = await db().select().from(externalAccounts).where(eq(externalAccounts.userId, me.id));
    const { passwordHash: _p, calendarToken, ...profile } = u;
    return c.json({ user: { ...profile, hasCalendarFeed: !!calendarToken }, externalAccounts: ext });
  })

  .patch('/', async (c) => {
    const me = requireUser(c);
    const input = await body(
      c,
      z.object({
        displayName: z.string().trim().min(1).max(60).optional(),
        username: usernameSchema.optional(),
        bio: z.string().max(500).optional(),
        timezone: z.string().max(64).optional(),
        theme: z.enum(['dark', 'light', 'system']).optional(),
        notificationPrefs: prefsSchema.optional(),
        avatarUrl: z.null().optional(),
      }),
    );
    if (input.timezone && !isValidTimezone(input.timezone)) throw badRequest('Unknown timezone');
    if (input.username && input.username.toLowerCase() !== me.username.toLowerCase()) {
      const [taken] = await db().select({ id: users.id }).from(users).where(and(sql`lower(${users.username}) = ${input.username.toLowerCase()}`, ne(users.id, me.id)));
      if (taken) throw conflict('That username is taken');
    }
    const { notificationPrefs, ...rest } = input;
    let prefs: Record<string, { inApp: boolean; email: boolean }> | undefined;
    if (notificationPrefs) {
      const [cur] = await db().select({ p: users.notificationPrefs }).from(users).where(eq(users.id, me.id));
      prefs = { ...cur.p, ...(notificationPrefs as Record<string, { inApp: boolean; email: boolean }>) };
    }
    await db()
      .update(users)
      .set({ ...rest, ...(prefs ? { notificationPrefs: prefs } : {}), updatedAt: deps().now() })
      .where(eq(users.id, me.id));
    return c.json({ ok: true });
  })

  .post('/avatar', rateLimit('avatar', 20, 3600_000), async (c) => {
    const me = requireUser(c);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('Attach an image file');
    if (file.size > 2 * 1024 * 1024) throw badRequest('Avatars must be 2 MB or smaller');
    const data = new Uint8Array(await file.arrayBuffer());
    const kind = classifyUpload(file.name, data);
    if ('error' in kind || !kind.isImage) throw badRequest('Avatar must be a PNG, JPEG, GIF or WebP image');
    const key = `avatars/${me.id}-${randomToken(6)}`;
    await putObject(key, data);
    const url = `/api/public/avatars/${key.split('/')[1]}`;
    await db().update(users).set({ avatarUrl: url }).where(eq(users.id, me.id));
    return c.json({ avatarUrl: url });
  })

  .post('/password', rateLimit('pwchange', 10, 3600_000), async (c) => {
    const me = requireUser(c);
    const input = await body(c, z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }));
    const [u] = await db().select().from(users).where(eq(users.id, me.id));
    if (!(await verifyPassword(input.currentPassword, u.passwordHash))) throw forbidden('Current password is incorrect');
    await db().update(users).set({ passwordHash: await hashPassword(input.newPassword), passwordChangedAt: deps().now() }).where(eq(users.id, me.id));
    // Sign out every other session.
    await db().delete(sessions).where(and(eq(sessions.userId, me.id), ne(sessions.id, c.get('sessionId') ?? '')));
    await audit(c, { action: 'user.password_changed' });
    return c.json({ ok: true });
  })

  .get('/sessions', async (c) => {
    const me = requireUser(c);
    const rows = await db()
      .select({ id: sessions.id, userAgent: sessions.userAgent, ip: sessions.ip, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, me.id))
      .orderBy(desc(sessions.lastSeenAt));
    return c.json({ sessions: rows.map((s) => ({ ...s, current: s.id === c.get('sessionId') })) });
  })

  .delete('/sessions/:id', async (c) => {
    const me = requireUser(c);
    await db().delete(sessions).where(and(eq(sessions.id, c.req.param('id')), eq(sessions.userId, me.id)));
    await audit(c, { action: 'user.session_revoked', targetId: c.req.param('id') });
    return c.json({ ok: true });
  })

  .post('/sessions/revoke-others', async (c) => {
    const me = requireUser(c);
    await db().delete(sessions).where(and(eq(sessions.userId, me.id), ne(sessions.id, c.get('sessionId') ?? '')));
    await audit(c, { action: 'user.sessions_revoked' });
    return c.json({ ok: true });
  })

  /* ----------------------------------------------------------- API tokens */
  .get('/tokens', async (c) => {
    const me = requireUser(c);
    const rows = await db()
      .select({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, scopes: apiTokens.scopes, lastUsedAt: apiTokens.lastUsedAt, expiresAt: apiTokens.expiresAt, createdAt: apiTokens.createdAt })
      .from(apiTokens)
      .where(eq(apiTokens.userId, me.id))
      .orderBy(desc(apiTokens.createdAt));
    return c.json({ tokens: rows });
  })
  .post('/tokens', rateLimit('tokens', 20, 3600_000), async (c) => {
    const me = requireUser(c);
    if (c.get('authVia') !== 'cookie') throw forbidden('API tokens can only be created from the web app');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(z.enum(['read', 'write'])).min(1).default(['read']), expiresInDays: z.number().int().min(1).max(365).nullable().default(90) }));
    const secret = `alp_${randomToken(30)}`;
    const id = newId();
    await db()
      .insert(apiTokens)
      .values({
        id,
        userId: me.id,
        name: input.name,
        tokenHash: sha256(secret),
        prefix: secret.slice(0, 10),
        scopes: input.scopes.includes('write') ? ['read', 'write'] : ['read'],
        expiresAt: input.expiresInDays ? new Date(deps().now().getTime() + input.expiresInDays * 86400_000) : null,
      });
    await audit(c, { action: 'user.api_token_created', targetId: id });
    return c.json({ id, token: secret }, 201);
  })
  .delete('/tokens/:id', async (c) => {
    const me = requireUser(c);
    await db().delete(apiTokens).where(and(eq(apiTokens.id, c.req.param('id')), eq(apiTokens.userId, me.id)));
    await audit(c, { action: 'user.api_token_revoked', targetId: c.req.param('id') });
    return c.json({ ok: true });
  })

  /* ----------------------------------------------------- calendar feed */
  .post('/calendar-feed', async (c) => {
    const me = requireUser(c);
    const token = randomToken(24);
    await db().update(users).set({ calendarToken: sha256(token) }).where(eq(users.id, me.id));
    return c.json({ url: `${env.appUrl}/api/calendar/${me.id}/${token}.ics` });
  })
  .delete('/calendar-feed', async (c) => {
    const me = requireUser(c);
    await db().update(users).set({ calendarToken: null }).where(eq(users.id, me.id));
    return c.json({ ok: true });
  })

  /* ------------------------------------------------ favourites & recents */
  .get('/favorites', async (c) => {
    const me = requireUser(c);
    const rows = await db()
      .select({ id: boards.id, name: boards.name, background: boards.background, workspaceId: boards.workspaceId, key: boards.key })
      .from(boardFavorites)
      .innerJoin(boards, eq(boards.id, boardFavorites.boardId))
      .where(and(eq(boardFavorites.userId, me.id), isNull(boards.archivedAt), visibleBoardPredicate(me.id)))
      .orderBy(desc(boardFavorites.createdAt));
    return c.json({ boards: rows });
  })
  .get('/recent', async (c) => {
    const me = requireUser(c);
    const rows = await db()
      .select({ id: boards.id, name: boards.name, background: boards.background, workspaceId: boards.workspaceId, key: boards.key, viewedAt: recentViews.viewedAt })
      .from(recentViews)
      .innerJoin(boards, eq(boards.id, recentViews.entityId))
      .where(and(eq(recentViews.userId, me.id), eq(recentViews.entityType, 'board'), isNull(boards.archivedAt), visibleBoardPredicate(me.id)))
      .orderBy(desc(recentViews.viewedAt))
      .limit(8);
    return c.json({ boards: rows });
  })

  /* ---------------------------------------------------------- inbox */
  .get('/inbox', async (c) => {
    const me = requireUser(c);
    const now = deps().now();
    const soon = new Date(now.getTime() + 7 * 86400_000);
    const base = and(isNull(cards.archivedAt), isNull(boards.archivedAt), isNull(lists.archivedAt), visibleBoardPredicate(me.id));
    const pick = async (cond: any, limit = 100) =>
      (
        await db()
          .select({ id: cards.id })
          .from(cards)
          .innerJoin(boards, eq(boards.id, cards.boardId))
          .innerJoin(lists, eq(lists.id, cards.listId))
          .where(and(base, cond))
          .orderBy(sql`${cards.dueAt} asc nulls last`, desc(cards.updatedAt))
          .limit(limit)
      ).map((r) => r.id);
    const assignedCond = sql`exists (select 1 from ${cardAssignees} ca where ca.card_id = ${cards.id} and ca.user_id = ${me.id})`;
    const [assigned, created, overdue, upcoming] = await Promise.all([
      pick(and(assignedCond, isNull(cards.completedAt))),
      pick(and(eq(cards.createdById, me.id), isNull(cards.completedAt))),
      pick(and(assignedCond, isNull(cards.completedAt), lt(cards.dueAt, now))),
      pick(and(assignedCond, isNull(cards.completedAt), gte(cards.dueAt, now), lte(cards.dueAt, soon))),
    ]);
    // "Needs attention": unread mentions / replies on cards.
    const attention = (
      await db()
        .select({ cardId: notifications.cardId })
        .from(notifications)
        .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt), inArray(notifications.type, ['mentioned', 'comment_reply', 'assigned']), isNotNull(notifications.cardId)))
        .limit(50)
    )
      .map((r) => r.cardId!)
      .filter(Boolean);
    const all = [...new Set([...assigned, ...created, ...overdue, ...upcoming, ...attention])];
    const summaries = await cardSummaries({ cardIds: all });
    const accessible = new Set(summaries.map((s) => s.id));
    const boardIds = [...new Set(summaries.map((s) => s.boardId))];
    const boardRows = boardIds.length
      ? await db().select({ id: boards.id, name: boards.name, key: boards.key, workspaceId: boards.workspaceId, background: boards.background }).from(boards).where(inArray(boards.id, boardIds))
      : [];
    const listIds = [...new Set(summaries.map((s) => s.listId))];
    const listRows = listIds.length ? await db().select({ id: lists.id, name: lists.name }).from(lists).where(inArray(lists.id, listIds)) : [];
    return c.json({
      cards: summaries,
      boards: boardRows,
      lists: listRows,
      sections: {
        assigned,
        created,
        overdue,
        upcoming,
        attention: [...new Set(attention)].filter((id) => accessible.has(id)),
      },
    });
  })

  /* -------------------------------------------------------- saved views */
  .get('/views', async (c) => {
    const me = requireUser(c);
    const boardId = c.req.query('boardId');
    const rows = await db()
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.userId, me.id), boardId ? eq(savedViews.boardId, boardId) : undefined))
      .orderBy(desc(savedViews.createdAt));
    return c.json({ views: rows });
  })
  .post('/views', async (c) => {
    const me = requireUser(c);
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(60), view: z.enum(['board', 'table', 'calendar', 'timeline', 'search']), boardId: z.string().nullable().optional(), filters: z.record(z.string(), z.unknown()) }));
    const [row] = await db().insert(savedViews).values({ id: newId(), userId: me.id, name: input.name, view: input.view, boardId: input.boardId ?? null, filters: input.filters }).returning();
    return c.json({ view: row }, 201);
  })
  .delete('/views/:id', async (c) => {
    const me = requireUser(c);
    await db().delete(savedViews).where(and(eq(savedViews.id, c.req.param('id')), eq(savedViews.userId, me.id)));
    return c.json({ ok: true });
  })

  /* ---------------------------------------------------- data portability */
  .get('/export', rateLimit('export', 10, 3600_000), async (c) => {
    const me = requireUser(c);
    const [u] = await db().select().from(users).where(eq(users.id, me.id));
    const { passwordHash: _p, calendarToken: _c, ...profile } = u;
    const memberships = await db()
      .select({ workspaceId: workspaceMembers.workspaceId, name: workspaces.name, role: workspaceMembers.role, joinedAt: workspaceMembers.joinedAt })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, me.id));
    const assigned = await db()
      .select({ id: cards.id, title: cards.title, boardId: cards.boardId, dueAt: cards.dueAt, completedAt: cards.completedAt })
      .from(cards)
      .innerJoin(cardAssignees, eq(cardAssignees.cardId, cards.id))
      .where(eq(cardAssignees.userId, me.id));
    const created = await db().select({ id: cards.id, title: cards.title, description: cards.description, boardId: cards.boardId, createdAt: cards.createdAt }).from(cards).where(eq(cards.createdById, me.id));
    const myComments = await db().select({ id: comments.id, cardId: comments.cardId, body: comments.body, createdAt: comments.createdAt }).from(comments).where(and(eq(comments.authorId, me.id), isNull(comments.deletedAt)));
    const myNotifications = await db().select().from(notifications).where(eq(notifications.userId, me.id)).orderBy(desc(notifications.createdAt)).limit(1000);
    const myActivity = await db().select().from(activities).where(eq(activities.actorId, me.id)).orderBy(desc(activities.createdAt)).limit(5000);
    const ext = await db().select().from(externalAccounts).where(eq(externalAccounts.userId, me.id));
    c.header('Content-Disposition', `attachment; filename="alypne-account-${u.username}.json"`);
    return c.json({
      exportedAt: deps().now().toISOString(),
      format: 'alypne.account.v1',
      profile,
      externalAccounts: ext,
      workspaces: memberships,
      cardsAssigned: assigned,
      cardsCreated: created,
      comments: myComments,
      notifications: myNotifications,
      activity: myActivity,
      note: 'Full workspace and board data can be exported from each workspace or board (JSON/CSV).',
    });
  })

  /** Permanently delete the account. Sole-owned workspaces with other members must be transferred first. */
  .post('/delete', rateLimit('delete-account', 5, 3600_000), async (c) => {
    const me = requireUser(c);
    const input = await body(c, z.object({ password: z.string().min(1), confirm: z.literal('DELETE') }));
    const [u] = await db().select().from(users).where(eq(users.id, me.id));
    if (!(await verifyPassword(input.password, u.passwordHash))) throw forbidden('Password is incorrect');
    const owned = await db()
      .select({ workspaceId: workspaceMembers.workspaceId, name: workspaces.name })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, me.id), eq(workspaceMembers.role, 'owner')));
    const blocking: string[] = [];
    const deletable: string[] = [];
    for (const w of owned) {
      const members = await db().select({ userId: workspaceMembers.userId, role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.workspaceId));
      const otherOwners = members.filter((m) => m.userId !== me.id && m.role === 'owner');
      if (otherOwners.length) continue;
      if (members.length > 1) blocking.push(w.name);
      else deletable.push(w.workspaceId);
    }
    if (blocking.length) throw conflict(`Transfer ownership of these workspaces first: ${blocking.join(', ')}`, { workspaces: blocking });
    if (deletable.length) await db().delete(workspaces).where(inArray(workspaces.id, deletable));
    await audit(c, { action: 'user.deleted', data: { username: u.username } });
    await destroySession(c);
    await db().delete(users).where(eq(users.id, me.id));
    return c.json({ ok: true });
  })

  .get('/external-accounts', async (c) => {
    const me = requireUser(c);
    return c.json({ accounts: await db().select().from(externalAccounts).where(eq(externalAccounts.userId, me.id)) });
  });

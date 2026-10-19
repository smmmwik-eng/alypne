import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import {
  boards,
  boardMembers,
  boardFavorites,
  recentViews,
  lists,
  labels,
  cards,
  customFields,
  customFieldValues,
  workflowStages,
  users,
  activities,
  workspaceMembers,
  releases,
  milestones,
  projects,
  attachments,
  workspaces,
  templates,
  cardAssignees,
  checklists,
  checklistItems,
  comments,
  cardRelations,
  bugDetails,
} from '../db/schema.js';
import { type AppEnv, audit, requireUser } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { requireBoard, requireWorkspace, effectiveBoardRole } from '../lib/access.js';
import { BOARD_BACKGROUNDS, CUSTOM_FIELD_TYPES, workspaceRoleAtLeast, type BoardRole, type WorkspaceRole } from '../../shared/constants.js';
import { toCsv, cardKey } from '../../shared/utils.js';
import { emit, userActor } from '../lib/events.js';
import { notify } from '../lib/notify.js';
import { cardSummaries, positionAt } from '../services/cards.js';
import { boardToBlueprint, createBoardFromBlueprint, defaultBlueprint, type BoardBlueprint } from '../services/boards.js';
import { publishBoard } from '../lib/realtime.js';
import { signedPath } from '../lib/storage.js';
import { rateLimit } from '../lib/rateLimit.js';

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const backgroundSchema = z.string().refine((b) => b in BOARD_BACKGROUNDS || /^#[0-9a-fA-F]{6}$/.test(b), 'Unknown background');

async function loadBoard(boardId: string, userId: string | null, role: BoardRole) {
  const [board] = await db().select().from(boards).where(eq(boards.id, boardId));
  const [ws] = await db().select({ id: workspaces.id, name: workspaces.name, color: workspaces.color, logoUrl: workspaces.logoUrl }).from(workspaces).where(eq(workspaces.id, board.workspaceId));
  const [ls, lbls, fields, stages, cardRows, explicitMembers, wsMembers, rel, mils] = await Promise.all([
    db().select().from(lists).where(and(eq(lists.boardId, boardId), isNull(lists.archivedAt))).orderBy(asc(lists.position)),
    db().select().from(labels).where(eq(labels.boardId, boardId)).orderBy(asc(labels.position)),
    db().select().from(customFields).where(eq(customFields.boardId, boardId)).orderBy(asc(customFields.position)),
    db().select().from(workflowStages).where(eq(workflowStages.workspaceId, board.workspaceId)).orderBy(asc(workflowStages.position)),
    cardSummaries({ boardId }),
    db()
      .select({ userId: boardMembers.userId, role: boardMembers.role, notificationLevel: boardMembers.notificationLevel })
      .from(boardMembers)
      .where(eq(boardMembers.boardId, boardId)),
    db()
      .select({ id: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl, wsRole: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, board.workspaceId)),
    db().select({ id: releases.id, name: releases.name, version: releases.version, status: releases.status, plannedDate: releases.plannedDate }).from(releases).where(eq(releases.workspaceId, board.workspaceId)),
    db().select({ id: milestones.id, name: milestones.name, date: milestones.date, releaseId: milestones.releaseId, completedAt: milestones.completedAt }).from(milestones).where(eq(milestones.workspaceId, board.workspaceId)),
  ]);
  // Members who can see the board, with their effective role.
  const members = wsMembers
    .map((m) => {
      const explicit = explicitMembers.find((e) => e.userId === m.id);
      const eff = effectiveBoardRole(board, m.wsRole as WorkspaceRole, (explicit?.role as BoardRole) ?? null);
      return eff ? { id: m.id, username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl, role: eff, explicit: !!explicit, wsRole: m.wsRole } : null;
    })
    .filter((m): m is NonNullable<typeof m> => !!m);
  // Cover images: short-lived signed URLs, only for users who can see the board.
  const coverIds = cardRows.map((c) => c.coverAttachmentId).filter((x): x is string => !!x);
  const covers = coverIds.length ? await db().select({ id: attachments.id }).from(attachments).where(inArray(attachments.id, coverIds)) : [];
  const coverUrls = Object.fromEntries(covers.map((a) => [a.id, signedPath('/api/files', a.id, 3600)]));
  let favorite = false;
  let notificationLevel = 'participating';
  if (userId) {
    const [fav] = await db().select().from(boardFavorites).where(and(eq(boardFavorites.boardId, boardId), eq(boardFavorites.userId, userId)));
    favorite = !!fav;
    notificationLevel = explicitMembers.find((m) => m.userId === userId)?.notificationLevel ?? 'participating';
  }
  const project = board.projectId ? (await db().select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, board.projectId)))[0] ?? null : null;
  const boardCardIds = cardRows.map((c) => c.id);
  const dependencies = boardCardIds.length
    ? await db()
        .select({ from: cardRelations.fromCardId, to: cardRelations.toCardId })
        .from(cardRelations)
        .where(and(eq(cardRelations.kind, 'blocks'), inArray(cardRelations.fromCardId, boardCardIds), inArray(cardRelations.toCardId, boardCardIds)))
    : [];
  return {
    dependencies,
    board: { ...board, favorite, notificationLevel },
    workspace: ws,
    project,
    role,
    lists: ls,
    cards: cardRows,
    labels: lbls,
    customFields: fields,
    stages,
    members,
    releases: rel,
    milestones: mils,
    coverUrls,
  };
}

const boardCreateSchema = z.object({
  workspaceId: z.string(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000).optional(),
  background: backgroundSchema.optional(),
  visibility: z.enum(['private', 'workspace', 'public']).optional(),
  projectId: z.string().nullable().optional(),
  templateId: z.string().optional(),
  blank: z.boolean().optional(),
});

export const boardRoutes = new Hono<AppEnv>()
  .post('/', rateLimit('board-create', 60, 3600_000), async (c) => {
    const me = requireUser(c);
    const input = await body(c, boardCreateSchema);
    const { workspace, role } = await requireWorkspace(me.id, input.workspaceId, 'member');
    if (!workspaceRoleAtLeast(role, 'admin') && workspace.settings.membersCanCreateBoards === false) throw forbidden('Only admins can create boards in this workspace');
    if (input.projectId) {
      const [p] = await db().select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspace.id)));
      if (!p) throw badRequest('Project not found in this workspace');
    }
    let bp: BoardBlueprint = input.blank ? { labels: defaultBlueprint().labels, lists: [] } : defaultBlueprint();
    if (input.templateId) {
      const [t] = await db().select().from(templates).where(and(eq(templates.id, input.templateId), eq(templates.kind, 'board')));
      if (!t || (t.workspaceId && t.workspaceId !== workspace.id)) throw notFound('Template');
      bp = t.data as unknown as BoardBlueprint;
    }
    const id = await createBoardFromBlueprint(userActor(me.id), { workspaceId: workspace.id, name: input.name, visibility: input.visibility, projectId: input.projectId, background: input.background }, { ...bp, description: input.description ?? bp.description });
    return c.json({ id }, 201);
  })

  .get('/:id', async (c) => {
    const user = c.get('user');
    const { board, role } = await requireBoard(user?.id ?? null, c.req.param('id'));
    if (user) {
      await db()
        .insert(recentViews)
        .values({ userId: user.id, entityType: 'board', entityId: board.id })
        .onConflictDoUpdate({ target: [recentViews.userId, recentViews.entityType, recentViews.entityId], set: { viewedAt: deps().now() } });
    }
    return c.json(await loadBoard(board.id, user?.id ?? null, role));
  })

  .patch('/:id', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'admin');
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(5000).optional(),
        background: backgroundSchema.optional(),
        visibility: z.enum(['private', 'workspace', 'public']).optional(),
        projectId: z.string().nullable().optional(),
        key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,7}$/, 'Key must be 2–8 letters/digits starting with a letter').optional(),
        settings: z.object({ cardCovers: z.boolean().optional(), showCompleted: z.boolean().optional(), commentPermission: z.enum(['members', 'observers']).optional(), votingEnabled: z.boolean().optional() }).optional(),
      }),
    );
    if (input.projectId) {
      const [p] = await db().select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, board.workspaceId)));
      if (!p) throw badRequest('Project not found');
    }
    if (input.key && input.key !== board.key) {
      const [clash] = await db().select({ id: boards.id }).from(boards).where(and(eq(boards.workspaceId, board.workspaceId), eq(boards.key, input.key)));
      if (clash) throw conflict('Another board in this workspace already uses that key');
    }
    await db()
      .update(boards)
      .set({ ...input, settings: input.settings ? { ...board.settings, ...input.settings } : undefined, updatedAt: deps().now() })
      .where(eq(boards.id, board.id));
    if (input.visibility && input.visibility !== board.visibility) await audit(c, { workspaceId: board.workspaceId, action: 'board.visibility_changed', targetType: 'board', targetId: board.id, data: { from: board.visibility, to: input.visibility } });
    await emit({ type: 'board.updated', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { fields: Object.keys(input), name: input.name ?? board.name }, quiet: true });
    return c.json({ ok: true });
  })

  .post('/:id/archive', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'admin');
    const { archived } = await body(c, z.object({ archived: z.boolean() }));
    await db().update(boards).set({ archivedAt: archived ? deps().now() : null }).where(eq(boards.id, board.id));
    await emit({ type: archived ? 'board.archived' : 'board.restored', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { name: board.name } });
    return c.json({ ok: true });
  })

  .delete('/:id', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'admin');
    const { confirmName } = await body(c, z.object({ confirmName: z.string() }));
    if (confirmName.trim() !== board.name) throw badRequest('Type the board name exactly to confirm deletion');
    await audit(c, { workspaceId: board.workspaceId, action: 'board.deleted', targetType: 'board', targetId: board.id, data: { name: board.name } });
    await db().delete(boards).where(eq(boards.id, board.id));
    await emit({ type: 'board.deleted', workspaceId: board.workspaceId, actor: userActor(me.id), data: { name: board.name } });
    publishBoard(board.id, { type: 'board.deleted' });
    return c.json({ ok: true });
  })

  .post('/:id/duplicate', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'observer');
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(120),
        workspaceId: z.string().optional(),
        include: z.object({ cards: z.boolean().default(true), members: z.boolean().default(false), settings: z.boolean().default(true), automations: z.boolean().default(false), customFields: z.boolean().default(true), labels: z.boolean().default(true) }).default({ cards: true, members: false, settings: true, automations: false, customFields: true, labels: true }),
      }),
    );
    const targetWs = input.workspaceId ?? board.workspaceId;
    await requireWorkspace(me.id, targetWs, 'member');
    const bp = await boardToBlueprint(board.id, { includeCards: input.include.cards, includeAutomations: input.include.automations });
    if (!input.include.labels) {
      bp.labels = [];
      for (const l of bp.lists) for (const c2 of l.cards ?? []) c2.labels = [];
    }
    if (!input.include.customFields) bp.customFields = [];
    const sameWs = targetWs === board.workspaceId;
    const id = await createBoardFromBlueprint(
      userActor(me.id),
      { workspaceId: targetWs, name: input.name, visibility: input.include.settings ? (board.visibility as any) : undefined, background: input.include.settings ? board.background : undefined, projectId: sameWs ? board.projectId : null },
      bp,
    );
    if (input.include.settings) await db().update(boards).set({ settings: board.settings }).where(eq(boards.id, id));
    if (input.include.members && sameWs) {
      const mem = await db().select().from(boardMembers).where(eq(boardMembers.boardId, board.id));
      for (const m of mem) if (m.userId !== me.id) await db().insert(boardMembers).values({ boardId: id, userId: m.userId, role: m.role }).onConflictDoNothing();
    }
    return c.json({ id }, 201);
  })

  .post('/:id/favorite', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'));
    const { favorite } = await body(c, z.object({ favorite: z.boolean() }));
    if (favorite) await db().insert(boardFavorites).values({ userId: me.id, boardId: board.id }).onConflictDoNothing();
    else await db().delete(boardFavorites).where(and(eq(boardFavorites.userId, me.id), eq(boardFavorites.boardId, board.id)));
    return c.json({ ok: true });
  })

  .post('/:id/notification-level', async (c) => {
    const me = requireUser(c);
    const { board, role } = await requireBoard(me.id, c.req.param('id'));
    const { level } = await body(c, z.object({ level: z.enum(['all', 'participating', 'none']) }));
    await db()
      .insert(boardMembers)
      .values({ boardId: board.id, userId: me.id, role: role === 'admin' ? 'admin' : role, notificationLevel: level })
      .onConflictDoUpdate({ target: [boardMembers.boardId, boardMembers.userId], set: { notificationLevel: level } });
    return c.json({ ok: true });
  })

  /* ---------------------------------------------------------- members */
  .post('/:id/members', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'admin');
    const input = await body(c, z.object({ userId: z.string(), role: z.enum(['admin', 'member', 'observer']) }));
    const [wm] = await db().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, board.workspaceId), eq(workspaceMembers.userId, input.userId)));
    if (!wm) throw badRequest('Only workspace members can be added to boards. Invite them to the workspace first.');
    await db()
      .insert(boardMembers)
      .values({ boardId: board.id, userId: input.userId, role: input.role })
      .onConflictDoUpdate({ target: [boardMembers.boardId, boardMembers.userId], set: { role: input.role } });
    await audit(c, { workspaceId: board.workspaceId, action: 'board.member_set', targetType: 'user', targetId: input.userId, data: { boardId: board.id, role: input.role } });
    await emit({ type: 'board.member.added', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { userId: input.userId, role: input.role } });
    await notify([input.userId], { type: 'board_change', title: `${me.displayName} added you to the board ${board.name}`, workspaceId: board.workspaceId, boardId: board.id, actorId: me.id });
    return c.json({ ok: true });
  })
  .delete('/:id/members/:userId', async (c) => {
    const me = requireUser(c);
    const targetId = c.req.param('userId');
    const { board } = await requireBoard(me.id, c.req.param('id'), targetId === me.id ? 'observer' : 'admin');
    const admins = await db().select().from(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.role, 'admin')));
    if (admins.length === 1 && admins[0].userId === targetId && board.visibility === 'private') throw badRequest('A private board needs at least one admin');
    await db().delete(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, targetId)));
    await audit(c, { workspaceId: board.workspaceId, action: 'board.member_removed', targetType: 'user', targetId, data: { boardId: board.id } });
    await emit({ type: 'board.member.removed', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { userId: targetId } });
    return c.json({ ok: true });
  })

  /* ----------------------------------------------------------- labels */
  .post('/:id/labels', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ name: z.string().trim().max(60).default(''), color: colorSchema }));
    const [row] = await db().insert(labels).values({ id: newId(), boardId: board.id, name: input.name, color: input.color, position: Date.now() }).returning();
    publishBoard(board.id, { type: 'changed', event: 'label.created' });
    return c.json({ label: row }, 201);
  })
  .patch('/:id/labels/:labelId', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ name: z.string().trim().max(60).optional(), color: colorSchema.optional() }));
    // Renaming keeps the label id, so card relationships are untouched.
    const res = await db().update(labels).set(input).where(and(eq(labels.id, c.req.param('labelId')), eq(labels.boardId, board.id))).returning();
    if (!res.length) throw notFound('Label');
    publishBoard(board.id, { type: 'changed', event: 'label.updated' });
    return c.json({ label: res[0] });
  })
  .delete('/:id/labels/:labelId', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'member');
    await db().delete(labels).where(and(eq(labels.id, c.req.param('labelId')), eq(labels.boardId, board.id)));
    publishBoard(board.id, { type: 'changed', event: 'label.deleted' });
    return c.json({ ok: true });
  })

  /* ---------------------------------------------------- custom fields */
  .post('/:id/custom-fields', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'admin');
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60),
        type: z.enum(CUSTOM_FIELD_TYPES),
        options: z.array(z.object({ label: z.string().trim().min(1).max(60), color: colorSchema.optional() })).max(50).default([]),
        showOnCard: z.boolean().default(true),
      }),
    );
    if (input.type === 'dropdown' && !input.options.length) throw badRequest('Dropdown fields need at least one option');
    const [row] = await db()
      .insert(customFields)
      .values({ id: newId(), boardId: board.id, name: input.name, type: input.type, options: input.type === 'dropdown' ? input.options.map((o) => ({ ...o, id: newId() })) : [], showOnCard: input.showOnCard, position: Date.now() })
      .returning();
    publishBoard(board.id, { type: 'changed', event: 'customField.created' });
    return c.json({ field: row }, 201);
  })
  .patch('/:id/custom-fields/:fieldId', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'admin');
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        showOnCard: z.boolean().optional(),
        position: z.number().finite().optional(),
        options: z.array(z.object({ id: z.string().optional(), label: z.string().trim().min(1).max(60), color: colorSchema.optional() })).max(50).optional(),
      }),
    );
    const [field] = await db().select().from(customFields).where(and(eq(customFields.id, c.req.param('fieldId')), eq(customFields.boardId, board.id)));
    if (!field) throw notFound('Custom field');
    let options = field.options;
    if (input.options) {
      if (field.type !== 'dropdown') throw badRequest('Only dropdown fields have options');
      options = input.options.map((o) => ({ id: o.id && field.options.some((x) => x.id === o.id) ? o.id : newId(), label: o.label, color: o.color }));
      const kept = new Set(options.map((o) => o.id));
      const removed = field.options.filter((o) => !kept.has(o.id)).map((o) => o.id);
      // Values pointing at removed options are cleared rather than left dangling.
      for (const rid of removed) await db().delete(customFieldValues).where(and(eq(customFieldValues.fieldId, field.id), sql`${customFieldValues.value} = ${JSON.stringify(rid)}::jsonb`));
    }
    await db().update(customFields).set({ name: input.name, showOnCard: input.showOnCard, position: input.position, options }).where(eq(customFields.id, field.id));
    publishBoard(board.id, { type: 'changed', event: 'customField.updated' });
    return c.json({ ok: true });
  })
  .delete('/:id/custom-fields/:fieldId', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'admin');
    await db().delete(customFields).where(and(eq(customFields.id, c.req.param('fieldId')), eq(customFields.boardId, board.id)));
    publishBoard(board.id, { type: 'changed', event: 'customField.deleted' });
    return c.json({ ok: true });
  })

  /* ------------------------------------------------------------- lists */
  .post('/:id/lists', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(120), index: z.number().int().min(0).optional(), stageId: z.string().nullable().optional() }));
    if (input.stageId) {
      const [s] = await db().select().from(workflowStages).where(and(eq(workflowStages.id, input.stageId), eq(workflowStages.workspaceId, board.workspaceId)));
      if (!s) throw badRequest('Unknown workflow stage');
    }
    const position = await positionAt('list', board.id, input.index);
    const [row] = await db().insert(lists).values({ id: newId(), boardId: board.id, name: input.name, position, stageId: input.stageId ?? null }).returning();
    await emit({ type: 'list.created', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { listName: row.name } });
    return c.json({ list: row }, 201);
  })

  /* ---------------------------------------------------------- activity */
  .get('/:id/activity', async (c) => {
    const user = c.get('user');
    const { board } = await requireBoard(user?.id ?? null, c.req.param('id'));
    const before = c.req.query('before');
    const limit = Math.min(100, Number(c.req.query('limit') ?? 40) || 40);
    const rows = await db()
      .select({
        id: activities.id,
        type: activities.type,
        data: activities.data,
        cardId: activities.cardId,
        actorType: activities.actorType,
        createdAt: activities.createdAt,
        actor: { id: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl },
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.actorId))
      .where(and(eq(activities.boardId, board.id), before ? lt(activities.createdAt, new Date(before)) : undefined))
      .orderBy(desc(activities.createdAt))
      .limit(limit);
    return c.json({ activities: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null });
  })

  .get('/:id/archived', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'));
    const archivedLists = await db().select().from(lists).where(and(eq(lists.boardId, board.id), isNotNull(lists.archivedAt))).orderBy(desc(lists.archivedAt));
    const archivedCardIds = (await db().select({ id: cards.id }).from(cards).where(and(eq(cards.boardId, board.id), isNotNull(cards.archivedAt))).orderBy(desc(cards.archivedAt)).limit(200)).map((r) => r.id);
    return c.json({ lists: archivedLists, cards: await cardSummaries({ cardIds: archivedCardIds, includeArchived: true }) });
  })

  /* ----------------------------------------------------------- exports */
  .get('/:id/export.json', rateLimit('export', 30, 3600_000), async (c) => {
    const user = c.get('user');
    const { board } = await requireBoard(user?.id ?? null, c.req.param('id'));
    const data = await exportBoardJson(board.id);
    c.header('Content-Disposition', `attachment; filename="${board.key.toLowerCase()}-board.json"`);
    return c.json(data);
  })
  .get('/:id/export.csv', rateLimit('export', 30, 3600_000), async (c) => {
    const user = c.get('user');
    const { board } = await requireBoard(user?.id ?? null, c.req.param('id'));
    const csv = await exportBoardCsv(board.id, board.key);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${board.key.toLowerCase()}-tasks.csv"`);
    return c.body('﻿' + csv);
  })

  .post('/:id/save-as-template', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).default(''), includeCards: z.boolean().default(true), includeAutomations: z.boolean().default(true) }));
    const data = await boardToBlueprint(board.id, { includeCards: input.includeCards, includeAutomations: input.includeAutomations });
    const [row] = await db()
      .insert(templates)
      .values({ id: newId(), workspaceId: board.workspaceId, kind: 'board', name: input.name, description: input.description, category: 'custom', data: data as unknown as Record<string, unknown>, createdById: me.id })
      .returning();
    return c.json({ template: row }, 201);
  });

export async function exportBoardJson(boardId: string) {
  const [board] = await db().select().from(boards).where(eq(boards.id, boardId));
  const ls = await db().select().from(lists).where(eq(lists.boardId, boardId)).orderBy(asc(lists.position));
  const lbls = await db().select().from(labels).where(eq(labels.boardId, boardId));
  const fields = await db().select().from(customFields).where(eq(customFields.boardId, boardId));
  const cardIds = (await db().select({ id: cards.id }).from(cards).where(eq(cards.boardId, boardId))).map((r) => r.id);
  const full = cardIds.length ? await db().select().from(cards).where(inArray(cards.id, cardIds)).orderBy(asc(cards.position)) : [];
  const summaries = await cardSummaries({ cardIds, includeArchived: true });
  const chks = cardIds.length ? await db().select().from(checklists).where(inArray(checklists.cardId, cardIds)) : [];
  const items = chks.length ? await db().select().from(checklistItems).where(inArray(checklistItems.checklistId, chks.map((c) => c.id))) : [];
  const cmts = cardIds.length
    ? await db()
        .select({ id: comments.id, cardId: comments.cardId, parentId: comments.parentId, body: comments.body, createdAt: comments.createdAt, author: users.username })
        .from(comments)
        .leftJoin(users, eq(users.id, comments.authorId))
        .where(and(inArray(comments.cardId, cardIds), isNull(comments.deletedAt)))
    : [];
  const rels = cardIds.length ? await db().select().from(cardRelations).where(inArray(cardRelations.fromCardId, cardIds)) : [];
  const bugs = cardIds.length ? await db().select().from(bugDetails).where(inArray(bugDetails.cardId, cardIds)) : [];
  const assignees = cardIds.length
    ? await db().select({ cardId: cardAssignees.cardId, username: users.username }).from(cardAssignees).innerJoin(users, eq(users.id, cardAssignees.userId)).where(inArray(cardAssignees.cardId, cardIds))
    : [];
  return {
    format: 'alypne.board.v1',
    exportedAt: deps().now().toISOString(),
    board: { id: board.id, name: board.name, key: board.key, description: board.description, background: board.background, visibility: board.visibility, settings: board.settings },
    lists: ls.map((l) => ({ id: l.id, name: l.name, position: l.position, archived: !!l.archivedAt, wipLimit: l.wipLimit })),
    labels: lbls.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    customFields: fields.map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options })),
    cards: full.map((c) => {
      const s = summaries.find((x) => x.id === c.id);
      return {
        id: c.id,
        key: cardKey(board.key, c.number),
        listId: c.listId,
        type: c.type,
        title: c.title,
        description: c.description,
        priority: c.priority,
        startAt: c.startAt,
        dueAt: c.dueAt,
        completedAt: c.completedAt,
        archived: !!c.archivedAt,
        position: c.position,
        labelIds: s?.labelIds ?? [],
        assignees: assignees.filter((a) => a.cardId === c.id).map((a) => a.username),
        customFields: s?.customFields ?? {},
        checklists: chks.filter((ch) => ch.cardId === c.id).map((ch) => ({ title: ch.title, items: items.filter((i) => i.checklistId === ch.id).sort((a, b) => a.position - b.position).map((i) => ({ text: i.text, completed: !!i.completedAt })) })),
        comments: cmts.filter((m) => m.cardId === c.id),
        relations: rels.filter((r) => r.fromCardId === c.id).map((r) => ({ kind: r.kind, toCardId: r.toCardId })),
        bug: bugs.find((b) => b.cardId === c.id) ?? null,
        createdAt: c.createdAt,
      };
    }),
  };
}

export async function exportBoardCsv(boardId: string, boardKey: string) {
  const data = await exportBoardJson(boardId);
  const listName = new Map(data.lists.map((l) => [l.id, l.name]));
  const labelName = new Map(data.labels.map((l) => [l.id, l.name || l.color]));
  const header = ['Key', 'Title', 'List', 'Type', 'Priority', 'Labels', 'Assignees', 'Start', 'Due', 'Completed', 'Archived', 'Checklist', 'Description', ...data.customFields.map((f) => f.name)];
  const rows = data.cards.map((c) => {
    const total = c.checklists.reduce((n, ch) => n + ch.items.length, 0);
    const done = c.checklists.reduce((n, ch) => n + ch.items.filter((i) => i.completed).length, 0);
    return [
      c.key,
      c.title,
      listName.get(c.listId) ?? '',
      c.type,
      c.priority,
      c.labelIds.map((id) => labelName.get(id)).join('; '),
      c.assignees.join('; '),
      c.startAt ? new Date(c.startAt).toISOString() : '',
      c.dueAt ? new Date(c.dueAt).toISOString() : '',
      c.completedAt ? new Date(c.completedAt).toISOString() : '',
      c.archived ? 'yes' : '',
      total ? `${done}/${total}` : '',
      c.description,
      ...data.customFields.map((f) => {
        const v = (c.customFields as Record<string, unknown>)[f.id];
        if (f.type === 'dropdown') return f.options.find((o) => o.id === v)?.label ?? '';
        return v === undefined || v === null ? '' : String(v);
      }),
    ];
  });
  void boardKey;
  return toCsv([header, ...rows]);
}

import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import {
  cards,
  cardWatchers,
  cardVotes,
  cardRelations,
  cardLinks,
  bugDetails,
  checklists,
  checklistItems,
  comments,
  attachments,
  activities,
  users,
  boards,
  lists,
  templates,
  customFieldValues,
  assetCards,
  assets,
  recentViews,
  labels,
  cardLabels,
} from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { boardAccess, requireBoard, requireCard, requireChecklist, requireChecklistItem, requireComment } from '../lib/access.js';
import { enqueue } from '../jobs/queue.js';
import { notify } from '../lib/notify.js';
import { emit, userActor } from '../lib/events.js';
import {
  addChecklist,
  addComment,
  addLabel,
  archiveCard,
  assign,
  createCard,
  deleteCard,
  duplicateCard,
  moveCard,
  positionAt,
  removeLabel,
  setChecklistItemCompleted,
  setCustomFieldValue,
  unassign,
  updateCard,
} from '../services/cards.js';
import { BUG_REPRO, BUG_RESOLUTIONS, BUG_SEVERITIES, LIMITS, PRIORITIES, boardRoleAtLeast } from '../../shared/constants.js';
import { parseDevLink, cardKey } from '../../shared/utils.js';
import { publishBoard } from '../lib/realtime.js';
import { signedPath } from '../lib/storage.js';
import { rateLimit } from '../lib/rateLimit.js';

const dateish = z
  .union([z.string().datetime({ offset: true }), z.null()])
  .transform((v) => (v === null ? null : new Date(v)));

const bugSchema = z.object({
  stepsToReproduce: z.string().max(10000).optional(),
  expectedBehaviour: z.string().max(5000).optional(),
  actualBehaviour: z.string().max(5000).optional(),
  severity: z.enum(BUG_SEVERITIES).optional(),
  platforms: z.array(z.string().max(40)).max(10).optional(),
  reproStatus: z.enum(BUG_REPRO).optional(),
  resolution: z.enum(BUG_RESOLUTIONS).optional(),
  gameVersion: z.string().max(60).optional(),
});

async function cardDetail(cardId: string, userId: string | null) {
  const [card] = await db().select().from(cards).where(eq(cards.id, cardId));
  const [board] = await db().select({ key: boards.key, name: boards.name }).from(boards).where(eq(boards.id, card.boardId));
  const [list] = await db().select({ name: lists.name }).from(lists).where(eq(lists.id, card.listId));
  const [chks, cmts, atts, rels, links, bug, watchers, votes, fieldValues, creator, linkedAssets] = await Promise.all([
    db().select().from(checklists).where(eq(checklists.cardId, cardId)).orderBy(asc(checklists.position)),
    db()
      .select({ id: comments.id, parentId: comments.parentId, body: comments.body, createdAt: comments.createdAt, editedAt: comments.editedAt, deletedAt: comments.deletedAt, author: { id: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl } })
      .from(comments)
      .leftJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.cardId, cardId))
      .orderBy(asc(comments.createdAt)),
    db()
      .select({ id: attachments.id, fileName: attachments.fileName, mimeType: attachments.mimeType, size: attachments.size, isImage: attachments.isImage, createdAt: attachments.createdAt, uploaderId: attachments.uploaderId, uploader: users.displayName })
      .from(attachments)
      .leftJoin(users, eq(users.id, attachments.uploaderId))
      .where(eq(attachments.cardId, cardId))
      .orderBy(desc(attachments.createdAt)),
    db().select().from(cardRelations).where(or(eq(cardRelations.fromCardId, cardId), eq(cardRelations.toCardId, cardId))),
    db().select().from(cardLinks).where(eq(cardLinks.cardId, cardId)).orderBy(desc(cardLinks.createdAt)),
    db().select().from(bugDetails).where(eq(bugDetails.cardId, cardId)),
    db().select({ userId: cardWatchers.userId }).from(cardWatchers).where(eq(cardWatchers.cardId, cardId)),
    db().select({ userId: cardVotes.userId }).from(cardVotes).where(eq(cardVotes.cardId, cardId)),
    db().select().from(customFieldValues).where(eq(customFieldValues.cardId, cardId)),
    card.createdById ? db().select({ id: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, card.createdById)) : Promise.resolve([]),
    db().select({ id: assets.id, name: assets.name, category: assets.category, robloxAssetId: assets.robloxAssetId }).from(assetCards).innerJoin(assets, eq(assets.id, assetCards.assetId)).where(eq(assetCards.cardId, cardId)),
  ]);
  const items = chks.length ? await db().select().from(checklistItems).where(inArray(checklistItems.checklistId, chks.map((c) => c.id))).orderBy(asc(checklistItems.position)) : [];
  // Related cards — only include those the viewer can access.
  const relatedIds = [...new Set(rels.flatMap((r) => [r.fromCardId, r.toCardId]).filter((id) => id !== cardId))];
  const relatedRaw = relatedIds.length
    ? await db()
        .select({ id: cards.id, title: cards.title, number: cards.number, boardId: cards.boardId, completedAt: cards.completedAt, boardKey: boards.key })
        .from(cards)
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .where(inArray(cards.id, relatedIds))
    : [];
  const related = [];
  for (const r of relatedRaw) if (await boardAccess(userId, r.boardId)) related.push(r);
  const relatedSet = new Set(related.map((r) => r.id));
  return {
    card: { ...card, key: cardKey(board.key, card.number), boardName: board.name, listName: list?.name ?? '' },
    creator: creator[0] ?? null,
    checklists: chks.map((c) => ({ ...c, items: items.filter((i) => i.checklistId === c.id) })),
    comments: cmts.map((c) => (c.deletedAt ? { ...c, body: '', deleted: true } : { ...c, deleted: false })),
    attachments: atts.map((a) => ({ ...a, url: signedPath('/api/files', a.id, 3600) })),
    relations: rels.filter((r) => relatedSet.has(r.fromCardId === cardId ? r.toCardId : r.fromCardId)),
    relatedCards: related,
    links,
    bug: bug[0] ?? null,
    watching: !!userId && watchers.some((w) => w.userId === userId),
    watcherCount: watchers.length,
    voted: !!userId && votes.some((v) => v.userId === userId),
    voteCount: votes.length,
    customFields: Object.fromEntries(fieldValues.map((v) => [v.fieldId, v.value])),
    assets: linkedAssets,
  };
}

const createSchema = z.object({
  boardId: z.string(),
  listId: z.string(),
  title: z.string().trim().min(1).max(LIMITS.titleMax),
  description: z.string().max(LIMITS.descriptionMax).optional(),
  index: z.number().int().min(0).optional(),
  type: z.enum(['task', 'bug']).optional(),
  priority: z.enum(PRIORITIES).optional(),
  startAt: dateish.optional(),
  dueAt: dateish.optional(),
  labelIds: z.array(z.string()).max(50).optional(),
  assigneeIds: z.array(z.string()).max(50).optional(),
  releaseId: z.string().nullable().optional(),
  templateId: z.string().optional(),
  bug: bugSchema.optional(),
});

const bulkSchema = z.object({
  cardIds: z.array(z.string()).min(1).max(200),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('move'), listId: z.string() }),
    z.object({ type: z.literal('archive') }),
    z.object({ type: z.literal('restore') }),
    z.object({ type: z.literal('delete') }),
    z.object({ type: z.literal('complete'), completed: z.boolean() }),
    z.object({ type: z.literal('addLabel'), labelId: z.string() }),
    z.object({ type: z.literal('removeLabel'), labelId: z.string() }),
    z.object({ type: z.literal('assign'), userId: z.string() }),
    z.object({ type: z.literal('unassign'), userId: z.string() }),
    z.object({ type: z.literal('setPriority'), priority: z.enum(PRIORITIES) }),
    z.object({ type: z.literal('setDue'), dueAt: dateish }),
    z.object({ type: z.literal('setRelease'), releaseId: z.string().nullable() }),
  ]),
});

export const cardRoutes = new Hono<AppEnv>()
  .post('/', rateLimit('card-create', 600, 3600_000), async (c) => {
    const me = requireUser(c);
    const input = await body(c, createSchema);
    await requireBoard(me.id, input.boardId, 'member');
    let extra: Partial<Parameters<typeof createCard>[1]> = {};
    if (input.templateId) {
      const [t] = await db().select().from(templates).where(and(eq(templates.id, input.templateId), eq(templates.kind, 'card')));
      if (!t) throw notFound('Template');
      const d = t.data as any;
      extra = { description: d.description, checklists: d.checklists, priority: d.priority, type: d.type };
      if (Array.isArray(d.labels)) {
        const boardLabels = await db().select().from(labels).where(eq(labels.boardId, input.boardId));
        extra.labelIds = d.labels.map((n: string) => boardLabels.find((l) => l.name === n)?.id).filter(Boolean);
      }
    }
    const key = c.req.header('idempotency-key');
    const card = await createCard(userActor(me.id), {
      ...extra,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      boardId: input.boardId,
      listId: input.listId,
      title: input.title,
      dedupeKey: key ? `create:${me.id}:${key}` : undefined,
    } as Parameters<typeof createCard>[1]);
    return c.json({ card }, 201);
  })

  .post('/bulk', rateLimit('bulk', 120, 3600_000), async (c) => {
    const me = requireUser(c);
    const { cardIds, action } = await body(c, bulkSchema);
    const actor = userActor(me.id);
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of [...new Set(cardIds)]) {
      try {
        const { card, role } = await requireCard(me.id, id, 'member');
        switch (action.type) {
          case 'move':
            await requireBoardForList(me.id, action.listId);
            await moveCard(actor, card.id, { listId: action.listId });
            break;
          case 'archive':
            await archiveCard(actor, card.id, true);
            break;
          case 'restore':
            await archiveCard(actor, card.id, false);
            break;
          case 'delete':
            if (!boardRoleAtLeast(role, 'member')) throw forbidden();
            await deleteCard(actor, card.id);
            break;
          case 'complete':
            await updateCard(actor, card.id, { completed: action.completed });
            break;
          case 'addLabel':
            await addLabel(actor, card.id, action.labelId);
            break;
          case 'removeLabel':
            await removeLabel(actor, card.id, action.labelId);
            break;
          case 'assign':
            await assign(actor, card.id, action.userId);
            break;
          case 'unassign':
            await unassign(actor, card.id, action.userId);
            break;
          case 'setPriority':
            await updateCard(actor, card.id, { priority: action.priority });
            break;
          case 'setDue':
            await updateCard(actor, card.id, { dueAt: action.dueAt });
            break;
          case 'setRelease':
            await updateCard(actor, card.id, { releaseId: action.releaseId });
            break;
        }
        results.push({ id, ok: true });
      } catch (e: any) {
        results.push({ id, ok: false, error: e?.message ?? 'Failed' });
      }
    }
    return c.json({ results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  })

  .get('/:id', async (c) => {
    const user = c.get('user');
    const { card, role } = await requireCard(user?.id ?? null, c.req.param('id'));
    if (user) {
      await db()
        .insert(recentViews)
        .values({ userId: user.id, entityType: 'card', entityId: card.id })
        .onConflictDoUpdate({ target: [recentViews.userId, recentViews.entityType, recentViews.entityId], set: { viewedAt: deps().now() } });
    }
    return c.json({ ...(await cardDetail(card.id, user?.id ?? null)), role });
  })

  .patch('/:id', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    const input = await body(
      c,
      z.object({
        version: z.number().int().optional(),
        title: z.string().max(LIMITS.titleMax).optional(),
        description: z.string().max(LIMITS.descriptionMax).optional(),
        priority: z.enum(PRIORITIES).optional(),
        startAt: dateish.optional(),
        dueAt: dateish.optional(),
        reminderMinutes: z.number().int().min(0).max(60 * 24 * 30).nullable().optional(),
        coverColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
        coverAttachmentId: z.string().nullable().optional(),
        releaseId: z.string().nullable().optional(),
        milestoneId: z.string().nullable().optional(),
        completed: z.boolean().optional(),
        recurrence: z.object({ freq: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(365) }).nullable().optional(),
      }),
    );
    const { version, ...patch } = input;
    if (patch.startAt && patch.dueAt && patch.startAt > patch.dueAt) throw badRequest('Start date must be before the due date');
    const updated = await updateCard(userActor(me.id), card.id, patch, version);
    return c.json({ card: updated });
  })

  .post('/:id/move', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ listId: z.string(), index: z.number().int().min(0).optional() }));
    await requireBoardForList(me.id, input.listId);
    const updated = await moveCard(userActor(me.id), card.id, input);
    return c.json({ card: updated });
  })

  .post('/:id/archive', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    const { archived } = await body(c, z.object({ archived: z.boolean() }));
    return c.json({ card: await archiveCard(userActor(me.id), card.id, archived) });
  })

  .delete('/:id', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    await deleteCard(userActor(me.id), card.id);
    return c.json({ ok: true });
  })

  .post('/:id/duplicate', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'observer');
    const input = await body(
      c,
      z.object({
        listId: z.string(),
        index: z.number().int().min(0).optional(),
        title: z.string().trim().min(1).max(LIMITS.titleMax).optional(),
        keep: z.object({ labels: z.boolean(), members: z.boolean(), checklists: z.boolean(), customFields: z.boolean(), dates: z.boolean() }).partial().optional(),
      }),
    );
    await requireBoardForList(me.id, input.listId);
    return c.json({ card: await duplicateCard(userActor(me.id), card.id, input) }, 201);
  })

  .post('/:id/labels', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    const { labelId } = await body(c, z.object({ labelId: z.string() }));
    await addLabel(userActor(me.id), card.id, labelId);
    return c.json({ ok: true });
  })
  .delete('/:id/labels/:labelId', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    await removeLabel(userActor(me.id), card.id, c.req.param('labelId'));
    return c.json({ ok: true });
  })

  .post('/:id/assignees', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    const { userId } = await body(c, z.object({ userId: z.string() }));
    await assign(userActor(me.id), card.id, userId);
    return c.json({ ok: true });
  })
  .delete('/:id/assignees/:userId', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    await unassign(userActor(me.id), card.id, c.req.param('userId'));
    return c.json({ ok: true });
  })

  .post('/:id/watch', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'));
    const { watching } = await body(c, z.object({ watching: z.boolean() }));
    if (watching) await db().insert(cardWatchers).values({ cardId: card.id, userId: me.id }).onConflictDoNothing();
    else await db().delete(cardWatchers).where(and(eq(cardWatchers.cardId, card.id), eq(cardWatchers.userId, me.id)));
    return c.json({ ok: true });
  })

  .post('/:id/vote', async (c) => {
    const me = requireUser(c);
    const { card, board } = await requireCard(me.id, c.req.param('id'));
    if (!board.settings.votingEnabled) throw badRequest('Voting is turned off for this board');
    const { vote } = await body(c, z.object({ vote: z.boolean() }));
    if (vote) await db().insert(cardVotes).values({ cardId: card.id, userId: me.id }).onConflictDoNothing();
    else await db().delete(cardVotes).where(and(eq(cardVotes.cardId, card.id), eq(cardVotes.userId, me.id)));
    publishBoard(card.boardId, { type: 'changed', event: 'card.voted', cardId: card.id });
    return c.json({ ok: true });
  })

  .put('/:id/custom-fields/:fieldId', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    const { value } = await body(c, z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }));
    const clean = await setCustomFieldValue(userActor(me.id), card.id, c.req.param('fieldId'), value);
    return c.json({ value: clean });
  })

  /* --------------------------------------------------- relations & links */
  .post('/:id/relations', async (c) => {
    const me = requireUser(c);
    const { card, board } = await requireCard(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ toCardId: z.string(), kind: z.enum(['relates', 'blocks', 'blocked_by', 'duplicates']) }));
    if (input.toCardId === card.id) throw badRequest('A card cannot relate to itself');
    const other = await requireCard(me.id, input.toCardId, 'observer');
    if (other.board.workspaceId !== board.workspaceId) throw badRequest('Related cards must be in the same workspace');
    // "blocked_by" is stored as the inverse "blocks" edge so dependency queries stay simple.
    const [from, to, kind] = input.kind === 'blocked_by' ? [input.toCardId, card.id, 'blocks'] : [card.id, input.toCardId, input.kind];
    if (kind === 'blocks') {
      const cycle = await reachable(to, from);
      if (cycle) throw badRequest('That dependency would create a cycle');
    }
    const [row] = await db().insert(cardRelations).values({ id: newId(), fromCardId: from, toCardId: to, kind }).onConflictDoNothing().returning();
    await emit({ type: 'card.relationAdded', workspaceId: board.workspaceId, boardId: card.boardId, cardId: card.id, actor: userActor(me.id), data: { cardTitle: card.title, kind: input.kind, otherTitle: other.card.title } });
    if (other.card.boardId !== card.boardId) publishBoard(other.card.boardId, { type: 'changed', event: 'card.relationAdded', cardId: other.card.id });
    return c.json({ relation: row ?? null }, 201);
  })
  .delete('/:id/relations/:relId', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    await db().delete(cardRelations).where(and(eq(cardRelations.id, c.req.param('relId')), or(eq(cardRelations.fromCardId, card.id), eq(cardRelations.toCardId, card.id))));
    publishBoard(card.boardId, { type: 'changed', event: 'card.relationRemoved', cardId: card.id });
    return c.json({ ok: true });
  })

  .post('/:id/links', async (c) => {
    const me = requireUser(c);
    const { card, board } = await requireCard(me.id, c.req.param('id'), 'member');
    const { url, title } = await body(c, z.object({ url: z.string().url().max(2000), title: z.string().max(200).optional() }));
    const parsed = parseDevLink(url);
    if (!parsed) throw badRequest('Enter a valid http(s) link');
    const [row] = await db()
      .insert(cardLinks)
      .values({ id: newId(), cardId: card.id, provider: parsed.provider, kind: parsed.kind, url, title: title || parsed.title, ref: parsed.ref, createdById: me.id })
      .returning();
    if (parsed.provider === 'github') {
      await enqueue('github.refreshLink', { linkId: row.id, workspaceId: board.workspaceId });
    }
    await emit({ type: 'card.linkAdded', workspaceId: board.workspaceId, boardId: card.boardId, cardId: card.id, actor: userActor(me.id), data: { cardTitle: card.title, provider: parsed.provider, kind: parsed.kind, ref: parsed.ref } });
    return c.json({ link: row }, 201);
  })
  .delete('/:id/links/:linkId', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    await db().delete(cardLinks).where(and(eq(cardLinks.id, c.req.param('linkId')), eq(cardLinks.cardId, card.id)));
    publishBoard(card.boardId, { type: 'changed', event: 'card.linkRemoved', cardId: card.id });
    return c.json({ ok: true });
  })

  .patch('/:id/bug', async (c) => {
    const me = requireUser(c);
    const { card, board } = await requireCard(me.id, c.req.param('id'), 'member');
    const input = await body(c, bugSchema.extend({ isBug: z.boolean().optional() }));
    const { isBug, ...fields } = input;
    if (isBug === false) {
      await db().update(cards).set({ type: 'task', updatedAt: deps().now() }).where(eq(cards.id, card.id));
      await db().delete(bugDetails).where(eq(bugDetails.cardId, card.id));
    } else {
      if (card.type !== 'bug') await db().update(cards).set({ type: 'bug', updatedAt: deps().now() }).where(eq(cards.id, card.id));
      await db().insert(bugDetails).values({ cardId: card.id, ...fields }).onConflictDoUpdate({ target: bugDetails.cardId, set: fields });
    }
    await emit({ type: 'bug.updated', workspaceId: board.workspaceId, boardId: card.boardId, cardId: card.id, actor: userActor(me.id), data: { cardTitle: card.title, fields: Object.keys(fields) }, quiet: true });
    return c.json({ ok: true });
  })

  .put('/:id/assets', async (c) => {
    const me = requireUser(c);
    const { card, board } = await requireCard(me.id, c.req.param('id'), 'member');
    const { assetIds } = await body(c, z.object({ assetIds: z.array(z.string()).max(50) }));
    const valid = assetIds.length ? await db().select({ id: assets.id }).from(assets).where(and(inArray(assets.id, assetIds), eq(assets.workspaceId, board.workspaceId))) : [];
    await db().delete(assetCards).where(eq(assetCards.cardId, card.id));
    if (valid.length) await db().insert(assetCards).values(valid.map((a) => ({ assetId: a.id, cardId: card.id })));
    publishBoard(card.boardId, { type: 'changed', event: 'card.assets', cardId: card.id });
    return c.json({ ok: true });
  })

  /* -------------------------------------------------------- checklists */
  .post('/:id/checklists', async (c) => {
    const me = requireUser(c);
    const { card } = await requireCard(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ title: z.string().trim().max(200).default('Checklist'), items: z.array(z.string().max(1000)).max(LIMITS.checklistItemsPerBulk).default([]), templateId: z.string().optional(), copyFromChecklistId: z.string().optional() }));
    let { title, items } = input;
    if (input.templateId) {
      const [t] = await db().select().from(templates).where(and(eq(templates.id, input.templateId), eq(templates.kind, 'checklist')));
      if (!t) throw notFound('Template');
      title = String((t.data as any).title ?? t.name);
      items = ((t.data as any).items ?? []).map(String);
    }
    if (input.copyFromChecklistId) {
      const src = await requireChecklist(me.id, input.copyFromChecklistId, 'observer');
      title = input.title && input.title !== 'Checklist' ? input.title : src.checklist.title;
      items = (await db().select().from(checklistItems).where(eq(checklistItems.checklistId, src.checklist.id)).orderBy(asc(checklistItems.position))).map((i) => i.text);
    }
    const cl = await addChecklist(userActor(me.id), card, title, items);
    return c.json({ checklist: cl }, 201);
  })

  /* ---------------------------------------------------------- comments */
  .post('/:id/comments', rateLimit('comment', 300, 3600_000), async (c) => {
    const me = requireUser(c);
    const { card, board, role } = await requireCard(me.id, c.req.param('id'), 'observer');
    const canComment = boardRoleAtLeast(role, 'member') || board.settings.commentPermission === 'observers';
    if (!canComment || board.archivedAt) throw forbidden('You cannot comment on this board');
    const input = await body(c, z.object({ body: z.string().min(1).max(LIMITS.commentMax), parentId: z.string().nullable().optional() }));
    const comment = await addComment(userActor(me.id), card.id, input.body, input.parentId);
    return c.json({ comment }, 201);
  })

  .get('/:id/activity', async (c) => {
    const user = c.get('user');
    const { card } = await requireCard(user?.id ?? null, c.req.param('id'));
    const before = c.req.query('before');
    const rows = await db()
      .select({ id: activities.id, type: activities.type, data: activities.data, actorType: activities.actorType, createdAt: activities.createdAt, actor: { id: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl } })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.actorId))
      .where(and(eq(activities.cardId, card.id), before ? lt(activities.createdAt, new Date(before)) : undefined))
      .orderBy(desc(activities.createdAt))
      .limit(50);
    return c.json({ activities: rows });
  })

  .post('/:id/save-as-template', async (c) => {
    const me = requireUser(c);
    const { card, board } = await requireCard(me.id, c.req.param('id'), 'member');
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(120) }));
    const detail = await cardDetail(card.id, me.id);
    const lbl = await db().select({ name: labels.name }).from(cardLabels).innerJoin(labels, eq(labels.id, cardLabels.labelId)).where(eq(cardLabels.cardId, card.id));
    const [row] = await db()
      .insert(templates)
      .values({
        id: newId(),
        workspaceId: board.workspaceId,
        kind: 'card',
        name,
        description: card.title,
        category: 'custom',
        data: { title: card.title, description: card.description, priority: card.priority, type: card.type, labels: lbl.map((l) => l.name), checklists: detail.checklists.map((cl) => ({ title: cl.title, items: cl.items.map((i) => i.text) })) },
        createdById: me.id,
      })
      .returning();
    return c.json({ template: row }, 201);
  });

async function requireBoardForList(userId: string, listId: string) {
  const [list] = await db().select().from(lists).where(eq(lists.id, listId));
  if (!list) throw notFound('List');
  await requireBoard(userId, list.boardId, 'member');
  return list;
}

/** Is `target` reachable from `start` along "blocks" edges? Used to reject dependency cycles. */
async function reachable(start: string, target: string): Promise<boolean> {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < 50 && frontier.length; depth++) {
    if (frontier.includes(target)) return true;
    const edges = await db().select({ to: cardRelations.toCardId }).from(cardRelations).where(and(inArray(cardRelations.fromCardId, frontier), eq(cardRelations.kind, 'blocks')));
    frontier = edges.map((e) => e.to).filter((id) => !seen.has(id));
    frontier.forEach((id) => seen.add(id));
  }
  return frontier.includes(target);
}

/* ------------------------------------------------- checklist & comment edits */

export const checklistRoutes = new Hono<AppEnv>()
  .patch('/checklists/:id', async (c) => {
    const me = requireUser(c);
    const { checklist, card } = await requireChecklist(me.id, c.req.param('id'));
    const input = await body(c, z.object({ title: z.string().trim().min(1).max(200).optional(), hideCompleted: z.boolean().optional() }));
    await db().update(checklists).set(input).where(eq(checklists.id, checklist.id));
    publishBoard(card.boardId, { type: 'changed', event: 'checklist.updated', cardId: card.id });
    return c.json({ ok: true });
  })
  .post('/checklists/:id/move', async (c) => {
    const me = requireUser(c);
    const { checklist, card } = await requireChecklist(me.id, c.req.param('id'));
    const { index } = await body(c, z.object({ index: z.number().int().min(0) }));
    const position = await positionAt('checklist', card.id, index, checklist.id);
    await db().update(checklists).set({ position }).where(eq(checklists.id, checklist.id));
    publishBoard(card.boardId, { type: 'changed', event: 'checklist.moved', cardId: card.id });
    return c.json({ ok: true });
  })
  .delete('/checklists/:id', async (c) => {
    const me = requireUser(c);
    const { checklist, card, board } = await requireChecklist(me.id, c.req.param('id'));
    await db().delete(checklists).where(eq(checklists.id, checklist.id));
    await emit({ type: 'checklist.deleted', workspaceId: board.workspaceId, boardId: card.boardId, cardId: card.id, actor: userActor(me.id), data: { cardTitle: card.title, checklistTitle: checklist.title } });
    return c.json({ ok: true });
  })
  .post('/checklists/:id/items', async (c) => {
    const me = requireUser(c);
    const { checklist, card } = await requireChecklist(me.id, c.req.param('id'));
    const input = await body(c, z.object({ text: z.string().max(1000).optional(), texts: z.array(z.string().max(1000)).max(LIMITS.checklistItemsPerBulk).optional(), index: z.number().int().min(0).optional() }));
    const texts = (input.texts ?? (input.text !== undefined ? input.text.split(/\r?\n/) : [])).map((t) => t.trim()).filter(Boolean);
    if (!texts.length) throw badRequest('Enter at least one item');
    const created = [];
    let index = input.index;
    for (const text of texts) {
      const position = await positionAt('item', checklist.id, index);
      const [row] = await db().insert(checklistItems).values({ id: newId(), checklistId: checklist.id, text, position }).returning();
      created.push(row);
      if (index !== undefined) index++;
    }
    publishBoard(card.boardId, { type: 'changed', event: 'checklist.itemAdded', cardId: card.id });
    return c.json({ items: created }, 201);
  })
  .post('/checklists/:id/save-as-template', async (c) => {
    const me = requireUser(c);
    const { checklist, board } = await requireChecklist(me.id, c.req.param('id'));
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(120) }));
    const items = await db().select().from(checklistItems).where(eq(checklistItems.checklistId, checklist.id)).orderBy(asc(checklistItems.position));
    const [row] = await db().insert(templates).values({ id: newId(), workspaceId: board.workspaceId, kind: 'checklist', name, category: 'custom', data: { title: checklist.title, items: items.map((i) => i.text) }, createdById: me.id }).returning();
    return c.json({ template: row }, 201);
  })
  .patch('/checklist-items/:id', async (c) => {
    const me = requireUser(c);
    const { item, card, board } = await requireChecklistItem(me.id, c.req.param('id'));
    const input = await body(
      c,
      z.object({
        version: z.number().int().optional(),
        text: z.string().trim().min(1).max(1000).optional(),
        completed: z.boolean().optional(),
        assigneeId: z.string().nullable().optional(),
        dueAt: dateish.optional(),
      }),
    );
    if (input.completed !== undefined) await setChecklistItemCompleted(userActor(me.id), item.id, input.completed);
    const set: Partial<typeof checklistItems.$inferInsert> = {};
    if (input.text !== undefined) set.text = input.text;
    if (input.dueAt !== undefined) set.dueAt = input.dueAt;
    if (input.assigneeId !== undefined) {
      if (input.assigneeId) {
              if (!(await boardAccess(input.assigneeId, board.id))) throw badRequest('That person cannot access this board');
      }
      set.assigneeId = input.assigneeId;
    }
    if (Object.keys(set).length) {
      const [fresh] = await db().select().from(checklistItems).where(eq(checklistItems.id, item.id));
      // Text edits use optimistic concurrency so simultaneous edits don't silently overwrite.
      if (input.text !== undefined && input.version !== undefined && fresh.version !== input.version) {
        throw conflict('This item was edited by someone else.', { current: fresh });
      }
      const [row] = await db()
        .update(checklistItems)
        .set({ ...set, version: sql`${checklistItems.version} + 1` })
        .where(and(eq(checklistItems.id, item.id), eq(checklistItems.version, fresh.version)))
        .returning();
      if (!row) {
        throw conflict('This item was edited by someone else. Please retry.');
      }
      if (input.assigneeId) {
        await notify([input.assigneeId], { type: 'assigned', title: `${me.displayName} assigned you a checklist item on “${card.title}”`, body: row.text, workspaceId: board.workspaceId, boardId: board.id, cardId: card.id, actorId: me.id, dedupeKey: `cli-assign:${item.id}:${input.assigneeId}` });
      }
    }
    publishBoard(card.boardId, { type: 'changed', event: 'checklist.itemUpdated', cardId: card.id });
    const [result] = await db().select().from(checklistItems).where(eq(checklistItems.id, item.id));
    return c.json({ item: result });
  })
  .post('/checklist-items/:id/move', async (c) => {
    const me = requireUser(c);
    const { item, card } = await requireChecklistItem(me.id, c.req.param('id'));
    const input = await body(c, z.object({ index: z.number().int().min(0), checklistId: z.string().optional() }));
    let checklistId = item.checklistId;
    if (input.checklistId && input.checklistId !== item.checklistId) {
      const target = await requireChecklist(me.id, input.checklistId);
      if (target.card.id !== card.id) throw badRequest('Items can only move between checklists on the same card');
      checklistId = target.checklist.id;
    }
    const position = await positionAt('item', checklistId, input.index, item.id);
    await db().update(checklistItems).set({ checklistId, position, version: sql`${checklistItems.version} + 1` }).where(eq(checklistItems.id, item.id));
    publishBoard(card.boardId, { type: 'changed', event: 'checklist.itemMoved', cardId: card.id });
    return c.json({ ok: true });
  })
  .delete('/checklist-items/:id', async (c) => {
    const me = requireUser(c);
    const { item, card } = await requireChecklistItem(me.id, c.req.param('id'));
    await db().delete(checklistItems).where(eq(checklistItems.id, item.id));
    publishBoard(card.boardId, { type: 'changed', event: 'checklist.itemDeleted', cardId: card.id });
    return c.json({ ok: true });
  })

  .patch('/comments/:id', async (c) => {
    const me = requireUser(c);
    const { comment, card } = await requireComment(me.id, c.req.param('id'));
    if (comment.authorId !== me.id) throw forbidden('You can only edit your own comments');
    const { body: text } = await body(c, z.object({ body: z.string().trim().min(1).max(LIMITS.commentMax) }));
    await db().update(comments).set({ body: text, editedAt: deps().now() }).where(eq(comments.id, comment.id));
    publishBoard(card.boardId, { type: 'changed', event: 'comment.edited', cardId: card.id });
    return c.json({ ok: true });
  })
  .delete('/comments/:id', async (c) => {
    const me = requireUser(c);
    const { comment, card, role } = await requireComment(me.id, c.req.param('id'));
    if (comment.authorId !== me.id && role !== 'admin') throw forbidden('Only the author or a board admin can delete this comment');
    await db().update(comments).set({ deletedAt: deps().now(), body: '' }).where(eq(comments.id, comment.id));
    publishBoard(card.boardId, { type: 'changed', event: 'comment.deleted', cardId: card.id });
    return c.json({ ok: true });
  });


import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { lists, cards, workflowStages } from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { requireBoard, requireList } from '../lib/access.js';
import { emit, userActor } from '../lib/events.js';
import { archiveCard, duplicateCard, moveCard, positionAt } from '../services/cards.js';
import { PRIORITY_META, type Priority } from '../../shared/constants.js';
import { POSITION_STEP } from '../../shared/utils.js';
import { publishBoard } from '../lib/realtime.js';

export const listRoutes = new Hono<AppEnv>()
  .patch('/:id', async (c) => {
    const me = requireUser(c);
    const { list, board } = await requireList(me.id, c.req.param('id'));
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        stageId: z.string().nullable().optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
        wipLimit: z.number().int().min(1).max(999).nullable().optional(),
        collapsed: z.boolean().optional(),
      }),
    );
    if (input.stageId) {
      const [s] = await db().select().from(workflowStages).where(and(eq(workflowStages.id, input.stageId), eq(workflowStages.workspaceId, board.workspaceId)));
      if (!s) throw badRequest('Unknown workflow stage');
    }
    const [row] = await db().update(lists).set(input).where(eq(lists.id, list.id)).returning();
    if (input.name && input.name !== list.name) await emit({ type: 'list.renamed', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { from: list.name, to: input.name } });
    else publishBoard(board.id, { type: 'changed', event: 'list.updated' });
    return c.json({ list: row });
  })

  .post('/:id/move', async (c) => {
    const me = requireUser(c);
    const { list, board } = await requireList(me.id, c.req.param('id'));
    const input = await body(c, z.object({ index: z.number().int().min(0), boardId: z.string().optional() }));
    const targetBoardId = input.boardId ?? board.id;
    if (targetBoardId !== board.id) {
      const target = await requireBoard(me.id, targetBoardId, 'member');
      if (target.board.workspaceId !== board.workspaceId) {
        // Stages are workspace-scoped; drop the mapping when moving across workspaces.
        await db().update(lists).set({ stageId: null }).where(eq(lists.id, list.id));
      }
      const position = await positionAt('list', targetBoardId, input.index);
      await db().update(lists).set({ boardId: targetBoardId, position }).where(eq(lists.id, list.id));
      const cardRows = await db().select({ id: cards.id }).from(cards).where(eq(cards.listId, list.id)).orderBy(asc(cards.position));
      for (const card of cardRows) await moveCard(userActor(me.id), card.id, { listId: list.id });
      await emit({ type: 'list.moved', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { listName: list.name, toBoardId: targetBoardId } });
      await emit({ type: 'list.movedIn', workspaceId: target.board.workspaceId, boardId: targetBoardId, actor: userActor(me.id), data: { listName: list.name, fromBoardId: board.id } });
      return c.json({ ok: true });
    }
    const position = await positionAt('list', board.id, input.index, list.id);
    await db().update(lists).set({ position }).where(eq(lists.id, list.id));
    publishBoard(board.id, { type: 'changed', event: 'list.reordered', actorId: me.id });
    return c.json({ ok: true, position });
  })

  .post('/:id/archive', async (c) => {
    const me = requireUser(c);
    const { list, board } = await requireList(me.id, c.req.param('id'));
    const { archived } = await body(c, z.object({ archived: z.boolean() }));
    const position = archived ? list.position : await positionAt('list', board.id, undefined, list.id);
    await db().update(lists).set({ archivedAt: archived ? deps().now() : null, position }).where(eq(lists.id, list.id));
    await emit({ type: archived ? 'list.archived' : 'list.restored', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { listName: list.name } });
    return c.json({ ok: true });
  })

  .delete('/:id', async (c) => {
    const me = requireUser(c);
    const { list, board } = await requireList(me.id, c.req.param('id'), 'admin');
    await db().delete(lists).where(eq(lists.id, list.id));
    await emit({ type: 'list.deleted', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { listName: list.name } });
    return c.json({ ok: true });
  })

  .post('/:id/copy', async (c) => {
    const me = requireUser(c);
    const { list, board } = await requireList(me.id, c.req.param('id'));
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(120) }));
    const ordered = await db().select().from(lists).where(and(eq(lists.boardId, board.id), isNull(lists.archivedAt))).orderBy(asc(lists.position));
    const idx = ordered.findIndex((l) => l.id === list.id);
    const position = await positionAt('list', board.id, idx + 1);
    const [copy] = await db().insert(lists).values({ id: newId(), boardId: board.id, name, position, stageId: list.stageId, color: list.color, wipLimit: list.wipLimit }).returning();
    const src = await db().select({ id: cards.id }).from(cards).where(and(eq(cards.listId, list.id), isNull(cards.archivedAt))).orderBy(asc(cards.position));
    for (const card of src) await duplicateCard({ ...userActor(me.id), depth: 99 }, card.id, { listId: copy.id });
    await emit({ type: 'list.copied', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { listName: list.name, newName: name } });
    return c.json({ list: copy }, 201);
  })

  .post('/:id/move-cards', async (c) => {
    const me = requireUser(c);
    const { list } = await requireList(me.id, c.req.param('id'));
    const { toListId } = await body(c, z.object({ toListId: z.string() }));
    await requireList(me.id, toListId);
    const src = await db().select({ id: cards.id }).from(cards).where(and(eq(cards.listId, list.id), isNull(cards.archivedAt))).orderBy(asc(cards.position));
    for (const card of src) await moveCard(userActor(me.id), card.id, { listId: toListId });
    return c.json({ moved: src.length });
  })

  .post('/:id/archive-cards', async (c) => {
    const me = requireUser(c);
    const { list } = await requireList(me.id, c.req.param('id'));
    const src = await db().select({ id: cards.id }).from(cards).where(and(eq(cards.listId, list.id), isNull(cards.archivedAt)));
    for (const card of src) await archiveCard(userActor(me.id), card.id, true);
    return c.json({ archived: src.length });
  })

  .post('/:id/sort', async (c) => {
    const me = requireUser(c);
    const { list, board } = await requireList(me.id, c.req.param('id'));
    const { by } = await body(c, z.object({ by: z.enum(['dueAt', 'createdAt', 'title', 'priority']) }));
    const rows = await db().select().from(cards).where(and(eq(cards.listId, list.id), isNull(cards.archivedAt)));
    const cmp: Record<string, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
      dueAt: (a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity),
      createdAt: (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      title: (a, b) => a.title.localeCompare(b.title),
      priority: (a, b) => PRIORITY_META[b.priority as Priority].rank - PRIORITY_META[a.priority as Priority].rank,
    };
    rows.sort(cmp[by]);
    await db().transaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) await tx.update(cards).set({ position: (i + 1) * POSITION_STEP }).where(eq(cards.id, rows[i].id));
    });
    publishBoard(board.id, { type: 'changed', event: 'list.sorted', actorId: me.id });
    return c.json({ ok: true });
  });


import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, isNull, isNotNull, lt, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { boards, cards, comments, labels, cardLabels, cardAssignees, projects, releases, workspaceMembers, workspaces, lists, users } from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { query } from '../lib/request.js';
import { visibleBoardPredicate } from '../lib/access.js';
import { cardSummaries } from '../services/cards.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const searchSchema = z.object({
  q: z.string().max(200).default(''),
  types: z.string().default('cards,boards,comments,labels,projects,releases'),
  workspaceId: z.string().optional(),
  boardId: z.string().optional(),
  assignee: z.string().optional(), // 'me' | userId
  label: z.string().max(60).optional(),
  status: z.enum(['open', 'done', 'any']).default('any'),
  due: z.enum(['overdue', 'week', 'none', 'any']).default('any'),
  kind: z.enum(['task', 'bug', 'any']).default('any'),
  archived: z.enum(['true', 'false']).default('false'),
  sort: z.enum(['relevance', 'updated', 'due', 'created']).default('relevance'),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Permission-aware global search. Every query joins through `boards` with
 * visibleBoardPredicate (or workspace membership for workspace-level entities),
 * so inaccessible content is never matched, counted or returned.
 */
export const searchRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const me = requireUser(c);
  const p = query(c, searchSchema);
  const types = new Set(p.types.split(','));
  const term = p.q.trim();
  const like = `%${escapeLike(term)}%`;
  const now = deps().now();
  const out: Record<string, unknown> = {};

  const memberWorkspaces = db().select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, me.id));

  if (types.has('cards')) {
    const conds: (SQL | undefined)[] = [visibleBoardPredicate(me.id), isNull(boards.archivedAt)];
    if (p.archived === 'false') conds.push(isNull(cards.archivedAt), isNull(lists.archivedAt));
    if (term) {
      const keyMatch = /^([A-Za-z][A-Za-z0-9]{1,7})-(\d+)$/.exec(term);
      conds.push(
        or(
          ilike(cards.title, like),
          ilike(cards.description, like),
          sql`to_tsvector('simple', ${cards.title} || ' ' || ${cards.description}) @@ websearch_to_tsquery('simple', ${term})`,
          keyMatch ? and(eq(sql`upper(${boards.key})`, keyMatch[1].toUpperCase()), eq(cards.number, Number(keyMatch[2]))) : undefined,
        ),
      );
    }
    if (p.workspaceId) conds.push(eq(boards.workspaceId, p.workspaceId));
    if (p.boardId) conds.push(eq(cards.boardId, p.boardId));
    if (p.assignee) conds.push(sql`exists (select 1 from ${cardAssignees} ca where ca.card_id = ${cards.id} and ca.user_id = ${p.assignee === 'me' ? me.id : p.assignee})`);
    if (p.label) conds.push(sql`exists (select 1 from ${cardLabels} cl join ${labels} l on l.id = cl.label_id where cl.card_id = ${cards.id} and lower(l.name) = ${p.label.toLowerCase()})`);
    if (p.status === 'open') conds.push(isNull(cards.completedAt));
    if (p.status === 'done') conds.push(isNotNull(cards.completedAt));
    if (p.due === 'overdue') conds.push(lt(cards.dueAt, now), isNull(cards.completedAt));
    if (p.due === 'week') conds.push(gte(cards.dueAt, now), lte(cards.dueAt, new Date(now.getTime() + 7 * 86400_000)));
    if (p.due === 'none') conds.push(isNull(cards.dueAt));
    if (p.kind !== 'any') conds.push(eq(cards.type, p.kind));
    const order =
      p.sort === 'due'
        ? [sql`${cards.dueAt} asc nulls last`]
        : p.sort === 'created'
          ? [desc(cards.createdAt)]
          : p.sort === 'updated' || !term
            ? [desc(cards.updatedAt)]
            : [sql`(case when ${cards.title} ilike ${like} then 0 else 1 end)`, desc(cards.updatedAt)];
    const where = and(...conds);
    const [rows, [count]] = await Promise.all([
      db()
        .select({ id: cards.id })
        .from(cards)
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(lists, eq(lists.id, cards.listId))
        .where(where)
        .orderBy(...order)
        .limit(p.limit)
        .offset(p.offset),
      db().select({ n: sql<number>`count(*)::int` }).from(cards).innerJoin(boards, eq(boards.id, cards.boardId)).innerJoin(lists, eq(lists.id, cards.listId)).where(where),
    ]);
    const summaries = await cardSummaries({ cardIds: rows.map((r) => r.id), includeArchived: p.archived === 'true' });
    const order2 = new Map(rows.map((r, i) => [r.id, i]));
    summaries.sort((a, b) => order2.get(a.id)! - order2.get(b.id)!);
    const boardIds = [...new Set(summaries.map((s) => s.boardId))];
    const listIds = [...new Set(summaries.map((s) => s.listId))];
    out.cards = {
      total: count.n,
      items: summaries,
      boards: boardIds.length ? await db().select({ id: boards.id, name: boards.name, key: boards.key, workspaceId: boards.workspaceId }).from(boards).where(inArray(boards.id, boardIds)) : [],
      lists: listIds.length ? await db().select({ id: lists.id, name: lists.name }).from(lists).where(inArray(lists.id, listIds)) : [],
    };
  }

  if (types.has('boards')) {
    out.boards = await db()
      .select({ id: boards.id, name: boards.name, key: boards.key, background: boards.background, workspaceId: boards.workspaceId, workspaceName: workspaces.name, archivedAt: boards.archivedAt })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(visibleBoardPredicate(me.id), term ? or(ilike(boards.name, like), ilike(boards.description, like), ilike(boards.key, like)) : undefined, p.workspaceId ? eq(boards.workspaceId, p.workspaceId) : undefined, p.archived === 'true' ? undefined : isNull(boards.archivedAt)))
      .orderBy(desc(boards.updatedAt))
      .limit(10);
  }

  if (types.has('comments') && term) {
    out.comments = await db()
      .select({ id: comments.id, body: comments.body, cardId: comments.cardId, createdAt: comments.createdAt, cardTitle: cards.title, boardId: cards.boardId, author: users.displayName })
      .from(comments)
      .innerJoin(cards, eq(cards.id, comments.cardId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .leftJoin(users, eq(users.id, comments.authorId))
      .where(and(visibleBoardPredicate(me.id), isNull(comments.deletedAt), ilike(comments.body, like), p.workspaceId ? eq(boards.workspaceId, p.workspaceId) : undefined, p.boardId ? eq(cards.boardId, p.boardId) : undefined))
      .orderBy(desc(comments.createdAt))
      .limit(10);
  }

  if (types.has('labels') && term) {
    out.labels = await db()
      .select({ id: labels.id, name: labels.name, color: labels.color, boardId: labels.boardId, boardName: boards.name, cardCount: sql<number>`(select count(*)::int from ${cardLabels} cl where cl.label_id = ${labels.id})` })
      .from(labels)
      .innerJoin(boards, eq(boards.id, labels.boardId))
      .where(and(visibleBoardPredicate(me.id), ilike(labels.name, like), p.workspaceId ? eq(boards.workspaceId, p.workspaceId) : undefined))
      .limit(10);
  }

  if (types.has('projects')) {
    out.projects = await db()
      .select({ id: projects.id, name: projects.name, stage: projects.stage, workspaceId: projects.workspaceId, thumbnailUrl: projects.thumbnailUrl })
      .from(projects)
      .where(and(inArray(projects.workspaceId, memberWorkspaces), term ? or(ilike(projects.name, like), ilike(projects.description, like), eq(projects.universeId, term), eq(projects.placeId, term)) : undefined, p.workspaceId ? eq(projects.workspaceId, p.workspaceId) : undefined))
      .limit(10);
  }

  if (types.has('releases')) {
    out.releases = await db()
      .select({ id: releases.id, name: releases.name, version: releases.version, status: releases.status, workspaceId: releases.workspaceId, plannedDate: releases.plannedDate })
      .from(releases)
      .where(and(inArray(releases.workspaceId, memberWorkspaces), term ? or(ilike(releases.name, like), ilike(releases.version, like), ilike(releases.notes, like)) : undefined, p.workspaceId ? eq(releases.workspaceId, p.workspaceId) : undefined))
      .limit(10);
  }

  return c.json(out);
});

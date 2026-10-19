import { Hono } from 'hono';
import { and, eq, gte, inArray, isNull, isNotNull, sql, desc } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { boards, cards, lists, cardAssignees, users, labels, cardLabels, workflowStages, releases, activities, workspaceMembers, milestones } from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { requireWorkspace, visibleBoardPredicate } from '../lib/access.js';
import { notFound } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { rateLimit } from '../lib/rateLimit.js';
import { env } from '../env.js';

/** Reports are computed from live data, scoped to boards the viewer can access. */
export const reportRoutes = new Hono<AppEnv>().get('/workspaces/:id/reports', async (c) => {
  const me = requireUser(c);
  const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
  const boardId = c.req.query('boardId');
  const projectId = c.req.query('projectId');
  const weeks = Math.min(26, Math.max(4, Number(c.req.query('weeks') ?? 12) || 12));
  const now = deps().now();
  const scope = and(
    eq(boards.workspaceId, workspace.id),
    isNull(boards.archivedAt),
    visibleBoardPredicate(me.id),
    isNull(cards.archivedAt),
    isNull(lists.archivedAt),
    boardId ? eq(boards.id, boardId) : undefined,
    projectId ? eq(boards.projectId, projectId) : undefined,
  );

  const [totals] = await db()
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(${cards.completedAt})::int`,
      overdue: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${cards.dueAt} < ${now})::int`,
      bugsOpen: sql<number>`count(*) filter (where ${cards.type} = 'bug' and ${cards.completedAt} is null)::int`,
      unassigned: sql<number>`count(*) filter (where ${cards.completedAt} is null and not exists (select 1 from ${cardAssignees} ca where ca.card_id = ${cards.id}))::int`,
    })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(scope);

  const byPriority = await db()
    .select({ priority: cards.priority, open: sql<number>`count(*) filter (where ${cards.completedAt} is null)::int`, done: sql<number>`count(${cards.completedAt})::int` })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(scope)
    .groupBy(cards.priority);

  const byAssignee = await db()
    .select({
      userId: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      open: sql<number>`count(*) filter (where ${cards.completedAt} is null)::int`,
      done: sql<number>`count(${cards.completedAt})::int`,
      overdue: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${cards.dueAt} < ${now})::int`,
      dueThisWeek: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${cards.dueAt} >= ${now} and ${cards.dueAt} < ${new Date(now.getTime() + 7 * 86400_000)})::int`,
    })
    .from(cardAssignees)
    .innerJoin(cards, eq(cards.id, cardAssignees.cardId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(users, eq(users.id, cardAssignees.userId))
    .where(scope)
    .groupBy(users.id, users.displayName, users.avatarUrl)
    .orderBy(desc(sql`count(*) filter (where ${cards.completedAt} is null)`));

  const byStage = await db()
    .select({ stage: sql<string>`coalesce(${workflowStages.name}, 'No stage')`, color: workflowStages.color, n: sql<number>`count(*)::int` })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .leftJoin(workflowStages, eq(workflowStages.id, lists.stageId))
    .where(and(scope, isNull(cards.completedAt)))
    .groupBy(workflowStages.name, workflowStages.color, workflowStages.position)
    .orderBy(sql`${workflowStages.position} nulls last`);

  const byLabel = await db()
    .select({ name: labels.name, color: labels.color, n: sql<number>`count(*)::int` })
    .from(cardLabels)
    .innerJoin(labels, eq(labels.id, cardLabels.labelId))
    .innerJoin(cards, eq(cards.id, cardLabels.cardId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(and(scope, isNull(cards.completedAt)))
    .groupBy(labels.name, labels.color)
    .orderBy(desc(sql`count(*)`))
    .limit(12);

  // Weekly created vs completed (UTC weeks starting Monday).
  const since = new Date(now.getTime() - weeks * 7 * 86400_000);
  const created = await db()
    .select({ week: sql<string>`to_char(date_trunc('week', ${cards.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`, n: sql<number>`count(*)::int` })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(and(scope, gte(cards.createdAt, since)))
    .groupBy(sql`1`);
  const completed = await db()
    .select({ week: sql<string>`to_char(date_trunc('week', ${cards.completedAt} at time zone 'UTC'), 'YYYY-MM-DD')`, n: sql<number>`count(*)::int` })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(and(scope, isNotNull(cards.completedAt), gte(cards.completedAt, since)))
    .groupBy(sql`1`);
  const trend: { week: string; created: number; completed: number }[] = [];
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  for (let i = weeks - 1; i >= 0; i--) {
    const w = new Date(monday.getTime() - i * 7 * 86400_000).toISOString().slice(0, 10);
    trend.push({ week: w, created: created.find((x) => x.week === w)?.n ?? 0, completed: completed.find((x) => x.week === w)?.n ?? 0 });
  }

  const rels = await db().select().from(releases).where(and(eq(releases.workspaceId, workspace.id), projectId ? eq(releases.projectId, projectId) : undefined)).orderBy(sql`${releases.plannedDate} desc nulls first`).limit(10);
  const releaseProgress = [];
  for (const r of rels) {
    const [p] = await db()
      .select({ total: sql<number>`count(*)::int`, done: sql<number>`count(${cards.completedAt})::int` })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(and(scope, eq(cards.releaseId, r.id)));
    releaseProgress.push({ id: r.id, name: r.name, version: r.version, status: r.status, plannedDate: r.plannedDate, total: p.total, done: p.done });
  }

  const boardProgress = await db()
    .select({ id: boards.id, name: boards.name, total: sql<number>`count(${cards.id})::int`, done: sql<number>`count(${cards.completedAt})::int` })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(scope)
    .groupBy(boards.id, boards.name);

  const activityByDay = await db()
    .select({ day: sql<string>`to_char(date_trunc('day', ${activities.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`, n: sql<number>`count(*)::int` })
    .from(activities)
    .innerJoin(boards, eq(boards.id, activities.boardId))
    .where(and(eq(activities.workspaceId, workspace.id), visibleBoardPredicate(me.id), gte(activities.createdAt, new Date(now.getTime() - 30 * 86400_000)), boardId ? eq(boards.id, boardId) : undefined, projectId ? eq(boards.projectId, projectId) : undefined))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return c.json({ totals, byPriority, byAssignee, byStage, byLabel, trend, releases: releaseProgress, boards: boardProgress, activityByDay, generatedAt: now.toISOString() });
});

/* ===================================================== iCalendar feeds */

function icsEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsDate(d: Date) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
/** Fold lines at 75 octets per RFC 5545. */
function fold(line: string) {
  const out: string[] = [];
  let s = line;
  while (Buffer.byteLength(s) > 75) {
    let cut = 75;
    while (Buffer.byteLength(s.slice(0, cut)) > 75) cut--;
    out.push(s.slice(0, cut));
    s = ' ' + s.slice(cut);
  }
  out.push(s);
  return out.join('\r\n');
}

export const calendarRoutes = new Hono<AppEnv>().get('/:userId/:file', rateLimit('ics', 120, 3600_000, (c) => c.req.param('userId')), async (c) => {
  const userId = c.req.param('userId');
  const file = c.req.param('file');
  if (!file.endsWith('.ics')) throw notFound('Calendar');
  const token = file.slice(0, -4);
  const [u] = await db().select().from(users).where(eq(users.id, userId));
  if (!u?.calendarToken || u.calendarToken !== sha256(token)) throw notFound('Calendar');
  const now = deps().now();
  const rows = await db()
    .select({ id: cards.id, title: cards.title, dueAt: cards.dueAt, startAt: cards.startAt, completedAt: cards.completedAt, boardId: cards.boardId, boardName: boards.name, updatedAt: cards.updatedAt })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(cardAssignees, and(eq(cardAssignees.cardId, cards.id), eq(cardAssignees.userId, u.id)))
    .where(and(isNotNull(cards.dueAt), isNull(cards.archivedAt), isNull(boards.archivedAt), visibleBoardPredicate(u.id), gte(cards.dueAt, new Date(now.getTime() - 60 * 86400_000))))
    .limit(1000);
  const wsIds = (await db().select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, u.id))).map((r) => r.id);
  const rels = wsIds.length ? await db().select().from(releases).where(and(inArray(releases.workspaceId, wsIds), isNotNull(releases.plannedDate))) : [];
  const mils = wsIds.length ? await db().select().from(milestones).where(inArray(milestones.workspaceId, wsIds)) : [];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Alypne//Tasks//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Alypne — my tasks', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const r of rows) {
    const end = r.dueAt!;
    const start = r.startAt && r.startAt < end ? r.startAt : new Date(end.getTime() - 30 * 60_000);
    lines.push('BEGIN:VEVENT', `UID:card-${r.id}@alypne`, `DTSTAMP:${icsDate(r.updatedAt)}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape((r.completedAt ? '✓ ' : '') + r.title)}`, `DESCRIPTION:${icsEscape(`Board: ${r.boardName}`)}`, `URL:${env.appUrl}/b/${r.boardId}/c/${r.id}`, 'END:VEVENT');
  }
  for (const r of rels) {
    const d = r.plannedDate!;
    lines.push('BEGIN:VEVENT', `UID:release-${r.id}@alypne`, `DTSTAMP:${icsDate(r.updatedAt)}`, `DTSTART;VALUE=DATE:${d.toISOString().slice(0, 10).replace(/-/g, '')}`, `SUMMARY:${icsEscape(`Release: ${r.name}${r.version ? ` ${r.version}` : ''}`)}`, `URL:${env.appUrl}/w/${r.workspaceId}/releases/${r.id}`, 'END:VEVENT');
  }
  for (const m of mils) {
    lines.push('BEGIN:VEVENT', `UID:milestone-${m.id}@alypne`, `DTSTAMP:${icsDate(m.createdAt)}`, `DTSTART;VALUE=DATE:${m.date.toISOString().slice(0, 10).replace(/-/g, '')}`, `SUMMARY:${icsEscape(`Milestone: ${m.name}`)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  c.header('Content-Type', 'text/calendar; charset=utf-8');
  c.header('Cache-Control', 'private, max-age=300');
  return c.body(lines.map(fold).join('\r\n') + '\r\n');
});


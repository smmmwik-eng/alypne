import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, isNotNull, sql, ilike, or } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import {
  projects,
  projectMembers,
  releases,
  milestones,
  assets,
  assetCards,
  boards,
  cards,
  lists,
  users,
  bugDetails,
  workspaceMembers,
  activities,
} from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { requireWorkspace, visibleBoardPredicate, assertUsersInWorkspace } from '../lib/access.js';
import { ASSET_CATEGORIES, ASSET_STATUSES, BUG_REPRO, BUG_RESOLUTIONS, BUG_SEVERITIES, PROJECT_STAGES, RELEASE_STATUSES } from '../../shared/constants.js';
import { emit, userActor } from '../lib/events.js';
import { notify } from '../lib/notify.js';
import { ROBLOX_ID, getExperience, universeForPlace } from '../lib/roblox.js';
import { cardSummaries } from '../services/cards.js';
import { rateLimit } from '../lib/rateLimit.js';
import { cardKey } from '../../shared/utils.js';

const robloxId = z.string().trim().regex(ROBLOX_ID, 'Must be a numeric Roblox ID').nullable().optional();
const dateOrNull = z.union([z.string().datetime({ offset: true }), z.null()]).transform((v) => (v ? new Date(v) : null));

async function scoped<T extends { workspaceId: string }>(rows: T[], what: string, userId: string, min: 'viewer' | 'member' | 'admin' = 'viewer') {
  const row = rows[0];
  if (!row) throw notFound(what);
  const access = await requireWorkspace(userId, row.workspaceId, min).catch((e) => {
    if (e.status === 404) throw notFound(what);
    throw e;
  });
  return { row, ...access };
}

/** Card counts for a release/project, restricted to boards the user can see. */
async function progressFor(userId: string, cond: any) {
  const [r] = await db()
    .select({ total: sql<number>`count(*)::int`, done: sql<number>`count(${cards.completedAt})::int` })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(and(cond, isNull(cards.archivedAt), isNull(lists.archivedAt), visibleBoardPredicate(userId)));
  return { total: r.total, done: r.done, percent: r.total ? Math.round((r.done / r.total) * 100) : 0 };
}

async function refreshProjectMeta(projectId: string, universeId: string | null, placeId: string | null) {
  let uni = universeId;
  if (!uni && placeId) uni = await universeForPlace(placeId);
  if (!uni) return null;
  const meta = await getExperience(uni);
  if (!meta) return null;
  await db()
    .update(projects)
    .set({ universeId: uni, placeId: placeId ?? meta.rootPlaceId, thumbnailUrl: meta.iconUrl, robloxMeta: meta as unknown as Record<string, unknown>, updatedAt: deps().now() })
    .where(eq(projects.id, projectId));
  return meta;
}

export const studioRoutes = new Hono<AppEnv>()
  /* ============================================================ projects */
  .get('/workspaces/:id/projects', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const rows = await db()
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspace.id), c.req.query('archived') === 'true' ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt)))
      .orderBy(asc(projects.name));
    const out = [];
    for (const p of rows) {
      const boardCount = await db().select({ n: sql<number>`count(*)::int` }).from(boards).where(and(eq(boards.projectId, p.id), isNull(boards.archivedAt), visibleBoardPredicate(me.id)));
      out.push({ ...p, boardCount: boardCount[0].n, progress: await progressFor(me.id, eq(boards.projectId, p.id)) });
    }
    return c.json({ projects: out });
  })

  .post('/workspaces/:id/projects', rateLimit('project-create', 60, 3600_000), async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(5000).default(''), universeId: robloxId, placeId: robloxId, stage: z.enum(PROJECT_STAGES).default('concept') }));
    const id = newId();
    await db().insert(projects).values({ id, workspaceId: workspace.id, name: input.name, description: input.description, universeId: input.universeId ?? null, placeId: input.placeId ?? null, stage: input.stage, createdById: me.id });
    await db().insert(projectMembers).values({ projectId: id, userId: me.id, title: 'Owner' });
    let warning: string | null = null;
    if (input.universeId || input.placeId) {
      try {
        const meta = await refreshProjectMeta(id, input.universeId ?? null, input.placeId ?? null);
        if (!meta) warning = 'No Roblox experience was found for that ID. You can update it later.';
      } catch (e: any) {
        warning = e?.message ?? 'Could not reach Roblox to fetch experience details.';
      }
    }
    await emit({ type: 'project.created', workspaceId: workspace.id, actor: userActor(me.id), data: { projectId: id, name: input.name } });
    return c.json({ id, warning }, 201);
  })

  .get('/projects/:id', async (c) => {
    const me = requireUser(c);
    const { row: project, role } = await scoped(await db().select().from(projects).where(eq(projects.id, c.req.param('id'))), 'Project', me.id);
    const linkedBoards = await db()
      .select({ id: boards.id, name: boards.name, key: boards.key, background: boards.background, archivedAt: boards.archivedAt })
      .from(boards)
      .where(and(eq(boards.projectId, project.id), visibleBoardPredicate(me.id)))
      .orderBy(asc(boards.name));
    const team = await db()
      .select({ userId: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl, title: projectMembers.title })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, project.id));
    const rels = await db().select().from(releases).where(eq(releases.projectId, project.id)).orderBy(sql`${releases.plannedDate} asc nulls last`);
    const releaseProgress = [];
    for (const r of rels) releaseProgress.push({ ...r, progress: await progressFor(me.id, eq(cards.releaseId, r.id)) });
    const boardIds = linkedBoards.map((b) => b.id);
    const recent = boardIds.length
      ? await db()
          .select({ id: activities.id, type: activities.type, data: activities.data, boardId: activities.boardId, cardId: activities.cardId, createdAt: activities.createdAt, actor: { id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl } })
          .from(activities)
          .leftJoin(users, eq(users.id, activities.actorId))
          .where(inArray(activities.boardId, boardIds))
          .orderBy(desc(activities.createdAt))
          .limit(30)
      : [];
    const mils = await db().select().from(milestones).where(eq(milestones.projectId, project.id)).orderBy(asc(milestones.date));
    const assetCount = await db().select({ n: sql<number>`count(*)::int` }).from(assets).where(eq(assets.projectId, project.id));
    return c.json({ project, role, boards: linkedBoards, team, releases: releaseProgress, milestones: mils, activity: recent, assetCount: assetCount[0].n, progress: await progressFor(me.id, eq(boards.projectId, project.id)) });
  })

  .patch('/projects/:id', async (c) => {
    const me = requireUser(c);
    const { row: project } = await scoped(await db().select().from(projects).where(eq(projects.id, c.req.param('id'))), 'Project', me.id, 'member');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(5000).optional(), universeId: robloxId, placeId: robloxId, stage: z.enum(PROJECT_STAGES).optional(), archived: z.boolean().optional() }));
    const { archived, ...rest } = input;
    await db()
      .update(projects)
      .set({ ...rest, archivedAt: archived === undefined ? undefined : archived ? deps().now() : null, updatedAt: deps().now() })
      .where(eq(projects.id, project.id));
    let warning: string | null = null;
    if ((input.universeId !== undefined && input.universeId !== project.universeId) || (input.placeId !== undefined && input.placeId !== project.placeId)) {
      if (input.universeId || input.placeId) {
        try {
          if (!(await refreshProjectMeta(project.id, input.universeId ?? null, input.placeId ?? null))) warning = 'No Roblox experience was found for that ID.';
        } catch (e: any) {
          warning = e?.message;
        }
      } else await db().update(projects).set({ robloxMeta: null, thumbnailUrl: null }).where(eq(projects.id, project.id));
    }
    return c.json({ ok: true, warning });
  })

  .post('/projects/:id/refresh-roblox', rateLimit('project-refresh', 30, 3600_000), async (c) => {
    const me = requireUser(c);
    const { row: project } = await scoped(await db().select().from(projects).where(eq(projects.id, c.req.param('id'))), 'Project', me.id, 'member');
    if (!project.universeId && !project.placeId) throw badRequest('Add a universe or place ID first');
    const meta = await refreshProjectMeta(project.id, project.universeId, project.placeId);
    if (!meta) throw notFound('Experience');
    return c.json({ experience: meta });
  })

  .delete('/projects/:id', async (c) => {
    const me = requireUser(c);
    const { row: project } = await scoped(await db().select().from(projects).where(eq(projects.id, c.req.param('id'))), 'Project', me.id, 'admin');
    // Boards are kept and simply unlinked (FK set null).
    await db().delete(projects).where(eq(projects.id, project.id));
    return c.json({ ok: true });
  })

  .put('/projects/:id/team', async (c) => {
    const me = requireUser(c);
    const { row: project } = await scoped(await db().select().from(projects).where(eq(projects.id, c.req.param('id'))), 'Project', me.id, 'member');
    const { members } = await body(c, z.object({ members: z.array(z.object({ userId: z.string(), title: z.string().max(60).default('') })).max(100) }));
    await assertUsersInWorkspace(project.workspaceId, members.map((m) => m.userId));
    await db().transaction(async (tx) => {
      await tx.delete(projectMembers).where(eq(projectMembers.projectId, project.id));
      if (members.length) await tx.insert(projectMembers).values(members.map((m) => ({ projectId: project.id, userId: m.userId, title: m.title })));
    });
    return c.json({ ok: true });
  })

  /* ============================================================ releases */
  .get('/workspaces/:id/releases', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const rows = await db()
      .select({ release: releases, projectName: projects.name })
      .from(releases)
      .leftJoin(projects, eq(projects.id, releases.projectId))
      .where(eq(releases.workspaceId, workspace.id))
      .orderBy(sql`${releases.plannedDate} desc nulls first`, desc(releases.createdAt));
    const out = [];
    for (const r of rows) out.push({ ...r.release, projectName: r.projectName, progress: await progressFor(me.id, eq(cards.releaseId, r.release.id)) });
    return c.json({ releases: out });
  })

  .post('/workspaces/:id/releases', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'member');
    const input = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(120), version: z.string().trim().max(60).default(''), description: z.string().max(5000).default(''), plannedDate: dateOrNull.optional(), projectId: z.string().nullable().optional(), status: z.enum(RELEASE_STATUSES).default('planning') }),
    );
    if (input.projectId) {
      const [p] = await db().select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspace.id)));
      if (!p) throw badRequest('Project not found');
    }
    const id = newId();
    await db().insert(releases).values({ id, workspaceId: workspace.id, name: input.name, version: input.version, description: input.description, plannedDate: input.plannedDate ?? null, projectId: input.projectId ?? null, status: input.status, createdById: me.id });
    await emit({ type: 'release.created', workspaceId: workspace.id, actor: userActor(me.id), data: { releaseId: id, releaseName: input.name, version: input.version } });
    return c.json({ id }, 201);
  })

  .get('/releases/:id', async (c) => {
    const me = requireUser(c);
    const { row: release, role } = await scoped(await db().select().from(releases).where(eq(releases.id, c.req.param('id'))), 'Release', me.id);
    const cardIds = (
      await db()
        .select({ id: cards.id })
        .from(cards)
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .where(and(eq(cards.releaseId, release.id), visibleBoardPredicate(me.id)))
    ).map((r) => r.id);
    const summaries = await cardSummaries({ cardIds, includeArchived: false });
    const boardIds = [...new Set(summaries.map((s) => s.boardId))];
    const boardRows = boardIds.length ? await db().select({ id: boards.id, name: boards.name, key: boards.key }).from(boards).where(inArray(boards.id, boardIds)) : [];
    const listIds = [...new Set(summaries.map((s) => s.listId))];
    const listRows = listIds.length ? await db().select({ id: lists.id, name: lists.name }).from(lists).where(inArray(lists.id, listIds)) : [];
    const mils = await db().select().from(milestones).where(eq(milestones.releaseId, release.id)).orderBy(asc(milestones.date));
    const history = await db()
      .select({ id: activities.id, data: activities.data, createdAt: activities.createdAt, actorType: activities.actorType, actor: users.displayName })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.actorId))
      .where(and(eq(activities.workspaceId, release.workspaceId), inArray(activities.type, ['release.statusChanged', 'release.created']), sql`${activities.data}->>'releaseId' = ${release.id}`))
      .orderBy(desc(activities.createdAt));
    const project = release.projectId ? (await db().select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, release.projectId)))[0] ?? null : null;
    return c.json({ release, role, project, cards: summaries, boards: boardRows, lists: listRows, milestones: mils, history, progress: await progressFor(me.id, eq(cards.releaseId, release.id)) });
  })

  .patch('/releases/:id', async (c) => {
    const me = requireUser(c);
    const { row: release, workspace } = await scoped(await db().select().from(releases).where(eq(releases.id, c.req.param('id'))), 'Release', me.id, 'member');
    const input = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(120).optional(), version: z.string().trim().max(60).optional(), description: z.string().max(5000).optional(), notes: z.string().max(50000).optional(), plannedDate: dateOrNull.optional(), status: z.enum(RELEASE_STATUSES).optional(), projectId: z.string().nullable().optional() }),
    );
    if (input.projectId) {
      const [p] = await db().select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspace.id)));
      if (!p) throw badRequest('Project not found');
    }
    await db()
      .update(releases)
      .set({ ...input, releasedAt: input.status === 'released' && release.status !== 'released' ? deps().now() : input.status && input.status !== 'released' ? null : undefined, updatedAt: deps().now() })
      .where(eq(releases.id, release.id));
    if (input.status && input.status !== release.status) {
      await emit({ type: 'release.statusChanged', workspaceId: workspace.id, actor: userActor(me.id), data: { releaseId: release.id, releaseName: release.name, version: release.version, from: release.status, to: input.status } });
      const members = await db().select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspace.id));
      await notify(members.map((m) => m.userId), { type: 'release', title: `${release.name}${release.version ? ` ${release.version}` : ''} is now ${input.status.replace('_', ' ')}`, workspaceId: workspace.id, actorId: me.id, link: `/w/${workspace.id}/releases/${release.id}`, dedupeKey: `release:${release.id}:${input.status}:${deps().now().getTime()}` });
    }
    return c.json({ ok: true });
  })

  /** Draft release notes from completed cards in the release. */
  .post('/releases/:id/generate-notes', async (c) => {
    const me = requireUser(c);
    const { row: release } = await scoped(await db().select().from(releases).where(eq(releases.id, c.req.param('id'))), 'Release', me.id, 'member');
    const rows = await db()
      .select({ title: cards.title, number: cards.number, type: cards.type, key: boards.key })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(eq(cards.releaseId, release.id), isNotNull(cards.completedAt), visibleBoardPredicate(me.id)))
      .orderBy(asc(cards.type), asc(cards.title));
    const features = rows.filter((r) => r.type !== 'bug');
    const bugs = rows.filter((r) => r.type === 'bug');
    const notes = [`# ${release.name}${release.version ? ` (${release.version})` : ''}`, '', release.description, '', features.length ? '## New & improved' : '', ...features.map((f) => `- ${f.title} (${cardKey(f.key, f.number)})`), '', bugs.length ? '## Bug fixes' : '', ...bugs.map((b) => `- ${b.title} (${cardKey(b.key, b.number)})`)]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n')
      .trim();
    return c.json({ notes });
  })

  .delete('/releases/:id', async (c) => {
    const me = requireUser(c);
    const { row: release } = await scoped(await db().select().from(releases).where(eq(releases.id, c.req.param('id'))), 'Release', me.id, 'admin');
    await db().delete(releases).where(eq(releases.id, release.id));
    return c.json({ ok: true });
  })

  /* ========================================================== milestones */
  .get('/workspaces/:id/milestones', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    return c.json({ milestones: await db().select().from(milestones).where(eq(milestones.workspaceId, workspace.id)).orderBy(asc(milestones.date)) });
  })
  .post('/workspaces/:id/milestones', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000).default(''), date: z.string().datetime({ offset: true }), projectId: z.string().nullable().optional(), releaseId: z.string().nullable().optional() }));
    const [row] = await db()
      .insert(milestones)
      .values({ id: newId(), workspaceId: workspace.id, name: input.name, description: input.description, date: new Date(input.date), projectId: input.projectId ?? null, releaseId: input.releaseId ?? null })
      .returning();
    return c.json({ milestone: row }, 201);
  })
  .patch('/milestones/:id', async (c) => {
    const me = requireUser(c);
    const { row } = await scoped(await db().select().from(milestones).where(eq(milestones.id, c.req.param('id'))), 'Milestone', me.id, 'member');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(2000).optional(), date: z.string().datetime({ offset: true }).optional(), completed: z.boolean().optional(), releaseId: z.string().nullable().optional() }));
    await db()
      .update(milestones)
      .set({ name: input.name, description: input.description, date: input.date ? new Date(input.date) : undefined, releaseId: input.releaseId, completedAt: input.completed === undefined ? undefined : input.completed ? deps().now() : null })
      .where(eq(milestones.id, row.id));
    return c.json({ ok: true });
  })
  .delete('/milestones/:id', async (c) => {
    const me = requireUser(c);
    const { row } = await scoped(await db().select().from(milestones).where(eq(milestones.id, c.req.param('id'))), 'Milestone', me.id, 'member');
    await db().delete(milestones).where(eq(milestones.id, row.id));
    return c.json({ ok: true });
  })

  /* ============================================================== assets */
  .get('/workspaces/:id/assets', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const q = c.req.query('q')?.trim();
    const category = c.req.query('category');
    const projectId = c.req.query('projectId');
    const rows = await db()
      .select({ asset: assets, owner: { id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }, projectName: projects.name, cardCount: sql<number>`(select count(*)::int from ${assetCards} ac where ac.asset_id = ${assets.id})` })
      .from(assets)
      .leftJoin(users, eq(users.id, assets.ownerId))
      .leftJoin(projects, eq(projects.id, assets.projectId))
      .where(
        and(
          eq(assets.workspaceId, workspace.id),
          category ? eq(assets.category, category) : undefined,
          projectId ? eq(assets.projectId, projectId) : undefined,
          q ? or(ilike(assets.name, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`), eq(assets.robloxAssetId, q)) : undefined,
        ),
      )
      .orderBy(asc(assets.name));
    return c.json({ assets: rows.map((r) => ({ ...r.asset, owner: r.owner?.id ? r.owner : null, projectName: r.projectName, cardCount: r.cardCount })) });
  })
  .post('/workspaces/:id/assets', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'member');
    const input = await body(c, assetSchema);
    await validateAsset(workspace.id, input);
    const [row] = await db()
      .insert(assets)
      .values({ id: newId(), workspaceId: workspace.id, name: input.name!, category: input.category!, robloxAssetId: input.robloxAssetId ?? null, url: input.url ?? null, description: input.description ?? '', status: input.status ?? 'in_progress', ownerId: input.ownerId ?? me.id, projectId: input.projectId ?? null, tags: input.tags ?? [] })
      .returning();
    return c.json({ asset: row }, 201);
  })
  .get('/assets/:id', async (c) => {
    const me = requireUser(c);
    const { row } = await scoped(await db().select().from(assets).where(eq(assets.id, c.req.param('id'))), 'Asset', me.id);
    const linked = (
      await db()
        .select({ id: cards.id })
        .from(assetCards)
        .innerJoin(cards, eq(cards.id, assetCards.cardId))
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .where(and(eq(assetCards.assetId, row.id), visibleBoardPredicate(me.id)))
    ).map((r) => r.id);
    return c.json({ asset: row, cards: await cardSummaries({ cardIds: linked, includeArchived: true }) });
  })
  .patch('/assets/:id', async (c) => {
    const me = requireUser(c);
    const { row } = await scoped(await db().select().from(assets).where(eq(assets.id, c.req.param('id'))), 'Asset', me.id, 'member');
    const input = await body(c, assetSchema.partial());
    await validateAsset(row.workspaceId, input);
    await db()
      .update(assets)
      .set({ ...input, updatedAt: deps().now() })
      .where(eq(assets.id, row.id));
    return c.json({ ok: true });
  })
  .delete('/assets/:id', async (c) => {
    const me = requireUser(c);
    const { row } = await scoped(await db().select().from(assets).where(eq(assets.id, c.req.param('id'))), 'Asset', me.id, 'member');
    await db().delete(assets).where(eq(assets.id, row.id));
    return c.json({ ok: true });
  })

  /* ================================================================ bugs */
  .get('/workspaces/:id/bugs', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const severity = c.req.query('severity');
    const resolution = c.req.query('resolution');
    const repro = c.req.query('repro');
    const platform = c.req.query('platform');
    const boardId = c.req.query('boardId');
    const rows = await db()
      .select({ id: cards.id, bug: bugDetails })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .innerJoin(bugDetails, eq(bugDetails.cardId, cards.id))
      .where(
        and(
          eq(boards.workspaceId, workspace.id),
          visibleBoardPredicate(me.id),
          isNull(cards.archivedAt),
          isNull(lists.archivedAt),
          boardId ? eq(cards.boardId, boardId) : undefined,
          severity && (BUG_SEVERITIES as readonly string[]).includes(severity) ? eq(bugDetails.severity, severity) : undefined,
          resolution && (BUG_RESOLUTIONS as readonly string[]).includes(resolution) ? eq(bugDetails.resolution, resolution) : undefined,
          repro && (BUG_REPRO as readonly string[]).includes(repro) ? eq(bugDetails.reproStatus, repro) : undefined,
          platform ? sql`${bugDetails.platforms} ? ${platform}` : undefined,
        ),
      )
      .orderBy(desc(cards.createdAt))
      .limit(500);
    const summaries = await cardSummaries({ cardIds: rows.map((r) => r.id) });
    const bmap = new Map(rows.map((r) => [r.id, r.bug]));
    const boardIds = [...new Set(summaries.map((s) => s.boardId))];
    const listIds = [...new Set(summaries.map((s) => s.listId))];
    return c.json({
      bugs: summaries.map((s) => ({ ...s, details: bmap.get(s.id) })),
      boards: boardIds.length ? await db().select({ id: boards.id, name: boards.name, key: boards.key }).from(boards).where(inArray(boards.id, boardIds)) : [],
      lists: listIds.length ? await db().select({ id: lists.id, name: lists.name }).from(lists).where(inArray(lists.id, listIds)) : [],
    });
  });

const assetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(ASSET_CATEGORIES),
  robloxAssetId: robloxId,
  url: z.string().url().max(2000).nullable().optional(),
  description: z.string().max(5000).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  ownerId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
});

async function validateAsset(workspaceId: string, input: Partial<z.infer<typeof assetSchema>>) {
  if (input.ownerId) await assertUsersInWorkspace(workspaceId, [input.ownerId]);
  if (input.projectId) {
    const [p] = await db().select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)));
    if (!p) throw badRequest('Project not found');
  }
  if (input.url && !/^https?:\/\//i.test(input.url)) throw badRequest('Links must start with http:// or https://');
}

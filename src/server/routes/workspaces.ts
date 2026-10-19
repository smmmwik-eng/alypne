import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, isNotNull, gte, lte } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import {
  workspaces,
  workspaceMembers,
  users,
  invitations,
  specialisations,
  memberSpecialisations,
  workflowStages,
  boards,
  boardMembers,
  boardFavorites,
  activities,
  auditLogs,
  cards,
  lists,
  projects,
  releases,
  cardAssignees,
  externalAccounts,
} from '../db/schema.js';
import { type AppEnv, audit, requireUser } from '../lib/auth.js';
import { newId, randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { requireWorkspace, visibleBoardPredicate } from '../lib/access.js';
import { DEFAULT_SPECIALISATIONS, DEFAULT_WORKFLOW, STAGE_CATEGORIES, workspaceRoleAtLeast, type WorkspaceRole } from '../../shared/constants.js';
import { POSITION_STEP, slugify } from '../../shared/utils.js';
import { emit, userActor } from '../lib/events.js';
import { notify } from '../lib/notify.js';
import { emailLayout, sendMail, mailConfigured } from '../lib/mailer.js';
import { env } from '../env.js';
import { rateLimit } from '../lib/rateLimit.js';
import { classifyUpload, putObject } from '../lib/storage.js';
import { publishUser } from '../lib/realtime.js';
import { cardSummaries } from '../services/cards.js';

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #7c6cf2');

export async function createWorkspace(userId: string, input: { name: string; description?: string; color?: string }) {
  const id = newId();
  let slug = slugify(input.name);
  const [clash] = await db().select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug));
  if (clash) slug = `${slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  await db().transaction(async (tx) => {
    await tx.insert(workspaces).values({ id, name: input.name, slug, description: input.description ?? '', color: input.color ?? '#7c6cf2', createdById: userId, settings: { defaultBoardVisibility: 'workspace', membersCanCreateBoards: true, membersCanInvite: false } });
    await tx.insert(workspaceMembers).values({ workspaceId: id, userId, role: 'owner' });
    await tx.insert(workflowStages).values(DEFAULT_WORKFLOW.map((s, i) => ({ id: newId(), workspaceId: id, name: s.name, category: s.category, color: s.color, position: (i + 1) * POSITION_STEP })));
    await tx.insert(specialisations).values(DEFAULT_SPECIALISATIONS.map((s, i) => ({ id: newId(), workspaceId: id, name: s.name, color: s.color, position: (i + 1) * POSITION_STEP })));
  });
  await emit({ type: 'workspace.created', workspaceId: id, actor: userActor(userId), data: { name: input.name } });
  return id;
}

async function memberRows(workspaceId: string) {
  const rows = await db()
    .select({ userId: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl, role: workspaceMembers.role, joinedAt: workspaceMembers.joinedAt })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(users.displayName));
  const ids = rows.map((r) => r.userId);
  const specs = ids.length
    ? await db()
        .select({ userId: memberSpecialisations.userId, specialisationId: memberSpecialisations.specialisationId })
        .from(memberSpecialisations)
        .innerJoin(specialisations, eq(specialisations.id, memberSpecialisations.specialisationId))
        .where(and(eq(specialisations.workspaceId, workspaceId), inArray(memberSpecialisations.userId, ids)))
    : [];
  const roblox = ids.length
    ? await db().select({ userId: externalAccounts.userId, username: externalAccounts.username, providerUserId: externalAccounts.providerUserId, avatarUrl: externalAccounts.avatarUrl }).from(externalAccounts).where(and(eq(externalAccounts.provider, 'roblox'), inArray(externalAccounts.userId, ids)))
    : [];
  return rows.map((r) => ({
    ...r,
    specialisationIds: specs.filter((s) => s.userId === r.userId).map((s) => s.specialisationId),
    roblox: roblox.find((x) => x.userId === r.userId) ?? null,
  }));
}

async function invitationEmail(ws: { name: string }, inviterName: string, email: string, link: string) {
  const { html, text } = emailLayout({
    heading: `Join ${ws.name} on Alypne`,
    body: `${inviterName} invited you to collaborate in the ${ws.name} workspace.`,
    actionLabel: 'Accept invitation',
    actionUrl: link,
    footer: 'If you were not expecting this invitation you can ignore this email.',
  });
  await sendMail({ to: email, subject: `${inviterName} invited you to ${ws.name} on Alypne`, html, text });
}

export const workspaceRoutes = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    requireUser(c);
    await next();
  })

  .get('/', async (c) => {
    const me = requireUser(c);
    const rows = await db()
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        description: workspaces.description,
        logoUrl: workspaces.logoUrl,
        color: workspaces.color,
        archivedAt: workspaces.archivedAt,
        role: workspaceMembers.role,
        memberCount: sql<number>`(select count(*)::int from ${workspaceMembers} m2 where m2.workspace_id = ${workspaces.id})`,
      })
      .from(workspaces)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, me.id)))
      .orderBy(asc(workspaces.name));
    return c.json({ workspaces: rows });
  })

  .post('/', rateLimit('ws-create', 20, 3600_000), async (c) => {
    const me = requireUser(c);
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(1000).optional(), color: colorSchema.optional() }));
    const id = await createWorkspace(me.id, input);
    await audit(c, { workspaceId: id, action: 'workspace.created', targetType: 'workspace', targetId: id });
    return c.json({ id }, 201);
  })

  .get('/:id', async (c) => {
    const me = requireUser(c);
    const { workspace, role } = await requireWorkspace(me.id, c.req.param('id'));
    const [members, stages, specs] = await Promise.all([
      memberRows(workspace.id),
      db().select().from(workflowStages).where(eq(workflowStages.workspaceId, workspace.id)).orderBy(asc(workflowStages.position)),
      db().select().from(specialisations).where(eq(specialisations.workspaceId, workspace.id)).orderBy(asc(specialisations.position)),
    ]);
    return c.json({ workspace, role, members, stages, specialisations: specs });
  })

  .patch('/:id', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(1000).optional(),
        color: colorSchema.optional(),
        logoUrl: z.null().optional(),
        settings: z.object({ defaultBoardVisibility: z.enum(['private', 'workspace']).optional(), membersCanCreateBoards: z.boolean().optional(), membersCanInvite: z.boolean().optional() }).optional(),
      }),
    );
    await db()
      .update(workspaces)
      .set({ ...input, settings: input.settings ? { ...workspace.settings, ...input.settings } : undefined, updatedAt: deps().now() })
      .where(eq(workspaces.id, workspace.id));
    await audit(c, { workspaceId: workspace.id, action: 'workspace.updated', data: { fields: Object.keys(input) } });
    return c.json({ ok: true });
  })

  .post('/:id/logo', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('Attach an image');
    if (file.size > 2 * 1024 * 1024) throw badRequest('Logos must be 2 MB or smaller');
    const data = new Uint8Array(await file.arrayBuffer());
    const kind = classifyUpload(file.name, data);
    if ('error' in kind || !kind.isImage) throw badRequest('Logo must be a PNG, JPEG, GIF or WebP image');
    const name = `${workspace.id}-${randomToken(6)}`;
    await putObject(`avatars/${name}`, data);
    const url = `/api/public/avatars/${name}`;
    await db().update(workspaces).set({ logoUrl: url }).where(eq(workspaces.id, workspace.id));
    return c.json({ logoUrl: url });
  })

  .post('/:id/archive', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'owner');
    const { archived } = await body(c, z.object({ archived: z.boolean() }));
    await db().update(workspaces).set({ archivedAt: archived ? deps().now() : null }).where(eq(workspaces.id, workspace.id));
    await audit(c, { workspaceId: workspace.id, action: archived ? 'workspace.archived' : 'workspace.restored' });
    return c.json({ ok: true });
  })

  .delete('/:id', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'owner');
    const { confirmName } = await body(c, z.object({ confirmName: z.string() }));
    if (confirmName.trim() !== workspace.name) throw badRequest('Type the workspace name exactly to confirm deletion');
    const members = await db().select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspace.id));
    await audit(c, { workspaceId: null, action: 'workspace.deleted', targetId: workspace.id, data: { name: workspace.name } });
    await db().delete(workspaces).where(eq(workspaces.id, workspace.id));
    for (const m of members) publishUser(m.userId, { type: 'workspace.changed', workspaceId: workspace.id });
    return c.json({ ok: true });
  })

  .post('/:id/transfer', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'owner');
    const { userId } = await body(c, z.object({ userId: z.string() }));
    if (userId === me.id) throw badRequest('You already own this workspace');
    const [target] = await db().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)));
    if (!target) throw badRequest('The new owner must already be a member');
    await db().transaction(async (tx) => {
      await tx.update(workspaceMembers).set({ role: 'owner' }).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)));
      await tx.update(workspaceMembers).set({ role: 'admin' }).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, me.id)));
    });
    await audit(c, { workspaceId: workspace.id, action: 'workspace.ownership_transferred', targetType: 'user', targetId: userId });
    await notify([userId], { type: 'workspace_change', title: `You are now the owner of ${workspace.name}`, workspaceId: workspace.id, actorId: me.id, link: `/w/${workspace.id}` });
    return c.json({ ok: true });
  })

  /* ------------------------------------------------------------ members */
  .get('/:id/members', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    return c.json({ members: await memberRows(workspace.id) });
  })

  .patch('/:id/members/:userId', async (c) => {
    const me = requireUser(c);
    const { workspace, role: myRole } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const targetId = c.req.param('userId');
    const { role } = await body(c, z.object({ role: z.enum(['admin', 'member', 'viewer']) }));
    if (targetId === me.id) throw badRequest('You cannot change your own role');
    const [target] = await db().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, targetId)));
    if (!target) throw notFound('Member');
    if (target.role === 'owner') throw forbidden('Owners cannot be changed. Use ownership transfer instead.');
    if ((target.role === 'admin' || role === 'admin') && myRole !== 'owner') throw forbidden('Only the owner can manage administrators');
    await db().update(workspaceMembers).set({ role }).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, targetId)));
    await audit(c, { workspaceId: workspace.id, action: 'workspace.member_role_changed', targetType: 'user', targetId, data: { from: target.role, to: role } });
    await emit({ type: 'workspace.member.roleChanged', workspaceId: workspace.id, actor: userActor(me.id), data: { userId: targetId, from: target.role, to: role } });
    await notify([targetId], { type: 'workspace_change', title: `Your role in ${workspace.name} is now ${role}`, workspaceId: workspace.id, actorId: me.id, link: `/w/${workspace.id}` });
    publishUser(targetId, { type: 'workspace.changed', workspaceId: workspace.id });
    return c.json({ ok: true });
  })

  .delete('/:id/members/:userId', async (c) => {
    const me = requireUser(c);
    const targetId = c.req.param('userId');
    const self = targetId === me.id;
    const { workspace, role: myRole } = await requireWorkspace(me.id, c.req.param('id'), self ? 'viewer' : 'admin');
    const [target] = await db().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, targetId)));
    if (!target) throw notFound('Member');
    if (target.role === 'owner') {
      const owners = await db().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.role, 'owner')));
      if (owners.length <= 1) throw forbidden(self ? 'Transfer ownership before leaving this workspace' : 'The owner cannot be removed');
      if (!self) throw forbidden('Owners cannot remove other owners');
    }
    if (!self && target.role === 'admin' && myRole !== 'owner') throw forbidden('Only the owner can remove administrators');
    await db().transaction(async (tx) => {
      await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, targetId)));
      const wsBoards = tx.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, workspace.id));
      await tx.delete(boardMembers).where(and(eq(boardMembers.userId, targetId), inArray(boardMembers.boardId, wsBoards)));
      await tx.delete(boardFavorites).where(and(eq(boardFavorites.userId, targetId), inArray(boardFavorites.boardId, wsBoards)));
      await tx.delete(cardAssignees).where(and(eq(cardAssignees.userId, targetId), inArray(cardAssignees.cardId, tx.select({ id: cards.id }).from(cards).innerJoin(boards, eq(boards.id, cards.boardId)).where(eq(boards.workspaceId, workspace.id)))));
    });
    await audit(c, { workspaceId: workspace.id, action: self ? 'workspace.member_left' : 'workspace.member_removed', targetType: 'user', targetId });
    await emit({ type: self ? 'workspace.member.left' : 'workspace.member.removed', workspaceId: workspace.id, actor: userActor(me.id), data: { userId: targetId } });
    publishUser(targetId, { type: 'workspace.changed', workspaceId: workspace.id });
    return c.json({ ok: true });
  })

  .put('/:id/members/:userId/specialisations', async (c) => {
    const me = requireUser(c);
    const targetId = c.req.param('userId');
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), targetId === me.id ? 'member' : 'admin');
    const { specialisationIds } = await body(c, z.object({ specialisationIds: z.array(z.string()).max(20) }));
    const valid = await db().select({ id: specialisations.id }).from(specialisations).where(eq(specialisations.workspaceId, workspace.id));
    const validIds = new Set(valid.map((v) => v.id));
    if (specialisationIds.some((s) => !validIds.has(s))) throw badRequest('Unknown specialisation');
    const [member] = await db().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, targetId)));
    if (!member) throw notFound('Member');
    await db().transaction(async (tx) => {
      if (valid.length) await tx.delete(memberSpecialisations).where(and(eq(memberSpecialisations.userId, targetId), inArray(memberSpecialisations.specialisationId, [...validIds])));
      if (specialisationIds.length) await tx.insert(memberSpecialisations).values(specialisationIds.map((s) => ({ specialisationId: s, userId: targetId })));
    });
    return c.json({ ok: true });
  })

  /* -------------------------------------------------------- invitations */
  .get('/:id/invitations', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const rows = await db()
      .select({ id: invitations.id, email: invitations.email, role: invitations.role, maxUses: invitations.maxUses, uses: invitations.uses, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt, invitedBy: users.displayName })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedById))
      .where(and(eq(invitations.workspaceId, workspace.id), isNull(invitations.revokedAt), gt(invitations.expiresAt, deps().now())))
      .orderBy(desc(invitations.createdAt));
    return c.json({ invitations: rows.filter((r) => r.uses < r.maxUses) });
  })

  .post('/:id/invitations', rateLimit('invite', 60, 3600_000), async (c) => {
    const me = requireUser(c);
    const wsId = c.req.param('id');
    const { workspace, role: myRole } = await requireWorkspace(me.id, wsId, 'member');
    if (!workspaceRoleAtLeast(myRole, 'admin') && !workspace.settings.membersCanInvite) throw forbidden('Only admins can invite people to this workspace');
    const input = await body(
      c,
      z.object({
        email: z.string().trim().toLowerCase().email().max(254).optional(),
        role: z.enum(['admin', 'member', 'viewer']).default('member'),
        maxUses: z.number().int().min(1).max(100).default(1),
        expiresInDays: z.number().int().min(1).max(30).default(7),
      }),
    );
    if (input.role === 'admin' && myRole !== 'owner') throw forbidden('Only the owner can invite administrators');
    if (!workspaceRoleAtLeast(myRole, 'admin') && input.role !== 'member' && input.role !== 'viewer') throw forbidden();
    if (input.email) {
      const [already] = await db()
        .select({ id: users.id })
        .from(users)
        .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, workspace.id)))
        .where(sql`lower(${users.email}) = ${input.email}`);
      if (already) throw conflict('That person is already a member');
    }
    const token = randomToken(24);
    const id = newId();
    await db()
      .insert(invitations)
      .values({ id, workspaceId: workspace.id, email: input.email ?? null, role: input.role, tokenHash: sha256(token), invitedById: me.id, maxUses: input.email ? 1 : input.maxUses, expiresAt: new Date(deps().now().getTime() + input.expiresInDays * 86400_000) });
    const link = `${env.appUrl}/invite/${token}`;
    if (input.email) {
      await invitationEmail(workspace, me.displayName, input.email, link);
      const [existing] = await db().select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email}`);
      if (existing) await notify([existing.id], { type: 'invitation', title: `${me.displayName} invited you to ${workspace.name}`, link: `/invite/${token}`, workspaceId: workspace.id, actorId: me.id, dedupeKey: `invite:${id}` });
    }
    await audit(c, { workspaceId: workspace.id, action: 'workspace.invitation_created', targetId: id, data: { role: input.role, email: input.email ?? null } });
    return c.json({ id, link, emailed: !!input.email && mailConfigured() }, 201);
  })

  .delete('/:id/invitations/:invId', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    await db().update(invitations).set({ revokedAt: deps().now() }).where(and(eq(invitations.id, c.req.param('invId')), eq(invitations.workspaceId, workspace.id)));
    await audit(c, { workspaceId: workspace.id, action: 'workspace.invitation_revoked', targetId: c.req.param('invId') });
    return c.json({ ok: true });
  })

  /* ---------------------------------------------------- specialisations */
  .post('/:id/specialisations', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(40), color: colorSchema }));
    const [row] = await db().insert(specialisations).values({ id: newId(), workspaceId: workspace.id, name: input.name, color: input.color, position: Date.now() }).returning();
    return c.json({ specialisation: row }, 201);
  })
  .patch('/:id/specialisations/:sid', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(40).optional(), color: colorSchema.optional() }));
    await db().update(specialisations).set(input).where(and(eq(specialisations.id, c.req.param('sid')), eq(specialisations.workspaceId, workspace.id)));
    return c.json({ ok: true });
  })
  .delete('/:id/specialisations/:sid', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    await db().delete(specialisations).where(and(eq(specialisations.id, c.req.param('sid')), eq(specialisations.workspaceId, workspace.id)));
    return c.json({ ok: true });
  })

  /* ---------------------------------------------------- workflow stages */
  .post('/:id/stages', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(40), category: z.enum(STAGE_CATEGORIES), color: colorSchema }));
    const [last] = await db().select({ p: workflowStages.position }).from(workflowStages).where(eq(workflowStages.workspaceId, workspace.id)).orderBy(desc(workflowStages.position)).limit(1);
    const [row] = await db().insert(workflowStages).values({ id: newId(), workspaceId: workspace.id, ...input, position: (last?.p ?? 0) + POSITION_STEP }).returning();
    return c.json({ stage: row }, 201);
  })
  .patch('/:id/stages/:sid', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(40).optional(), category: z.enum(STAGE_CATEGORIES).optional(), color: colorSchema.optional(), position: z.number().finite().optional() }));
    await db().update(workflowStages).set(input).where(and(eq(workflowStages.id, c.req.param('sid')), eq(workflowStages.workspaceId, workspace.id)));
    return c.json({ ok: true });
  })
  .delete('/:id/stages/:sid', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    await db().delete(workflowStages).where(and(eq(workflowStages.id, c.req.param('sid')), eq(workflowStages.workspaceId, workspace.id)));
    return c.json({ ok: true });
  })

  /* ------------------------------------------------------------ boards */
  .get('/:id/boards', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const archived = c.req.query('archived') === 'true';
    const rows = await db()
      .select({
        id: boards.id,
        name: boards.name,
        key: boards.key,
        description: boards.description,
        background: boards.background,
        visibility: boards.visibility,
        projectId: boards.projectId,
        archivedAt: boards.archivedAt,
        updatedAt: boards.updatedAt,
        favorite: sql<boolean>`exists (select 1 from ${boardFavorites} f where f.board_id = ${boards.id} and f.user_id = ${me.id})`,
        openCards: sql<number>`(select count(*)::int from ${cards} c where c.board_id = ${boards.id} and c.archived_at is null and c.completed_at is null)`,
      })
      .from(boards)
      .where(and(eq(boards.workspaceId, workspace.id), archived ? isNotNull(boards.archivedAt) : isNull(boards.archivedAt), visibleBoardPredicate(me.id)))
      .orderBy(asc(boards.name));
    return c.json({ boards: rows });
  })

  /* ----------------------------------------------------------- activity */
  .get('/:id/activity', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const before = c.req.query('before');
    const limit = Math.min(100, Number(c.req.query('limit') ?? 40) || 40);
    const rows = await db()
      .select({
        id: activities.id,
        type: activities.type,
        data: activities.data,
        boardId: activities.boardId,
        cardId: activities.cardId,
        actorType: activities.actorType,
        createdAt: activities.createdAt,
        actor: { id: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl },
        boardName: boards.name,
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.actorId))
      .leftJoin(boards, eq(boards.id, activities.boardId))
      .where(
        and(
          eq(activities.workspaceId, workspace.id),
          // Activity on boards the viewer can't see is never returned.
          or(isNull(activities.boardId), visibleBoardPredicate(me.id)),
          before ? lt(activities.createdAt, new Date(before)) : undefined,
        ),
      )
      .orderBy(desc(activities.createdAt))
      .limit(limit);
    return c.json({ activities: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null });
  })

  .get('/:id/audit', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const rows = await db()
      .select({ id: auditLogs.id, action: auditLogs.action, targetType: auditLogs.targetType, targetId: auditLogs.targetId, data: auditLogs.data, createdAt: auditLogs.createdAt, ip: auditLogs.ip, user: users.displayName })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(eq(auditLogs.workspaceId, workspace.id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);
    return c.json({ entries: rows });
  })

  /* ---------------------------------------------------------- dashboard */
  .get('/:id/dashboard', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const now = deps().now();
    const week = new Date(now.getTime() + 7 * 86400_000);
    const visible = and(eq(boards.workspaceId, workspace.id), isNull(boards.archivedAt), visibleBoardPredicate(me.id), isNull(cards.archivedAt), isNull(lists.archivedAt));
    const ids = async (cond: any, limit = 20) =>
      (
        await db()
          .select({ id: cards.id })
          .from(cards)
          .innerJoin(boards, eq(boards.id, cards.boardId))
          .innerJoin(lists, eq(lists.id, cards.listId))
          .where(and(visible, cond))
          .orderBy(sql`${cards.dueAt} asc nulls last`)
          .limit(limit)
      ).map((r) => r.id);
    const mine = sql`exists (select 1 from ${cardAssignees} ca where ca.card_id = ${cards.id} and ca.user_id = ${me.id})`;
    const [assigned, upcoming, overdue] = await Promise.all([
      ids(and(mine, isNull(cards.completedAt))),
      ids(and(isNull(cards.completedAt), gte(cards.dueAt, now), lte(cards.dueAt, week))),
      ids(and(isNull(cards.completedAt), lt(cards.dueAt, now))),
    ]);
    const summaries = await cardSummaries({ cardIds: [...new Set([...assigned, ...upcoming, ...overdue])] });
    const [totals] = await db()
      .select({ open: sql<number>`count(*) filter (where ${cards.completedAt} is null)::int`, done: sql<number>`count(*) filter (where ${cards.completedAt} is not null)::int` })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(visible);
    const projectRows = await db().select().from(projects).where(and(eq(projects.workspaceId, workspace.id), isNull(projects.archivedAt)));
    const projectProgress = [];
    for (const p of projectRows) {
      const [r] = await db()
        .select({ total: sql<number>`count(*)::int`, done: sql<number>`count(${cards.completedAt})::int` })
        .from(cards)
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(lists, eq(lists.id, cards.listId))
        .where(and(visible, eq(boards.projectId, p.id)));
      projectProgress.push({ id: p.id, name: p.name, stage: p.stage, thumbnailUrl: p.thumbnailUrl, total: r.total, done: r.done });
    }
    const releaseRows = await db()
      .select()
      .from(releases)
      .where(and(eq(releases.workspaceId, workspace.id), inArray(releases.status, ['planning', 'in_progress', 'testing'])))
      .orderBy(sql`${releases.plannedDate} asc nulls last`)
      .limit(6);
    const releaseProgress = [];
    for (const r of releaseRows) {
      const [x] = await db()
        .select({ total: sql<number>`count(*)::int`, done: sql<number>`count(${cards.completedAt})::int` })
        .from(cards)
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(lists, eq(lists.id, cards.listId))
        .where(and(visible, eq(cards.releaseId, r.id)));
      releaseProgress.push({ id: r.id, name: r.name, version: r.version, status: r.status, plannedDate: r.plannedDate, total: x.total, done: x.done });
    }
    const boardRows = await db().select({ id: boards.id, name: boards.name, key: boards.key, background: boards.background }).from(boards).where(and(eq(boards.workspaceId, workspace.id), visibleBoardPredicate(me.id)));
    return c.json({ cards: summaries, sections: { assigned, upcoming, overdue }, totals, projects: projectProgress, releases: releaseProgress, boards: boardRows });
  });

/* ---------------------------------------------------- invitation accept */

export const invitationRoutes = new Hono<AppEnv>()
  .get('/:token', rateLimit('invite-view', 60, 3600_000), async (c) => {
    const [inv] = await db()
      .select({ id: invitations.id, role: invitations.role, email: invitations.email, expiresAt: invitations.expiresAt, revokedAt: invitations.revokedAt, uses: invitations.uses, maxUses: invitations.maxUses, workspaceName: workspaces.name, workspaceColor: workspaces.color, workspaceLogo: workspaces.logoUrl, invitedBy: users.displayName })
      .from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .leftJoin(users, eq(users.id, invitations.invitedById))
      .where(eq(invitations.tokenHash, sha256(c.req.param('token'))));
    if (!inv || inv.revokedAt || inv.expiresAt <= deps().now() || inv.uses >= inv.maxUses) throw notFound('Invitation');
    return c.json({ invitation: { role: inv.role, workspaceName: inv.workspaceName, workspaceColor: inv.workspaceColor, workspaceLogo: inv.workspaceLogo, invitedBy: inv.invitedBy, emailRestricted: !!inv.email } });
  })
  .post('/:token/accept', rateLimit('invite-accept', 30, 3600_000), async (c) => {
    const me = requireUser(c);
    const now = deps().now();
    const [inv] = await db().select().from(invitations).where(eq(invitations.tokenHash, sha256(c.req.param('token'))));
    if (!inv || inv.revokedAt || inv.expiresAt <= now || inv.uses >= inv.maxUses) throw notFound('Invitation');
    if (inv.email && inv.email.toLowerCase() !== me.email.toLowerCase()) throw forbidden('This invitation was sent to a different email address');
    const [existing] = await db().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, inv.workspaceId), eq(workspaceMembers.userId, me.id)));
    if (existing) return c.json({ workspaceId: inv.workspaceId, alreadyMember: true });
    // Atomically consume one use so a single-use link can't be redeemed twice concurrently.
    const [consumed] = await db()
      .update(invitations)
      .set({ uses: sql`${invitations.uses} + 1` })
      .where(and(eq(invitations.id, inv.id), lt(invitations.uses, invitations.maxUses)))
      .returning();
    if (!consumed) throw notFound('Invitation');
    await db().insert(workspaceMembers).values({ workspaceId: inv.workspaceId, userId: me.id, role: inv.role as WorkspaceRole }).onConflictDoNothing();
    await audit(c, { workspaceId: inv.workspaceId, action: 'workspace.member_joined', targetType: 'user', targetId: me.id, data: { role: inv.role } });
    await emit({ type: 'workspace.member.joined', workspaceId: inv.workspaceId, actor: userActor(me.id), data: { userId: me.id, userName: me.displayName, role: inv.role } });
    const admins = await db().select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, inv.workspaceId), inArray(workspaceMembers.role, ['owner', 'admin'])));
    await notify(admins.map((a) => a.userId), { type: 'workspace_change', title: `${me.displayName} joined the workspace`, workspaceId: inv.workspaceId, actorId: me.id, link: `/w/${inv.workspaceId}/members`, dedupeKey: `joined:${inv.workspaceId}:${me.id}` });
    return c.json({ workspaceId: inv.workspaceId });
  });

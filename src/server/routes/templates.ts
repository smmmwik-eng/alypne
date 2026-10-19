import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull, or, desc } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { templates, workflowStages, projects, releases, automationRules, lists, labels, customFields } from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { requireBoard, requireCard, requireWorkspace } from '../lib/access.js';
import { createBoardFromBlueprint, type BoardBlueprint } from '../services/boards.js';
import { addChecklist, createCard } from '../services/cards.js';
import { userActor, emit } from '../lib/events.js';
import { BUILTIN_TEMPLATES } from '../templates/builtin.js';
import { POSITION_STEP } from '../../shared/utils.js';
import { STAGE_CATEGORIES, workspaceRoleAtLeast } from '../../shared/constants.js';
import { computeNextRun } from '../jobs/schedule.js';
import { ACTION_TYPES, CONDITION_TYPES, TRIGGER_TYPES } from '../../shared/automation.js';

const KINDS = ['board', 'card', 'checklist', 'workflow', 'automation', 'project', 'release'] as const;

const dataSchemas: Record<(typeof KINDS)[number], z.ZodType> = {
  board: z.object({
    description: z.string().max(5000).optional(),
    background: z.string().optional(),
    labels: z.array(z.object({ name: z.string().max(60), color: z.string() })).max(50),
    customFields: z.array(z.object({ name: z.string().max(60), type: z.string(), options: z.array(z.object({ id: z.string(), label: z.string(), color: z.string().optional() })).optional(), showOnCard: z.boolean().optional() })).max(30).optional(),
    lists: z.array(z.object({ name: z.string().max(120), stage: z.string().nullable().optional(), wipLimit: z.number().nullable().optional(), cards: z.array(z.any()).max(500).optional() })).max(50),
    automations: z.array(z.any()).max(50).optional(),
  }),
  card: z.object({ title: z.string().optional(), description: z.string().max(50000).optional(), priority: z.string().optional(), type: z.enum(['task', 'bug']).optional(), labels: z.array(z.string()).optional(), checklists: z.array(z.object({ title: z.string(), items: z.array(z.string()) })).optional() }),
  checklist: z.object({ title: z.string().max(200), items: z.array(z.string().max(1000)).max(200) }),
  workflow: z.object({ stages: z.array(z.object({ name: z.string().min(1).max(40), category: z.enum(STAGE_CATEGORIES), color: z.string() })).min(1).max(20) }),
  automation: z.object({
    name: z.string().max(120),
    trigger: z.object({ type: z.string().refine((t) => TRIGGER_TYPES.includes(t)), params: z.record(z.string(), z.unknown()) }),
    conditions: z.array(z.object({ type: z.string().refine((t) => CONDITION_TYPES.includes(t)), params: z.record(z.string(), z.unknown()) })),
    actions: z.array(z.object({ type: z.string().refine((t) => ACTION_TYPES.includes(t)), params: z.record(z.string(), z.unknown()) })),
  }),
  project: z.object({ stage: z.string().optional(), description: z.string().optional(), boards: z.array(z.string()).max(10) }),
  release: z.object({ version: z.string().max(60).optional(), description: z.string().max(5000).optional(), tasks: z.array(z.string().max(500)).max(100).optional() }),
};

export async function seedBuiltinTemplates() {
  for (const t of BUILTIN_TEMPLATES) {
    await db()
      .insert(templates)
      .values({ id: newId(), slug: t.slug, workspaceId: null, kind: t.kind, name: t.name, description: t.description, category: t.category, data: t.data })
      .onConflictDoUpdate({ target: templates.slug, set: { name: t.name, description: t.description, category: t.category, data: t.data, kind: t.kind, updatedAt: deps().now() } });
  }
}

async function loadTemplate(userId: string, id: string) {
  const [t] = await db().select().from(templates).where(eq(templates.id, id));
  if (!t) throw notFound('Template');
  if (t.workspaceId) await requireWorkspace(userId, t.workspaceId).catch(() => {
    throw notFound('Template');
  });
  return t;
}

/** Resolve a name-referenced automation blueprint against a board's lists/labels/fields. Missing refs leave the rule disabled for review. */
async function instantiateAutomation(boardId: string, workspaceId: string, userId: string, data: any, userTz: string) {
  const ls = await db().select().from(lists).where(eq(lists.boardId, boardId));
  const lbs = await db().select().from(labels).where(eq(labels.boardId, boardId));
  const fs = await db().select().from(customFields).where(eq(customFields.boardId, boardId));
  let complete = true;
  const map = (params: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...params };
    for (const k of ['listId', 'toListId']) {
      if (k in out) {
        const v = out[k];
        const hit = typeof v === 'string' ? (ls.find((l) => l.id === v) ?? ls.find((l) => l.name === v)) : undefined;
        out[k] = hit?.id ?? null;
        if (!hit && k === 'listId') complete = false;
      }
    }
    if ('labelId' in out) {
      const v = out.labelId;
      const hit = typeof v === 'string' ? (lbs.find((l) => l.id === v) ?? lbs.find((l) => l.name === v)) : undefined;
      out.labelId = hit?.id ?? null;
      if (!hit) complete = false;
    }
    if ('fieldId' in out) {
      const v = out.fieldId;
      const hit = typeof v === 'string' ? (fs.find((f) => f.id === v) ?? fs.find((f) => f.name === v)) : undefined;
      out.fieldId = hit?.id ?? null;
      if (!hit) complete = false;
    }
    if ('userId' in out && !out.userId) complete = false;
    return out;
  };
  const trigger = { type: data.trigger.type, params: map(data.trigger.params ?? {}) };
  // Trigger filters are optional: an unresolved trigger list just means "any list".
  const rule = {
    id: newId(),
    workspaceId,
    boardId,
    name: String(data.name ?? 'Automation'),
    trigger,
    conditions: (data.conditions ?? []).map((c: any) => ({ type: c.type, params: map(c.params ?? {}) })),
    actions: (data.actions ?? []).map((a: any) => ({ type: a.type, params: map(a.params ?? {}) })),
    createdById: userId,
  };
  const enabled = complete;
  await db()
    .insert(automationRules)
    .values({ ...rule, enabled, nextRunAt: enabled && trigger.type === 'schedule' ? computeNextRun(trigger.params as any, String(trigger.params.timezone ?? userTz), deps().now()) : null });
  return { ruleId: rule.id, enabled };
}

export const templateRoutes = new Hono<AppEnv>()
  .get('/workspaces/:id/templates', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const kind = c.req.query('kind');
    const rows = await db()
      .select({ id: templates.id, slug: templates.slug, kind: templates.kind, name: templates.name, description: templates.description, category: templates.category, workspaceId: templates.workspaceId, createdById: templates.createdById, updatedAt: templates.updatedAt, data: templates.data })
      .from(templates)
      .where(and(or(isNull(templates.workspaceId), eq(templates.workspaceId, workspace.id)), kind ? eq(templates.kind, kind) : undefined))
      .orderBy(asc(templates.kind), desc(templates.workspaceId), asc(templates.name));
    return c.json({ templates: rows.map((t) => ({ ...t, builtIn: !t.workspaceId })) });
  })

  .post('/workspaces/:id/templates', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'member');
    const input = await body(c, z.object({ kind: z.enum(KINDS), name: z.string().trim().min(1).max(120), description: z.string().max(1000).default(''), category: z.string().max(40).default('custom'), data: z.unknown() }));
    const data = dataSchemas[input.kind].parse(input.data) as Record<string, unknown>;
    const [row] = await db().insert(templates).values({ id: newId(), workspaceId: workspace.id, kind: input.kind, name: input.name, description: input.description, category: input.category, data, createdById: me.id }).returning();
    return c.json({ template: row }, 201);
  })

  .patch('/templates/:id', async (c) => {
    const me = requireUser(c);
    const t = await loadTemplate(me.id, c.req.param('id'));
    if (!t.workspaceId) throw forbidden('Built-in templates cannot be edited. Duplicate it to make changes.');
    const { role } = await requireWorkspace(me.id, t.workspaceId, 'member');
    if (t.createdById !== me.id && !workspaceRoleAtLeast(role, 'admin')) throw forbidden('Only the creator or an admin can edit this template');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(1000).optional(), category: z.string().max(40).optional(), data: z.unknown().optional() }));
    const data = input.data !== undefined ? (dataSchemas[t.kind as (typeof KINDS)[number]].parse(input.data) as Record<string, unknown>) : undefined;
    const [row] = await db().update(templates).set({ name: input.name, description: input.description, category: input.category, data, updatedAt: deps().now() }).where(eq(templates.id, t.id)).returning();
    return c.json({ template: row });
  })

  .delete('/templates/:id', async (c) => {
    const me = requireUser(c);
    const t = await loadTemplate(me.id, c.req.param('id'));
    if (!t.workspaceId) throw forbidden('Built-in templates cannot be deleted');
    const { role } = await requireWorkspace(me.id, t.workspaceId, 'member');
    if (t.createdById !== me.id && !workspaceRoleAtLeast(role, 'admin')) throw forbidden('Only the creator or an admin can delete this template');
    await db().delete(templates).where(eq(templates.id, t.id));
    return c.json({ ok: true });
  })

  .post('/templates/:id/duplicate', async (c) => {
    const me = requireUser(c);
    const t = await loadTemplate(me.id, c.req.param('id'));
    const { workspaceId, name } = await body(c, z.object({ workspaceId: z.string(), name: z.string().trim().min(1).max(120).optional() }));
    await requireWorkspace(me.id, workspaceId, 'member');
    const [row] = await db()
      .insert(templates)
      .values({ id: newId(), workspaceId, kind: t.kind, name: name ?? `${t.name} (copy)`, description: t.description, category: 'custom', data: t.data, createdById: me.id })
      .returning();
    return c.json({ template: row }, 201);
  })

  /** Apply a template: always creates real database entities. */
  .post('/templates/:id/apply', async (c) => {
    const me = requireUser(c);
    const t = await loadTemplate(me.id, c.req.param('id'));
    const input = await body(c, z.object({ workspaceId: z.string(), name: z.string().trim().min(1).max(120).optional(), boardId: z.string().optional(), listId: z.string().optional(), cardId: z.string().optional(), projectId: z.string().nullable().optional() }));
    if (t.workspaceId && t.workspaceId !== input.workspaceId) throw badRequest('Template belongs to another workspace');
    const actor = userActor(me.id);
    const d = t.data as any;
    switch (t.kind) {
      case 'board': {
        await requireWorkspace(me.id, input.workspaceId, 'member');
        const id = await createBoardFromBlueprint(actor, { workspaceId: input.workspaceId, name: input.name ?? t.name, projectId: input.projectId ?? null }, d as BoardBlueprint);
        return c.json({ kind: 'board', boardId: id }, 201);
      }
      case 'card': {
        if (!input.boardId || !input.listId) throw badRequest('Choose a board and list');
        const { board } = await requireBoard(me.id, input.boardId, 'member');
        const lbs = await db().select().from(labels).where(eq(labels.boardId, board.id));
        const card = await createCard(actor, {
          boardId: board.id,
          listId: input.listId,
          title: input.name ?? d.title ?? t.name,
          description: d.description,
          priority: d.priority,
          type: d.type,
          labelIds: (d.labels ?? []).map((n: string) => lbs.find((l) => l.name === n)?.id).filter(Boolean),
          checklists: d.checklists,
        });
        return c.json({ kind: 'card', cardId: card.id, boardId: board.id }, 201);
      }
      case 'checklist': {
        if (!input.cardId) throw badRequest('Choose a card');
        const { card } = await requireCard(me.id, input.cardId, 'member');
        const cl = await addChecklist(actor, card, d.title ?? t.name, d.items ?? []);
        return c.json({ kind: 'checklist', checklistId: cl.id, cardId: card.id }, 201);
      }
      case 'workflow': {
        const { workspace } = await requireWorkspace(me.id, input.workspaceId, 'admin');
        const existing = await db().select().from(workflowStages).where(eq(workflowStages.workspaceId, workspace.id));
        let pos = Math.max(0, ...existing.map((s) => s.position));
        const added = [];
        for (const s of d.stages ?? []) {
          if (existing.some((e) => e.name.toLowerCase() === String(s.name).toLowerCase())) continue;
          pos += POSITION_STEP;
          const [row] = await db().insert(workflowStages).values({ id: newId(), workspaceId: workspace.id, name: s.name, category: s.category, color: s.color, position: pos }).returning();
          added.push(row);
        }
        return c.json({ kind: 'workflow', added: added.length }, 201);
      }
      case 'automation': {
        if (!input.boardId) throw badRequest('Choose a board');
        const { board } = await requireBoard(me.id, input.boardId, 'member');
        const res = await instantiateAutomation(board.id, board.workspaceId, me.id, d, me.timezone);
        return c.json({ kind: 'automation', ...res, boardId: board.id }, 201);
      }
      case 'project': {
        const { workspace } = await requireWorkspace(me.id, input.workspaceId, 'member');
        const projectId = newId();
        await db().insert(projects).values({ id: projectId, workspaceId: workspace.id, name: input.name ?? t.name, description: d.description ?? '', stage: d.stage ?? 'concept', createdById: me.id });
        const boardIds = [];
        for (const slug of d.boards ?? []) {
          const [bt] = await db().select().from(templates).where(eq(templates.slug, slug));
          if (!bt) continue;
          boardIds.push(await createBoardFromBlueprint(actor, { workspaceId: workspace.id, name: `${input.name ?? t.name} · ${bt.name}`, projectId }, bt.data as unknown as BoardBlueprint));
        }
        return c.json({ kind: 'project', projectId, boardIds }, 201);
      }
      case 'release': {
        const { workspace } = await requireWorkspace(me.id, input.workspaceId, 'member');
        const releaseId = newId();
        await db().insert(releases).values({ id: releaseId, workspaceId: workspace.id, projectId: input.projectId ?? null, name: input.name ?? t.name, version: d.version ?? '', description: d.description ?? '', createdById: me.id });
        let created = 0;
        if (input.boardId && input.listId && Array.isArray(d.tasks)) {
          const { board } = await requireBoard(me.id, input.boardId, 'member');
          if (board.workspaceId !== workspace.id) throw badRequest('Board is in another workspace');
          for (const title of d.tasks) {
            await createCard(actor, { boardId: board.id, listId: input.listId, title, releaseId });
            created++;
          }
        }
        await emit({ type: 'release.created', workspaceId: workspace.id, actor, data: { releaseId, releaseName: input.name ?? t.name } });
        return c.json({ kind: 'release', releaseId, cardsCreated: created }, 201);
      }
    }
    throw badRequest('Unsupported template');
  });


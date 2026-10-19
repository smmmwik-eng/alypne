import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { automationRules, automationExecutions, templates, users } from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { requireBoard, requireCard } from '../lib/access.js';
import { ACTION_TYPES, CARDLESS_ACTIONS, CARDLESS_TRIGGERS, CONDITION_TYPES, TRIGGER_TYPES } from '../../shared/automation.js';
import { LIMITS } from '../../shared/constants.js';
import { executeRule, validateRuleReferences } from '../jobs/automation.js';
import { computeNextRun } from '../jobs/schedule.js';
import { isValidTimezone } from './auth.js';
import { boardToBlueprint } from '../services/boards.js';

const stepSchema = (types: string[]) =>
  z.object({ type: z.string().refine((t) => types.includes(t), 'Unknown step type'), params: z.record(z.string(), z.unknown()).default({}) });

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: stepSchema(TRIGGER_TYPES),
  conditions: z.array(stepSchema(CONDITION_TYPES)).max(LIMITS.automationConditionsMax).default([]),
  actions: z.array(stepSchema(ACTION_TYPES)).min(1, 'Add at least one action').max(LIMITS.automationActionsMax),
});

function validateShape(rule: z.infer<typeof ruleSchema>) {
  const cardless = CARDLESS_TRIGGERS.has(rule.trigger.type);
  if (cardless) {
    if (rule.conditions.length) throw badRequest('Scheduled and release triggers have no card, so card conditions cannot be used');
    const bad = rule.actions.find((a) => !CARDLESS_ACTIONS.has(a.type));
    if (bad) throw badRequest(`“${bad.type}” needs a card. With this trigger use Create card, Send notification or Change release status.`);
  }
  if (rule.trigger.type === 'schedule') {
    const p = rule.trigger.params as { time?: string; weekdays?: number[]; timezone?: string };
    if (!/^\d{1,2}:\d{2}$/.test(p.time ?? '')) throw badRequest('Choose a time for the schedule (HH:MM)');
    if (p.weekdays && (!Array.isArray(p.weekdays) || p.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) throw badRequest('Invalid weekdays');
    if (p.timezone && !isValidTimezone(p.timezone)) throw badRequest('Unknown timezone');
  }
  if (rule.trigger.type === 'due.approaching') {
    const h = Number(rule.trigger.params.hours);
    if (!Number.isFinite(h) || h < 1 || h > 720) throw badRequest('Hours before due must be between 1 and 720');
  }
  for (const a of rule.actions) {
    const p = a.params;
    const need = (k: string) => {
      if (p[k] === undefined || p[k] === null || p[k] === '') throw badRequest(`${a.type}: ${k} is required`);
    };
    if (['moveCard', 'createCard'].includes(a.type)) need('listId');
    if (['assignMember', 'unassignMember'].includes(a.type)) need('userId');
    if (['addLabel', 'removeLabel'].includes(a.type)) need('labelId');
    if (a.type === 'setCustomField') need('fieldId');
    if (a.type === 'setReleaseStatus') {
      need('releaseId');
      need('status');
    }
    if (a.type === 'addComment') need('text');
    if (a.type === 'setPriority') need('priority');
  }
}

async function nextRunFor(rule: { trigger: { type: string; params: Record<string, unknown> } }, userTz: string) {
  if (rule.trigger.type !== 'schedule') return null;
  const tz = String(rule.trigger.params.timezone ?? userTz);
  return computeNextRun(rule.trigger.params as any, tz, deps().now());
}

async function loadRule(userId: string, id: string, min: 'member' | 'admin' = 'member') {
  const [rule] = await db().select().from(automationRules).where(eq(automationRules.id, id));
  if (!rule || !rule.boardId) throw notFound('Rule');
  const access = await requireBoard(userId, rule.boardId, 'observer').catch(() => {
    throw notFound('Rule');
  });
  if (access.role === 'observer') throw forbidden();
  if (min === 'admin' && access.role !== 'admin' && rule.createdById !== userId) throw forbidden('Only the rule creator or a board admin can change this rule');
  return { rule, ...access };
}

export const automationRoutes = new Hono<AppEnv>()
  .get('/boards/:boardId/automations', async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('boardId'));
    const rules = await db()
      .select({ rule: automationRules, creator: users.displayName })
      .from(automationRules)
      .leftJoin(users, eq(users.id, automationRules.createdById))
      .where(eq(automationRules.boardId, board.id))
      .orderBy(desc(automationRules.createdAt));
    return c.json({ rules: rules.map((r) => ({ ...r.rule, creatorName: r.creator })) });
  })

  .post('/automations', async (c) => {
    const me = requireUser(c);
    const input = await body(c, ruleSchema.extend({ boardId: z.string() }));
    const { board } = await requireBoard(me.id, input.boardId, 'member');
    validateShape(input);
    const refError = await validateRuleReferences(board.id, board.workspaceId, [input.trigger, ...input.conditions, ...input.actions]);
    if (refError) throw badRequest(refError);
    const [rule] = await db()
      .insert(automationRules)
      .values({ id: newId(), workspaceId: board.workspaceId, boardId: board.id, name: input.name, enabled: input.enabled, trigger: input.trigger, conditions: input.conditions, actions: input.actions, createdById: me.id, nextRunAt: await nextRunFor(input, me.timezone) })
      .returning();
    return c.json({ rule }, 201);
  })

  .patch('/automations/:id', async (c) => {
    const me = requireUser(c);
    const { rule, board } = await loadRule(me.id, c.req.param('id'), 'admin');
    const input = await body(c, ruleSchema.partial());
    const merged = { name: input.name ?? rule.name, enabled: input.enabled ?? rule.enabled, trigger: input.trigger ?? rule.trigger, conditions: input.conditions ?? rule.conditions, actions: input.actions ?? rule.actions };
    validateShape(merged as z.infer<typeof ruleSchema>);
    const refError = await validateRuleReferences(board.id, board.workspaceId, [merged.trigger, ...merged.conditions, ...merged.actions]);
    if (refError) throw badRequest(refError);
    const [updated] = await db()
      .update(automationRules)
      .set({ ...merged, nextRunAt: merged.enabled ? await nextRunFor(merged, me.timezone) : null, updatedAt: deps().now() })
      .where(eq(automationRules.id, rule.id))
      .returning();
    return c.json({ rule: updated });
  })

  .delete('/automations/:id', async (c) => {
    const me = requireUser(c);
    const { rule } = await loadRule(me.id, c.req.param('id'), 'admin');
    await db().delete(automationRules).where(eq(automationRules.id, rule.id));
    return c.json({ ok: true });
  })

  .get('/automations/:id/executions', async (c) => {
    const me = requireUser(c);
    const { rule } = await loadRule(me.id, c.req.param('id'));
    const rows = await db().select().from(automationExecutions).where(eq(automationExecutions.ruleId, rule.id)).orderBy(desc(automationExecutions.createdAt)).limit(50);
    return c.json({ executions: rows });
  })

  /** Run a rule now — against a chosen card for card triggers, or without a card for scheduled rules. */
  .post('/automations/:id/run', async (c) => {
    const me = requireUser(c);
    const { rule } = await loadRule(me.id, c.req.param('id'));
    const { cardId } = await body(c, z.object({ cardId: z.string().optional() }));
    const cardless = CARDLESS_TRIGGERS.has(rule.trigger.type);
    if (!cardless) {
      if (!cardId) throw badRequest('Choose a card to run this rule on');
      const { card } = await requireCard(me.id, cardId, 'member');
      if (card.boardId !== rule.boardId) throw badRequest('Card is not on this board');
    }
    const status = await executeRule(rule, { eventKey: `manual:${newId()}`, cardId: cardless ? null : cardId!, event: { type: 'manual', by: me.id } });
    const [exec] = await db().select().from(automationExecutions).where(eq(automationExecutions.ruleId, rule.id)).orderBy(desc(automationExecutions.createdAt)).limit(1);
    return c.json({ status, execution: exec });
  })

  /** Retry a failed execution. Allowed only for failures; creates a new attempt with the same event key. */
  .post('/automation-executions/:id/retry', async (c) => {
    const me = requireUser(c);
    const [exec] = await db().select().from(automationExecutions).where(eq(automationExecutions.id, c.req.param('id')));
    if (!exec) throw notFound('Execution');
    const { rule } = await loadRule(me.id, exec.ruleId);
    if (exec.status !== 'failed') throw badRequest('Only failed runs can be retried');
    const [latest] = await db()
      .select({ attempt: automationExecutions.attempt })
      .from(automationExecutions)
      .where(and(eq(automationExecutions.ruleId, rule.id), eq(automationExecutions.eventKey, exec.eventKey)))
      .orderBy(desc(automationExecutions.attempt))
      .limit(1);
    if (latest.attempt !== exec.attempt) throw badRequest('A newer attempt already exists for this event');
    const status = await executeRule(rule, { eventKey: exec.eventKey, cardId: exec.cardId, event: exec.event, attempt: exec.attempt + 1 });
    return c.json({ status });
  })

  .post('/automations/:id/save-as-template', async (c) => {
    const me = requireUser(c);
    const { rule, board } = await loadRule(me.id, c.req.param('id'));
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(120) }));
    const bp = await boardToBlueprint(board.id, { includeCards: false, includeAutomations: true });
    const mapped = bp.automations?.find((a) => a.name === rule.name) ?? { name: rule.name, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions };
    const [row] = await db().insert(templates).values({ id: newId(), workspaceId: board.workspaceId, kind: 'automation', name, category: 'custom', data: mapped as unknown as Record<string, unknown>, createdById: me.id }).returning();
    return c.json({ template: row }, 201);
  });

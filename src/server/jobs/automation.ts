import { and, asc, eq, gte, inArray, isNull, lte, or, sql, lt, gt, isNotNull } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import {
  automationRules,
  automationExecutions,
  cards,
  lists,
  labels,
  cardLabels,
  cardAssignees,
  cardWatchers,
  customFields,
  customFieldValues,
  workflowStages,
  releases,
  boardMembers,
  users,
  boards,
} from '../db/schema.js';
import { newId } from '../lib/crypto.js';
import type { Actor, DomainEvent } from '../lib/events.js';
import { emit } from '../lib/events.js';
import { boardAccess } from '../lib/access.js';
import { notify } from '../lib/notify.js';
import {
  addChecklist,
  addComment,
  addLabel,
  archiveCard,
  assign,
  createCard,
  moveCard,
  removeLabel,
  setCustomFieldValue,
  unassign,
  updateCard,
} from '../services/cards.js';
import { LIMITS, boardRoleAtLeast, type Priority } from '../../shared/constants.js';
import { CARDLESS_TRIGGERS } from '../../shared/automation.js';
import { registerJob } from './queue.js';
import { computeNextRun } from './schedule.js';

type Rule = typeof automationRules.$inferSelect;
type Step = { type: string; params: Record<string, unknown> };

class SkipRule extends Error {}

/* ------------------------------------------------------------ triggers */

function triggerMatches(rule: Rule, ev: DomainEvent): boolean {
  const p = rule.trigger.params ?? {};
  const d = ev.data ?? {};
  switch (rule.trigger.type) {
    case 'card.created':
      return !p.listId || p.listId === d.listId;
    case 'card.moved':
      return !p.toListId || p.toListId === d.toListId;
    case 'label.added':
    case 'label.removed':
      return !p.labelId || p.labelId === d.labelId;
    case 'member.assigned':
    case 'member.removed':
      return !p.userId || p.userId === d.userId;
    case 'customField.changed':
      return !p.fieldId || p.fieldId === d.fieldId;
    case 'release.statusChanged':
      return !p.status || p.status === d.to;
    default:
      return true;
  }
}

/* ---------------------------------------------------------- conditions */

async function conditionHolds(cond: Step, cardId: string | null): Promise<boolean> {
  const p = cond.params ?? {};
  if (!cardId) return false;
  const [card] = await db().select().from(cards).where(eq(cards.id, cardId));
  if (!card) return false;
  switch (cond.type) {
    case 'inList':
      return card.listId === p.listId;
    case 'hasLabel':
    case 'notHasLabel': {
      const [row] = await db().select().from(cardLabels).where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, String(p.labelId))));
      return cond.type === 'hasLabel' ? !!row : !row;
    }
    case 'assignedTo': {
      const [row] = await db().select().from(cardAssignees).where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, String(p.userId))));
      return !!row;
    }
    case 'unassigned': {
      const [row] = await db().select().from(cardAssignees).where(eq(cardAssignees.cardId, cardId)).limit(1);
      return !row;
    }
    case 'priorityIs':
      return card.priority === p.priority;
    case 'dueWithin': {
      if (!card.dueAt) return false;
      const days = Number(p.days ?? 0);
      const now = deps().now().getTime();
      return card.dueAt.getTime() >= now && card.dueAt.getTime() <= now + days * 86400_000;
    }
    case 'hasNoDueDate':
      return !card.dueAt;
    case 'customFieldEquals': {
      const [v] = await db().select().from(customFieldValues).where(and(eq(customFieldValues.cardId, cardId), eq(customFieldValues.fieldId, String(p.fieldId))));
      return String(v?.value ?? '') === String(p.value ?? '');
    }
    case 'statusIs': {
      if (p.category === 'done' && card.completedAt) return true;
      const [row] = await db().select({ category: workflowStages.category }).from(lists).leftJoin(workflowStages, eq(workflowStages.id, lists.stageId)).where(eq(lists.id, card.listId));
      return (row?.category ?? 'todo') === p.category;
    }
    case 'titleContains':
      return card.title.toLowerCase().includes(String(p.text ?? '').toLowerCase());
  }
  return false;
}

/* ------------------------------------------------------------- actions */

function interpolate(text: string, ctx: { cardTitle?: string; date: Date }) {
  return text.replace(/\{card\}/g, ctx.cardTitle ?? '').replace(/\{date\}/g, ctx.date.toISOString().slice(0, 10));
}

async function runAction(action: Step, rule: Rule, actor: Actor, cardId: string | null, log: string[]) {
  const p = action.params ?? {};
  const [card] = cardId ? await db().select().from(cards).where(eq(cards.id, cardId)) : [];
  const needCard = () => {
    if (!card) throw new Error(`Action “${action.type}” needs a card, but this trigger has none`);
    if (card.archivedAt && action.type !== 'archiveCard') throw new SkipRule('Card is archived');
    return card;
  };
  const ctx = { cardTitle: card?.title, date: deps().now() };
  switch (action.type) {
    case 'moveCard': {
      const c = needCard();
      if (c.listId === p.listId) return log.push('Card already in target list');
      await moveCard(actor, c.id, { listId: String(p.listId), index: 0 });
      return log.push('Moved card');
    }
    case 'createCard': {
      const [list] = await db().select().from(lists).where(eq(lists.id, String(p.listId)));
      if (!list || list.boardId !== rule.boardId) throw new Error('Target list no longer exists on this board');
      const created = await createCard(actor, { boardId: list.boardId, listId: list.id, title: interpolate(String(p.title ?? 'New card'), ctx) || 'New card' });
      return log.push(`Created card “${created.title}”`);
    }
    case 'assignMember': {
      const c = needCard();
      await assign(actor, c.id, String(p.userId));
      return log.push('Assigned member');
    }
    case 'unassignMember': {
      const c = needCard();
      await unassign(actor, c.id, String(p.userId));
      return log.push('Removed member');
    }
    case 'addLabel': {
      const c = needCard();
      await addLabel(actor, c.id, String(p.labelId));
      return log.push('Added label');
    }
    case 'removeLabel': {
      const c = needCard();
      await removeLabel(actor, c.id, String(p.labelId));
      return log.push('Removed label');
    }
    case 'setPriority': {
      const c = needCard();
      await updateCard(actor, c.id, { priority: p.priority as Priority });
      return log.push(`Set priority to ${p.priority}`);
    }
    case 'setCustomField': {
      const c = needCard();
      await setCustomFieldValue(actor, c.id, String(p.fieldId), p.value);
      return log.push('Updated custom field');
    }
    case 'addChecklist': {
      const c = needCard();
      const items = String(p.items ?? '').split(/\r?\n/).filter((x) => x.trim());
      await addChecklist(actor, c, String(p.title ?? 'Checklist'), items);
      return log.push(`Added checklist with ${items.length} item(s)`);
    }
    case 'addComment': {
      const c = needCard();
      await addComment(actor, c.id, interpolate(String(p.text ?? ''), ctx));
      return log.push('Added comment');
    }
    case 'markComplete': {
      const c = needCard();
      await updateCard(actor, c.id, { completed: true });
      return log.push('Marked complete');
    }
    case 'archiveCard': {
      const c = needCard();
      await archiveCard(actor, c.id, true);
      return log.push('Archived card');
    }
    case 'notify': {
      const target = String(p.target ?? 'assignees');
      let recipients: string[] = [];
      if (target === 'assignees' && card) recipients = (await db().select({ u: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, card.id))).map((r) => r.u);
      else if (target === 'watchers' && card) recipients = (await db().select({ u: cardWatchers.userId }).from(cardWatchers).where(eq(cardWatchers.cardId, card.id))).map((r) => r.u);
      else if (target === 'creator' && card?.createdById) recipients = [card.createdById];
      else if (target === 'board_admins' && rule.boardId) recipients = (await db().select({ u: boardMembers.userId }).from(boardMembers).where(and(eq(boardMembers.boardId, rule.boardId), eq(boardMembers.role, 'admin')))).map((r) => r.u);
      else if (target.startsWith('user:')) recipients = [target.slice(5)];
      const n = await notify(recipients, {
        type: 'automation',
        title: `${rule.name}: ${interpolate(String(p.message ?? 'Automation notification'), ctx)}`.slice(0, 280),
        workspaceId: rule.workspaceId,
        boardId: rule.boardId,
        cardId: card?.id ?? null,
        // Automation notifications are delivered even to the rule owner.
        actorId: null,
        dedupeKey: `auto-notify:${rule.id}:${card?.id ?? 'none'}:${ctx.date.getTime()}`,
      });
      return log.push(`Sent ${n} notification(s)`);
    }
    case 'setReleaseStatus': {
      const [rel] = await db().select().from(releases).where(and(eq(releases.id, String(p.releaseId)), eq(releases.workspaceId, rule.workspaceId)));
      if (!rel) throw new Error('Release not found');
      if (rel.status === p.status) return log.push('Release already in that status');
      await db()
        .update(releases)
        .set({ status: String(p.status), releasedAt: p.status === 'released' ? deps().now() : rel.releasedAt, updatedAt: deps().now() })
        .where(eq(releases.id, rel.id));
      await emit({ type: 'release.statusChanged', workspaceId: rule.workspaceId, actor, data: { releaseId: rel.id, releaseName: rel.name, version: rel.version, from: rel.status, to: p.status } });
      return log.push(`Release ${rel.name} → ${p.status}`);
    }
  }
  throw new Error(`Unknown action ${action.type}`);
}

/* ------------------------------------------------------------ executor */

export async function executeRule(rule: Rule, opts: { eventKey: string; cardId: string | null; parentActor?: Actor; event?: Record<string, unknown>; attempt?: number }): Promise<'success' | 'skipped' | 'failed' | 'duplicate'> {
  const attempt = opts.attempt ?? 1;
  const execId = newId();
  // Claim the (rule, event, attempt) slot first; a duplicate delivery is a no-op.
  const claimed = await db()
    .insert(automationExecutions)
    .values({ id: execId, ruleId: rule.id, eventKey: opts.eventKey, status: 'running', cardId: opts.cardId, event: opts.event ?? {}, attempt })
    .onConflictDoNothing()
    .returning({ id: automationExecutions.id });
  if (!claimed.length) return 'duplicate';

  const log: string[] = [];
  const finish = async (status: 'success' | 'skipped' | 'failed', error?: string) => {
    await db().update(automationExecutions).set({ status, log, error: error ?? null }).where(eq(automationExecutions.id, execId));
    await db().update(automationRules).set({ lastRunAt: deps().now() }).where(eq(automationRules.id, rule.id));
    return status;
  };

  try {
    // Rate limit per rule.
    const [recent] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(automationExecutions)
      .where(and(eq(automationExecutions.ruleId, rule.id), gte(automationExecutions.createdAt, new Date(deps().now().getTime() - 3600_000)), inArray(automationExecutions.status, ['success', 'failed'])));
    if (recent.n >= LIMITS.automationRunsPerRulePerHour) return finish('skipped', `Rate limit reached (${LIMITS.automationRunsPerRulePerHour} runs/hour). The rule will resume automatically.`);

    // The rule acts with its creator's permissions, re-checked on every run.
    if (!rule.createdById) return finish('failed', 'The rule owner no longer exists. Ask a board admin to recreate this rule.');
    if (rule.boardId) {
      const access = await boardAccess(rule.createdById, rule.boardId);
      if (!access || !boardRoleAtLeast(access.role, 'member')) return finish('failed', 'The rule owner no longer has edit access to this board.');
      if (access.board.archivedAt) return finish('skipped', 'Board is archived');
    }
    if (opts.cardId) {
      const [card] = await db().select({ boardId: cards.boardId }).from(cards).where(eq(cards.id, opts.cardId));
      if (!card) return finish('skipped', 'Card no longer exists');
      if (rule.boardId && card.boardId !== rule.boardId) return finish('skipped', 'Card is on a different board');
    }

    for (const cond of rule.conditions) {
      if (!(await conditionHolds(cond, opts.cardId))) {
        log.push(`Condition not met: ${cond.type}`);
        return finish('skipped');
      }
    }
    const actor: Actor = { type: 'automation', userId: rule.createdById, depth: (opts.parentActor?.depth ?? 0) + 1, ruleId: rule.id };
    for (const action of rule.actions) await runAction(action, rule, actor, opts.cardId, log);
    return finish('success');
  } catch (e: any) {
    if (e instanceof SkipRule) {
      log.push(e.message);
      return finish('skipped');
    }
    const message = String(e?.message ?? e).slice(0, 500);
    log.push(`Error: ${message}`);
    await finish('failed', message);
    if (rule.createdById) {
      await notify([rule.createdById], {
        type: 'automation',
        title: `Automation “${rule.name}” failed`,
        body: message,
        workspaceId: rule.workspaceId,
        boardId: rule.boardId,
        link: rule.boardId ? `/b/${rule.boardId}?panel=automation` : null,
        dedupeKey: `auto-fail:${execId}`,
      });
    }
    return 'failed';
  }
}

export async function handleEvent(eventId: string, ev: DomainEvent) {
  if (ev.actor.depth >= LIMITS.automationDepthMax) return;
  const rules = await db()
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.workspaceId, ev.workspaceId),
        eq(automationRules.enabled, true),
        sql`${automationRules.trigger}->>'type' = ${ev.type}`,
        ev.type === 'release.statusChanged' ? undefined : ev.boardId ? or(eq(automationRules.boardId, ev.boardId), isNull(automationRules.boardId)) : isNull(automationRules.boardId),
      ),
    )
    .orderBy(asc(automationRules.createdAt));
  for (const rule of rules) {
    // A rule never re-triggers itself directly.
    if (ev.actor.ruleId === rule.id) continue;
    if (!triggerMatches(rule, ev)) continue;
    const cardId = CARDLESS_TRIGGERS.has(rule.trigger.type) ? null : (ev.cardId ?? null);
    await executeRule(rule, { eventKey: `event:${eventId}`, cardId, parentActor: ev.actor, event: { type: ev.type, data: ev.data ?? {} } });
  }
}

/** Time-based triggers: due approaching / due passed. Event keys make each card fire once per due date. */
export async function runDueTriggers(now: Date) {
  const rules = await db()
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.enabled, true), isNotNull(automationRules.boardId), sql`${automationRules.trigger}->>'type' in ('due.approaching','due.passed')`));
  for (const rule of rules) {
    const base = and(eq(cards.boardId, rule.boardId!), isNull(cards.archivedAt), isNull(cards.completedAt), isNotNull(cards.dueAt));
    let rows: { id: string; dueAt: Date | null }[];
    if (rule.trigger.type === 'due.approaching') {
      const hours = Math.max(1, Math.min(24 * 30, Number(rule.trigger.params.hours ?? 24)));
      rows = await db().select({ id: cards.id, dueAt: cards.dueAt }).from(cards).where(and(base, gt(cards.dueAt, now), lte(cards.dueAt, new Date(now.getTime() + hours * 3600_000)))).limit(200);
    } else {
      rows = await db().select({ id: cards.id, dueAt: cards.dueAt }).from(cards).where(and(base, lt(cards.dueAt, now), gt(cards.dueAt, new Date(now.getTime() - 3 * 86400_000)))).limit(200);
    }
    for (const r of rows) {
      await executeRule(rule, { eventKey: `${rule.trigger.type}:${r.id}:${r.dueAt!.toISOString()}`, cardId: r.id, event: { type: rule.trigger.type } });
    }
  }
}

export async function runScheduledRules(now: Date) {
  const due = await db()
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.enabled, true), isNotNull(automationRules.nextRunAt), lte(automationRules.nextRunAt, now)));
  for (const rule of due) {
    const scheduledFor = rule.nextRunAt!;
    const tz = String(rule.trigger.params.timezone ?? (await creatorTimezone(rule.createdById)));
    const next = computeNextRun(rule.trigger.params as any, tz, new Date(Math.max(now.getTime(), scheduledFor.getTime())));
    // Advance first (compare-and-set) so concurrent workers can't double-run a slot.
    const moved = await db()
      .update(automationRules)
      .set({ nextRunAt: next })
      .where(and(eq(automationRules.id, rule.id), eq(automationRules.nextRunAt, scheduledFor)))
      .returning({ id: automationRules.id });
    if (!moved.length) continue;
    await executeRule(rule, { eventKey: `schedule:${scheduledFor.toISOString()}`, cardId: null, event: { type: 'schedule', scheduledFor: scheduledFor.toISOString() } });
  }
}

async function creatorTimezone(userId: string | null): Promise<string> {
  if (!userId) return 'UTC';
  const [u] = await db().select({ tz: users.timezone }).from(users).where(eq(users.id, userId));
  return u?.tz ?? 'UTC';
}

/* -------------------------------------------------------- validation */

/** Check every referenced list/label/field/member/release belongs to the rule's board/workspace. */
export async function validateRuleReferences(boardId: string, workspaceId: string, steps: Step[]): Promise<string | null> {
  const boardLists = new Set((await db().select({ id: lists.id }).from(lists).where(eq(lists.boardId, boardId))).map((r) => r.id));
  const boardLabels = new Set((await db().select({ id: labels.id }).from(labels).where(eq(labels.boardId, boardId))).map((r) => r.id));
  const fields = await db().select().from(customFields).where(eq(customFields.boardId, boardId));
  const rels = new Set((await db().select({ id: releases.id }).from(releases).where(eq(releases.workspaceId, workspaceId))).map((r) => r.id));
  for (const s of steps) {
    const p = s.params ?? {};
    for (const k of ['listId', 'toListId']) if (p[k] != null && p[k] !== '' && !boardLists.has(String(p[k]))) return `${s.type}: list not found on this board`;
    if (p.labelId != null && p.labelId !== '' && !boardLabels.has(String(p.labelId))) return `${s.type}: label not found on this board`;
    if (p.fieldId != null && p.fieldId !== '' && !fields.some((f) => f.id === p.fieldId)) return `${s.type}: custom field not found on this board`;
    if (p.releaseId != null && p.releaseId !== '' && !rels.has(String(p.releaseId))) return `${s.type}: release not found in this workspace`;
    const uid = p.userId ?? (typeof p.target === 'string' && p.target.startsWith('user:') ? p.target.slice(5) : null);
    if (uid) {
      const access = await boardAccess(String(uid), boardId);
      if (!access) return `${s.type}: that member cannot access this board`;
    }
  }
  const [b] = await db().select({ id: boards.id }).from(boards).where(eq(boards.id, boardId));
  return b ? null : 'Board not found';
}

registerJob('automation.event', async (payload: { eventId: string; event: DomainEvent }) => {
  await handleEvent(payload.eventId, payload.event);
});

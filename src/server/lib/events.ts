import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../deps.js';
import { activities, cardWatchers, integrations, webhooks, users, boardMembers } from '../db/schema.js';
import { newId } from './crypto.js';
import { publishBoard, publishUser } from './realtime.js';
import { enqueue } from '../jobs/queue.js';
import { notify } from './notify.js';
import { LIMITS } from '../../shared/constants.js';

export interface Actor {
  type: 'user' | 'automation' | 'integration' | 'system';
  userId: string | null;
  /** Automation causation depth; prevents rule A → rule B → rule A loops. */
  depth: number;
  ruleId?: string;
}

export const userActor = (userId: string): Actor => ({ type: 'user', userId, depth: 0 });
export const systemActor: Actor = { type: 'system', userId: null, depth: 0 };

export interface DomainEvent {
  type: string;
  workspaceId: string;
  boardId?: string | null;
  cardId?: string | null;
  actor: Actor;
  data?: Record<string, unknown>;
  /** Unique key; a retried operation with the same key is recorded once. */
  dedupeKey?: string;
  /** Record but don't fan out to watchers (e.g. noisy reorder events). */
  quiet?: boolean;
}

/** Event types that automation rules can react to. */
const AUTOMATION_EVENTS = new Set([
  'card.created',
  'card.moved',
  'card.archived',
  'label.added',
  'label.removed',
  'member.assigned',
  'member.removed',
  'checklist.completed',
  'customField.changed',
  'release.statusChanged',
  'due.approaching',
  'due.passed',
]);

/** Events delivered to outgoing webhooks / Discord / email integrations. */
export const INTEGRATION_EVENTS = [
  'card.created',
  'card.moved',
  'card.completed',
  'card.archived',
  'comment.added',
  'member.assigned',
  'release.statusChanged',
  'release.created',
  'bug.created',
] as const;

const WATCHER_EVENTS = new Set(['card.moved', 'comment.added', 'card.completed', 'card.archived', 'due.changed', 'attachment.added', 'checklist.completed']);

const ACTIVITY_LABELS: Record<string, string> = {
  'card.moved': 'moved the card',
  'comment.added': 'commented',
  'card.completed': 'marked the card complete',
  'card.archived': 'archived the card',
  'due.changed': 'changed the due date',
  'attachment.added': 'added an attachment',
  'checklist.completed': 'completed a checklist',
};

export async function emit(ev: DomainEvent): Promise<{ id: string; duplicate: boolean }> {
  const id = newId();
  const inserted = await db()
    .insert(activities)
    .values({
      id,
      workspaceId: ev.workspaceId,
      boardId: ev.boardId ?? null,
      cardId: ev.cardId ?? null,
      actorId: ev.actor.userId,
      actorType: ev.actor.type,
      type: ev.type,
      data: { ...(ev.data ?? {}), ...(ev.actor.ruleId ? { ruleId: ev.actor.ruleId } : {}) },
      dedupeKey: ev.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: activities.id });
  if (!inserted.length) return { id, duplicate: true };

  if (ev.boardId) publishBoard(ev.boardId, { type: 'changed', event: ev.type, cardId: ev.cardId ?? undefined, actorId: ev.actor.userId });

  if (AUTOMATION_EVENTS.has(ev.type) && ev.actor.depth < LIMITS.automationDepthMax) {
    await enqueue('automation.event', { eventId: id, event: ev }, { dedupeKey: `auto:${id}` });
  }

  if ((INTEGRATION_EVENTS as readonly string[]).includes(ev.type)) {
    const [hasIntegration] = await db().select({ id: integrations.id }).from(integrations).where(eq(integrations.workspaceId, ev.workspaceId)).limit(1);
    const [hasHook] = hasIntegration
      ? [hasIntegration]
      : await db()
          .select({ id: webhooks.id })
          .from(webhooks)
          .where(and(eq(webhooks.workspaceId, ev.workspaceId), eq(webhooks.direction, 'outgoing')))
          .limit(1);
    if (hasHook) await enqueue('integrations.dispatch', { eventId: id, event: ev }, { dedupeKey: `int:${id}` });
  }

  if (ev.cardId && !ev.quiet && WATCHER_EVENTS.has(ev.type)) {
    const watcherRows = await db()
      .select({ userId: cardWatchers.userId })
      .from(cardWatchers)
      .where(ev.actor.userId ? and(eq(cardWatchers.cardId, ev.cardId), ne(cardWatchers.userId, ev.actor.userId)) : eq(cardWatchers.cardId, ev.cardId));
    // Members who chose "All activity" for this board also follow every card on it.
    const followers = ev.boardId
      ? await db()
          .select({ userId: boardMembers.userId })
          .from(boardMembers)
          .where(and(eq(boardMembers.boardId, ev.boardId), eq(boardMembers.notificationLevel, 'all')))
      : [];
    const watchers = [...new Map([...watcherRows, ...followers].filter((w) => w.userId !== ev.actor.userId).map((w) => [w.userId, w])).values()];
    if (watchers.length) {
      const actorName = ev.actor.userId
        ? ((await db().select({ n: users.displayName }).from(users).where(eq(users.id, ev.actor.userId)))[0]?.n ?? 'Someone')
        : ev.actor.type === 'automation'
          ? 'Automation'
          : 'Alypne';
      const cardTitle = String(ev.data?.cardTitle ?? 'a card');
      await notify(
        watchers.map((w) => w.userId),
        {
          type: 'watched_update',
          title: `${actorName} ${ACTIVITY_LABELS[ev.type] ?? 'updated'} on “${cardTitle}”`,
          body: typeof ev.data?.excerpt === 'string' ? ev.data.excerpt : '',
          workspaceId: ev.workspaceId,
          boardId: ev.boardId ?? null,
          cardId: ev.cardId,
          actorId: ev.actor.userId,
          dedupeKey: `watch:${id}`,
        },
      );
    }
  }
  return { id, duplicate: false };
}

export async function publishWorkspaceMembers(userIds: string[], msg: Record<string, unknown>) {
  for (const u of userIds) publishUser(u, { type: 'workspace.changed', ...msg });
}

export async function activityForUsers(ids: string[]) {
  if (!ids.length) return [];
  return db().select({ id: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, ids));
}

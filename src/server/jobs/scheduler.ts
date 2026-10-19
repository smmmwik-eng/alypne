import { and, eq, gt, isNotNull, isNull, lte, lt, sql } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { cards, cardAssignees, boards, notifications, users } from '../db/schema.js';
import { enqueue, pruneJobs, registerJob } from './queue.js';
import { runDueTriggers, runScheduledRules } from './automation.js';
import { notify } from '../lib/notify.js';
import { advanceRecurrence, duplicateCard, updateCard } from '../services/cards.js';
import { emailLayout, sendMail } from '../lib/mailer.js';
import { env } from '../env.js';
import { systemActor } from '../lib/events.js';

const DEFAULT_REMINDER_MINUTES = 24 * 60;

/** Due-soon reminders and overdue alerts. Dedupe keys include the due timestamp so changing a due date re-arms reminders, while retries never duplicate. */
export async function runReminders(now: Date) {
  const horizon = new Date(now.getTime() + 30 * 86400_000);
  const upcoming = await db()
    .select({ id: cards.id, title: cards.title, dueAt: cards.dueAt, reminderMinutes: cards.reminderMinutes, boardId: cards.boardId, workspaceId: boards.workspaceId })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(isNull(cards.archivedAt), isNull(cards.completedAt), isNull(boards.archivedAt), gt(cards.dueAt, now), lte(cards.dueAt, horizon)))
    .limit(2000);
  for (const c of upcoming) {
    const minutes = c.reminderMinutes ?? DEFAULT_REMINDER_MINUTES;
    if (c.dueAt!.getTime() - minutes * 60_000 > now.getTime()) continue;
    const assignees = (await db().select({ u: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, c.id))).map((r) => r.u);
    await notify(assignees, { type: 'due_soon', title: `“${c.title}” is due soon`, body: `Due ${c.dueAt!.toISOString()}`, workspaceId: c.workspaceId, boardId: c.boardId, cardId: c.id, dedupeKey: `due_soon:${c.id}:${c.dueAt!.toISOString()}` });
  }
  const overdue = await db()
    .select({ id: cards.id, title: cards.title, dueAt: cards.dueAt, boardId: cards.boardId, workspaceId: boards.workspaceId })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(isNull(cards.archivedAt), isNull(cards.completedAt), isNull(boards.archivedAt), lt(cards.dueAt, now), gt(cards.dueAt, new Date(now.getTime() - 3 * 86400_000))))
    .limit(2000);
  for (const c of overdue) {
    const assignees = (await db().select({ u: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, c.id))).map((r) => r.u);
    await notify(assignees, { type: 'overdue', title: `“${c.title}” is overdue`, workspaceId: c.workspaceId, boardId: c.boardId, cardId: c.id, dedupeKey: `overdue:${c.id}:${c.dueAt!.toISOString()}` });
  }
}

/** Recurring cards: when an occurrence comes due, a fresh copy is created and the recurrence moves to it. */
export async function runRecurring(now: Date) {
  const rows = await db()
    .select()
    .from(cards)
    .where(and(isNotNull(cards.recurrence), isNull(cards.archivedAt), sql`(${cards.recurrence}->>'nextAt')::timestamptz <= ${now}`))
    .limit(200);
  for (const card of rows) {
    const rec = card.recurrence!;
    // Compare-and-set on the exact recurrence value makes this idempotent across workers/retries.
    const cleared = await db()
      .update(cards)
      .set({ recurrence: null })
      .where(and(eq(cards.id, card.id), sql`${cards.recurrence}->>'nextAt' = ${rec.nextAt}`))
      .returning({ id: cards.id });
    if (!cleared.length) continue;
    const copy = await duplicateCard({ ...systemActor }, card.id, { listId: card.listId, index: 0, keep: { labels: true, members: true, checklists: true, customFields: true, dates: false } });
    const nextDue = new Date(rec.nextAt);
    const duration = card.startAt && card.dueAt ? card.dueAt.getTime() - card.startAt.getTime() : null;
    await updateCard({ ...systemActor }, copy.id, {
      dueAt: nextDue,
      startAt: duration !== null ? new Date(nextDue.getTime() - duration) : null,
      recurrence: { freq: rec.freq, interval: rec.interval },
    });
    // updateCard derives the following occurrence from the copy's due date.
    const following = advanceRecurrence(nextDue, rec.freq, rec.interval);
    await db().update(cards).set({ recurrence: { freq: rec.freq, interval: rec.interval, nextAt: following.toISOString() } }).where(eq(cards.id, copy.id));
  }
}

export async function tick(now = deps().now()) {
  await runReminders(now);
  await runScheduledRules(now);
  await runDueTriggers(now);
  await runRecurring(now);
  if (now.getUTCMinutes() === 0) await pruneJobs();
}

registerJob('scheduler.tick', async () => {
  await tick();
});

registerJob('notification.email', async (payload: { notificationId: string }) => {
  const [n] = await db()
    .select({ id: notifications.id, title: notifications.title, body: notifications.body, link: notifications.link, emailedAt: notifications.emailedAt, email: users.email, displayName: users.displayName })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(eq(notifications.id, payload.notificationId));
  if (!n || n.emailedAt) return;
  const { html, text } = emailLayout({
    heading: n.title,
    body: n.body || 'Open Alypne to see the details.',
    actionLabel: 'Open in Alypne',
    actionUrl: n.link ? `${env.appUrl}${n.link}` : env.appUrl,
    footer: 'Change which emails you receive in Settings → Notifications.',
  });
  await sendMail({ to: n.email, subject: n.title, html, text });
  await db().update(notifications).set({ emailedAt: deps().now() }).where(eq(notifications.id, n.id));
});

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  if (timer) return;
  const enqueueTick = () => {
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    void enqueue('scheduler.tick', {}, { dedupeKey: `tick:${minute.toISOString()}`, maxAttempts: 1 }).catch((e) => console.error('[alypne:scheduler]', e));
  };
  enqueueTick();
  timer = setInterval(enqueueTick, 30_000);
  timer.unref?.();
}
export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

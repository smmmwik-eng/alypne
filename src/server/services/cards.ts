import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import {
  boards,
  cards,
  lists,
  labels,
  cardLabels,
  cardAssignees,
  cardWatchers,
  checklists,
  checklistItems,
  comments,
  customFields,
  customFieldValues,
  workflowStages,
  users,
  bugDetails,
  attachments,
  cardRelations,
  cardVotes,
  releases,
  workspaceMembers,
  activities,
} from '../db/schema.js';
import { newId } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { emit, type Actor } from '../lib/events.js';
import { notify } from '../lib/notify.js';
import { boardAccess } from '../lib/access.js';
import { publishBoard } from '../lib/realtime.js';
import { extractMentions, POSITION_STEP } from '../../shared/utils.js';
import { LIMITS, type Priority } from '../../shared/constants.js';

export type CardRow = typeof cards.$inferSelect;

/* ------------------------------------------------------------- positions */

/**
 * Compute a fractional position for inserting at `index` among the ordered
 * siblings. When neighbours get too close the sibling set is renumbered.
 */
export async function positionAt(kind: 'card' | 'list' | 'checklist' | 'item', scopeId: string, index: number | undefined, excludeId?: string): Promise<number> {
  const siblings = await siblingPositions(kind, scopeId, excludeId);
  const i = index === undefined || index < 0 || index > siblings.length ? siblings.length : index;
  const before = siblings[i - 1]?.position;
  const after = siblings[i]?.position;
  let pos: number;
  if (before === undefined && after === undefined) pos = POSITION_STEP;
  else if (before === undefined) pos = after! / 2;
  else if (after === undefined) pos = before + POSITION_STEP;
  else pos = (before + after) / 2;
  const tooClose = (before !== undefined && pos - before < 1e-6) || (after !== undefined && after - pos < 1e-6);
  if (!tooClose) return pos;
  await renumber(kind, siblings.map((s) => s.id));
  return positionAt(kind, scopeId, index, excludeId);
}

async function siblingPositions(kind: 'card' | 'list' | 'checklist' | 'item', scopeId: string, excludeId?: string) {
  const d = db();
  switch (kind) {
    case 'card':
      return d.select({ id: cards.id, position: cards.position }).from(cards)
        .where(and(eq(cards.listId, scopeId), isNull(cards.archivedAt), excludeId ? ne(cards.id, excludeId) : undefined))
        .orderBy(asc(cards.position));
    case 'list':
      return d.select({ id: lists.id, position: lists.position }).from(lists)
        .where(and(eq(lists.boardId, scopeId), isNull(lists.archivedAt), excludeId ? ne(lists.id, excludeId) : undefined))
        .orderBy(asc(lists.position));
    case 'checklist':
      return d.select({ id: checklists.id, position: checklists.position }).from(checklists)
        .where(and(eq(checklists.cardId, scopeId), excludeId ? ne(checklists.id, excludeId) : undefined))
        .orderBy(asc(checklists.position));
    case 'item':
      return d.select({ id: checklistItems.id, position: checklistItems.position }).from(checklistItems)
        .where(and(eq(checklistItems.checklistId, scopeId), excludeId ? ne(checklistItems.id, excludeId) : undefined))
        .orderBy(asc(checklistItems.position));
  }
}

async function renumber(kind: 'card' | 'list' | 'checklist' | 'item', ids: string[]) {
  const table = { card: cards, list: lists, checklist: checklists, item: checklistItems }[kind];
  await db().transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) await tx.update(table).set({ position: (i + 1) * POSITION_STEP }).where(eq(table.id, ids[i]));
  });
}

/* --------------------------------------------------------------- helpers */

async function nextCardNumber(boardId: string): Promise<number> {
  const [row] = await db()
    .update(boards)
    .set({ nextCardNumber: sql`${boards.nextCardNumber} + 1` })
    .where(eq(boards.id, boardId))
    .returning({ n: boards.nextCardNumber });
  return row.n - 1;
}

async function listStageCategory(listId: string): Promise<string | null> {
  const [row] = await db()
    .select({ category: workflowStages.category })
    .from(lists)
    .leftJoin(workflowStages, eq(workflowStages.id, lists.stageId))
    .where(eq(lists.id, listId));
  return row?.category ?? null;
}

async function displayName(userId: string | null): Promise<string> {
  if (!userId) return 'Automation';
  const [u] = await db().select({ n: users.displayName }).from(users).where(eq(users.id, userId));
  return u?.n ?? 'Someone';
}

function bump(card: CardRow) {
  return { version: card.version + 1, updatedAt: deps().now() };
}

async function boardWorkspace(boardId: string): Promise<string> {
  const [b] = await db().select({ ws: boards.workspaceId }).from(boards).where(eq(boards.id, boardId));
  if (!b) throw notFound('Board');
  return b.ws;
}

async function getCard(id: string): Promise<CardRow> {
  const [c] = await db().select().from(cards).where(eq(cards.id, id));
  if (!c) throw notFound('Card');
  return c;
}

/* ---------------------------------------------------------------- create */

export interface CreateCardInput {
  boardId: string;
  listId: string;
  title: string;
  description?: string;
  index?: number;
  type?: 'task' | 'bug';
  priority?: Priority;
  startAt?: Date | null;
  dueAt?: Date | null;
  labelIds?: string[];
  assigneeIds?: string[];
  releaseId?: string | null;
  milestoneId?: string | null;
  coverColor?: string | null;
  bug?: Partial<typeof bugDetails.$inferInsert>;
  importSource?: string;
  checklists?: { title: string; items: string[] }[];
  dedupeKey?: string;
}

export async function createCard(actor: Actor, input: CreateCardInput): Promise<CardRow> {
  if (input.dedupeKey) {
    // A retried create with the same key returns the card made the first time.
    const [prior] = await db().select({ cardId: activities.cardId }).from(activities).where(eq(activities.dedupeKey, input.dedupeKey));
    if (prior?.cardId) {
      const [existing] = await db().select().from(cards).where(eq(cards.id, prior.cardId));
      if (existing) return existing;
    }
  }
  const [list] = await db().select().from(lists).where(and(eq(lists.id, input.listId), eq(lists.boardId, input.boardId)));
  if (!list) throw badRequest('List does not belong to this board');
  if (list.archivedAt) throw badRequest('Cannot add cards to an archived list');
  const workspaceId = await boardWorkspace(input.boardId);
  const position = await positionAt('card', input.listId, input.index);
  const number = await nextCardNumber(input.boardId);
  const id = newId();
  const now = deps().now();
  const category = await listStageCategory(input.listId);
  const [card] = await db()
    .insert(cards)
    .values({
      id,
      boardId: input.boardId,
      listId: input.listId,
      number,
      type: input.type ?? 'task',
      title: input.title.trim().slice(0, LIMITS.titleMax),
      description: (input.description ?? '').slice(0, LIMITS.descriptionMax),
      position,
      priority: input.priority ?? 'none',
      startAt: input.startAt ?? null,
      dueAt: input.dueAt ?? null,
      releaseId: input.releaseId ?? null,
      milestoneId: input.milestoneId ?? null,
      coverColor: input.coverColor ?? null,
      completedAt: category === 'done' ? now : null,
      createdById: actor.userId,
      importSource: input.importSource ?? null,
    })
    .returning();
  if (input.type === 'bug') await db().insert(bugDetails).values({ ...input.bug, cardId: id });
  if (input.labelIds?.length) {
    const valid = await db().select({ id: labels.id }).from(labels).where(and(eq(labels.boardId, input.boardId), inArray(labels.id, input.labelIds)));
    if (valid.length) await db().insert(cardLabels).values(valid.map((l) => ({ cardId: id, labelId: l.id }))).onConflictDoNothing();
  }
  if (actor.userId && actor.type === 'user') await db().insert(cardWatchers).values({ cardId: id, userId: actor.userId }).onConflictDoNothing();
  for (const cl of input.checklists ?? []) await addChecklist(actor, card, cl.title, cl.items, { silent: true });
  await emit({
    type: input.type === 'bug' ? 'bug.created' : 'card.created',
    workspaceId,
    boardId: input.boardId,
    cardId: id,
    actor,
    data: { cardTitle: card.title, listId: input.listId, listName: list.name },
    dedupeKey: input.dedupeKey,
  });
  if (input.type === 'bug') {
    // Bugs are cards too; automation listening for card.created should see them.
    await emit({ type: 'card.created', workspaceId, boardId: input.boardId, cardId: id, actor, data: { cardTitle: card.title, listId: input.listId, listName: list.name, bug: true }, quiet: true });
  }
  for (const uid of input.assigneeIds ?? []) await assign(actor, card, uid);
  return card;
}

/* ---------------------------------------------------------------- update */

export interface CardPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  startAt?: Date | null;
  dueAt?: Date | null;
  reminderMinutes?: number | null;
  coverColor?: string | null;
  coverAttachmentId?: string | null;
  releaseId?: string | null;
  milestoneId?: string | null;
  completed?: boolean;
  recurrence?: { freq: 'daily' | 'weekly' | 'monthly'; interval: number } | null;
}

export async function updateCard(actor: Actor, cardId: string, patch: CardPatch, expectedVersion?: number): Promise<CardRow> {
  const card = await getCard(cardId);
  if (expectedVersion !== undefined && expectedVersion !== card.version) {
    throw conflict('This card was changed by someone else. Review the latest version and try again.', { current: card });
  }
  const set: Partial<typeof cards.$inferInsert> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const track = <K extends keyof CardRow>(k: K, v: CardRow[K]) => {
    const before = card[k];
    const same = before instanceof Date && v instanceof Date ? before.getTime() === v.getTime() : before === v;
    if (!same) {
      (set as any)[k] = v;
      changes[k] = { from: before instanceof Date ? before.toISOString() : before, to: v instanceof Date ? v.toISOString() : v };
    }
  };
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw badRequest('Title cannot be empty');
    track('title', t.slice(0, LIMITS.titleMax));
  }
  if (patch.description !== undefined) track('description', patch.description.slice(0, LIMITS.descriptionMax));
  if (patch.priority !== undefined) track('priority', patch.priority);
  if (patch.startAt !== undefined) track('startAt', patch.startAt);
  if (patch.dueAt !== undefined) track('dueAt', patch.dueAt);
  if (patch.reminderMinutes !== undefined) track('reminderMinutes', patch.reminderMinutes);
  if (patch.coverColor !== undefined) track('coverColor', patch.coverColor);
  if (patch.coverAttachmentId !== undefined) {
    if (patch.coverAttachmentId) {
      const [a] = await db().select().from(attachments).where(and(eq(attachments.id, patch.coverAttachmentId), eq(attachments.cardId, card.id)));
      if (!a || !a.isImage) throw badRequest('Cover must be an image attached to this card');
    }
    track('coverAttachmentId', patch.coverAttachmentId);
  }
  if (patch.releaseId !== undefined) {
    if (patch.releaseId) {
      const ws = await boardWorkspace(card.boardId);
      const [r] = await db().select({ id: releases.id }).from(releases).where(and(eq(releases.id, patch.releaseId), eq(releases.workspaceId, ws)));
      if (!r) throw badRequest('Release not found in this workspace');
    }
    track('releaseId', patch.releaseId);
  }
  if (patch.milestoneId !== undefined) track('milestoneId', patch.milestoneId);
  if (patch.completed !== undefined) {
    const now = deps().now();
    if (patch.completed && !card.completedAt) track('completedAt', now);
    if (!patch.completed && card.completedAt) track('completedAt', null);
  }
  if (patch.recurrence !== undefined) {
    if (patch.recurrence) {
      const base = card.dueAt ?? deps().now();
      const nextAt = advanceRecurrence(base, patch.recurrence.freq, patch.recurrence.interval).toISOString();
      set.recurrence = { ...patch.recurrence, nextAt };
    } else set.recurrence = null;
    changes.recurrence = { from: card.recurrence, to: set.recurrence };
  }
  if (!Object.keys(changes).length) return card;

  const [updated] = await db()
    .update(cards)
    .set({ ...set, ...bump(card) })
    .where(and(eq(cards.id, card.id), eq(cards.version, card.version)))
    .returning();
  if (!updated) throw conflict('This card was changed by someone else. Please retry.', { current: await getCard(card.id) });

  const workspaceId = await boardWorkspace(card.boardId);
  const base = { workspaceId, boardId: card.boardId, cardId: card.id, actor };
  if (changes.dueAt) await emit({ ...base, type: 'due.changed', data: { cardTitle: updated.title, from: changes.dueAt.from, to: changes.dueAt.to } });
  if (changes.completedAt) {
    await emit({ ...base, type: updated.completedAt ? 'card.completed' : 'card.reopened', data: { cardTitle: updated.title } });
  }
  const rest = Object.fromEntries(Object.entries(changes).filter(([k]) => k !== 'dueAt' && k !== 'completedAt'));
  if (Object.keys(rest).length) {
    // Large text bodies are summarised so activity rows stay small.
    if (rest.description) rest.description = { from: null, to: null };
    await emit({ ...base, type: 'card.updated', data: { cardTitle: updated.title, changes: rest }, quiet: true });
  }
  return updated;
}

export function advanceRecurrence(from: Date, freq: 'daily' | 'weekly' | 'monthly', interval: number): Date {
  const d = new Date(from);
  const n = Math.max(1, Math.min(365, interval));
  if (freq === 'daily') d.setUTCDate(d.getUTCDate() + n);
  else if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d;
}

/* ------------------------------------------------------------------ move */

export async function moveCard(actor: Actor, cardId: string, target: { listId: string; index?: number }): Promise<CardRow> {
  const card = await getCard(cardId);
  const [toList] = await db().select().from(lists).where(eq(lists.id, target.listId));
  if (!toList || toList.archivedAt) throw badRequest('Target list not available');
  const [fromList] = await db().select().from(lists).where(eq(lists.id, card.listId));
  const crossBoard = toList.boardId !== card.boardId;
  const position = await positionAt('card', toList.id, target.index, card.id);
  const set: Partial<typeof cards.$inferInsert> = { listId: toList.id, position, ...bump(card) };

  if (crossBoard) {
    set.boardId = toList.boardId;
    set.number = await nextCardNumber(toList.boardId);
    set.releaseId = (await boardWorkspace(toList.boardId)) === (await boardWorkspace(card.boardId)) ? card.releaseId : null;
    await remapCardForBoard(card.id, card.boardId, toList.boardId);
  }

  if (toList.id !== card.listId) {
    const [fromCat, toCat] = [await listStageCategory(card.listId), await listStageCategory(toList.id)];
    if (toCat === 'done' && !card.completedAt) set.completedAt = deps().now();
    if (fromCat === 'done' && toCat && toCat !== 'done' && card.completedAt) set.completedAt = null;
  }

  const [updated] = await db().update(cards).set(set).where(and(eq(cards.id, card.id), eq(cards.version, card.version))).returning();
  if (!updated) throw conflict('This card was changed by someone else. Please retry.');

  const workspaceId = await boardWorkspace(updated.boardId);
  if (toList.id !== card.listId) {
    await emit({
      type: 'card.moved',
      workspaceId,
      boardId: updated.boardId,
      cardId: card.id,
      actor,
      data: { cardTitle: card.title, fromListId: card.listId, fromListName: fromList?.name, toListId: toList.id, toListName: toList.name, fromBoardId: crossBoard ? card.boardId : undefined },
    });
    if (crossBoard) {
      await emit({ type: 'card.movedAway', workspaceId: await boardWorkspace(card.boardId), boardId: card.boardId, actor, data: { cardTitle: card.title, toBoardId: toList.boardId }, quiet: true });
    }
    if (set.completedAt && !card.completedAt) await emit({ type: 'card.completed', workspaceId, boardId: updated.boardId, cardId: card.id, actor, data: { cardTitle: card.title } });
  } else {
    // Reordering within a list is not worth an activity entry; just tell open boards.
    publishBoard(updated.boardId, { type: 'changed', event: 'card.reordered', cardId: card.id, actorId: actor.userId });
  }
  return updated;
}

/** When a card changes boards: keep labels with a matching name+colour, drop board-specific custom fields, drop assignees without access. */
async function remapCardForBoard(cardId: string, fromBoardId: string, toBoardId: string) {
  const current = await db()
    .select({ labelId: labels.id, name: labels.name, color: labels.color })
    .from(cardLabels)
    .innerJoin(labels, eq(labels.id, cardLabels.labelId))
    .where(eq(cardLabels.cardId, cardId));
  const targetLabels = await db().select().from(labels).where(eq(labels.boardId, toBoardId));
  await db().delete(cardLabels).where(eq(cardLabels.cardId, cardId));
  const mapped = current
    .map((l) => targetLabels.find((t) => t.name === l.name && t.color === l.color))
    .filter((x): x is (typeof targetLabels)[number] => !!x);
  if (mapped.length) await db().insert(cardLabels).values(mapped.map((l) => ({ cardId, labelId: l.id }))).onConflictDoNothing();
  const fromFields = await db().select({ id: customFields.id }).from(customFields).where(eq(customFields.boardId, fromBoardId));
  if (fromFields.length) await db().delete(customFieldValues).where(and(eq(customFieldValues.cardId, cardId), inArray(customFieldValues.fieldId, fromFields.map((f) => f.id))));
  const assignees = await db().select().from(cardAssignees).where(eq(cardAssignees.cardId, cardId));
  for (const a of assignees) if (!(await boardAccess(a.userId, toBoardId))) await db().delete(cardAssignees).where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, a.userId)));
}

/* ------------------------------------------------------ archive / delete */

export async function archiveCard(actor: Actor, cardId: string, archived: boolean): Promise<CardRow> {
  const card = await getCard(cardId);
  if (!!card.archivedAt === archived) return card;
  let position = card.position;
  if (!archived) position = await positionAt('card', card.listId, undefined, card.id);
  const [updated] = await db()
    .update(cards)
    .set({ archivedAt: archived ? deps().now() : null, position, ...bump(card) })
    .where(eq(cards.id, card.id))
    .returning();
  await emit({ type: archived ? 'card.archived' : 'card.restored', workspaceId: await boardWorkspace(card.boardId), boardId: card.boardId, cardId: card.id, actor, data: { cardTitle: card.title } });
  return updated;
}

export async function deleteCard(actor: Actor, cardId: string) {
  const card = await getCard(cardId);
  const workspaceId = await boardWorkspace(card.boardId);
  await db().delete(cards).where(eq(cards.id, card.id));
  await emit({ type: 'card.deleted', workspaceId, boardId: card.boardId, actor, data: { cardTitle: card.title, number: card.number } });
}

/* -------------------------------------------------------- labels/members */

export async function addLabel(actor: Actor, cardId: string, labelId: string) {
  const card = await getCard(cardId);
  const [label] = await db().select().from(labels).where(and(eq(labels.id, labelId), eq(labels.boardId, card.boardId)));
  if (!label) throw badRequest('Label does not belong to this board');
  const res = await db().insert(cardLabels).values({ cardId, labelId }).onConflictDoNothing().returning();
  if (!res.length) return false;
  await touch(card);
  await emit({ type: 'label.added', workspaceId: await boardWorkspace(card.boardId), boardId: card.boardId, cardId, actor, data: { cardTitle: card.title, labelId, labelName: label.name, labelColor: label.color } });
  return true;
}

export async function removeLabel(actor: Actor, cardId: string, labelId: string) {
  const card = await getCard(cardId);
  const res = await db().delete(cardLabels).where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId))).returning();
  if (!res.length) return false;
  const [label] = await db().select().from(labels).where(eq(labels.id, labelId));
  await touch(card);
  await emit({ type: 'label.removed', workspaceId: await boardWorkspace(card.boardId), boardId: card.boardId, cardId, actor, data: { cardTitle: card.title, labelId, labelName: label?.name, labelColor: label?.color } });
  return true;
}

export async function assign(actor: Actor, cardOrId: CardRow | string, userId: string) {
  const card = typeof cardOrId === 'string' ? await getCard(cardOrId) : cardOrId;
  const access = await boardAccess(userId, card.boardId);
  if (!access || access.role === 'observer') throw badRequest('That person cannot be assigned: they are not an editing member of this board');
  const res = await db().insert(cardAssignees).values({ cardId: card.id, userId }).onConflictDoNothing().returning();
  if (!res.length) return false;
  await db().insert(cardWatchers).values({ cardId: card.id, userId }).onConflictDoNothing();
  await touch(card);
  const workspaceId = await boardWorkspace(card.boardId);
  const [target] = await db().select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  await emit({ type: 'member.assigned', workspaceId, boardId: card.boardId, cardId: card.id, actor, data: { cardTitle: card.title, userId, userName: target?.displayName } });
  await notify([userId], {
    type: 'assigned',
    title: `${await displayName(actor.userId)} assigned you to “${card.title}”`,
    workspaceId,
    boardId: card.boardId,
    cardId: card.id,
    actorId: actor.userId,
    dedupeKey: `assigned:${card.id}:${userId}:${Date.now()}`,
  });
  return true;
}

export async function unassign(actor: Actor, cardId: string, userId: string) {
  const card = await getCard(cardId);
  const res = await db().delete(cardAssignees).where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId))).returning();
  if (!res.length) return false;
  await touch(card);
  const [target] = await db().select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  await emit({ type: 'member.removed', workspaceId: await boardWorkspace(card.boardId), boardId: card.boardId, cardId, actor, data: { cardTitle: card.title, userId, userName: target?.displayName } });
  return true;
}

async function touch(card: CardRow) {
  await db().update(cards).set({ updatedAt: deps().now(), version: sql`${cards.version} + 1` }).where(eq(cards.id, card.id));
}

/* ----------------------------------------------------------- checklists */

export async function addChecklist(actor: Actor, card: CardRow, title: string, items: string[], opts: { silent?: boolean } = {}) {
  const id = newId();
  const position = await positionAt('checklist', card.id, undefined);
  const [cl] = await db().insert(checklists).values({ id, cardId: card.id, title: title.trim().slice(0, 200) || 'Checklist', position }).returning();
  const clean = items.map((t) => t.trim()).filter(Boolean).slice(0, LIMITS.checklistItemsPerBulk);
  if (clean.length) {
    await db().insert(checklistItems).values(clean.map((text, i) => ({ id: newId(), checklistId: id, text: text.slice(0, 1000), position: (i + 1) * POSITION_STEP })));
  }
  if (!opts.silent) {
    await touch(card);
    await emit({ type: 'checklist.added', workspaceId: await boardWorkspace(card.boardId), boardId: card.boardId, cardId: card.id, actor, data: { cardTitle: card.title, checklistTitle: cl.title } });
  }
  return cl;
}

/** Toggle an item; emits checklist.completed exactly when the last open item closes. */
export async function setChecklistItemCompleted(actor: Actor, itemId: string, completed: boolean) {
  const [item] = await db().select().from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) throw notFound('Checklist item');
  if (!!item.completedAt === completed) return item;
  const [updated] = await db()
    .update(checklistItems)
    .set({ completedAt: completed ? deps().now() : null, completedById: completed ? actor.userId : null, version: item.version + 1 })
    .where(and(eq(checklistItems.id, itemId), eq(checklistItems.version, item.version)))
    .returning();
  if (!updated) throw conflict('This item was changed by someone else. Please retry.');
  const [cl] = await db().select().from(checklists).where(eq(checklists.id, item.checklistId));
  const card = await getCard(cl.cardId);
  await touch(card);
  const workspaceId = await boardWorkspace(card.boardId);
  await emit({ type: completed ? 'checklist.item.completed' : 'checklist.item.reopened', workspaceId, boardId: card.boardId, cardId: card.id, actor, data: { cardTitle: card.title, itemText: item.text, checklistTitle: cl.title }, quiet: true });
  if (completed) {
    const [open] = await db().select({ n: sql<number>`count(*)::int` }).from(checklistItems).where(and(eq(checklistItems.checklistId, cl.id), isNull(checklistItems.completedAt)));
    if (open.n === 0) {
      await emit({ type: 'checklist.completed', workspaceId, boardId: card.boardId, cardId: card.id, actor, data: { cardTitle: card.title, checklistId: cl.id, checklistTitle: cl.title } });
    }
  }
  return updated;
}

/* ---------------------------------------------------------- custom fields */

export async function validateFieldValue(field: typeof customFields.$inferSelect, value: unknown, workspaceId: string): Promise<string | number | boolean | null> {
  if (value === null || value === undefined || value === '') return null;
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') throw badRequest(`${field.name} must be text`);
      return value.slice(0, 5000);
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) throw badRequest(`${field.name} must be a number`);
      return n;
    }
    case 'date': {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) throw badRequest(`${field.name} must be a date`);
      return d.toISOString();
    }
    case 'checkbox':
      if (typeof value !== 'boolean') throw badRequest(`${field.name} must be true or false`);
      return value;
    case 'dropdown':
      if (typeof value !== 'string' || !field.options.some((o) => o.id === value)) throw badRequest(`${field.name}: choose one of the configured options`);
      return value;
    case 'url': {
      try {
        const u = new URL(String(value));
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
        return u.toString();
      } catch {
        throw badRequest(`${field.name} must be a valid http(s) URL`);
      }
    }
    case 'user': {
      const [m] = await db().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, String(value))));
      if (!m) throw badRequest(`${field.name} must be a workspace member`);
      return String(value);
    }
  }
  throw badRequest('Unsupported field type');
}

export async function setCustomFieldValue(actor: Actor, cardId: string, fieldId: string, value: unknown) {
  const card = await getCard(cardId);
  const [field] = await db().select().from(customFields).where(and(eq(customFields.id, fieldId), eq(customFields.boardId, card.boardId)));
  if (!field) throw badRequest('Custom field does not belong to this board');
  const workspaceId = await boardWorkspace(card.boardId);
  const clean = await validateFieldValue(field, value, workspaceId);
  const [prev] = await db().select().from(customFieldValues).where(and(eq(customFieldValues.cardId, cardId), eq(customFieldValues.fieldId, fieldId)));
  if ((prev?.value ?? null) === clean) return clean;
  if (clean === null) await db().delete(customFieldValues).where(and(eq(customFieldValues.cardId, cardId), eq(customFieldValues.fieldId, fieldId)));
  else
    await db()
      .insert(customFieldValues)
      .values({ cardId, fieldId, value: clean })
      .onConflictDoUpdate({ target: [customFieldValues.cardId, customFieldValues.fieldId], set: { value: clean, updatedAt: deps().now() } });
  await touch(card);
  await emit({ type: 'customField.changed', workspaceId, boardId: card.boardId, cardId, actor, data: { cardTitle: card.title, fieldId, fieldName: field.name, from: prev?.value ?? null, to: clean } });
  return clean;
}

/* --------------------------------------------------------------- comments */

export async function addComment(actor: Actor, cardId: string, body: string, parentId?: string | null) {
  const card = await getCard(cardId);
  const text = body.trim();
  if (!text) throw badRequest('Comment cannot be empty');
  if (text.length > LIMITS.commentMax) throw badRequest('Comment is too long');
  let parent: typeof comments.$inferSelect | undefined;
  if (parentId) {
    [parent] = await db().select().from(comments).where(and(eq(comments.id, parentId), eq(comments.cardId, cardId)));
    if (!parent) throw badRequest('Reply target not found on this card');
    if (parent.parentId) parentId = parent.parentId; // keep threads one level deep
  }
  const id = newId();
  const [comment] = await db().insert(comments).values({ id, cardId, parentId: parentId ?? null, authorId: actor.userId, body: text }).returning();
  if (actor.userId && actor.type === 'user') await db().insert(cardWatchers).values({ cardId, userId: actor.userId }).onConflictDoNothing();
  const workspaceId = await boardWorkspace(card.boardId);
  const excerpt = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  await emit({ type: 'comment.added', workspaceId, boardId: card.boardId, cardId, actor, data: { cardTitle: card.title, commentId: id, excerpt } });
  const author = await displayName(actor.userId);
  const mentioned = extractMentions(text);
  if (mentioned.length) {
    const mentionedUsers = await db().select({ id: users.id }).from(users).where(inArray(sql`lower(${users.username})`, mentioned));
    await notify(
      mentionedUsers.map((u) => u.id),
      { type: 'mentioned', title: `${author} mentioned you on “${card.title}”`, body: excerpt, workspaceId, boardId: card.boardId, cardId, actorId: actor.userId, dedupeKey: `mention:${id}` },
    );
  }
  if (parent?.authorId) {
    await notify([parent.authorId], { type: 'comment_reply', title: `${author} replied to your comment on “${card.title}”`, body: excerpt, workspaceId, boardId: card.boardId, cardId, actorId: actor.userId, dedupeKey: `reply:${id}` });
  }
  return comment;
}

/* -------------------------------------------------------------- duplicate */

export async function duplicateCard(
  actor: Actor,
  cardId: string,
  opts: { listId: string; index?: number; title?: string; keep?: { labels?: boolean; members?: boolean; checklists?: boolean; customFields?: boolean; dates?: boolean } },
): Promise<CardRow> {
  const src = await getCard(cardId);
  const keep = { labels: true, members: true, checklists: true, customFields: true, dates: true, ...opts.keep };
  const [toList] = await db().select().from(lists).where(eq(lists.id, opts.listId));
  if (!toList) throw badRequest('Target list not found');
  const sameBoard = toList.boardId === src.boardId;
  const srcLabels = keep.labels ? await db().select({ labelId: cardLabels.labelId }).from(cardLabels).where(eq(cardLabels.cardId, src.id)) : [];
  let labelIds = srcLabels.map((l) => l.labelId);
  if (!sameBoard && labelIds.length) {
    const srcDefs = await db().select().from(labels).where(inArray(labels.id, labelIds));
    const target = await db().select().from(labels).where(eq(labels.boardId, toList.boardId));
    labelIds = srcDefs.map((l) => target.find((t) => t.name === l.name && t.color === l.color)?.id).filter((x): x is string => !!x);
  }
  const cls = keep.checklists ? await db().select().from(checklists).where(eq(checklists.cardId, src.id)).orderBy(asc(checklists.position)) : [];
  const clData: { title: string; items: string[] }[] = [];
  for (const cl of cls) {
    const items = await db().select().from(checklistItems).where(eq(checklistItems.checklistId, cl.id)).orderBy(asc(checklistItems.position));
    clData.push({ title: cl.title, items: items.map((i) => i.text) });
  }
  const [bug] = src.type === 'bug' ? await db().select().from(bugDetails).where(eq(bugDetails.cardId, src.id)) : [];
  const copy = await createCard(actor, {
    boardId: toList.boardId,
    listId: toList.id,
    index: opts.index,
    title: opts.title ?? src.title,
    description: src.description,
    type: src.type as 'task' | 'bug',
    priority: src.priority as Priority,
    startAt: keep.dates ? src.startAt : null,
    dueAt: keep.dates ? src.dueAt : null,
    labelIds,
    coverColor: src.coverColor,
    releaseId: sameBoard ? src.releaseId : null,
    bug: bug ? { ...bug, cardId: undefined } : undefined,
    checklists: clData,
  });
  if (keep.members) {
    const members = await db().select().from(cardAssignees).where(eq(cardAssignees.cardId, src.id));
    for (const m of members) await assign(actor, copy, m.userId).catch(() => undefined);
  }
  if (keep.customFields && sameBoard) {
    const vals = await db().select().from(customFieldValues).where(eq(customFieldValues.cardId, src.id));
    if (vals.length) await db().insert(customFieldValues).values(vals.map((v) => ({ cardId: copy.id, fieldId: v.fieldId, value: v.value })));
  }
  return copy;
}

/* ------------------------------------------------------------ summaries */

/** Compact card representations for board / table / calendar views. */
export async function cardSummaries(where: { boardId?: string; cardIds?: string[]; includeArchived?: boolean }) {
  const conds = [];
  if (where.boardId) conds.push(eq(cards.boardId, where.boardId));
  if (where.cardIds) {
    if (!where.cardIds.length) return [];
    conds.push(inArray(cards.id, where.cardIds));
  }
  if (!where.includeArchived) conds.push(isNull(cards.archivedAt));
  const rows = await db()
    .select({
      id: cards.id,
      boardId: cards.boardId,
      listId: cards.listId,
      number: cards.number,
      type: cards.type,
      title: cards.title,
      position: cards.position,
      priority: cards.priority,
      startAt: cards.startAt,
      dueAt: cards.dueAt,
      completedAt: cards.completedAt,
      coverColor: cards.coverColor,
      coverAttachmentId: cards.coverAttachmentId,
      releaseId: cards.releaseId,
      milestoneId: cards.milestoneId,
      archivedAt: cards.archivedAt,
      createdById: cards.createdById,
      createdAt: cards.createdAt,
      updatedAt: cards.updatedAt,
      version: cards.version,
      hasDescription: sql<boolean>`length(${cards.description}) > 0`,
      recurrence: cards.recurrence,
    })
    .from(cards)
    .where(and(...conds))
    .orderBy(asc(cards.position));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const [lbl, asg, items, cmt, att, cfv, votes, rel, bugs] = await Promise.all([
    db().select().from(cardLabels).where(inArray(cardLabels.cardId, ids)),
    db().select().from(cardAssignees).where(inArray(cardAssignees.cardId, ids)),
    db()
      .select({ cardId: checklists.cardId, total: sql<number>`count(${checklistItems.id})::int`, done: sql<number>`count(${checklistItems.completedAt})::int` })
      .from(checklists)
      .leftJoin(checklistItems, eq(checklistItems.checklistId, checklists.id))
      .where(inArray(checklists.cardId, ids))
      .groupBy(checklists.cardId),
    db().select({ cardId: comments.cardId, n: sql<number>`count(*)::int` }).from(comments).where(and(inArray(comments.cardId, ids), isNull(comments.deletedAt))).groupBy(comments.cardId),
    db().select({ cardId: attachments.cardId, n: sql<number>`count(*)::int` }).from(attachments).where(inArray(attachments.cardId, ids)).groupBy(attachments.cardId),
    db().select().from(customFieldValues).where(inArray(customFieldValues.cardId, ids)),
    db().select({ cardId: cardVotes.cardId, n: sql<number>`count(*)::int` }).from(cardVotes).where(inArray(cardVotes.cardId, ids)).groupBy(cardVotes.cardId),
    db().select().from(cardRelations).where(and(inArray(cardRelations.toCardId, ids), eq(cardRelations.kind, 'blocks'))),
    db().select({ cardId: bugDetails.cardId, severity: bugDetails.severity, resolution: bugDetails.resolution }).from(bugDetails).where(inArray(bugDetails.cardId, ids)),
  ]);
  const group = <T extends { cardId: string | null }>(arr: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of arr) {
      if (!x.cardId) continue;
      const l = m.get(x.cardId);
      if (l) l.push(x);
      else m.set(x.cardId, [x]);
    }
    return m;
  };
  const L = group(lbl), A = group(asg), I = group(items), C = group(cmt), T = group(att), F = group(cfv), V = group(votes), B = group(bugs);
  const blockedBy = new Map<string, number>();
  for (const r of rel) blockedBy.set(r.toCardId, (blockedBy.get(r.toCardId) ?? 0) + 1);
  return rows.map((r) => ({
    ...r,
    labelIds: (L.get(r.id) ?? []).map((x) => x.labelId),
    assigneeIds: (A.get(r.id) ?? []).map((x) => x.userId),
    checklist: { total: I.get(r.id)?.[0]?.total ?? 0, done: I.get(r.id)?.[0]?.done ?? 0 },
    commentCount: C.get(r.id)?.[0]?.n ?? 0,
    attachmentCount: T.get(r.id)?.[0]?.n ?? 0,
    voteCount: V.get(r.id)?.[0]?.n ?? 0,
    blockedByCount: blockedBy.get(r.id) ?? 0,
    customFields: Object.fromEntries((F.get(r.id) ?? []).map((v) => [v.fieldId, v.value])),
    bug: B.get(r.id)?.[0] ? { severity: B.get(r.id)![0].severity, resolution: B.get(r.id)![0].resolution } : null,
  }));
}

export type CardSummary = Awaited<ReturnType<typeof cardSummaries>>[number];


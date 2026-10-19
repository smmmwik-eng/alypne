import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../deps.js';
import {
  boards,
  boardMembers,
  lists,
  labels,
  cards,
  cardLabels,
  checklists,
  checklistItems,
  customFields,
  workflowStages,
  automationRules,
  workspaces,
} from '../db/schema.js';
import { newId } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { emit, type Actor } from '../lib/events.js';
import { POSITION_STEP, boardKeyFromName } from '../../shared/utils.js';
import { LABEL_COLORS, type BoardVisibility, type Priority } from '../../shared/constants.js';
import { createCard } from './cards.js';
import { computeNextRun } from '../jobs/schedule.js';

/** Portable board description used by templates, duplication and imports. Lists/labels are referenced by name. */
export interface BoardBlueprint {
  description?: string;
  background?: string;
  labels: { name: string; color: string }[];
  customFields?: { name: string; type: string; options?: { id: string; label: string; color?: string }[]; showOnCard?: boolean }[];
  lists: {
    name: string;
    stage?: string | null;
    wipLimit?: number | null;
    cards?: {
      title: string;
      description?: string;
      type?: 'task' | 'bug';
      priority?: Priority;
      labels?: string[];
      checklists?: { title: string; items: string[] }[];
    }[];
  }[];
  automations?: { name: string; trigger: { type: string; params: Record<string, unknown> }; conditions: { type: string; params: Record<string, unknown> }[]; actions: { type: string; params: Record<string, unknown> }[] }[];
}

export const DEFAULT_LABELS: { name: string; color: string }[] = [
  { name: 'Bug', color: '#f43f5e' },
  { name: 'Feature', color: '#a78bfa' },
  { name: 'Scripting', color: '#38bdf8' },
  { name: 'Building', color: '#34d399' },
  { name: 'UI', color: '#e879f9' },
  { name: 'Blocked', color: '#fb923c' },
];

export async function uniqueBoardKey(workspaceId: string, name: string): Promise<string> {
  const base = boardKeyFromName(name);
  const existing = new Set((await db().select({ key: boards.key }).from(boards).where(eq(boards.workspaceId, workspaceId))).map((b) => b.key));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!existing.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}${Date.now() % 10000}`;
}

/** Translate rule params between IDs (live) and names (blueprint). */
function mapRuleParams(
  rule: { trigger: { type: string; params: Record<string, unknown> }; conditions: { type: string; params: Record<string, unknown> }[]; actions: { type: string; params: Record<string, unknown> }[] },
  listMap: Map<string, string>,
  labelMap: Map<string, string>,
  fieldMap: Map<string, string>,
) {
  const mapParams = (p: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...p };
    for (const k of ['listId', 'toListId']) if (typeof out[k] === 'string') out[k] = listMap.get(out[k] as string) ?? null;
    if (typeof out.labelId === 'string') out.labelId = labelMap.get(out.labelId) ?? null;
    if (typeof out.fieldId === 'string') out.fieldId = fieldMap.get(out.fieldId) ?? null;
    // Member-specific params don't survive templating.
    if (typeof out.userId === 'string') out.userId = null;
    return out;
  };
  return {
    trigger: { type: rule.trigger.type, params: mapParams(rule.trigger.params) },
    conditions: rule.conditions.map((c) => ({ type: c.type, params: mapParams(c.params) })),
    actions: rule.actions.map((a) => ({ type: a.type, params: mapParams(a.params) })),
  };
}

export async function boardToBlueprint(boardId: string, opts: { includeCards: boolean; includeAutomations?: boolean }): Promise<BoardBlueprint> {
  const [board] = await db().select().from(boards).where(eq(boards.id, boardId));
  const ls = await db().select().from(lists).where(and(eq(lists.boardId, boardId), isNull(lists.archivedAt))).orderBy(asc(lists.position));
  const lbls = await db().select().from(labels).where(eq(labels.boardId, boardId)).orderBy(asc(labels.position));
  const fields = await db().select().from(customFields).where(eq(customFields.boardId, boardId)).orderBy(asc(customFields.position));
  const stages = await db().select().from(workflowStages).where(eq(workflowStages.workspaceId, board.workspaceId));
  const labelName = new Map(lbls.map((l) => [l.id, l.name]));
  const bp: BoardBlueprint = {
    description: board.description,
    background: board.background,
    labels: lbls.map((l) => ({ name: l.name, color: l.color })),
    customFields: fields.map((f) => ({ name: f.name, type: f.type, options: f.options, showOnCard: f.showOnCard })),
    lists: [],
  };
  for (const l of ls) {
    const entry: BoardBlueprint['lists'][number] = { name: l.name, stage: stages.find((s) => s.id === l.stageId)?.name ?? null, wipLimit: l.wipLimit, cards: [] };
    if (opts.includeCards) {
      const cs = await db().select().from(cards).where(and(eq(cards.listId, l.id), isNull(cards.archivedAt))).orderBy(asc(cards.position));
      for (const c of cs) {
        const cl = await db().select({ labelId: cardLabels.labelId }).from(cardLabels).where(eq(cardLabels.cardId, c.id));
        const chks = await db().select().from(checklists).where(eq(checklists.cardId, c.id)).orderBy(asc(checklists.position));
        const chkData = [];
        for (const ch of chks) {
          const items = await db().select({ text: checklistItems.text }).from(checklistItems).where(eq(checklistItems.checklistId, ch.id)).orderBy(asc(checklistItems.position));
          chkData.push({ title: ch.title, items: items.map((i) => i.text) });
        }
        entry.cards!.push({
          title: c.title,
          description: c.description,
          type: c.type as 'task' | 'bug',
          priority: c.priority as Priority,
          labels: cl.map((x) => labelName.get(x.labelId)).filter((x): x is string => x !== undefined),
          checklists: chkData,
        });
      }
    }
    bp.lists.push(entry);
  }
  if (opts.includeAutomations) {
    const rules = await db().select().from(automationRules).where(eq(automationRules.boardId, boardId));
    const listMap = new Map(ls.map((l) => [l.id, l.name]));
    const labelMap = new Map(lbls.map((l) => [l.id, l.name]));
    const fieldMap = new Map(fields.map((f) => [f.id, f.name]));
    bp.automations = rules.map((r) => ({ name: r.name, ...mapRuleParams(r, listMap, labelMap, fieldMap) }));
  }
  return bp;
}

export async function createBoardFromBlueprint(
  actor: Actor,
  input: { workspaceId: string; name: string; visibility?: BoardVisibility; projectId?: string | null; background?: string; importSource?: string },
  bp: BoardBlueprint,
): Promise<string> {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, input.workspaceId));
  if (!ws) throw badRequest('Workspace not found');
  const id = newId();
  const key = await uniqueBoardKey(input.workspaceId, input.name);
  const stages = await db().select().from(workflowStages).where(eq(workflowStages.workspaceId, input.workspaceId));
  await db().transaction(async (tx) => {
    await tx.insert(boards).values({
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      name: input.name.slice(0, 120),
      key,
      description: bp.description ?? '',
      background: input.background ?? bp.background ?? 'slate',
      visibility: input.visibility ?? ws.settings.defaultBoardVisibility ?? 'workspace',
      createdById: actor.userId,
      importSource: input.importSource ?? null,
    });
    if (actor.userId) await tx.insert(boardMembers).values({ boardId: id, userId: actor.userId, role: 'admin' });
  });
  const labelIds = new Map<string, string>();
  for (const [i, l] of bp.labels.entries()) {
    const lid = newId();
    await db().insert(labels).values({ id: lid, boardId: id, name: l.name.slice(0, 60), color: /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : LABEL_COLORS[i % LABEL_COLORS.length], position: (i + 1) * POSITION_STEP });
    if (!labelIds.has(l.name)) labelIds.set(l.name, lid);
  }
  const fieldIds = new Map<string, string>();
  for (const [i, f] of (bp.customFields ?? []).entries()) {
    if (!['text', 'number', 'date', 'checkbox', 'dropdown', 'url', 'user'].includes(f.type)) continue;
    const fid = newId();
    await db().insert(customFields).values({ id: fid, boardId: id, name: f.name.slice(0, 60), type: f.type, options: f.options ?? [], showOnCard: f.showOnCard ?? true, position: (i + 1) * POSITION_STEP });
    fieldIds.set(f.name, fid);
  }
  const listIds = new Map<string, string>();
  for (const [i, l] of bp.lists.entries()) {
    const lid = newId();
    const stage = l.stage ? stages.find((s) => s.name.toLowerCase() === l.stage!.toLowerCase()) : undefined;
    await db().insert(lists).values({ id: lid, boardId: id, name: l.name.slice(0, 120), position: (i + 1) * POSITION_STEP, stageId: stage?.id ?? null, wipLimit: l.wipLimit ?? null });
    if (!listIds.has(l.name)) listIds.set(l.name, lid);
    for (const c of l.cards ?? []) {
      await createCard(
        { ...actor, depth: 99 }, // seeded content shouldn't fire automations
        {
          boardId: id,
          listId: lid,
          title: c.title,
          description: c.description,
          type: c.type,
          priority: c.priority,
          labelIds: (c.labels ?? []).map((n) => labelIds.get(n)).filter((x): x is string => !!x),
          checklists: c.checklists,
        },
      );
    }
  }
  for (const r of bp.automations ?? []) {
    const mapped = mapRuleParams(r, listIds, labelIds, fieldIds);
    await db().insert(automationRules).values({
      id: newId(),
      workspaceId: input.workspaceId,
      boardId: id,
      name: r.name,
      enabled: true,
      ...mapped,
      createdById: actor.userId,
      nextRunAt: mapped.trigger.type === 'schedule' ? computeNextRun(mapped.trigger.params as any, 'UTC', new Date()) : null,
    });
  }
  await emit({ type: 'board.created', workspaceId: input.workspaceId, boardId: id, actor, data: { name: input.name } });
  return id;
}

/** Default lists for a blank board, mapped to the workspace workflow. */
export function defaultBlueprint(): BoardBlueprint {
  return {
    labels: DEFAULT_LABELS,
    lists: [
      { name: 'Backlog', stage: 'Backlog' },
      { name: 'In Progress', stage: 'In Progress' },
      { name: 'Testing', stage: 'Testing' },
      { name: 'Done', stage: 'Completed' },
    ],
  };
}

export async function boardMemberIds(boardId: string) {
  return (await db().select({ userId: boardMembers.userId }).from(boardMembers).where(eq(boardMembers.boardId, boardId))).map((r) => r.userId);
}

import { and, eq, isNull, or, sql, inArray, type SQL } from 'drizzle-orm';
import { db } from '../deps.js';
import { boards, boardMembers, cards, workspaceMembers, workspaces, lists, checklists, checklistItems, comments, attachments } from '../db/schema.js';
import { boardRoleAtLeast, workspaceRoleAtLeast, type BoardRole, type WorkspaceRole } from '../../shared/constants.js';
import { forbidden, notFound } from './errors.js';

export type Board = typeof boards.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;

export async function workspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const [row] = await db()
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)))
    .limit(1);
  return (row?.role as WorkspaceRole) ?? null;
}

/** Throws 404 for non-members (so workspace existence is not revealed) and 403 for insufficient role. */
export async function requireWorkspace(userId: string, workspaceId: string, min: WorkspaceRole = 'viewer'): Promise<{ workspace: Workspace; role: WorkspaceRole }> {
  const [row] = await db()
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaces)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) throw notFound('Workspace');
  const role = row.role as WorkspaceRole;
  if (!workspaceRoleAtLeast(role, min)) throw forbidden();
  return { workspace: row.workspace, role };
}

/**
 * Effective board role:
 *  - workspace owner/admin           → admin
 *  - explicit board member           → that role (capped to observer for workspace viewers)
 *  - visibility=workspace + member   → member (viewer → observer)
 *  - visibility=public               → observer (read-only, even signed out)
 */
export function effectiveBoardRole(board: Pick<Board, 'visibility'>, wsRole: WorkspaceRole | null, boardRole: BoardRole | null): BoardRole | null {
  if (wsRole === 'owner' || wsRole === 'admin') return 'admin';
  if (boardRole) return wsRole === 'viewer' ? 'observer' : boardRole;
  if (wsRole && board.visibility !== 'private') return wsRole === 'viewer' ? 'observer' : 'member';
  if (board.visibility === 'public') return 'observer';
  return null;
}

export async function boardAccess(userId: string | null, boardId: string): Promise<{ board: Board; role: BoardRole; wsRole: WorkspaceRole | null } | null> {
  const [board] = await db().select().from(boards).where(eq(boards.id, boardId)).limit(1);
  if (!board) return null;
  let wsRole: WorkspaceRole | null = null;
  let bRole: BoardRole | null = null;
  if (userId) {
    wsRole = await workspaceRole(userId, board.workspaceId);
    const [bm] = await db()
      .select({ role: boardMembers.role })
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
      .limit(1);
    bRole = (bm?.role as BoardRole) ?? null;
  }
  const role = effectiveBoardRole(board, wsRole, bRole);
  if (!role) return null;
  return { board, role, wsRole };
}

export async function requireBoard(userId: string | null, boardId: string, min: BoardRole = 'observer') {
  const access = await boardAccess(userId, boardId);
  if (!access) throw notFound('Board');
  if (!boardRoleAtLeast(access.role, min)) throw forbidden();
  if (min !== 'observer' && access.board.archivedAt && min !== 'admin') throw forbidden('This board is archived. Restore it to make changes.');
  return access;
}

export async function requireCard(userId: string | null, cardId: string, min: BoardRole = 'observer') {
  const [card] = await db().select().from(cards).where(eq(cards.id, cardId)).limit(1);
  if (!card) throw notFound('Card');
  const access = await boardAccess(userId, card.boardId);
  if (!access) throw notFound('Card');
  if (!boardRoleAtLeast(access.role, min)) throw forbidden();
  if (min !== 'observer' && access.board.archivedAt) throw forbidden('This board is archived. Restore it to make changes.');
  return { card, ...access };
}

export async function requireList(userId: string, listId: string, min: BoardRole = 'member') {
  const [list] = await db().select().from(lists).where(eq(lists.id, listId)).limit(1);
  if (!list) throw notFound('List');
  const access = await requireBoard(userId, list.boardId, min).catch((e) => {
    if (e.status === 404) throw notFound('List');
    throw e;
  });
  return { list, ...access };
}

export async function requireChecklist(userId: string, checklistId: string, min: BoardRole = 'member') {
  const [cl] = await db().select().from(checklists).where(eq(checklists.id, checklistId)).limit(1);
  if (!cl) throw notFound('Checklist');
  const access = await requireCard(userId, cl.cardId, min);
  return { checklist: cl, ...access };
}

export async function requireChecklistItem(userId: string, itemId: string, min: BoardRole = 'member') {
  const [item] = await db().select().from(checklistItems).where(eq(checklistItems.id, itemId)).limit(1);
  if (!item) throw notFound('Checklist item');
  const access = await requireChecklist(userId, item.checklistId, min);
  return { item, ...access };
}

export async function requireComment(userId: string, commentId: string) {
  const [comment] = await db().select().from(comments).where(eq(comments.id, commentId)).limit(1);
  if (!comment || comment.deletedAt) throw notFound('Comment');
  const access = await requireCard(userId, comment.cardId, 'observer');
  return { comment, ...access };
}

export async function requireAttachment(userId: string | null, attachmentId: string, min: BoardRole = 'observer') {
  const [att] = await db().select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
  if (!att || !att.cardId) throw notFound('Attachment');
  const access = await requireCard(userId, att.cardId, min);
  return { attachment: att, ...access };
}

/**
 * SQL predicate selecting boards the user may view. Used by search, inbox and
 * reports so permission rules live in exactly one place (mirrors effectiveBoardRole).
 */
export function visibleBoardPredicate(userId: string): SQL {
  return or(
    sql`exists (select 1 from ${workspaceMembers} wm where wm.workspace_id = ${boards.workspaceId} and wm.user_id = ${userId} and (wm.role in ('owner','admin') or ${boards.visibility} <> 'private'))`,
    sql`exists (select 1 from ${boardMembers} bm where bm.board_id = ${boards.id} and bm.user_id = ${userId})`,
  )!;
}

export async function visibleBoardIds(userId: string, opts: { workspaceId?: string; includeArchived?: boolean } = {}): Promise<string[]> {
  const conds: SQL[] = [visibleBoardPredicate(userId)];
  if (opts.workspaceId) conds.push(eq(boards.workspaceId, opts.workspaceId));
  if (!opts.includeArchived) conds.push(isNull(boards.archivedAt));
  // Only boards inside workspaces the user belongs to, or explicitly shared with them.
  const rows = await db()
    .select({ id: boards.id })
    .from(boards)
    .where(and(...conds));
  return rows.map((r) => r.id);
}

export async function assertUsersInWorkspace(workspaceId: string, userIds: string[]) {
  if (!userIds.length) return;
  const rows = await db()
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, userIds)));
  if (rows.length !== new Set(userIds).size) throw forbidden('Some users are not members of this workspace');
}

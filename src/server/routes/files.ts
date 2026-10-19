import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../deps.js';
import { attachments, cards } from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { newId, randomToken } from '../lib/crypto.js';
import { badRequest, forbidden, notFound, payloadTooLarge } from '../lib/errors.js';
import { requireAttachment, requireCard } from '../lib/access.js';
import { classifyUpload, deleteObject, getObject, putObject, safeFileName, signedPath, verifySignature } from '../lib/storage.js';
import { emit, userActor } from '../lib/events.js';
import { env } from '../env.js';
import { rateLimit } from '../lib/rateLimit.js';
import { formatBytes } from '../../shared/utils.js';

export async function workspaceStorageUsed(workspaceId: string): Promise<number> {
  const [r] = await db().select({ n: sql<number>`coalesce(sum(${attachments.size}), 0)::bigint` }).from(attachments).where(eq(attachments.workspaceId, workspaceId));
  return Number(r.n);
}

export const fileRoutes = new Hono<AppEnv>()
  .post('/cards/:id/attachments', rateLimit('upload', 120, 3600_000), async (c) => {
    const me = requireUser(c);
    const { card, board } = await requireCard(me.id, c.req.param('id'), 'member');
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > env.uploadMaxBytes + 64 * 1024) throw payloadTooLarge(`Files must be ${formatBytes(env.uploadMaxBytes)} or smaller`);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('Attach a file');
    if (file.size === 0) throw badRequest('The file is empty');
    if (file.size > env.uploadMaxBytes) throw payloadTooLarge(`Files must be ${formatBytes(env.uploadMaxBytes)} or smaller`);
    const used = await workspaceStorageUsed(board.workspaceId);
    if (used + file.size > env.workspaceQuotaBytes) {
      throw payloadTooLarge(`This workspace has used ${formatBytes(used)} of its ${formatBytes(env.workspaceQuotaBytes)} storage. Remove old attachments to upload more.`);
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const kind = classifyUpload(file.name, data);
    if ('error' in kind) throw badRequest(kind.error);
    const id = newId();
    const storageKey = `attachments/${board.workspaceId}/${id}-${randomToken(6)}`;
    await putObject(storageKey, data);
    const fileName = safeFileName(file.name);
    const [row] = await db()
      .insert(attachments)
      .values({ id, workspaceId: board.workspaceId, cardId: card.id, uploaderId: me.id, fileName, mimeType: kind.mimeType, size: file.size, storageKey, isImage: kind.isImage })
      .returning();
    // First image becomes the cover automatically, like Trello.
    if (kind.isImage && !card.coverAttachmentId && !card.coverColor) await db().update(cards).set({ coverAttachmentId: id }).where(eq(cards.id, card.id));
    await emit({ type: 'attachment.added', workspaceId: board.workspaceId, boardId: board.id, cardId: card.id, actor: userActor(me.id), data: { cardTitle: card.title, fileName, size: file.size } });
    return c.json({ attachment: { ...row, url: signedPath('/api/files', id, 3600) } }, 201);
  })

  .get('/attachments/:id/url', async (c) => {
    const user = c.get('user');
    const { attachment } = await requireAttachment(user?.id ?? null, c.req.param('id'));
    return c.json({ url: signedPath('/api/files', attachment.id, 600) });
  })

  .delete('/attachments/:id', async (c) => {
    const me = requireUser(c);
    const { attachment, card, board, role } = await requireAttachment(me.id, c.req.param('id'), 'member');
    if (attachment.uploaderId !== me.id && role !== 'admin') throw forbidden('Only the uploader or a board admin can remove this file');
    await db().delete(attachments).where(eq(attachments.id, attachment.id));
    if (card.coverAttachmentId === attachment.id) await db().update(cards).set({ coverAttachmentId: null }).where(eq(cards.id, card.id));
    await deleteObject(attachment.storageKey);
    await emit({ type: 'attachment.removed', workspaceId: board.workspaceId, boardId: board.id, cardId: card.id, actor: userActor(me.id), data: { cardTitle: card.title, fileName: attachment.fileName } });
    return c.json({ ok: true });
  })

  /** Signed download. The signature proves an access check happened when the URL was issued. */
  .get('/files/:id', async (c) => {
    const id = c.req.param('id');
    if (!verifySignature(id, c.req.query('exp'), c.req.query('sig'))) throw forbidden('This file link has expired. Refresh the page to get a new one.');
    const [att] = await db().select().from(attachments).where(eq(attachments.id, id));
    if (!att) throw notFound('File');
    const data = await getObject(att.storageKey);
    if (!data) throw notFound('File');
    const inline = att.isImage || att.mimeType === 'application/pdf' || att.mimeType.startsWith('video/') || att.mimeType.startsWith('audio/');
    c.header('Content-Type', att.mimeType);
    c.header('Content-Length', String(data.length));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    c.header('Cache-Control', 'private, max-age=600');
    c.header('Content-Disposition', `${inline && c.req.query('download') !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.fileName)}`);
    return c.body(new Uint8Array(data));
  })

  /** Public avatars and workspace logos (non-sensitive, uploaded intentionally for display). */
  .get('/public/avatars/:name', async (c) => {
    const name = c.req.param('name');
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw notFound('File');
    const data = await getObject(`avatars/${name}`);
    if (!data) throw notFound('File');
    const b = data;
    const type = b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : b[0] === 0x47 ? 'image/gif' : 'image/webp';
    c.header('Content-Type', type);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'public, max-age=86400, immutable');
    return c.body(new Uint8Array(data));
  });

export async function storageSummary(workspaceId: string) {
  const used = await workspaceStorageUsed(workspaceId);
  const [count] = await db().select({ n: sql<number>`count(*)::int` }).from(attachments).where(and(eq(attachments.workspaceId, workspaceId)));
  return { usedBytes: used, quotaBytes: env.workspaceQuotaBytes, maxFileBytes: env.uploadMaxBytes, files: count.n };
}

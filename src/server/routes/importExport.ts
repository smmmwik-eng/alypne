import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull, inArray } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { boards, lists, labels, cards, customFields, checklists, checklistItems, comments, cardLinks, users, workspaceMembers, cardAssignees, customFieldValues, workspaces, projects, releases, assets, milestones, workflowStages, boardMembers, cardLabels } from '../db/schema.js';
import { type AppEnv, requireUser } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';
import { requireBoard, requireWorkspace, visibleBoardIds } from '../lib/access.js';
import { parseCsvTasks, parseTrello, trelloColor, type CsvMapping } from '../services/importers.js';
import { uniqueBoardKey } from '../services/boards.js';
import { createCard, addLabel } from '../services/cards.js';
import { emit, userActor } from '../lib/events.js';
import { POSITION_STEP, cardKey } from '../../shared/utils.js';
import { exportBoardJson } from './boards.js';
import { rateLimit } from '../lib/rateLimit.js';
import { PRIORITY_META, type Priority } from '../../shared/constants.js';

async function readJsonOrFile(c: any): Promise<unknown> {
  const type = c.req.header('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('Attach a file');
    const text = await file.text();
    try {
      return JSON.parse(text);
    } catch {
      throw badRequest('The file is not valid JSON');
    }
  }
  try {
    return await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

async function readText(c: any): Promise<{ text: string; fields: Record<string, string> }> {
  const type = c.req.header('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    const fields: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
    if (file instanceof File) return { text: await file.text(), fields };
    if (fields.text) return { text: fields.text, fields };
    throw badRequest('Attach a CSV file');
  }
  const json = await c.req.json().catch(() => null);
  if (!json || typeof json.text !== 'string') throw badRequest('Provide CSV text');
  return { text: json.text, fields: Object.fromEntries(Object.entries(json).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export const importExportRoutes = new Hono<AppEnv>()
  /* ------------------------------------------------------------- Trello */
  .post('/workspaces/:id/import/trello/preview', rateLimit('import-preview', 60, 3600_000), async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'member');
    const raw = await readJsonOrFile(c);
    let parsed;
    try {
      parsed = parseTrello(raw);
    } catch (e: any) {
      throw badRequest(e.message);
    }
    const [dupe] = await db().select({ id: boards.id, name: boards.name }).from(boards).where(and(eq(boards.workspaceId, workspace.id), eq(boards.importSource, `trello:${parsed.board.id}`)));
    return c.json({ preview: parsed.preview, duplicateOf: dupe ?? null });
  })

  .post('/workspaces/:id/import/trello', rateLimit('import', 20, 3600_000), async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'member');
    const raw = (await readJsonOrFile(c)) as any;
    const opts = z.object({ name: z.string().trim().min(1).max(120).optional(), allowDuplicate: z.boolean().default(false), includeArchived: z.boolean().default(true) }).parse(raw?.options ?? {});
    let parsed;
    try {
      parsed = parseTrello(raw?.board ?? raw);
    } catch (e: any) {
      throw badRequest(e.message);
    }
    const t = parsed.board;
    const source = `trello:${t.id}`;
    const [dupe] = await db().select({ id: boards.id }).from(boards).where(and(eq(boards.workspaceId, workspace.id), eq(boards.importSource, source)));
    if (dupe && !opts.allowDuplicate) throw conflict('This Trello board was already imported into this workspace. Confirm to import it again as a separate board.', { boardId: dupe.id });

    const actor = { ...userActor(me.id), depth: 99 }; // imports never trigger automations
    const boardId = newId();
    const name = opts.name ?? t.name;
    await db().insert(boards).values({ id: boardId, workspaceId: workspace.id, name, key: await uniqueBoardKey(workspace.id, name), description: t.desc ?? '', visibility: 'workspace', createdById: me.id, importSource: dupe ? null : source });
    await db().insert(boardMembers).values({ boardId, userId: me.id, role: 'admin' });

    const labelMap = new Map<string, string>();
    for (const [i, l] of t.labels.entries()) {
      const lid = newId();
      await db().insert(labels).values({ id: lid, boardId, name: l.name ?? '', color: trelloColor(l.color), position: (i + 1) * POSITION_STEP });
      labelMap.set(l.id, lid);
    }
    const fieldMap = new Map<string, { id: string; type: string; options: Map<string, string> }>();
    for (const [i, f] of t.customFields.entries()) {
      const type = { text: 'text', number: 'number', date: 'date', checkbox: 'checkbox', list: 'dropdown' }[f.type];
      if (!type) continue;
      const options = new Map<string, string>();
      const opts2 = (f.options ?? []).map((o) => {
        const oid = newId();
        options.set(o.id, oid);
        return { id: oid, label: String((o.value as any)?.text ?? 'Option').slice(0, 60) };
      });
      const fid = newId();
      await db().insert(customFields).values({ id: fid, boardId, name: f.name.slice(0, 60), type, options: opts2, position: (i + 1) * POSITION_STEP });
      fieldMap.set(f.id, { id: fid, type, options });
    }
    const listMap = new Map<string, string>();
    const orderedLists = [...t.lists].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    for (const [i, l] of orderedLists.entries()) {
      if (l.closed && !opts.includeArchived) continue;
      const lid = newId();
      await db().insert(lists).values({ id: lid, boardId, name: l.name.slice(0, 120) || 'Untitled list', position: (i + 1) * POSITION_STEP, archivedAt: l.closed ? deps().now() : null });
      listMap.set(l.id, lid);
    }
    // Match Trello members to workspace members by username.
    const wsUsers = await db().select({ id: users.id, username: users.username }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, workspace.id));
    const memberMap = new Map<string, string>();
    for (const m of t.members) {
      const hit = wsUsers.find((u) => m.username && u.username.toLowerCase() === m.username.toLowerCase());
      if (hit) memberMap.set(m.id, hit.id);
    }
    const commentsByCard = new Map<string, typeof t.actions>();
    for (const a of t.actions) {
      if (a.type !== 'commentCard') continue;
      const cid = (a.data as any)?.card?.id;
      if (!cid) continue;
      const arr = commentsByCard.get(cid) ?? [];
      arr.push(a);
      commentsByCard.set(cid, arr);
    }
    let cardCount = 0;
    let skipped = 0;
    const orderedCards = [...t.cards].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    for (const tc of orderedCards) {
      const listId = listMap.get(tc.idList);
      if (!listId || (tc.closed && !opts.includeArchived)) {
        skipped++;
        continue;
      }
      const due = tc.due ? new Date(tc.due) : null;
      const start = tc.start ? new Date(tc.start) : null;
      const cover = (tc.cover as any)?.color;
      const [archivedList] = await db().select({ archivedAt: lists.archivedAt }).from(lists).where(eq(lists.id, listId));
      if (archivedList.archivedAt) await db().update(lists).set({ archivedAt: null }).where(eq(lists.id, listId));
      const card = await createCard(actor, {
        boardId,
        listId,
        title: tc.name.slice(0, 512) || 'Untitled card',
        description: tc.desc,
        dueAt: due && !Number.isNaN(due.getTime()) ? due : null,
        startAt: start && !Number.isNaN(start.getTime()) ? start : null,
        coverColor: cover ? trelloColor(cover) : null,
        importSource: `trello:${tc.id}`,
        checklists: t.checklists
          .filter((cl) => cl.idCard === tc.id)
          .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
          .map((cl) => ({ title: cl.name, items: [...cl.checkItems].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)).map((i) => i.name) })),
      });
      if (archivedList.archivedAt) await db().update(lists).set({ archivedAt: archivedList.archivedAt }).where(eq(lists.id, listId));
      // Checklist item state.
      const trelloLists = t.checklists.filter((cl) => cl.idCard === tc.id).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
      const ours = await db().select().from(checklists).where(eq(checklists.cardId, card.id)).orderBy(asc(checklists.position));
      for (let i = 0; i < ours.length; i++) {
        const items = await db().select().from(checklistItems).where(eq(checklistItems.checklistId, ours[i].id)).orderBy(asc(checklistItems.position));
        const src = [...(trelloLists[i]?.checkItems ?? [])].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
        for (let j = 0; j < items.length; j++) if (src[j]?.state === 'complete') await db().update(checklistItems).set({ completedAt: deps().now() }).where(eq(checklistItems.id, items[j].id));
      }
      for (const lid of tc.idLabels) {
        const mapped = labelMap.get(lid);
        if (mapped) await addLabel(actor, card.id, mapped).catch(() => undefined);
      }
      for (const mid of tc.idMembers) {
        const uid = memberMap.get(mid);
        if (uid) await db().insert(cardAssignees).values({ cardId: card.id, userId: uid }).onConflictDoNothing();
      }
      for (const item of tc.customFieldItems) {
        const f = fieldMap.get(item.idCustomField);
        if (!f) continue;
        const v = (item.value ?? {}) as Record<string, unknown>;
        let value: string | number | boolean | null = null;
        if (f.type === 'text' && typeof v.text === 'string') value = v.text.slice(0, 5000);
        if (f.type === 'number' && v.number !== undefined && Number.isFinite(Number(v.number))) value = Number(v.number);
        if (f.type === 'date' && typeof v.date === 'string' && !Number.isNaN(new Date(v.date).getTime())) value = new Date(v.date).toISOString();
        if (f.type === 'checkbox') value = v.checked === 'true' || v.checked === true;
        if (f.type === 'dropdown' && item.idValue) value = f.options.get(item.idValue) ?? null;
        if (value !== null) await db().insert(customFieldValues).values({ cardId: card.id, fieldId: f.id, value }).onConflictDoNothing();
      }
      for (const a of tc.attachments) {
        if (!a.url || !/^https?:\/\//.test(a.url)) continue;
        await db().insert(cardLinks).values({ id: newId(), cardId: card.id, provider: 'url', kind: 'link', url: a.url.slice(0, 2000), title: (a.name ?? a.url).slice(0, 200), ref: 'trello', createdById: me.id });
      }
      const cmts = (commentsByCard.get(tc.id) ?? []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      for (const cm of cmts) {
        const text = String((cm.data as any)?.text ?? '').slice(0, 9000);
        if (!text) continue;
        const who = cm.memberCreator?.fullName || cm.memberCreator?.username || 'Trello user';
        await db().insert(comments).values({ id: newId(), cardId: card.id, authorId: me.id, body: `${text}\n\n— *Imported from Trello: ${who}, ${cm.date ? new Date(cm.date).toISOString().slice(0, 10) : 'unknown date'}*`, createdAt: cm.date && !Number.isNaN(new Date(cm.date).getTime()) ? new Date(cm.date) : deps().now() });
      }
      const updates: Partial<typeof cards.$inferInsert> = {};
      if (tc.dueComplete) updates.completedAt = due ?? deps().now();
      if (tc.closed) updates.archivedAt = deps().now();
      if (Object.keys(updates).length) await db().update(cards).set(updates).where(eq(cards.id, card.id));
      cardCount++;
    }
    await emit({ type: 'board.imported', workspaceId: workspace.id, boardId, actor: userActor(me.id), data: { source: 'trello', cards: cardCount, name } });
    return c.json({ boardId, imported: { cards: cardCount, skipped }, unsupported: parsed.preview.unsupported }, 201);
  })

  /* ---------------------------------------------------------------- CSV */
  .post('/boards/:id/import/csv/preview', rateLimit('import-preview', 60, 3600_000), async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'member');
    const { text, fields } = await readText(c);
    const mapping = fields.mapping ? (JSON.parse(fields.mapping) as Partial<CsvMapping>) : undefined;
    let parsed;
    try {
      parsed = parseCsvTasks(text, mapping);
    } catch (e: any) {
      throw badRequest(e.message);
    }
    const existingLists = await db().select({ name: lists.name }).from(lists).where(and(eq(lists.boardId, board.id), isNull(lists.archivedAt)));
    const names = new Set(existingLists.map((l) => l.name.toLowerCase()));
    const newLists = [...new Set(parsed.rows.map((r) => r.list).filter((l): l is string => !!l && !names.has(l.toLowerCase())))];
    return c.json({
      header: parsed.header,
      mapping: parsed.mapping,
      total: parsed.rows.length,
      valid: parsed.rows.filter((r) => r.title).length,
      rows: parsed.rows.slice(0, 50).map((r) => ({ ...r, dueAt: r.dueAt?.toISOString() ?? null, startAt: r.startAt?.toISOString() ?? null })),
      errors: parsed.rows.filter((r) => r.errors.length).slice(0, 100).map((r) => ({ line: r.line, errors: r.errors })),
      newLists,
    });
  })

  .post('/boards/:id/import/csv', rateLimit('import', 20, 3600_000), async (c) => {
    const me = requireUser(c);
    const { board } = await requireBoard(me.id, c.req.param('id'), 'member');
    const { text, fields } = await readText(c);
    const mapping = fields.mapping ? (JSON.parse(fields.mapping) as Partial<CsvMapping>) : undefined;
    const skipDuplicates = fields.skipDuplicates !== 'false';
    const defaultListId = fields.defaultListId;
    let parsed;
    try {
      parsed = parseCsvTasks(text, mapping);
    } catch (e: any) {
      throw badRequest(e.message);
    }
    const boardLists = await db().select().from(lists).where(and(eq(lists.boardId, board.id), isNull(lists.archivedAt))).orderBy(asc(lists.position));
    const byName = new Map(boardLists.map((l) => [l.name.toLowerCase(), l.id]));
    let fallback = defaultListId && boardLists.some((l) => l.id === defaultListId) ? defaultListId : boardLists[0]?.id;
    const boardLabels = await db().select().from(labels).where(eq(labels.boardId, board.id));
    const labelByName = new Map(boardLabels.map((l) => [l.name.toLowerCase(), l.id]));
    const members = await db().select({ id: users.id, username: users.username }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, board.workspaceId));
    const actor = { ...userActor(me.id), depth: 99 };
    let created = 0;
    let duplicates = 0;
    const failed: { line: number; error: string }[] = [];
    for (const r of parsed.rows) {
      if (!r.title) {
        failed.push({ line: r.line, error: 'Missing title' });
        continue;
      }
      let listId = r.list ? byName.get(r.list.toLowerCase()) : fallback;
      if (!listId && r.list) {
        const lid = newId();
        const pos = (boardLists.length + byName.size + 1) * POSITION_STEP;
        await db().insert(lists).values({ id: lid, boardId: board.id, name: r.list.slice(0, 120), position: pos });
        byName.set(r.list.toLowerCase(), lid);
        listId = lid;
      }
      if (!listId) {
        const lid = newId();
        await db().insert(lists).values({ id: lid, boardId: board.id, name: 'Imported', position: POSITION_STEP });
        fallback = lid;
        listId = lid;
      }
      if (skipDuplicates) {
        const [dupe] = await db().select({ id: cards.id }).from(cards).where(and(eq(cards.listId, listId), eq(cards.title, r.title), isNull(cards.archivedAt)));
        if (dupe) {
          duplicates++;
          continue;
        }
      }
      try {
        const card = await createCard(actor, { boardId: board.id, listId, title: r.title, description: r.description, dueAt: r.dueAt, startAt: r.startAt, priority: r.priority, type: r.type });
        for (const name of r.labels) {
          let lid = labelByName.get(name.toLowerCase());
          if (!lid) {
            lid = newId();
            await db().insert(labels).values({ id: lid, boardId: board.id, name: name.slice(0, 60), color: '#94a3b8', position: Date.now() });
            labelByName.set(name.toLowerCase(), lid);
          }
          await addLabel(actor, card.id, lid);
        }
        for (const uname of r.assignees) {
          const m = members.find((u) => u.username.toLowerCase() === uname.toLowerCase());
          if (m) await db().insert(cardAssignees).values({ cardId: card.id, userId: m.id }).onConflictDoNothing();
        }
        created++;
      } catch (e: any) {
        failed.push({ line: r.line, error: e?.message ?? 'Failed' });
      }
    }
    await emit({ type: 'board.imported', workspaceId: board.workspaceId, boardId: board.id, actor: userActor(me.id), data: { source: 'csv', cards: created } });
    return c.json({ created, duplicates, failed });
  })

  /* ------------------------------------------------------ workspace export */
  .get('/workspaces/:id/export.json', rateLimit('export', 10, 3600_000), async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'));
    const boardIds = await visibleBoardIds(me.id, { workspaceId: workspace.id, includeArchived: true });
    const boardsData = [];
    for (const id of boardIds) boardsData.push(await exportBoardJson(id));
    const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspace.id));
    c.header('Content-Disposition', `attachment; filename="${ws.slug}-workspace.json"`);
    return c.json({
      format: 'alypne.workspace.v1',
      exportedAt: deps().now().toISOString(),
      workspace: { id: ws.id, name: ws.name, description: ws.description, settings: ws.settings },
      members: await db().select({ username: users.username, displayName: users.displayName, role: workspaceMembers.role }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, ws.id)),
      workflowStages: await db().select().from(workflowStages).where(eq(workflowStages.workspaceId, ws.id)),
      projects: await db().select().from(projects).where(eq(projects.workspaceId, ws.id)),
      releases: await db().select().from(releases).where(eq(releases.workspaceId, ws.id)),
      milestones: await db().select().from(milestones).where(eq(milestones.workspaceId, ws.id)),
      assets: await db().select().from(assets).where(eq(assets.workspaceId, ws.id)),
      boards: boardsData,
    });
  })

  /* ------------------------------------------------- printable board report */
  .get('/boards/:id/report', async (c) => {
    const user = c.get('user');
    const { board } = await requireBoard(user?.id ?? null, c.req.param('id'));
    const ls = await db().select().from(lists).where(and(eq(lists.boardId, board.id), isNull(lists.archivedAt))).orderBy(asc(lists.position));
    const cs = await db().select().from(cards).where(and(eq(cards.boardId, board.id), isNull(cards.archivedAt))).orderBy(asc(cards.position));
    const ids = cs.map((x) => x.id);
    const lbl = ids.length
      ? await db().select({ cardId: cardLabels.cardId, name: labels.name, color: labels.color }).from(cardLabels).innerJoin(labels, eq(labels.id, cardLabels.labelId)).where(inArray(cardLabels.cardId, ids))
      : [];
    const asg = ids.length ? await db().select({ cardId: cardAssignees.cardId, name: users.displayName }).from(cardAssignees).innerJoin(users, eq(users.id, cardAssignees.userId)).where(inArray(cardAssignees.cardId, ids)) : [];
    const done = cs.filter((x) => x.completedAt).length;
    const overdue = cs.filter((x) => !x.completedAt && x.dueAt && x.dueAt < deps().now()).length;
    const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(board.name)} — Alypne report</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:Inter,Segoe UI,system-ui,sans-serif;color:#111;margin:32px;font-size:13px;line-height:1.45}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
.meta{color:#555;margin-bottom:16px}.stats{display:flex;gap:24px;margin:12px 0 4px}.stats b{display:block;font-size:18px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#666}
.lbl{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;margin:0 3px 2px 0;color:#111}.done{color:#888;text-decoration:line-through}
.toolbar{margin-bottom:20px}button{font:inherit;padding:6px 12px;border:1px solid #ccc;border-radius:999px;background:#fff;cursor:pointer}
@media print{.toolbar{display:none}body{margin:12mm}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Print / save as PDF</button></div>
<h1>${esc(board.name)}</h1><div class="meta">${esc(board.key)} · generated ${esc(deps().now().toISOString().slice(0, 16).replace('T', ' '))} UTC</div>
${board.description ? `<p>${esc(board.description)}</p>` : ''}
<div class="stats"><div><b>${cs.length}</b>cards</div><div><b>${done}</b>completed</div><div><b>${cs.length - done}</b>open</div><div><b>${overdue}</b>overdue</div></div>
${ls
  .map((l) => {
    const lc = cs.filter((x) => x.listId === l.id);
    return `<h2>${esc(l.name)} <span style="color:#888;font-weight:400">(${lc.length})</span></h2>${
      lc.length
        ? `<table><thead><tr><th style="width:80px">Key</th><th>Card</th><th style="width:110px">Priority</th><th style="width:150px">Assignees</th><th style="width:90px">Due</th></tr></thead><tbody>${lc
            .map(
              (x) =>
                `<tr><td>${esc(cardKey(board.key, x.number))}</td><td class="${x.completedAt ? 'done' : ''}">${esc(x.title)}<br>${lbl
                  .filter((y) => y.cardId === x.id)
                  .map((y) => `<span class="lbl" style="background:${esc(y.color)}55">${esc(y.name || ' ')}</span>`)
                  .join('')}</td><td>${esc(PRIORITY_META[x.priority as Priority]?.label ?? '')}</td><td>${esc(
                  asg
                    .filter((y) => y.cardId === x.id)
                    .map((y) => y.name)
                    .join(', '),
                )}</td><td>${fmt(x.dueAt)}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '<p style="color:#888">No cards</p>'
    }`;
  })
  .join('')}
</body></html>`;
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    return c.html(html);
  });

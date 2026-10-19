import { describe, it, expect, beforeAll } from 'vitest';
import { setup, signup, addMember, workspaceWithBoard, type TestApp } from './helpers.js';

let app: TestApp;
beforeAll(async () => {
  ({ app } = await setup());
});

const titles = (board: any, listId: string) => board.cards.filter((c: any) => c.listId === listId).sort((a: any, b: any) => a.position - b.position).map((c: any) => c.title);

describe('boards, lists and cards', () => {
  it('creates a board with default lists, labels and sequential card keys', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    expect(board.lists.map((l: any) => l.name)).toEqual(['Backlog', 'In Progress', 'Testing', 'Done']);
    expect(board.labels.length).toBeGreaterThan(0);
    expect(board.lists[3].stageId).toBeTruthy();
    const a = await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'First' });
    const b = await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Second' });
    expect(b.json.card.number).toBe(a.json.card.number + 1);
    const detail = await owner.get(`/cards/${a.json.card.id}`);
    expect(detail.json.card.key).toMatch(/^[A-Z0-9]+-1$/);
  });

  it('persists drag-and-drop ordering within and across lists', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const [l1, l2] = board.lists;
    const ids: string[] = [];
    for (const t of ['A', 'B', 'C', 'D']) ids.push((await owner.post('/cards', { boardId, listId: l1.id, title: t })).json.card.id);
    // Move D to the top.
    await owner.post(`/cards/${ids[3]}/move`, { listId: l1.id, index: 0 });
    let data = (await owner.get(`/boards/${boardId}`)).json;
    expect(titles(data, l1.id)).toEqual(['D', 'A', 'B', 'C']);
    // Move A into list 2, then B above it.
    await owner.post(`/cards/${ids[0]}/move`, { listId: l2.id, index: 0 });
    await owner.post(`/cards/${ids[1]}/move`, { listId: l2.id, index: 0 });
    data = (await owner.get(`/boards/${boardId}`)).json;
    expect(titles(data, l1.id)).toEqual(['D', 'C']);
    expect(titles(data, l2.id)).toEqual(['B', 'A']);
    // Many inserts at the same spot force a renumber; order must survive.
    for (let i = 0; i < 60; i++) await owner.post(`/cards/${i % 2 ? ids[3] : ids[2]}/move`, { listId: l1.id, index: 1 });
    data = (await owner.get(`/boards/${boardId}`)).json;
    expect(titles(data, l1.id)).toHaveLength(2);
    const act = await owner.get(`/boards/${boardId}/activity`);
    expect(act.json.activities.some((a: any) => a.type === 'card.moved')).toBe(true);
  });

  it('reorders, renames, archives and restores lists', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const last = board.lists[3];
    await owner.post(`/lists/${last.id}/move`, { index: 0 });
    let data = (await owner.get(`/boards/${boardId}`)).json;
    expect(data.lists[0].id).toBe(last.id);
    await owner.patch(`/lists/${last.id}`, { name: 'Shipped', wipLimit: 5 });
    await owner.post(`/lists/${last.id}/archive`, { archived: true });
    data = (await owner.get(`/boards/${boardId}`)).json;
    expect(data.lists.find((l: any) => l.id === last.id)).toBeUndefined();
    const arch = await owner.get(`/boards/${boardId}/archived`);
    expect(arch.json.lists[0].name).toBe('Shipped');
    await owner.post(`/lists/${last.id}/archive`, { archived: false });
    data = (await owner.get(`/boards/${boardId}`)).json;
    expect(data.lists.find((l: any) => l.id === last.id).wipLimit).toBe(5);
  });

  it('marks cards complete when moved into a done-stage list and reopens when moved out', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Ship it' })).json.card;
    await owner.post(`/cards/${card.id}/move`, { listId: board.lists[3].id });
    expect((await owner.get(`/cards/${card.id}`)).json.card.completedAt).toBeTruthy();
    await owner.post(`/cards/${card.id}/move`, { listId: board.lists[1].id });
    expect((await owner.get(`/cards/${card.id}`)).json.card.completedAt).toBeNull();
  });

  it('detects concurrent edits with card versions', async () => {
    const owner = await signup(app);
    const member = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Shared' })).json.card;
    const v = card.version;
    expect((await owner.patch(`/cards/${card.id}`, { description: 'Owner text', version: v })).status).toBe(200);
    const stale = await member.patch(`/cards/${card.id}`, { description: 'Member text', version: v });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.current.description).toBe('Owner text');
  });

  it('edits card fields, labels, assignees, dates and validates', async () => {
    const owner = await signup(app);
    const member = await signup(app);
    const outsider = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Fields' })).json.card;
    const due = new Date(Date.now() + 86400_000).toISOString();
    expect((await owner.patch(`/cards/${card.id}`, { priority: 'high', dueAt: due, startAt: new Date().toISOString() })).status).toBe(200);
    expect((await owner.patch(`/cards/${card.id}`, { startAt: new Date(Date.now() + 2 * 86400_000).toISOString(), dueAt: due })).status).toBe(400);
    expect((await owner.post(`/cards/${card.id}/labels`, { labelId: board.labels[0].id })).status).toBe(200);
    expect((await owner.post(`/cards/${card.id}/assignees`, { userId: member.user.id })).status).toBe(200);
    expect((await owner.post(`/cards/${card.id}/assignees`, { userId: outsider.user.id })).status).toBe(400);
    const other = await workspaceWithBoard(outsider, 'X');
    expect((await owner.post(`/cards/${card.id}/labels`, { labelId: other.board.labels[0].id })).status).toBe(400);
    const d = (await owner.get(`/boards/${boardId}`)).json.cards.find((c: any) => c.id === card.id);
    expect(d.labelIds).toEqual([board.labels[0].id]);
    expect(d.assigneeIds).toEqual([member.user.id]);
    expect(d.priority).toBe('high');
    // Assignment notifies the member.
    const notes = await member.get('/notifications');
    expect(notes.json.notifications.some((n: any) => n.type === 'assigned')).toBe(true);
  });

  it('supports checklists with ordering, completion and concurrency-safe edits', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'With checklist' })).json.card;
    const cl = (await owner.post(`/cards/${card.id}/checklists`, { title: 'QA', items: ['one', 'two'] })).json.checklist;
    await owner.post(`/checklists/${cl.id}/items`, { text: 'three\nfour' });
    let detail = (await owner.get(`/cards/${card.id}`)).json;
    const items = detail.checklists[0].items;
    expect(items.map((i: any) => i.text)).toEqual(['one', 'two', 'three', 'four']);
    await owner.post(`/checklist-items/${items[3].id}/move`, { index: 0 });
    for (const i of items) await owner.patch(`/checklist-items/${i.id}`, { completed: true });
    detail = (await owner.get(`/cards/${card.id}`)).json;
    expect(detail.checklists[0].items[0].text).toBe('four');
    expect(detail.checklists[0].items.every((i: any) => i.completedAt)).toBe(true);
    const act = await owner.get(`/cards/${card.id}/activity`);
    expect(act.json.activities.filter((a: any) => a.type === 'checklist.completed')).toHaveLength(1);
    const summary = (await owner.get(`/boards/${boardId}`)).json.cards.find((c: any) => c.id === card.id);
    expect(summary.checklist).toEqual({ total: 4, done: 4 });
    // Stale text edit is rejected.
    const it0 = detail.checklists[0].items[0];
    await owner.patch(`/checklist-items/${it0.id}`, { text: 'edited', version: it0.version });
    expect((await owner.patch(`/checklist-items/${it0.id}`, { text: 'stale', version: it0.version })).status).toBe(409);
    // Copy checklist to a new one.
    const copy = await owner.post(`/cards/${card.id}/checklists`, { copyFromChecklistId: cl.id });
    expect(copy.status).toBe(201);
  });

  it('threads comments, notifies mentions and replies, and enforces edit permissions', async () => {
    const owner = await signup(app, 'ownerc');
    const member = await signup(app, 'memberc');
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Discuss' })).json.card;
    const c1 = await owner.post(`/cards/${card.id}/comments`, { body: 'Hey @memberc can you look?' });
    expect(c1.status).toBe(201);
    const mention = await member.get('/notifications');
    expect(mention.json.notifications.find((n: any) => n.type === 'mentioned')).toBeTruthy();
    const reply = await member.post(`/cards/${card.id}/comments`, { body: 'On it', parentId: c1.json.comment.id });
    expect(reply.json.comment.parentId).toBe(c1.json.comment.id);
    const ownerNotes = await owner.get('/notifications');
    expect(ownerNotes.json.notifications.find((n: any) => n.type === 'comment_reply')).toBeTruthy();
    expect((await member.patch(`/comments/${c1.json.comment.id}`, { body: 'hijack' })).status).toBe(403);
    expect((await owner.patch(`/comments/${c1.json.comment.id}`, { body: 'edited' })).status).toBe(200);
    expect((await member.del(`/comments/${c1.json.comment.id}`)).status).toBe(403);
    expect((await owner.del(`/comments/${reply.json.comment.id}`)).status).toBe(200); // board admin may delete
    const detail = (await owner.get(`/cards/${card.id}`)).json;
    expect(detail.comments.find((c: any) => c.id === reply.json.comment.id).deleted).toBe(true);
  });

  it('validates custom field values per type and handles option removal safely', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Fields' })).json.card;
    const num = (await owner.post(`/boards/${boardId}/custom-fields`, { name: 'Points', type: 'number' })).json.field;
    const dd = (await owner.post(`/boards/${boardId}/custom-fields`, { name: 'Platform', type: 'dropdown', options: [{ label: 'PC' }, { label: 'Mobile' }] })).json.field;
    const url = (await owner.post(`/boards/${boardId}/custom-fields`, { name: 'Doc', type: 'url' })).json.field;
    expect((await owner.put(`/cards/${card.id}/custom-fields/${num.id}`, { value: 'abc' })).status).toBe(400);
    expect((await owner.put(`/cards/${card.id}/custom-fields/${num.id}`, { value: 5 })).json.value).toBe(5);
    expect((await owner.put(`/cards/${card.id}/custom-fields/${url.id}`, { value: 'javascript:alert(1)' })).status).toBe(400);
    expect((await owner.put(`/cards/${card.id}/custom-fields/${dd.id}`, { value: 'not-an-option' })).status).toBe(400);
    expect((await owner.put(`/cards/${card.id}/custom-fields/${dd.id}`, { value: dd.options[1].id })).status).toBe(200);
    // Remove the "Mobile" option: values pointing at it are cleared, not left dangling.
    expect((await owner.patch(`/boards/${boardId}/custom-fields/${dd.id}`, { options: [{ id: dd.options[0].id, label: 'PC' }] })).status).toBe(200);
    const s = (await owner.get(`/boards/${boardId}`)).json.cards.find((c: any) => c.id === card.id);
    expect(s.customFields[num.id]).toBe(5);
    expect(s.customFields[dd.id]).toBeUndefined();
  });

  it('duplicates cards and boards and moves cards between boards', async () => {
    const owner = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Template me', labelIds: [board.labels[0].id] })).json.card;
    await owner.post(`/cards/${card.id}/checklists`, { title: 'Steps', items: ['a', 'b'] });
    const dup = await owner.post(`/cards/${card.id}/duplicate`, { listId: board.lists[1].id });
    expect(dup.status).toBe(201);
    const dupDetail = (await owner.get(`/cards/${dup.json.card.id}`)).json;
    expect(dupDetail.checklists[0].items).toHaveLength(2);
    const copy = await owner.post(`/boards/${boardId}/duplicate`, { name: 'Copy', include: { cards: true, members: false, settings: true, automations: false, customFields: true, labels: true } });
    const copyData = (await owner.get(`/boards/${copy.json.id}`)).json;
    expect(copyData.cards.map((c: any) => c.title).sort()).toEqual(['Template me', 'Template me']);
    expect(copyData.board.key).not.toBe(board.board.key);
    // Move to the other board: matching label kept, card renumbered.
    const moved = await owner.post(`/cards/${card.id}/move`, { listId: copyData.lists[0].id });
    expect(moved.json.card.boardId).toBe(copy.json.id);
    const after = (await owner.get(`/boards/${copy.json.id}`)).json.cards.find((c: any) => c.id === card.id);
    expect(after.labelIds).toEqual([copyData.labels.find((l: any) => l.name === board.labels[0].name).id]);
    void workspaceId;
  });

  it('runs bulk actions and reports per-card results', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const ids = [];
    for (const t of ['x', 'y', 'z']) ids.push((await owner.post('/cards', { boardId, listId: board.lists[0].id, title: t })).json.card.id);
    const res = await owner.post('/cards/bulk', { cardIds: [...ids, 'missing'], action: { type: 'setPriority', priority: 'urgent' } });
    expect(res.json.succeeded).toBe(3);
    expect(res.json.failed).toBe(1);
    await owner.post('/cards/bulk', { cardIds: ids, action: { type: 'archive' } });
    expect((await owner.get(`/boards/${boardId}`)).json.cards).toHaveLength(0);
  });

  it('rejects dependency cycles', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const a = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'A' })).json.card;
    const b = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'B' })).json.card;
    expect((await owner.post(`/cards/${a.id}/relations`, { toCardId: b.id, kind: 'blocks' })).status).toBe(201);
    expect((await owner.post(`/cards/${b.id}/relations`, { toCardId: a.id, kind: 'blocks' })).status).toBe(400);
    const summary = (await owner.get(`/boards/${boardId}`)).json.cards.find((c: any) => c.id === b.id);
    expect(summary.blockedByCount).toBe(1);
  });

  it('replays responses for repeated idempotency keys', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const body = { boardId, listId: board.lists[0].id, title: 'Once' };
    const r1 = await owner.post('/cards', body, { 'idempotency-key': 'abc-123' });
    const r2 = await owner.post('/cards', body, { 'idempotency-key': 'abc-123' });
    expect(r2.json.card.id).toBe(r1.json.card.id);
    expect((await owner.get(`/boards/${boardId}`)).json.cards.filter((c: any) => c.title === 'Once')).toHaveLength(1);
  });

  it('uploads attachments with validation and signed downloads', async () => {
    const owner = await signup(app);
    const outsider = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Files' })).json.card;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const fd = new FormData();
    fd.append('file', new File([png], 'shot.png', { type: 'image/png' }));
    const up = await owner.req('POST', `/cards/${card.id}/attachments`, fd);
    expect(up.status).toBe(201);
    expect(up.json.attachment.isImage).toBe(true);
    // Fake image (HTML renamed .png) is rejected.
    const bad = new FormData();
    bad.append('file', new File(['<script>alert(1)</script>'], 'evil.png'));
    expect((await owner.req('POST', `/cards/${card.id}/attachments`, bad)).status).toBe(400);
    const exe = new FormData();
    exe.append('file', new File(['MZ'], 'virus.exe'));
    expect((await owner.req('POST', `/cards/${card.id}/attachments`, exe)).status).toBe(400);
    const dl = await owner.get(up.json.attachment.url.replace('/api', ''));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    const tampered = up.json.attachment.url.replace(/sig=[^&]+/, 'sig=forged');
    expect((await outsider.get(tampered.replace('/api', ''))).status).toBe(403);
    expect((await outsider.get(`/attachments/${up.json.attachment.id}/url`)).status).toBe(404);
    // First image became the cover.
    expect((await owner.get(`/cards/${card.id}`)).json.card.coverAttachmentId).toBe(up.json.attachment.id);
  });

  it('exports JSON and CSV and produces a printable report', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    await owner.post('/cards', { boardId, listId: board.lists[0].id, title: '=SUM(A1) injection', description: 'line1\nline2, "quoted"' });
    const json = await owner.get(`/boards/${boardId}/export.json`);
    expect(json.json.format).toBe('alypne.board.v1');
    expect(json.json.cards).toHaveLength(1);
    const csv = await owner.get(`/boards/${boardId}/export.csv`);
    expect(csv.text).toContain("'=SUM(A1) injection");
    expect(csv.text).toContain('"line1\nline2, ""quoted"""');
    const report = await owner.get(`/boards/${boardId}/report`);
    expect(report.status).toBe(200);
    expect(report.text).toContain('<h1>Game Dev</h1>');
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setup, signup, addMember, workspaceWithBoard, type TestApp } from './helpers.js';
import { parseTrello, parseCsvTasks } from '../services/importers.js';
import { parseCsv, toCsv, extractMentions, parseDevLink, boardKeyFromName } from '../../shared/utils.js';

let app: TestApp;
beforeAll(async () => {
  ({ app } = await setup());
});

const fixture = JSON.parse(readFileSync(path.resolve('src/server/tests/fixtures/trello-board.json'), 'utf8'));

describe('Trello import', () => {
  it('previews the fixture and reports unsupported data honestly', () => {
    const { preview } = parseTrello(fixture);
    expect(preview.boardName).toBe('Obby Tycoon — Sprint Board');
    expect(preview.counts.cards).toBe(4);
    expect(preview.counts.archivedCards).toBe(1);
    expect(preview.counts.checklistItems).toBe(3);
    expect(preview.counts.comments).toBe(2);
    expect(preview.unsupported.join(' ')).toMatch(/Uploaded attachment files/);
    expect(preview.unsupported.join(' ')).toMatch(/Power-Up/);
  });

  it('rejects malformed files with a helpful message', () => {
    expect(() => parseTrello({ hello: 'world' })).toThrow(/Trello board export/);
    expect(() => parseTrello({ ...fixture, cards: 'nope' })).toThrow();
  });

  it('imports lists, cards, labels, checklists, comments, dates and custom fields; blocks accidental duplicates', async () => {
    const owner = await signup(app, 'trellofan');
    const { workspaceId } = await workspaceWithBoard(owner);
    const prev = await owner.post(`/workspaces/${workspaceId}/import/trello/preview`, fixture);
    expect(prev.status).toBe(200);
    expect(prev.json.duplicateOf).toBeNull();
    const res = await owner.post(`/workspaces/${workspaceId}/import/trello`, { board: fixture, options: {} });
    expect(res.status).toBe(201);
    const board = (await owner.get(`/boards/${res.json.boardId}`)).json;
    expect(board.lists.map((l: any) => l.name)).toEqual(['To Do', 'Doing', 'Done']);
    const pet = board.cards.find((c: any) => c.title === 'Pet follow system');
    expect(pet.labelIds).toHaveLength(2);
    expect(pet.assigneeIds).toEqual([owner.user.id]); // matched by username
    expect(new Date(pet.dueAt).toISOString()).toBe('2026-11-20T17:00:00.000Z');
    const detail = (await owner.get(`/cards/${pet.id}`)).json;
    expect(detail.checklists[0].items.map((i: any) => [i.text, !!i.completedAt])).toEqual([
      ['Pathfinding', true],
      ['Idle animation', false],
      ['Rarity tiers', false],
    ]);
    expect(detail.comments[0].body).toContain('Imported from Trello');
    expect(detail.links[0].url).toContain('trello.com');
    const est = board.customFields.find((f: any) => f.name === 'Estimate');
    expect(pet.customFields[est.id]).toBe(8);
    const done = board.cards.find((c: any) => c.title === 'Lobby lighting');
    expect(done.completedAt).toBeTruthy();
    expect(board.cards.find((c: any) => c.title === 'Old idea')).toBeUndefined(); // archived
    const again = await owner.post(`/workspaces/${workspaceId}/import/trello`, { board: fixture, options: {} });
    expect(again.status).toBe(409);
    const forced = await owner.post(`/workspaces/${workspaceId}/import/trello`, { board: fixture, options: { allowDuplicate: true } });
    expect(forced.status).toBe(201);
  });

  it('requires workspace membership with edit rights', async () => {
    const owner = await signup(app);
    const viewer = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    await addMember(owner, viewer, workspaceId, 'viewer');
    expect((await viewer.post(`/workspaces/${workspaceId}/import/trello`, { board: fixture })).status).toBe(403);
  });
});

describe('CSV import / export', () => {
  it('parses quoted CSV and maps headers', () => {
    const rows = parseCsv('Title,Description,Status\r\n"Fix ""jump""","multi\nline",Doing\nSecond,,');
    expect(rows).toEqual([
      ['Title', 'Description', 'Status'],
      ['Fix "jump"', 'multi\nline', 'Doing'],
      ['Second', '', ''],
    ]);
    const parsed = parseCsvTasks('Name,Due date,Priority,Labels\nA,2026-12-01,high,UI; Bug\nB,not a date,weird,');
    expect(parsed.rows[0].priority).toBe('high');
    expect(parsed.rows[0].labels).toEqual(['UI', 'Bug']);
    expect(parsed.rows[1].errors.length).toBe(2);
    expect(() => parseCsvTasks('foo,bar\n1,2')).toThrow(/title column/);
    expect(toCsv([['=cmd', 'a,b', 'x"y']])).toBe(`'=cmd,"a,b","x""y"`);
  });

  it('imports into a board, creating lists and labels, and skips duplicates', async () => {
    const owner = await signup(app);
    const { boardId } = await workspaceWithBoard(owner);
    const text = 'Title,List,Labels,Priority\nSword VFX,Polish,VFX,high\nShop UI,Backlog,UI,\n';
    const prev = await owner.post(`/boards/${boardId}/import/csv/preview`, { text });
    expect(prev.json.newLists).toEqual(['Polish']);
    expect((await owner.post(`/boards/${boardId}/import/csv`, { text })).json.created).toBe(2);
    expect((await owner.post(`/boards/${boardId}/import/csv`, { text })).json.duplicates).toBe(2);
    const board = (await owner.get(`/boards/${boardId}`)).json;
    expect(board.lists.some((l: any) => l.name === 'Polish')).toBe(true);
    expect(board.labels.some((l: any) => l.name === 'VFX')).toBe(true);
  });
});

describe('templates', () => {
  it('lists built-in Roblox templates and applies them as real entities', async () => {
    const owner = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    const list = (await owner.get(`/workspaces/${workspaceId}/templates`)).json.templates;
    const names = list.map((t: any) => t.name);
    for (const n of ['New game development', 'Bug tracking', 'Update planning', 'Scripting tasks', 'Building and modelling', 'UI development', 'Animation', 'Quality assurance', 'Studio recruitment', 'Team onboarding', 'Game events', 'Moderation and operations']) {
      expect(names).toContain(n);
    }
    const bugTpl = list.find((t: any) => t.slug === 'board-bug-tracking');
    const applied = await owner.post(`/templates/${bugTpl.id}/apply`, { workspaceId, name: 'Bugs' });
    const created = (await owner.get(`/boards/${applied.json.boardId}`)).json;
    expect(created.lists.map((l: any) => l.name)).toContain('Reproducing');
    const rules = (await owner.get(`/boards/${applied.json.boardId}/automations`)).json.rules;
    expect(rules[0].trigger.params.labelId).toBe(created.labels.find((l: any) => l.name === 'Critical').id);
    // Checklist template onto a card.
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Release' })).json.card;
    const cl = list.find((t: any) => t.slug === 'checklist-release');
    await owner.post(`/templates/${cl.id}/apply`, { workspaceId, cardId: card.id });
    expect((await owner.get(`/cards/${card.id}`)).json.checklists[0].items.length).toBe(6);
    // Built-ins are read-only; custom templates can be created, edited and deleted.
    expect((await owner.patch(`/templates/${cl.id}`, { name: 'x' })).status).toBe(403);
    const mine = await owner.post(`/workspaces/${workspaceId}/templates`, { kind: 'checklist', name: 'Mine', data: { title: 'Mine', items: ['a'] } });
    expect(mine.status).toBe(201);
    expect((await owner.patch(`/templates/${mine.json.template.id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await owner.post(`/workspaces/${workspaceId}/templates`, { kind: 'checklist', name: 'Bad', data: { nope: true } })).status).toBe(400);
    // Save a board as template and create a board from it.
    const saved = await owner.post(`/boards/${boardId}/save-as-template`, { name: 'Our flow' });
    const fromTpl = await owner.post('/boards', { workspaceId, name: 'From template', templateId: saved.json.template.id });
    expect((await owner.get(`/boards/${fromTpl.json.id}`)).json.cards.map((c: any) => c.title)).toContain('Release');
  });

  it('creates a project from a project template with linked boards', async () => {
    const owner = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    const t = (await owner.get(`/workspaces/${workspaceId}/templates?kind=project`)).json.templates[0];
    const res = await owner.post(`/templates/${t.id}/apply`, { workspaceId, name: 'Space Sim' });
    expect(res.json.boardIds).toHaveLength(3);
    const project = (await owner.get(`/projects/${res.json.projectId}`)).json;
    expect(project.boards).toHaveLength(3);
  });
});

describe('search, releases, reports and notifications', () => {
  it('searches cards by text and key and respects filters', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const c1 = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Leaderboard DataStore', description: 'ordered datastore' })).json.card;
    await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Unrelated', type: 'bug' });
    const r = await owner.get('/search?q=datastore');
    expect(r.json.cards.items.map((c: any) => c.id)).toEqual([c1.id]);
    const byKey = await owner.get(`/search?q=${board.board.key}-${c1.number}`);
    expect(byKey.json.cards.items[0].id).toBe(c1.id);
    expect((await owner.get('/search?q=&kind=bug')).json.cards.items.every((c: any) => c.type === 'bug')).toBe(true);
    expect((await owner.get('/search?q=%25')).json.cards.total).toBe(0);
  });

  it('tracks release progress and status history', async () => {
    const owner = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    const rel = await owner.post(`/workspaces/${workspaceId}/releases`, { name: 'Winter update', version: '1.4.0', plannedDate: '2026-12-15T00:00:00.000Z' });
    const a = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Snow map', releaseId: rel.json.id })).json.card;
    await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Sled', releaseId: rel.json.id });
    await owner.patch(`/cards/${a.id}`, { completed: true });
    const detail = (await owner.get(`/releases/${rel.json.id}`)).json;
    expect(detail.progress).toEqual({ total: 2, done: 1, percent: 50 });
    await owner.patch(`/releases/${rel.json.id}`, { status: 'released' });
    const after = (await owner.get(`/releases/${rel.json.id}`)).json;
    expect(after.release.releasedAt).toBeTruthy();
    expect(after.history.some((h: any) => h.data.to === 'released')).toBe(true);
    const notes = (await owner.post(`/releases/${rel.json.id}/generate-notes`)).json.notes;
    expect(notes).toContain('Snow map');
    expect(notes).not.toContain('Sled');
  });

  it('computes reports only from boards the viewer can see', async () => {
    const owner = await signup(app);
    const member = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Public-ish', priority: 'high' });
    const secret = await owner.post('/boards', { workspaceId, name: 'Secret', visibility: 'private' });
    const sb = (await owner.get(`/boards/${secret.json.id}`)).json;
    await owner.post('/cards', { boardId: secret.json.id, listId: sb.lists[0].id, title: 'Hidden' });
    expect((await owner.get(`/workspaces/${workspaceId}/reports`)).json.totals.total).toBe(2);
    const mine = (await member.get(`/workspaces/${workspaceId}/reports`)).json;
    expect(mine.totals.total).toBe(1);
    expect(mine.trend).toHaveLength(12);
  });

  it('marks notifications read individually and all at once', async () => {
    const owner = await signup(app);
    const member = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    for (const t of ['a', 'b']) await owner.post('/cards', { boardId, listId: board.lists[0].id, title: t, assigneeIds: [member.user.id] });
    let n = await member.get('/notifications');
    expect(n.json.unread).toBe(2);
    await member.post('/notifications/read', { ids: [n.json.notifications[0].id] });
    expect((await member.get('/notifications/unread-count')).json.unread).toBe(1);
    await member.post('/notifications/read-all');
    n = await member.get('/notifications');
    expect(n.json.unread).toBe(0);
    // Preferences: turning off in-app assignment notifications stops new ones.
    expect((await member.patch('/me', { notificationPrefs: { assigned: { inApp: false, email: false } } })).status).toBe(200);
    await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'c', assigneeIds: [member.user.id] });
    expect((await member.get('/notifications/unread-count')).json.unread).toBe(0);
  });

  it('does not notify people about boards they cannot access', async () => {
    const owner = await signup(app);
    const member = await signup(app, 'nosy');
    const { workspaceId } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    const secret = await owner.post('/boards', { workspaceId, name: 'Secret', visibility: 'private' });
    const sb = (await owner.get(`/boards/${secret.json.id}`)).json;
    const card = (await owner.post('/cards', { boardId: secret.json.id, listId: sb.lists[0].id, title: 'Hidden' })).json.card;
    await owner.post(`/cards/${card.id}/comments`, { body: 'hey @nosy' });
    expect((await member.get('/notifications')).json.notifications).toHaveLength(0);
  });
});

describe('shared utilities', () => {
  it('extracts mentions, parses dev links and builds board keys', () => {
    expect(extractMentions('hi @Alice and @bob_2, not email@x.com or `@code`')).toEqual(['alice', 'bob_2']);
    expect(parseDevLink('https://github.com/a/b/pull/12')).toMatchObject({ provider: 'github', kind: 'pull_request', ref: 'a/b#12' });
    expect(parseDevLink('https://gitlab.com/g/p/-/merge_requests/3')).toMatchObject({ provider: 'gitlab', ref: 'g/p!3' });
    expect(parseDevLink('https://www.roblox.com/games/920587237/Adopt-Me')).toMatchObject({ provider: 'roblox', kind: 'experience', ref: '920587237' });
    expect(parseDevLink('javascript:alert(1)')).toBeNull();
    expect(boardKeyFromName('Game Development Board')).toBe('GDB');
    expect(boardKeyFromName('Bugs')).toBe('BUGS');
  });
});

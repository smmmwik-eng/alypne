import { describe, it, expect, beforeAll } from 'vitest';
import { setup, signup, addMember, workspaceWithBoard, type TestApp } from './helpers.js';
import { drainJobs } from '../jobs/queue.js';
import { tick } from '../jobs/scheduler.js';
import { computeNextRun, zonedToUtc } from '../jobs/schedule.js';

let app: TestApp;
let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
  app = ctx.app;
});

describe('automation engine', () => {
  it('runs a card.moved rule with conditions and actions on the server', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const [backlog, inProgress] = board.lists;
    const bugLabel = board.labels.find((l: any) => l.name === 'Bug');
    const rule = await owner.post('/automations', {
      boardId,
      name: 'Bugs in progress get urgent + checklist',
      trigger: { type: 'card.moved', params: { toListId: inProgress.id } },
      conditions: [{ type: 'hasLabel', params: { labelId: bugLabel.id } }],
      actions: [
        { type: 'setPriority', params: { priority: 'urgent' } },
        { type: 'addChecklist', params: { title: 'Fix steps', items: 'Reproduce\nFix\nVerify' } },
        { type: 'addComment', params: { text: 'Automation picked up {card}' } },
      ],
    });
    expect(rule.status).toBe(201);
    const bug = (await owner.post('/cards', { boardId, listId: backlog.id, title: 'Crash', labelIds: [bugLabel.id] })).json.card;
    const plain = (await owner.post('/cards', { boardId, listId: backlog.id, title: 'Plain' })).json.card;
    await owner.post(`/cards/${bug.id}/move`, { listId: inProgress.id });
    await owner.post(`/cards/${plain.id}/move`, { listId: inProgress.id });
    await drainJobs();
    const bugDetail = (await owner.get(`/cards/${bug.id}`)).json;
    expect(bugDetail.card.priority).toBe('urgent');
    expect(bugDetail.checklists[0].items.map((i: any) => i.text)).toEqual(['Reproduce', 'Fix', 'Verify']);
    expect(bugDetail.comments[0].body).toBe('Automation picked up Crash');
    expect((await owner.get(`/cards/${plain.id}`)).json.card.priority).toBe('none');
    const execs = await owner.get(`/automations/${rule.json.rule.id}/executions`);
    expect(execs.json.executions.map((e: any) => e.status).sort()).toEqual(['skipped', 'success']);
    // Activity records the automation as actor type.
    const acts = await owner.get(`/cards/${bug.id}/activity`);
    expect(acts.json.activities.some((a: any) => a.actorType === 'automation')).toBe(true);
  });

  it('prevents infinite loops between rules and never double-executes an event', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const [a, b] = board.lists;
    // A → B and B → A would ping-pong forever without depth limits.
    await owner.post('/automations', { boardId, name: 'to B', trigger: { type: 'card.moved', params: { toListId: a.id } }, actions: [{ type: 'moveCard', params: { listId: b.id } }] });
    await owner.post('/automations', { boardId, name: 'to A', trigger: { type: 'card.moved', params: { toListId: b.id } }, actions: [{ type: 'moveCard', params: { listId: a.id } }] });
    const card = (await owner.post('/cards', { boardId, listId: board.lists[2].id, title: 'Loop' })).json.card;
    await owner.post(`/cards/${card.id}/move`, { listId: a.id });
    const processed = await drainJobs(50);
    expect(processed).toBeLessThan(30);
    const acts = (await owner.get(`/cards/${card.id}/activity`)).json.activities.filter((x: any) => x.type === 'card.moved');
    expect(acts.length).toBeLessThanOrEqual(4); // 1 manual + bounded automation hops
    // Re-delivering the same event does nothing (idempotent executions).
    const { handleEvent } = await import('../jobs/automation.js');
    const { db } = await import('../deps.js');
    const { automationExecutions } = await import('../db/schema.js');
    const before = (await db().select().from(automationExecutions)).length;
    const last = (await owner.get(`/cards/${card.id}/activity`)).json.activities.find((x: any) => x.type === 'card.moved');
    await handleEvent(last.id, { type: 'card.moved', workspaceId: board.workspace.id, boardId, cardId: card.id, actor: { type: 'user', userId: owner.user.id, depth: 0 }, data: { toListId: a.id } });
    await handleEvent(last.id, { type: 'card.moved', workspaceId: board.workspace.id, boardId, cardId: card.id, actor: { type: 'user', userId: owner.user.id, depth: 0 }, data: { toListId: a.id } });
    const after = (await db().select().from(automationExecutions)).length;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('validates references and blocks card actions on cardless triggers', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const other = await workspaceWithBoard(owner, 'Other');
    expect((await owner.post('/automations', { boardId, name: 'bad', trigger: { type: 'card.created', params: {} }, actions: [{ type: 'moveCard', params: { listId: other.board.lists[0].id } }] })).status).toBe(400);
    expect((await owner.post('/automations', { boardId, name: 'bad2', trigger: { type: 'schedule', params: { time: '09:00', weekdays: [1] } }, actions: [{ type: 'archiveCard', params: {} }] })).status).toBe(400);
    expect((await owner.post('/automations', { boardId, name: 'bad3', trigger: { type: 'nope', params: {} }, actions: [{ type: 'archiveCard', params: {} }] })).status).toBe(400);
    expect((await owner.post('/automations', { boardId, name: 'ok', trigger: { type: 'schedule', params: { time: '09:00', weekdays: [1, 3] } }, actions: [{ type: 'createCard', params: { listId: board.lists[0].id, title: 'Standup {date}' } }] })).status).toBe(201);
  });

  it('runs scheduled rules exactly once per slot via the scheduler', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    const rule = (await owner.post('/automations', { boardId, name: 'Daily card', trigger: { type: 'schedule', params: { time: '09:00', weekdays: [], timezone: 'UTC' } }, actions: [{ type: 'createCard', params: { listId: board.lists[0].id, title: 'Daily {date}' } }] })).json.rule;
    const next = new Date(rule.nextRunAt);
    expect(next.getUTCHours()).toBe(9);
    const realNow = ctx.deps().now;
    ctx.setDeps({ db: ctx.deps().db, now: () => new Date(next.getTime() + 60_000) });
    try {
      await tick();
      await tick(); // second tick in the same slot must not run again
    } finally {
      ctx.setDeps({ db: ctx.deps().db, now: realNow });
    }
    const data = (await owner.get(`/boards/${boardId}`)).json;
    expect(data.cards.filter((c: any) => c.title.startsWith('Daily ')).length).toBe(1);
    const execs = (await owner.get(`/automations/${rule.id}/executions`)).json.executions;
    expect(execs).toHaveLength(1);
  });

  it('fires due.approaching once per due date and reminders without duplicates', async () => {
    const owner = await signup(app);
    const member = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    const label = board.labels[0];
    await owner.post('/automations', { boardId, name: 'Due soon label', trigger: { type: 'due.approaching', params: { hours: 48 } }, actions: [{ type: 'addLabel', params: { labelId: label.id } }] });
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Soon', dueAt: new Date(Date.now() + 3600_000).toISOString(), assigneeIds: [member.user.id] })).json.card;
    await tick();
    await tick();
    await drainJobs();
    const s = (await owner.get(`/boards/${boardId}`)).json.cards.find((c: any) => c.id === card.id);
    expect(s.labelIds).toContain(label.id);
    const notes = (await member.get('/notifications')).json.notifications.filter((n: any) => n.type === 'due_soon');
    expect(notes).toHaveLength(1);
  });

  it('records failures with an error, notifies the owner and allows retry', async () => {
    const owner = await signup(app);
    const member = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    const rule = (await owner.post('/automations', { boardId, name: 'Assign member', trigger: { type: 'card.created', params: {} }, actions: [{ type: 'assignMember', params: { userId: member.user.id } }] })).json.rule;
    // Member leaves: the action now fails.
    await member.del(`/workspaces/${workspaceId}/members/${member.user.id}`);
    await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Will fail' });
    await drainJobs();
    const execs = (await owner.get(`/automations/${rule.id}/executions`)).json.executions;
    expect(execs[0].status).toBe('failed');
    expect(execs[0].error).toMatch(/cannot be assigned/);
    const n = (await owner.get('/notifications')).json.notifications;
    expect(n.some((x: any) => x.type === 'automation' && x.title.includes('failed'))).toBe(true);
    const retry = await owner.post(`/automation-executions/${execs[0].id}/retry`);
    expect(retry.json.status).toBe('failed');
  });

  it('stops acting when the rule owner loses access', async () => {
    const owner = await signup(app);
    const member = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    const rule = (await member.post('/automations', { boardId, name: 'Member rule', trigger: { type: 'card.created', params: {} }, actions: [{ type: 'setPriority', params: { priority: 'high' } }] })).json.rule;
    await owner.patch(`/workspaces/${workspaceId}/members/${member.user.id}`, { role: 'viewer' });
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'x' })).json.card;
    await drainJobs();
    expect((await owner.get(`/cards/${card.id}`)).json.card.priority).toBe('none');
    const execs = (await owner.get(`/automations/${rule.id}/executions`)).json.executions;
    expect(execs[0].status).toBe('failed');
  });
});

describe('timezone scheduling', () => {
  it('keeps local wall time across DST transitions', () => {
    // New York: DST starts 2026-03-08, ends 2026-11-01.
    const before = computeNextRun({ time: '09:00', weekdays: [] }, 'America/New_York', new Date('2026-03-07T20:00:00Z'))!;
    const after = computeNextRun({ time: '09:00', weekdays: [] }, 'America/New_York', new Date('2026-03-08T20:00:00Z'))!;
    expect(before.toISOString()).toBe('2026-03-08T13:00:00.000Z'); // 09:00 EDT (first day of DST)
    expect(after.toISOString()).toBe('2026-03-09T13:00:00.000Z');
    const winter = computeNextRun({ time: '09:00', weekdays: [] }, 'America/New_York', new Date('2026-11-01T20:00:00Z'))!;
    expect(winter.toISOString()).toBe('2026-11-02T14:00:00.000Z'); // 09:00 EST
    expect(zonedToUtc(2026, 6, 1, 12, 0, 'Europe/London').toISOString()).toBe('2026-06-01T11:00:00.000Z');
  });

  it('respects weekdays', () => {
    // 2026-10-19 is a Monday.
    const next = computeNextRun({ time: '10:00', weekdays: [5] }, 'UTC', new Date('2026-10-19T12:00:00Z'))!;
    expect(next.toISOString()).toBe('2026-10-23T10:00:00.000Z');
    expect(computeNextRun({ time: '25:00' }, 'UTC', new Date())).toBeNull();
  });
});

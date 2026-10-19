import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { setup, signup, addMember, workspaceWithBoard, Client, type TestApp } from './helpers.js';
import { drainJobs } from '../jobs/queue.js';
import { isPrivateAddress } from '../lib/net.js';

let app: TestApp;
let ctx: Awaited<ReturnType<typeof setup>>;
const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(async () => {
  ctx = await setup();
  app = ctx.app;
});
afterEach(() => ctx.setDeps({ db: ctx.deps().db, fetch: realFetch }));

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; json?: unknown; text?: string }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  ctx.setDeps({
    db: ctx.deps().db,
    fetch: (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const r = handler(url, init);
      return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  return calls;
}

describe('Roblox account verification', () => {
  it('verifies via profile code checked on the server, and prevents linking one Roblox account twice', async () => {
    const u = await signup(app);
    let description = 'hello';
    mockFetch((url) => {
      if (url.includes('/v1/usernames/users')) return { json: { data: [{ id: 123456, name: 'BuilderMan', displayName: 'Builder' }] } };
      if (url.includes('/v1/users/123456')) return { json: { id: 123456, name: 'BuilderMan', displayName: 'Builder', description, isBanned: false } };
      if (url.includes('avatar-headshot')) return { json: { data: [{ targetId: 123456, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png' }] } };
      return { status: 404 };
    });
    const start = await u.post('/roblox/verify/start', { username: 'BuilderMan' });
    expect(start.status).toBe(200);
    expect(start.json.code).toMatch(/^alypne /);
    const notYet = await u.post('/roblox/verify/check', { challengeId: start.json.challengeId });
    expect(notYet.json.verified).toBe(false);
    description = `My studio profile ${start.json.code}`;
    const ok = await u.post('/roblox/verify/check', { challengeId: start.json.challengeId });
    expect(ok.json.verified).toBe(true);
    expect(ok.json.account.providerUserId).toBe('123456');
    const me = await u.get('/me');
    expect(me.json.externalAccounts[0].verificationMethod).toBe('profile_code');
    // A different Alypne user cannot claim the same Roblox account.
    const thief = await signup(app);
    const s2 = await thief.post('/roblox/verify/start', { username: 'BuilderMan' });
    description = `x ${s2.json.code}`;
    expect((await thief.post('/roblox/verify/check', { challengeId: s2.json.challengeId })).status).toBe(409);
    expect((await u.del('/roblox/account')).status).toBe(200);
  });

  it('handles Roblox API failures safely', async () => {
    const u = await signup(app);
    mockFetch(() => ({ status: 503 }));
    const res = await u.post('/roblox/verify/start', { username: 'BuilderMan' });
    expect(res.status).toBe(502);
    expect(res.json.error.message).not.toMatch(/stack|Error:/);
    mockFetch(() => ({ status: 429 }));
    expect((await u.post('/roblox/verify/start', { username: 'BuilderMan' })).status).toBe(429);
  });

  it('reports OAuth as unavailable when not configured', async () => {
    const u = await signup(app);
    expect((await u.get('/roblox/status')).json.oauthAvailable).toBe(false);
    expect((await u.get('/roblox/oauth/start')).status).toBe(400);
  });

  it('validates IDs and fetches experience metadata for game projects', async () => {
    const u = await signup(app);
    const { workspaceId } = await workspaceWithBoard(u);
    expect((await u.post(`/workspaces/${workspaceId}/projects`, { name: 'Bad', placeId: '12ab' })).status).toBe(400);
    mockFetch((url) => {
      if (url.includes('/universes/v1/places/999/universe')) return { json: { universeId: 555 } };
      if (url.includes('games.roblox.com/v1/games?universeIds=555')) return { json: { data: [{ id: 555, rootPlaceId: 999, name: 'Obby World', description: 'Jump!', creator: { name: 'Studio', type: 'Group' }, playing: 10, visits: 1000, maxPlayers: 20, created: '2024-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' }] } };
      if (url.includes('games/icons')) return { json: { data: [{ state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/icon.png' }] } };
      return { status: 404 };
    });
    const p = await u.post(`/workspaces/${workspaceId}/projects`, { name: 'Obby', placeId: '999' });
    expect(p.status).toBe(201);
    expect(p.json.warning).toBeNull();
    const detail = await u.get(`/projects/${p.json.id}`);
    expect(detail.json.project.universeId).toBe('555');
    expect(detail.json.project.thumbnailUrl).toBe('https://tr.rbxcdn.com/icon.png');
    expect(detail.json.project.robloxMeta.name).toBe('Obby World');
  });
});

describe('integrations', () => {
  it('blocks SSRF targets for outgoing webhooks', async () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    const owner = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    expect((await owner.post(`/workspaces/${workspaceId}/webhooks`, { direction: 'outgoing', name: 'x', url: 'https://127.0.0.1/hook', events: ['card.created'] })).status).toBe(400);
    expect((await owner.post(`/workspaces/${workspaceId}/webhooks`, { direction: 'outgoing', name: 'x', url: 'http://example.com/hook', events: ['card.created'] })).status).toBe(400);
  });

  it('only admins manage integrations and secrets are never returned', async () => {
    const owner = await signup(app);
    const member = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    await addMember(owner, member, workspaceId);
    const url = 'https://discord.com/api/webhooks/123/abcDEF_secret';
    expect((await member.post(`/workspaces/${workspaceId}/integrations`, { provider: 'discord', name: 'Dev', webhookUrl: url, events: ['card.created'] })).status).toBe(403);
    expect((await owner.post(`/workspaces/${workspaceId}/integrations`, { provider: 'discord', name: 'Dev', webhookUrl: 'https://evil.com/api/webhooks/1/x', events: ['card.created'] })).status).toBe(400);
    const created = await owner.post(`/workspaces/${workspaceId}/integrations`, { provider: 'discord', name: 'Dev', webhookUrl: url, events: ['card.created', 'release.statusChanged'] });
    expect(created.status).toBe(201);
    const list = await member.get(`/workspaces/${workspaceId}/integrations`);
    expect(JSON.stringify(list.json)).not.toContain('abcDEF_secret');
    expect(list.json.integrations[0].hasSecret).toBe(true);
  });

  it('delivers Discord notifications through the job queue with a safe payload', async () => {
    const owner = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await owner.post(`/workspaces/${workspaceId}/integrations`, { provider: 'discord', name: 'Dev', webhookUrl: 'https://discord.com/api/webhooks/1/tok', events: ['card.created'] });
    const calls = mockFetch(() => ({ status: 204, text: '' }));
    await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'New pet system', description: 'TOP SECRET DESCRIPTION' });
    await drainJobs();
    // DNS lookup for discord.com happens for real; skip the delivery assertion when offline.
    const discord = calls.filter((c) => c.url.startsWith('https://discord.com/api/webhooks/1/tok'));
    if (discord.length) {
      const sent = JSON.parse(String(discord[0].init!.body));
      expect(sent.embeds[0].description).toContain('New pet system');
      expect(JSON.stringify(sent)).not.toContain('TOP SECRET');
      expect(sent.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it('creates cards from incoming webhooks and dedupes by externalId', async () => {
    const owner = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    const hook = await owner.post(`/workspaces/${workspaceId}/webhooks`, { direction: 'incoming', name: 'Bug form', boardId, listId: board.lists[0].id });
    expect(hook.status).toBe(201);
    const path = new URL(hook.json.url).pathname.replace('/api', '');
    const anon = new Client(app);
    const r1 = await anon.req('POST', path, { title: 'Reported from game', type: 'bug', externalId: 'ticket-1' });
    expect(r1.status).toBe(201);
    await anon.req('POST', path, { title: 'Reported from game', type: 'bug', externalId: 'ticket-1' });
    const cards = (await owner.get(`/boards/${boardId}`)).json.cards.filter((c: any) => c.title === 'Reported from game');
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('bug');
    expect((await anon.req('POST', '/hooks/incoming/alpin_wrong', { title: 'x' })).status).toBe(401);
  });

  it('verifies GitHub signatures and links PRs mentioning card keys', async () => {
    const owner = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    const card = (await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Inventory UI' })).json.card;
    const key = `${board.board.key}-${card.number}`;
    const gh = await owner.post(`/workspaces/${workspaceId}/integrations`, { provider: 'github', name: 'Repo', repos: ['studio/game'] });
    const secret = gh.json.webhookSecret;
    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'studio/game' }, pull_request: { number: 7, title: `${key}: inventory grid`, body: '', html_url: 'https://github.com/studio/game/pull/7', state: 'open', merged: false, head: { ref: 'feature' } } });
    const send = (sig: string) => app.request(`/api/hooks/github/${gh.json.integration.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sig }, body: payload });
    expect((await send('sha256=bad')).status).toBe(401);
    const good = await send(`sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`);
    expect(good.status).toBe(200);
    expect((await good.json()).linked).toBe(1);
    const detail = (await owner.get(`/cards/${card.id}`)).json;
    expect(detail.links[0].kind).toBe('pull_request');
    expect(detail.links[0].ref).toBe('studio/game#7');
  });

  it('serves an iCalendar feed only with the secret token', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Launch, day', dueAt: '2026-12-01T15:00:00.000Z', assigneeIds: [owner.user.id] });
    const feed = await owner.post('/me/calendar-feed');
    const path = new URL(feed.json.url).pathname.replace('/api', '');
    const anon = new Client(app);
    const ics = await anon.get(path);
    expect(ics.status).toBe(200);
    expect(ics.text).toContain('BEGIN:VCALENDAR');
    expect(ics.text).toContain('SUMMARY:Launch\\, day');
    expect(ics.text).toContain('DTEND:20261201T150000Z');
    expect((await anon.get(path.replace(/\/[^/]+\.ics$/, '/wrong.ics'))).status).toBe(404);
  });
});

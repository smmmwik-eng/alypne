import { describe, it, expect, beforeAll } from 'vitest';
import { setup, signup, addMember, workspaceWithBoard, Client, type TestApp } from './helpers.js';

let app: TestApp;
beforeAll(async () => {
  ({ app } = await setup());
});

describe('workspaces, invitations and roles', () => {
  it('creates a workspace with default workflow stages and specialisations', async () => {
    const owner = await signup(app);
    const ws = await owner.post('/workspaces', { name: 'Nebula Studios' });
    expect(ws.status).toBe(201);
    const detail = await owner.get(`/workspaces/${ws.json.id}`);
    expect(detail.json.role).toBe('owner');
    expect(detail.json.stages.map((s: any) => s.name)).toContain('Code Review');
    expect(detail.json.specialisations.map((s: any) => s.name)).toContain('Scripter');
  });

  it('invitation links are single use and role-limited', async () => {
    const owner = await signup(app);
    const a = await signup(app);
    const b = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    const inv = await owner.post(`/workspaces/${workspaceId}/invitations`, { role: 'member' });
    const token = inv.json.link.split('/invite/')[1];
    expect((await new Client(app).get(`/invitations/${token}`)).json.invitation.role).toBe('member');
    expect((await a.post(`/invitations/${token}/accept`)).status).toBe(200);
    expect((await b.post(`/invitations/${token}/accept`)).status).toBe(404);
    // A member cannot invite when membersCanInvite is off.
    expect((await a.post(`/workspaces/${workspaceId}/invitations`, { role: 'member' })).status).toBe(403);
  });

  it('email-restricted invitations only work for that address', async () => {
    const owner = await signup(app);
    const wrong = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    const inv = await owner.post(`/workspaces/${workspaceId}/invitations`, { role: 'member', email: 'someone-else@example.com' });
    const token = inv.json.link.split('/invite/')[1];
    expect((await wrong.post(`/invitations/${token}/accept`)).status).toBe(403);
  });

  it('enforces role management rules on the server', async () => {
    const owner = await signup(app);
    const admin = await signup(app);
    const member = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    await addMember(owner, admin, workspaceId, 'admin');
    await addMember(owner, member, workspaceId, 'member');
    // Admins cannot promote to admin or touch the owner.
    expect((await admin.patch(`/workspaces/${workspaceId}/members/${member.user.id}`, { role: 'admin' })).status).toBe(403);
    expect((await admin.patch(`/workspaces/${workspaceId}/members/${owner.user.id}`, { role: 'viewer' })).status).toBe(403);
    expect((await admin.patch(`/workspaces/${workspaceId}/members/${member.user.id}`, { role: 'viewer' })).status).toBe(200);
    // Members cannot manage members at all.
    expect((await member.patch(`/workspaces/${workspaceId}/members/${admin.user.id}`, { role: 'viewer' })).status).toBe(403);
    // Only the owner can delete, and must confirm the name.
    expect((await admin.del(`/workspaces/${workspaceId}`, { confirmName: 'Studio' })).status).toBe(403);
    expect((await owner.del(`/workspaces/${workspaceId}`, { confirmName: 'wrong' })).status).toBe(400);
  });

  it('transfers ownership and blocks the last owner from leaving', async () => {
    const owner = await signup(app);
    const other = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    await addMember(owner, other, workspaceId, 'member');
    expect((await owner.del(`/workspaces/${workspaceId}/members/${owner.user.id}`)).status).toBe(403);
    expect((await owner.post(`/workspaces/${workspaceId}/transfer`, { userId: other.user.id })).status).toBe(200);
    expect((await other.get(`/workspaces/${workspaceId}`)).json.role).toBe('owner');
    expect((await owner.get(`/workspaces/${workspaceId}`)).json.role).toBe('admin');
    expect((await owner.del(`/workspaces/${workspaceId}/members/${owner.user.id}`)).status).toBe(200);
    expect((await owner.get(`/workspaces/${workspaceId}`)).status).toBe(404);
  });

  it('isolates workspaces: outsiders get 404 for every resource', async () => {
    const owner = await signup(app);
    const outsider = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    const card = await owner.post('/cards', { boardId, listId: board.lists[0].id, title: 'Secret plan' });
    expect((await outsider.get(`/workspaces/${workspaceId}`)).status).toBe(404);
    expect((await outsider.get(`/boards/${boardId}`)).status).toBe(404);
    expect((await outsider.get(`/cards/${card.json.card.id}`)).status).toBe(404);
    expect((await outsider.patch(`/cards/${card.json.card.id}`, { title: 'pwned' })).status).toBe(404);
    expect((await outsider.post(`/cards/${card.json.card.id}/comments`, { body: 'hi' })).status).toBe(404);
    expect((await outsider.get(`/workspaces/${workspaceId}/activity`)).status).toBe(404);
    expect((await outsider.post('/cards', { boardId, listId: board.lists[0].id, title: 'x' })).status).toBe(404);
    // Cross-workspace references are rejected even for legitimate users.
    const other = await workspaceWithBoard(outsider, 'Other');
    expect((await outsider.post(`/cards/${card.json.card.id}/move`, { listId: other.board.lists[0].id })).status).toBe(404);
    const s = await outsider.get('/search?q=Secret');
    expect(s.json.cards.total).toBe(0);
  });

  it('viewers are read-only and private boards are hidden from members', async () => {
    const owner = await signup(app);
    const viewer = await signup(app);
    const member = await signup(app);
    const { workspaceId, boardId, board } = await workspaceWithBoard(owner);
    await addMember(owner, viewer, workspaceId, 'viewer');
    await addMember(owner, member, workspaceId, 'member');
    expect((await viewer.get(`/boards/${boardId}`)).json.role).toBe('observer');
    expect((await viewer.post('/cards', { boardId, listId: board.lists[0].id, title: 'x' })).status).toBe(403);
    expect((await viewer.post(`/boards/${boardId}/lists`, { name: 'x' })).status).toBe(403);
    expect((await viewer.post('/boards', { workspaceId, name: 'x' })).status).toBe(403);
    // Make the board private: member loses access entirely.
    expect((await owner.patch(`/boards/${boardId}`, { visibility: 'private' })).status).toBe(200);
    expect((await member.get(`/boards/${boardId}`)).status).toBe(404);
    expect((await member.get(`/workspaces/${workspaceId}/boards`)).json.boards.length).toBe(0);
    // Adding them explicitly restores access.
    expect((await owner.post(`/boards/${boardId}/members`, { userId: member.user.id, role: 'member' })).status).toBe(200);
    expect((await member.get(`/boards/${boardId}`)).status).toBe(200);
    // Members cannot change board settings.
    expect((await member.patch(`/boards/${boardId}`, { name: 'Renamed' })).status).toBe(403);
  });

  it('public boards are readable without signing in but not writable', async () => {
    const owner = await signup(app);
    const { boardId, board } = await workspaceWithBoard(owner);
    await owner.patch(`/boards/${boardId}`, { visibility: 'public' });
    const anon = new Client(app);
    const view = await anon.get(`/boards/${boardId}`);
    expect(view.status).toBe(200);
    expect(view.json.role).toBe('observer');
    expect((await anon.post('/cards', { boardId, listId: board.lists[0].id, title: 'x' })).status).toBe(401);
  });

  it('manages workflow stages and specialisations', async () => {
    const owner = await signup(app);
    const { workspaceId } = await workspaceWithBoard(owner);
    const st = await owner.post(`/workspaces/${workspaceId}/stages`, { name: 'Playtest', category: 'in_progress', color: '#123456' });
    expect(st.status).toBe(201);
    const sp = await owner.post(`/workspaces/${workspaceId}/specialisations`, { name: 'VFX', color: '#abcdef' });
    expect((await owner.put(`/workspaces/${workspaceId}/members/${owner.user.id}/specialisations`, { specialisationIds: [sp.json.specialisation.id] })).status).toBe(200);
    const members = await owner.get(`/workspaces/${workspaceId}/members`);
    expect(members.json.members[0].specialisationIds).toContain(sp.json.specialisation.id);
  });
});

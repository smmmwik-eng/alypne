import { describe, it, expect, beforeAll } from 'vitest';
import { setup, signup, Client, type TestApp } from './helpers.js';
import { devOutbox } from '../lib/mailer.js';

let app: TestApp;
beforeAll(async () => {
  ({ app } = await setup());
});

describe('authentication', () => {
  it('signs up, reads the session and signs out', async () => {
    const c = await signup(app, 'alice');
    expect(c.user.username).toBe('alice');
    const me = await c.get('/me');
    expect(me.status).toBe(200);
    expect(me.json.user).not.toHaveProperty('passwordHash');
    await c.post('/auth/signout');
    expect((await c.get('/me')).status).toBe(401);
  });

  it('rejects duplicate emails and usernames (case-insensitive)', async () => {
    await signup(app, 'bob');
    const c = new Client(app);
    const dupe = await c.post('/auth/signup', { email: 'BOB@example.com', username: 'other', displayName: 'x', password: 'longenough1' });
    expect(dupe.status).toBe(409);
    const dupe2 = await c.post('/auth/signup', { email: 'new@example.com', username: 'BOB', displayName: 'x', password: 'longenough1' });
    expect(dupe2.status).toBe(409);
  });

  it('validates input', async () => {
    const c = new Client(app);
    expect((await c.post('/auth/signup', { email: 'bad', username: 'ok_name', displayName: 'x', password: 'longenough1' })).status).toBe(400);
    expect((await c.post('/auth/signup', { email: 'a@b.co', username: 'bad name!', displayName: 'x', password: 'longenough1' })).status).toBe(400);
    expect((await c.post('/auth/signup', { email: 'a@b.co', username: 'okname', displayName: 'x', password: 'short' })).status).toBe(400);
  });

  it('signs in with email or username and rejects wrong passwords', async () => {
    await signup(app, 'carol');
    const c = new Client(app);
    expect((await c.post('/auth/signin', { identifier: 'carol', password: 'nope-nope' })).status).toBe(401);
    expect((await c.post('/auth/signin', { identifier: 'CAROL@example.com', password: 'correct horse battery' })).status).toBe(200);
    expect((await c.get('/me')).status).toBe(200);
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const c = await signup(app, 'dave');
    const res = await app.request('/api/workspaces', { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X' }) });
    expect(res.status).toBe(403);
    const cross = await app.request('/api/workspaces', { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-alypne-client': 'web', origin: 'https://evil.example', host: 'localhost' }, body: JSON.stringify({ name: 'X' }) });
    expect(cross.status).toBe(403);
  });

  it('resets a password with a single-use emailed token and revokes sessions', async () => {
    const c = await signup(app, 'erin');
    const anon = new Client(app);
    devOutbox.length = 0;
    expect((await anon.post('/auth/forgot-password', { email: 'erin@example.com' })).status).toBe(200);
    // Unknown emails get the same response (no account enumeration).
    expect((await anon.post('/auth/forgot-password', { email: 'nobody@example.com' })).status).toBe(200);
    const mail = devOutbox.find((m) => m.to === 'erin@example.com');
    const token = /token=([^\s&"]+)/.exec(mail!.text)![1];
    const reset = await anon.post('/auth/reset-password', { token: decodeURIComponent(token), password: 'brand new password' });
    expect(reset.status).toBe(200);
    expect((await anon.post('/auth/reset-password', { token: decodeURIComponent(token), password: 'another one!!' })).status).toBe(400);
    expect((await c.get('/me')).status).toBe(401); // old session revoked
    const again = new Client(app);
    expect((await again.post('/auth/signin', { identifier: 'erin', password: 'brand new password' })).status).toBe(200);
  });

  it('verifies email addresses', async () => {
    devOutbox.length = 0;
    const c = await signup(app, 'frank');
    const mail = devOutbox.find((m) => m.to === 'frank@example.com');
    const token = decodeURIComponent(/token=([^\s&"]+)/.exec(mail!.text)![1]);
    expect((await c.post('/auth/verify-email', { token })).status).toBe(200);
    const me = await c.get('/me');
    expect(me.json.user.emailVerifiedAt).toBeTruthy();
  });

  it('lists and revokes sessions, changes password', async () => {
    const c = await signup(app, 'gina');
    const other = new Client(app);
    await other.post('/auth/signin', { identifier: 'gina', password: 'correct horse battery' });
    const list = await c.get('/me/sessions');
    expect(list.json.sessions.length).toBe(2);
    await c.post('/me/sessions/revoke-others');
    expect((await other.get('/me')).status).toBe(401);
    expect((await c.post('/me/password', { currentPassword: 'wrong', newPassword: 'whatever123' })).status).toBe(403);
    expect((await c.post('/me/password', { currentPassword: 'correct horse battery', newPassword: 'whatever123' })).status).toBe(200);
  });

  it('issues API tokens that authenticate with Bearer and respect read-only scope', async () => {
    const c = await signup(app, 'hank');
    const tok = await c.post('/me/tokens', { name: 'CI', scopes: ['read'] });
    expect(tok.status).toBe(201);
    const read = await app.request('/api/me', { headers: { authorization: `Bearer ${tok.json.token}` } });
    expect(read.status).toBe(200);
    const write = await app.request('/api/workspaces', { method: 'POST', headers: { authorization: `Bearer ${tok.json.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nope' }) });
    expect(write.status).toBe(403);
    const bad = await app.request('/api/me', { headers: { authorization: 'Bearer alp_invalid' } });
    expect(bad.status).toBe(401);
  });

  it('deletes an account after confirmation and exports data', async () => {
    const c = await signup(app, 'ivy');
    await c.post('/workspaces', { name: 'Solo' });
    const exp = await c.get('/me/export');
    expect(exp.status).toBe(200);
    expect(exp.json.format).toBe('alypne.account.v1');
    expect(JSON.stringify(exp.json)).not.toContain('passwordHash');
    expect((await c.post('/me/delete', { password: 'wrong', confirm: 'DELETE' })).status).toBe(403);
    expect((await c.post('/me/delete', { password: 'correct horse battery', confirm: 'DELETE' })).status).toBe(200);
    const again = new Client(app);
    expect((await again.post('/auth/signin', { identifier: 'ivy', password: 'correct horse battery' })).status).toBe(401);
  });
});

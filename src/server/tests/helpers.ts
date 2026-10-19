import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.ALYPNE_DISABLE_RATE_LIMIT = 'true';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'alypne-test-'));

const { boot } = await import('../boot.js');
const { createApp } = await import('../app.js');
const { setDeps, deps } = await import('../deps.js');

export type TestApp = ReturnType<typeof createApp>;

export async function setup() {
  const database = await boot('pglite:memory');
  const app = createApp();
  return { app, database, setDeps, deps };
}

export class Client {
  cookie = '';
  constructor(
    private app: TestApp,
    public user: { id: string; username: string; email: string } = { id: '', username: '', email: '' },
  ) {}

  async req<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T; headers: Headers; text: string }> {
    const init: RequestInit = { method, headers: { 'x-alypne-client': 'web', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await this.app.request(`/api${url}`, init);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = /alypne_session=([^;]*)/.exec(setCookie);
      if (m) this.cookie = m[1] ? `alypne_session=${m[1]}` : '';
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers, text };
  }
  get = <T = any>(url: string) => this.req<T>('GET', url);
  post = <T = any>(url: string, body?: unknown, headers?: Record<string, string>) => this.req<T>('POST', url, body ?? {}, headers);
  patch = <T = any>(url: string, body?: unknown) => this.req<T>('PATCH', url, body ?? {});
  put = <T = any>(url: string, body?: unknown) => this.req<T>('PUT', url, body ?? {});
  del = <T = any>(url: string, body?: unknown) => this.req<T>('DELETE', url, body);
}

let n = 0;
export async function signup(app: TestApp, name?: string): Promise<Client> {
  const username = name ?? `user${++n}_${Math.random().toString(36).slice(2, 6)}`;
  const c = new Client(app);
  const res = await c.post('/auth/signup', { email: `${username}@example.com`, username, displayName: username, password: 'correct horse battery' });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
  const me = await c.get('/auth/me');
  c.user = me.json.user;
  return c;
}

/** Create a workspace + board with default lists. */
export async function workspaceWithBoard(owner: Client, name = 'Studio') {
  const ws = await owner.post('/workspaces', { name });
  const board = await owner.post('/boards', { workspaceId: ws.json.id, name: 'Game Dev' });
  const data = await owner.get(`/boards/${board.json.id}`);
  return { workspaceId: ws.json.id as string, boardId: board.json.id as string, board: data.json };
}

/** Invite and accept so `member` joins the owner's workspace with the given role. */
export async function addMember(owner: Client, member: Client, workspaceId: string, role: 'admin' | 'member' | 'viewer' = 'member') {
  const inv = await owner.post(`/workspaces/${workspaceId}/invitations`, { role });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${inv.text}`);
  const token = inv.json.link.split('/invite/')[1];
  const acc = await member.post(`/invitations/${token}/accept`);
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${acc.text}`);
}

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { users, sessions, apiTokens, auditLogs } from '../db/schema.js';
import { newId, randomToken, sha256 } from './crypto.js';
import { env } from '../env.js';
import { forbidden, unauthorized } from './errors.js';
import { clientIp } from './request.js';

export const SESSION_COOKIE = 'alypne_session';
const SESSION_DAYS = 30;

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
  timezone: string;
  theme: string;
}

export type AppEnv = {
  Variables: {
    user: AuthUser | null;
    sessionId: string | null;
    authVia: 'cookie' | 'token' | null;
    tokenScopes: string[] | null;
  };
};

export async function createSession(c: Context, userId: string): Promise<string> {
  const token = randomToken(32);
  const now = deps().now();
  const id = newId();
  await db()
    .insert(sessions)
    .values({
      id,
      userId,
      tokenHash: sha256(token),
      userAgent: (c.req.header('user-agent') ?? '').slice(0, 300),
      ip: clientIp(c),
      expiresAt: new Date(now.getTime() + SESSION_DAYS * 86400_000),
    });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  return id;
}

export async function destroySession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db().delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

const userColumns = {
  id: users.id,
  email: users.email,
  username: users.username,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  emailVerifiedAt: users.emailVerifiedAt,
  timezone: users.timezone,
  theme: users.theme,
};

export async function userFromSessionToken(token: string): Promise<{ user: AuthUser; sessionId: string } | null> {
  const now = deps().now();
  const rows = await db()
    .select({ ...userColumns, sessionId: sessions.id, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, now), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (now.getTime() - row.lastSeenAt.getTime() > 5 * 60_000) {
    await db().update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
  }
  const { sessionId, lastSeenAt: _l, ...user } = row;
  return { user, sessionId };
}

async function userFromApiToken(token: string): Promise<{ user: AuthUser; scopes: string[] } | null> {
  const now = deps().now();
  const rows = await db()
    .select({ ...userColumns, tokenId: apiTokens.id, scopes: apiTokens.scopes, expiresAt: apiTokens.expiresAt })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row || (row.expiresAt && row.expiresAt <= now)) return null;
  await db().update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.tokenId));
  const { tokenId: _t, scopes, expiresAt: _e, ...user } = row;
  return { user, scopes };
}

/**
 * Resolves the current user from a session cookie or a `Bearer alp_...` API token.
 * Enforces CSRF protection for cookie-authenticated unsafe requests: the request must
 * carry the `X-Alypne-Client` header (which cross-site forms cannot set without a CORS
 * preflight that we never grant) and, when present, a same-origin `Origin` header.
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  c.set('sessionId', null);
  c.set('authVia', null);
  c.set('tokenScopes', null);

  const authz = c.req.header('authorization');
  if (authz?.startsWith('Bearer ')) {
    const res = await userFromApiToken(authz.slice(7).trim());
    if (!res) throw unauthorized('Invalid or expired API token');
    c.set('user', res.user);
    c.set('authVia', 'token');
    c.set('tokenScopes', res.scopes);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !res.scopes.includes('write')) {
      throw forbidden('This API token is read-only');
    }
    return next();
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const res = await userFromSessionToken(token);
    if (res) {
      c.set('user', res.user);
      c.set('sessionId', res.sessionId);
      c.set('authVia', 'cookie');
    }
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !c.req.path.startsWith('/api/hooks/')) {
    if (c.req.header('x-alypne-client') !== 'web') throw forbidden('Missing client header (CSRF protection)');
    const origin = c.req.header('origin');
    if (origin) {
      const host = c.req.header('host');
      let ok = false;
      try {
        const o = new URL(origin);
        ok = o.host === host || origin === new URL(env.appUrl).origin;
      } catch {
        ok = false;
      }
      if (!ok) throw forbidden('Cross-origin request rejected');
    }
  }
  await next();
};

export function requireUser(c: Context<AppEnv>): AuthUser {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export async function audit(c: Context<AppEnv> | null, entry: { userId?: string | null; workspaceId?: string | null; action: string; targetType?: string; targetId?: string; data?: Record<string, unknown> }) {
  await db()
    .insert(auditLogs)
    .values({
      id: newId(),
      userId: entry.userId ?? c?.get('user')?.id ?? null,
      workspaceId: entry.workspaceId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? '',
      targetId: entry.targetId ?? '',
      ip: c ? clientIp(c) : '',
      data: entry.data ?? {},
    });
}

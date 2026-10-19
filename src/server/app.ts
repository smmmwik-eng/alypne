import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { type AppEnv, authMiddleware } from './lib/auth.js';
import { errorHandler, notFound } from './lib/errors.js';
import { db } from './deps.js';
import { idempotencyKeys } from './db/schema.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { workspaceRoutes, invitationRoutes } from './routes/workspaces.js';
import { boardRoutes } from './routes/boards.js';
import { listRoutes } from './routes/lists.js';
import { cardRoutes, checklistRoutes } from './routes/cards.js';
import { fileRoutes } from './routes/files.js';
import { notificationRoutes } from './routes/notifications.js';
import { searchRoutes } from './routes/search.js';
import { automationRoutes } from './routes/automations.js';
import { templateRoutes } from './routes/templates.js';
import { robloxRoutes } from './routes/roblox.js';
import { studioRoutes } from './routes/studio.js';
import { integrationRoutes, hookRoutes } from './routes/integrations.js';
import { importExportRoutes } from './routes/importExport.js';
import { reportRoutes, calendarRoutes } from './routes/reports.js';
import { env } from './env.js';
import './jobs/automation.js';
import './jobs/scheduler.js';
import './jobs/integrations.js';

/**
 * Replays the stored response for a repeated `Idempotency-Key` on unsafe requests,
 * so a client retry after a network failure never applies an action twice.
 */
const idempotency = async (c: any, next: () => Promise<void>) => {
  const key = c.req.header('idempotency-key');
  const user = c.get('user');
  if (!key || !user || c.req.method === 'GET' || key.length > 100) return next();
  const [prev] = await db()
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, user.id), eq(idempotencyKeys.key, key)));
  if (prev) {
    if (prev.route !== `${c.req.method} ${c.req.path}`) return c.json({ error: { code: 'idempotency_mismatch', message: 'Idempotency key reused for a different request' } }, 422);
    return c.json(prev.body, prev.status);
  }
  await next();
  const res: Response = c.res;
  if (res.status < 500 && res.headers.get('content-type')?.includes('application/json')) {
    const payload = await res.clone().json().catch(() => null);
    await db()
      .insert(idempotencyKeys)
      .values({ key, userId: user.id, route: `${c.req.method} ${c.req.path}`, status: res.status, body: payload })
      .onConflictDoNothing();
  }
};

export function createApp() {
  const api = new Hono<AppEnv>()
    .use('*', authMiddleware)
    .use('*', idempotency)
    .route('/auth', authRoutes)
    .route('/me', meRoutes)
    .route('/workspaces', workspaceRoutes)
    .route('/invitations', invitationRoutes)
    .route('/boards', boardRoutes)
    .route('/lists', listRoutes)
    .route('/cards', cardRoutes)
    .route('/', checklistRoutes)
    .route('/', fileRoutes)
    .route('/notifications', notificationRoutes)
    .route('/search', searchRoutes)
    .route('/', automationRoutes)
    .route('/', templateRoutes)
    .route('/roblox', robloxRoutes)
    .route('/', studioRoutes)
    .route('/', integrationRoutes)
    .route('/hooks', hookRoutes)
    .route('/', importExportRoutes)
    .route('/', reportRoutes)
    .route('/calendar', calendarRoutes)
    .get('/health', (c) => c.json({ ok: true }))
    .all('*', () => {
      throw notFound('Endpoint');
    });

  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.rbxcdn.com'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      referrerPolicy: 'strict-origin-when-cross-origin',
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Imports and attachments get larger bodies; everything else is small JSON.
  app.use('/api/*', async (c, next) => {
    const big = /\/(attachments|import\/|avatar|logo)/.test(c.req.path);
    return bodyLimit({ maxSize: big ? Math.max(env.uploadMaxBytes + 1024 * 1024, 30 * 1024 * 1024) : 2 * 1024 * 1024 })(c, next);
  });
  app.route('/api', api);

  // Production: serve the built SPA with history fallback.
  const clientDir = path.resolve(process.cwd(), 'dist/client');
  if (existsSync(path.join(clientDir, 'index.html'))) {
    const indexHtml = readFileSync(path.join(clientDir, 'index.html'), 'utf8');
    const root = path.relative(process.cwd(), clientDir);
    app.use('/assets/*', serveStatic({ root, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.use('*', serveStatic({ root }));
    app.get('*', (c) => c.html(indexHtml));
  }
  return app;
}

export type App = ReturnType<typeof createApp>;

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { integrations, webhooks, webhookDeliveries, lists, boards, cards, cardLinks } from '../db/schema.js';
import { type AppEnv, audit, requireUser } from '../lib/auth.js';
import { decryptSecret, encryptSecret, hmacHex, newId, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { boardAccess, requireWorkspace } from '../lib/access.js';
import { INTEGRATION_EVENTS, emit } from '../lib/events.js';
import { assertPublicUrl } from '../lib/net.js';
import { deliverDiscord, deliverWebhook, type EventPayload } from '../jobs/integrations.js';
import { mailConfigured } from '../lib/mailer.js';
import { env } from '../env.js';
import { createCard } from '../services/cards.js';
import { rateLimit } from '../lib/rateLimit.js';
import { boardRoleAtLeast } from '../../shared/constants.js';

const eventsSchema = z.array(z.enum(INTEGRATION_EVENTS)).max(INTEGRATION_EVENTS.length);
const DISCORD_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function testPayload(workspaceId: string): EventPayload {
  return { id: newId(), type: 'test', createdAt: deps().now().toISOString(), workspaceId, board: null, card: null, actor: { type: 'system', id: null, name: 'Alypne' }, data: {} };
}

/** Never return secrets: replace with presence flags. */
function publicIntegration(i: typeof integrations.$inferSelect) {
  const { secretEnc, ...rest } = i;
  return { ...rest, hasSecret: !!secretEnc, hookUrl: i.provider === 'github' || i.provider === 'gitlab' ? `${env.appUrl}/api/hooks/${i.provider}/${i.id}` : null };
}
function publicWebhook(w: typeof webhooks.$inferSelect) {
  const { secretEnc, tokenHash, ...rest } = w;
  return { ...rest, hasSecret: !!secretEnc || !!tokenHash };
}

export const integrationRoutes = new Hono<AppEnv>()
  .get('/workspaces/:id/integrations', async (c) => {
    const me = requireUser(c);
    const { workspace, role } = await requireWorkspace(me.id, c.req.param('id'));
    const ints = await db().select().from(integrations).where(eq(integrations.workspaceId, workspace.id)).orderBy(desc(integrations.createdAt));
    const hooks = await db().select().from(webhooks).where(eq(webhooks.workspaceId, workspace.id)).orderBy(desc(webhooks.createdAt));
    return c.json({
      role,
      integrations: ints.map(publicIntegration),
      webhooks: hooks.map(publicWebhook),
      instance: {
        email: mailConfigured(),
        robloxOAuth: !!(env.robloxClientId && env.robloxClientSecret),
        githubToken: !!env.githubToken,
        appUrl: env.appUrl,
      },
      events: INTEGRATION_EVENTS,
    });
  })

  .post('/workspaces/:id/integrations', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const input = await body(
      c,
      z.discriminatedUnion('provider', [
        z.object({ provider: z.literal('discord'), name: z.string().trim().min(1).max(60), webhookUrl: z.string().trim().regex(DISCORD_RE, 'Paste a Discord webhook URL (Server Settings → Integrations → Webhooks)'), events: eventsSchema.min(1), boardIds: z.array(z.string()).max(50).default([]) }),
        z.object({ provider: z.literal('github'), name: z.string().trim().min(1).max(60), repos: z.array(z.string().regex(REPO_RE, 'Use owner/repository')).max(50).default([]), token: z.string().trim().max(200).optional() }),
        z.object({ provider: z.literal('gitlab'), name: z.string().trim().min(1).max(60), projects: z.array(z.string().max(200)).max(50).default([]) }),
      ]),
    );
    let config: Record<string, unknown> = {};
    let secret: string | null = null;
    let reveal: Record<string, string> = {};
    if (input.provider === 'discord') {
      for (const b of input.boardIds) {
        const [row] = await db().select().from(boards).where(and(eq(boards.id, b), eq(boards.workspaceId, workspace.id)));
        if (!row) throw badRequest('Unknown board in filter');
      }
      config = { boardIds: input.boardIds };
      secret = input.webhookUrl;
    } else if (input.provider === 'github') {
      const webhookSecret = randomToken(24);
      config = { repos: input.repos };
      secret = JSON.stringify({ token: input.token || null, webhookSecret });
      reveal = { webhookSecret };
    } else {
      const webhookToken = randomToken(24);
      config = { projects: input.projects };
      secret = JSON.stringify({ webhookToken });
      reveal = { webhookToken };
    }
    const [row] = await db()
      .insert(integrations)
      .values({ id: newId(), workspaceId: workspace.id, provider: input.provider, name: input.name, config, secretEnc: encryptSecret(secret), events: input.provider === 'discord' ? input.events : [], createdById: me.id })
      .returning();
    await audit(c, { workspaceId: workspace.id, action: 'integration.connected', targetType: input.provider, targetId: row.id });
    return c.json({ integration: publicIntegration(row), ...reveal }, 201);
  })

  .patch('/integrations/:id', async (c) => {
    const me = requireUser(c);
    const [int] = await db().select().from(integrations).where(eq(integrations.id, c.req.param('id')));
    if (!int) throw notFound('Integration');
    await requireWorkspace(me.id, int.workspaceId, 'admin');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(60).optional(), events: eventsSchema.optional(), enabled: z.boolean().optional(), boardIds: z.array(z.string()).optional(), repos: z.array(z.string().regex(REPO_RE)).optional(), webhookUrl: z.string().regex(DISCORD_RE).optional() }));
    const config = { ...int.config };
    if (input.boardIds) config.boardIds = input.boardIds;
    if (input.repos) config.repos = input.repos;
    const [row] = await db()
      .update(integrations)
      .set({
        name: input.name,
        events: input.events,
        config,
        status: input.enabled === undefined ? undefined : input.enabled ? 'active' : 'disabled',
        secretEnc: input.webhookUrl ? encryptSecret(input.webhookUrl) : undefined,
        updatedAt: deps().now(),
      })
      .where(eq(integrations.id, int.id))
      .returning();
    return c.json({ integration: publicIntegration(row) });
  })

  .delete('/integrations/:id', async (c) => {
    const me = requireUser(c);
    const [int] = await db().select().from(integrations).where(eq(integrations.id, c.req.param('id')));
    if (!int) throw notFound('Integration');
    await requireWorkspace(me.id, int.workspaceId, 'admin');
    await db().delete(integrations).where(eq(integrations.id, int.id));
    await audit(c, { workspaceId: int.workspaceId, action: 'integration.disconnected', targetType: int.provider, targetId: int.id });
    return c.json({ ok: true });
  })

  .post('/integrations/:id/test', rateLimit('int-test', 20, 3600_000), async (c) => {
    const me = requireUser(c);
    const [int] = await db().select().from(integrations).where(eq(integrations.id, c.req.param('id')));
    if (!int) throw notFound('Integration');
    await requireWorkspace(me.id, int.workspaceId, 'admin');
    if (int.provider !== 'discord') throw badRequest('Only Discord integrations can send test messages. GitHub/GitLab connect via their webhook settings.');
    try {
      const res = await deliverDiscord(int.id, testPayload(int.workspaceId));
      return c.json({ ok: !!res?.ok, status: res?.status ?? null, message: res?.ok ? 'Test message delivered' : `Discord responded ${res?.status}` });
    } catch (e: any) {
      return c.json({ ok: false, message: e?.message ?? 'Delivery failed' });
    }
  })

  .get('/integrations/:id/deliveries', async (c) => {
    const me = requireUser(c);
    const [int] = await db().select().from(integrations).where(eq(integrations.id, c.req.param('id')));
    if (!int) throw notFound('Integration');
    await requireWorkspace(me.id, int.workspaceId, 'admin');
    return c.json({ deliveries: await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.integrationId, int.id)).orderBy(desc(webhookDeliveries.createdAt)).limit(50) });
  })

  /* ------------------------------------------------------------ webhooks */
  .post('/workspaces/:id/webhooks', async (c) => {
    const me = requireUser(c);
    const { workspace } = await requireWorkspace(me.id, c.req.param('id'), 'admin');
    const input = await body(
      c,
      z.discriminatedUnion('direction', [
        z.object({ direction: z.literal('outgoing'), name: z.string().trim().min(1).max(60), url: z.string().url().max(2000), events: eventsSchema.min(1), boardId: z.string().nullable().optional() }),
        z.object({ direction: z.literal('incoming'), name: z.string().trim().min(1).max(60), boardId: z.string(), listId: z.string() }),
      ]),
    );
    if (input.boardId) {
      const [b] = await db().select().from(boards).where(and(eq(boards.id, input.boardId), eq(boards.workspaceId, workspace.id)));
      if (!b) throw badRequest('Board not found in this workspace');
    }
    if (input.direction === 'outgoing') {
      await assertPublicUrl(input.url);
      const secret = randomToken(24);
      const [row] = await db()
        .insert(webhooks)
        .values({ id: newId(), workspaceId: workspace.id, boardId: input.boardId ?? null, direction: 'outgoing', name: input.name, url: input.url, secretEnc: encryptSecret(secret), events: input.events, createdById: me.id })
        .returning();
      await audit(c, { workspaceId: workspace.id, action: 'webhook.created', targetId: row.id, data: { direction: 'outgoing' } });
      return c.json({ webhook: publicWebhook(row), secret }, 201);
    }
    const [list] = await db().select().from(lists).where(and(eq(lists.id, input.listId), eq(lists.boardId, input.boardId)));
    if (!list) throw badRequest('List not found on that board');
    const token = `alpin_${randomToken(24)}`;
    const [row] = await db()
      .insert(webhooks)
      .values({ id: newId(), workspaceId: workspace.id, boardId: input.boardId, direction: 'incoming', name: input.name, tokenHash: sha256(token), targetListId: list.id, events: [], createdById: me.id })
      .returning();
    await audit(c, { workspaceId: workspace.id, action: 'webhook.created', targetId: row.id, data: { direction: 'incoming' } });
    return c.json({ webhook: publicWebhook(row), url: `${env.appUrl}/api/hooks/incoming/${token}` }, 201);
  })

  .patch('/webhooks/:id', async (c) => {
    const me = requireUser(c);
    const [hook] = await db().select().from(webhooks).where(eq(webhooks.id, c.req.param('id')));
    if (!hook) throw notFound('Webhook');
    await requireWorkspace(me.id, hook.workspaceId, 'admin');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(60).optional(), enabled: z.boolean().optional(), events: eventsSchema.optional(), url: z.string().url().optional() }));
    if (input.url) await assertPublicUrl(input.url);
    const [row] = await db().update(webhooks).set(input).where(eq(webhooks.id, hook.id)).returning();
    return c.json({ webhook: publicWebhook(row) });
  })

  .delete('/webhooks/:id', async (c) => {
    const me = requireUser(c);
    const [hook] = await db().select().from(webhooks).where(eq(webhooks.id, c.req.param('id')));
    if (!hook) throw notFound('Webhook');
    await requireWorkspace(me.id, hook.workspaceId, 'admin');
    await db().delete(webhooks).where(eq(webhooks.id, hook.id));
    await audit(c, { workspaceId: hook.workspaceId, action: 'webhook.deleted', targetId: hook.id });
    return c.json({ ok: true });
  })

  .post('/webhooks/:id/test', rateLimit('wh-test', 20, 3600_000), async (c) => {
    const me = requireUser(c);
    const [hook] = await db().select().from(webhooks).where(eq(webhooks.id, c.req.param('id')));
    if (!hook || hook.direction !== 'outgoing') throw notFound('Webhook');
    await requireWorkspace(me.id, hook.workspaceId, 'admin');
    try {
      const res = await deliverWebhook(hook.id, testPayload(hook.workspaceId));
      return c.json({ ok: !!res?.ok, status: res?.status ?? null, message: 'Test delivered' });
    } catch (e: any) {
      return c.json({ ok: false, message: e?.message ?? 'Delivery failed' });
    }
  })

  .get('/webhooks/:id/deliveries', async (c) => {
    const me = requireUser(c);
    const [hook] = await db().select().from(webhooks).where(eq(webhooks.id, c.req.param('id')));
    if (!hook) throw notFound('Webhook');
    await requireWorkspace(me.id, hook.workspaceId, 'admin');
    return c.json({ deliveries: await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.id)).orderBy(desc(webhookDeliveries.createdAt)).limit(50) });
  });

/* ===================================================== inbound endpoints */

const KEY_RE = /\b([A-Z][A-Z0-9]{1,7})-(\d{1,7})\b/g;

async function cardsForKeys(workspaceId: string, text: string) {
  const keys = new Map<string, Set<number>>();
  for (const m of text.matchAll(KEY_RE)) {
    const set = keys.get(m[1]) ?? new Set<number>();
    set.add(Number(m[2]));
    keys.set(m[1], set);
  }
  if (!keys.size) return [];
  const bs = await db().select({ id: boards.id, key: boards.key }).from(boards).where(and(eq(boards.workspaceId, workspaceId), inArray(boards.key, [...keys.keys()])));
  const out: (typeof cards.$inferSelect)[] = [];
  for (const b of bs) {
    const nums = [...(keys.get(b.key) ?? [])];
    if (nums.length) out.push(...(await db().select().from(cards).where(and(eq(cards.boardId, b.id), inArray(cards.number, nums)))));
  }
  return out;
}

async function attachDevLink(workspaceId: string, card: typeof cards.$inferSelect, link: { provider: string; kind: string; url: string; title: string; ref: string; state: string | null }, summary: string) {
  const [existing] = await db().select().from(cardLinks).where(and(eq(cardLinks.cardId, card.id), eq(cardLinks.url, link.url)));
  if (existing) await db().update(cardLinks).set({ state: link.state, title: link.title }).where(eq(cardLinks.id, existing.id));
  else await db().insert(cardLinks).values({ id: newId(), cardId: card.id, ...link });
  await emit({ type: `${link.provider}.activity`, workspaceId, boardId: card.boardId, cardId: card.id, actor: { type: 'integration', userId: null, depth: 0 }, data: { cardTitle: card.title, summary, url: link.url }, dedupeKey: `${link.provider}:${card.id}:${link.url}:${link.state ?? ''}` });
}

export const hookRoutes = new Hono<AppEnv>()
  /** Create a card from an external system. Token in the URL; acts as the webhook's creator. */
  .post('/incoming/:token', rateLimit('hook-in', 120, 3600_000, (c) => c.req.param('token').slice(0, 16)), async (c) => {
    const [hook] = await db().select().from(webhooks).where(and(eq(webhooks.tokenHash, sha256(c.req.param('token'))), eq(webhooks.direction, 'incoming')));
    if (!hook || !hook.enabled || !hook.boardId || !hook.targetListId || !hook.createdById) throw unauthorized('Unknown or disabled webhook');
    const access = await boardAccess(hook.createdById, hook.boardId);
    if (!access || !boardRoleAtLeast(access.role, 'member')) throw forbidden('The webhook owner no longer has access to this board');
    const input = await body(c, z.object({ title: z.string().trim().min(1).max(512), description: z.string().max(20000).optional(), dueAt: z.string().datetime({ offset: true }).optional(), type: z.enum(['task', 'bug']).optional(), externalId: z.string().max(200).optional() }));
    const card = await createCard(
      { type: 'integration', userId: hook.createdById, depth: 0 },
      { boardId: hook.boardId, listId: hook.targetListId, title: input.title, description: input.description, dueAt: input.dueAt ? new Date(input.dueAt) : null, type: input.type, dedupeKey: input.externalId ? `incoming:${hook.id}:${input.externalId}` : undefined },
    );
    return c.json({ id: card.id, url: `${env.appUrl}/b/${card.boardId}/c/${card.id}` }, 201);
  })

  /** GitHub webhook: verifies X-Hub-Signature-256 and links PRs/commits/issues that mention card keys (e.g. GAME-42). */
  .post('/github/:id', async (c) => {
    const [int] = await db().select().from(integrations).where(and(eq(integrations.id, c.req.param('id')), eq(integrations.provider, 'github')));
    if (!int?.secretEnc || int.status === 'disabled') throw notFound('Integration');
    const raw = await c.req.text();
    const { webhookSecret } = JSON.parse(decryptSecret(int.secretEnc));
    const sig = c.req.header('x-hub-signature-256') ?? '';
    if (!safeEqual(sig, `sha256=${hmacHex(webhookSecret, raw)}`)) throw unauthorized('Invalid signature');
    const event = c.req.header('x-github-event');
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw badRequest('Invalid JSON');
    }
    const repo = String(payload?.repository?.full_name ?? '');
    const repos = (int.config.repos as string[] | undefined) ?? [];
    if (repos.length && !repos.includes(repo)) return c.json({ ignored: 'repository not linked' });
    let linked = 0;
    if (event === 'pull_request' && payload.pull_request) {
      const pr = payload.pull_request;
      const state = pr.merged ? 'merged' : String(pr.state);
      for (const card of await cardsForKeys(int.workspaceId, `${pr.title} ${pr.body ?? ''} ${pr.head?.ref ?? ''}`)) {
        await attachDevLink(int.workspaceId, card, { provider: 'github', kind: 'pull_request', url: pr.html_url, title: `PR #${pr.number}: ${String(pr.title).slice(0, 180)}`, ref: `${repo}#${pr.number}`, state }, `Pull request #${pr.number} ${payload.action}`);
        linked++;
      }
    } else if (event === 'push' && Array.isArray(payload.commits)) {
      for (const commit of payload.commits.slice(0, 50)) {
        for (const card of await cardsForKeys(int.workspaceId, String(commit.message ?? ''))) {
          await attachDevLink(int.workspaceId, card, { provider: 'github', kind: 'commit', url: commit.url, title: `Commit ${String(commit.id).slice(0, 7)}: ${String(commit.message).split('\n')[0].slice(0, 160)}`, ref: `${repo}@${String(commit.id).slice(0, 7)}`, state: null }, 'Commit pushed');
          linked++;
        }
      }
    } else if (event === 'issues' && payload.issue) {
      const is = payload.issue;
      for (const card of await cardsForKeys(int.workspaceId, `${is.title} ${is.body ?? ''}`)) {
        await attachDevLink(int.workspaceId, card, { provider: 'github', kind: 'issue', url: is.html_url, title: `Issue #${is.number}: ${String(is.title).slice(0, 180)}`, ref: `${repo}#${is.number}`, state: String(is.state) }, `Issue #${is.number} ${payload.action}`);
        linked++;
      }
    }
    await db().update(integrations).set({ lastDeliveryAt: deps().now(), status: 'active', lastError: null }).where(eq(integrations.id, int.id));
    return c.json({ ok: true, linked });
  })

  /** GitLab webhook: verifies X-Gitlab-Token; links merge requests and commits that mention card keys. */
  .post('/gitlab/:id', async (c) => {
    const [int] = await db().select().from(integrations).where(and(eq(integrations.id, c.req.param('id')), eq(integrations.provider, 'gitlab')));
    if (!int?.secretEnc || int.status === 'disabled') throw notFound('Integration');
    const { webhookToken } = JSON.parse(decryptSecret(int.secretEnc));
    if (!safeEqual(c.req.header('x-gitlab-token') ?? '', webhookToken)) throw unauthorized('Invalid token');
    const payload: any = await c.req.json().catch(() => {
      throw badRequest('Invalid JSON');
    });
    const project = String(payload?.project?.path_with_namespace ?? '');
    let linked = 0;
    if (payload.object_kind === 'merge_request' && payload.object_attributes) {
      const mr = payload.object_attributes;
      for (const card of await cardsForKeys(int.workspaceId, `${mr.title} ${mr.description ?? ''} ${mr.source_branch ?? ''}`)) {
        await attachDevLink(int.workspaceId, card, { provider: 'gitlab', kind: 'pull_request', url: mr.url, title: `MR !${mr.iid}: ${String(mr.title).slice(0, 180)}`, ref: `${project}!${mr.iid}`, state: String(mr.state) }, `Merge request !${mr.iid} ${mr.action ?? ''}`);
        linked++;
      }
    } else if (payload.object_kind === 'push' && Array.isArray(payload.commits)) {
      for (const commit of payload.commits.slice(0, 50)) {
        for (const card of await cardsForKeys(int.workspaceId, String(commit.message ?? ''))) {
          await attachDevLink(int.workspaceId, card, { provider: 'gitlab', kind: 'commit', url: commit.url, title: `Commit ${String(commit.id).slice(0, 7)}: ${String(commit.message).split('\n')[0].slice(0, 160)}`, ref: `${project}@${String(commit.id).slice(0, 7)}`, state: null }, 'Commit pushed');
          linked++;
        }
      }
    }
    await db().update(integrations).set({ lastDeliveryAt: deps().now(), status: 'active', lastError: null }).where(eq(integrations.id, int.id));
    return c.json({ ok: true, linked });
  });

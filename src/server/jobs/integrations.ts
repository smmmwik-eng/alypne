import { and, eq, inArray } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { integrations, webhooks, webhookDeliveries, cards, boards, users, cardLinks } from '../db/schema.js';
import { decryptSecret, hmacHex, newId } from '../lib/crypto.js';
import { postJson } from '../lib/net.js';
import { enqueue, registerJob } from './queue.js';
import type { DomainEvent } from '../lib/events.js';
import { env } from '../env.js';
import { cardKey } from '../../shared/utils.js';

export interface EventPayload {
  id: string;
  type: string;
  createdAt: string;
  workspaceId: string;
  board: { id: string; name: string; key: string; url: string } | null;
  card: { id: string; key: string; title: string; url: string } | null;
  actor: { type: string; id: string | null; name: string | null };
  data: Record<string, unknown>;
}

export async function buildPayload(eventId: string, ev: DomainEvent): Promise<EventPayload> {
  const [board] = ev.boardId ? await db().select({ id: boards.id, name: boards.name, key: boards.key }).from(boards).where(eq(boards.id, ev.boardId)) : [];
  const [card] = ev.cardId ? await db().select({ id: cards.id, title: cards.title, number: cards.number }).from(cards).where(eq(cards.id, ev.cardId)) : [];
  const [actor] = ev.actor.userId ? await db().select({ name: users.displayName }).from(users).where(eq(users.id, ev.actor.userId)) : [];
  // Only non-sensitive summary fields leave Alypne; descriptions and comment bodies beyond the excerpt are never sent.
  const { excerpt, cardTitle: _t, ...rest } = (ev.data ?? {}) as Record<string, unknown>;
  const safeData = Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== 'object' || v === null));
  return {
    id: eventId,
    type: ev.type,
    createdAt: deps().now().toISOString(),
    workspaceId: ev.workspaceId,
    board: board ? { ...board, url: `${env.appUrl}/b/${board.id}` } : null,
    card: card && board ? { id: card.id, key: cardKey(board.key, card.number), title: card.title, url: `${env.appUrl}/b/${board.id}/c/${card.id}` } : null,
    actor: { type: ev.actor.type, id: ev.actor.userId, name: actor?.name ?? (ev.actor.type === 'automation' ? 'Automation' : null) },
    data: { ...safeData, ...(typeof excerpt === 'string' ? { excerpt } : {}) },
  };
}

export function describe(p: EventPayload): string {
  const who = p.actor.name ?? 'Someone';
  const card = p.card ? `**${p.card.title}**` : 'a card';
  const d = p.data;
  switch (p.type) {
    case 'card.created':
      return `${who} created ${card} in ${d.listName ?? 'a list'}`;
    case 'bug.created':
      return `${who} reported a bug: ${card}`;
    case 'card.moved':
      return `${who} moved ${card} from ${d.fromListName ?? '?'} to ${d.toListName ?? '?'}`;
    case 'card.completed':
      return `${who} completed ${card}`;
    case 'card.archived':
      return `${who} archived ${card}`;
    case 'comment.added':
      return `${who} commented on ${card}${d.excerpt ? `: “${d.excerpt}”` : ''}`;
    case 'member.assigned':
      return `${who} assigned ${d.userName ?? 'someone'} to ${card}`;
    case 'release.created':
      return `${who} created release **${d.releaseName}**${d.version ? ` (${d.version})` : ''}`;
    case 'release.statusChanged':
      return `Release **${d.releaseName}**${d.version ? ` ${d.version}` : ''} is now **${String(d.to).replace('_', ' ')}**`;
    case 'test':
      return 'This is a test message from Alypne. Your integration is connected.';
  }
  return `${who}: ${p.type}`;
}

const COLORS: Record<string, number> = { 'card.completed': 0x34d399, 'bug.created': 0xf43f5e, 'release.statusChanged': 0x8b7cf6, 'release.created': 0x8b7cf6 };

export function discordMessage(p: EventPayload) {
  return {
    username: 'Alypne',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: (p.card?.key ? `${p.card.key} · ${p.card.title}` : p.type === 'test' ? 'Alypne connected' : 'Alypne update').slice(0, 250),
        url: p.card?.url ?? p.board?.url ?? env.appUrl,
        description: describe(p).slice(0, 2000),
        color: COLORS[p.type] ?? 0x6b7280,
        footer: { text: p.board ? `Alypne · ${p.board.name}` : 'Alypne' },
        timestamp: p.createdAt,
      },
    ],
  };
}

async function recordDelivery(row: { webhookId?: string; integrationId?: string; event: string; status: string; responseStatus?: number | null; error?: string | null; attempts: number }) {
  await db().insert(webhookDeliveries).values({ id: newId(), webhookId: row.webhookId ?? null, integrationId: row.integrationId ?? null, event: row.event, status: row.status, responseStatus: row.responseStatus ?? null, error: row.error ?? null, attempts: row.attempts });
}

export async function deliverDiscord(integrationId: string, payload: EventPayload, attempt = 1) {
  const [int] = await db().select().from(integrations).where(eq(integrations.id, integrationId));
  if (!int || int.status === 'disabled' || !int.secretEnc) return;
  const url = decryptSecret(int.secretEnc);
  try {
    const res = await postJson(url, discordMessage(payload));
    await recordDelivery({ integrationId, event: payload.type, status: res.ok ? 'success' : 'failed', responseStatus: res.status, error: res.ok ? null : res.text, attempts: attempt });
    await db().update(integrations).set({ lastDeliveryAt: deps().now(), status: res.ok ? 'active' : 'error', lastError: res.ok ? null : `Discord responded ${res.status}` }).where(eq(integrations.id, integrationId));
    if (!res.ok && res.status >= 500) throw new Error(`Discord responded ${res.status}`);
    return res;
  } catch (e: any) {
    await recordDelivery({ integrationId, event: payload.type, status: 'failed', error: String(e?.message ?? e).slice(0, 300), attempts: attempt });
    await db().update(integrations).set({ status: 'error', lastError: String(e?.message ?? e).slice(0, 300) }).where(eq(integrations.id, integrationId));
    throw e;
  }
}

export async function deliverWebhook(webhookId: string, payload: EventPayload, attempt = 1) {
  const [hook] = await db().select().from(webhooks).where(eq(webhooks.id, webhookId));
  if (!hook || !hook.enabled || !hook.url) return;
  const body = JSON.stringify(payload);
  const secret = hook.secretEnc ? decryptSecret(hook.secretEnc) : '';
  const ts = Math.floor(Date.now() / 1000);
  const headers = {
    'x-alypne-event': payload.type,
    'x-alypne-delivery': newId(),
    'x-alypne-timestamp': String(ts),
    // Signature over "<timestamp>.<body>" so receivers can reject replays.
    'x-alypne-signature': `sha256=${hmacHex(secret, `${ts}.${body}`)}`,
  };
  try {
    const res = await postJson(hook.url, body, headers);
    await recordDelivery({ webhookId, event: payload.type, status: res.ok ? 'success' : 'failed', responseStatus: res.status, error: res.ok ? null : res.text, attempts: attempt });
    if (!res.ok) throw new Error(`Endpoint responded ${res.status}`);
    return res;
  } catch (e: any) {
    if (!String(e?.message).startsWith('Endpoint responded')) await recordDelivery({ webhookId, event: payload.type, status: 'failed', error: String(e?.message ?? e).slice(0, 300), attempts: attempt });
    throw e;
  }
}

registerJob('integrations.dispatch', async ({ eventId, event }: { eventId: string; event: DomainEvent }) => {
  const payload = await buildPayload(eventId, event);
  const ints = await db().select().from(integrations).where(and(eq(integrations.workspaceId, event.workspaceId), inArray(integrations.provider, ['discord'])));
  for (const i of ints) {
    if (i.status === 'disabled' || !i.events.includes(event.type)) continue;
    const boardFilter = (i.config.boardIds as string[] | undefined) ?? [];
    if (boardFilter.length && (!event.boardId || !boardFilter.includes(event.boardId))) continue;
    await enqueue('deliver.discord', { integrationId: i.id, payload }, { dedupeKey: `d:${i.id}:${eventId}`, maxAttempts: 4 });
  }
  const hooks = await db().select().from(webhooks).where(and(eq(webhooks.workspaceId, event.workspaceId), eq(webhooks.direction, 'outgoing'), eq(webhooks.enabled, true)));
  for (const h of hooks) {
    if (!h.events.includes(event.type)) continue;
    if (h.boardId && h.boardId !== event.boardId) continue;
    await enqueue('deliver.webhook', { webhookId: h.id, payload }, { dedupeKey: `w:${h.id}:${eventId}`, maxAttempts: 4 });
  }
});

registerJob('deliver.discord', async ({ integrationId, payload }: { integrationId: string; payload: EventPayload }, job) => {
  await deliverDiscord(integrationId, payload, job.attempts);
});
registerJob('deliver.webhook', async ({ webhookId, payload }: { webhookId: string; payload: EventPayload }, job) => {
  await deliverWebhook(webhookId, payload, job.attempts);
});

/** Refresh a GitHub PR/issue link's title and state from the GitHub REST API. */
registerJob('github.refreshLink', async ({ linkId, workspaceId }: { linkId: string; workspaceId: string }) => {
  const [link] = await db().select().from(cardLinks).where(eq(cardLinks.id, linkId));
  if (!link || link.provider !== 'github') return;
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(link.ref);
  if (!m) return;
  const [int] = await db().select().from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'github')));
  let token = env.githubToken;
  if (int?.secretEnc) {
    try {
      token = JSON.parse(decryptSecret(int.secretEnc)).token || token;
    } catch {
      /* ignore malformed secret */
    }
  }
  const kind = link.kind === 'pull_request' ? 'pulls' : 'issues';
  const res = await deps().fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/${kind}/${m[3]}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Alypne', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404 || res.status === 403) return; // private repo without token, or rate limited: keep the plain link
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const data: any = await res.json();
  const state = data.merged_at ? 'merged' : String(data.state ?? '');
  await db().update(cardLinks).set({ title: `${link.kind === 'pull_request' ? 'PR' : 'Issue'} #${m[3]}: ${String(data.title ?? '').slice(0, 180)}`, state }).where(eq(cardLinks.id, link.id));
});

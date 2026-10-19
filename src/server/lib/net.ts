import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '../env.js';
import { badRequest } from './errors.js';
import { deps } from '../deps.js';

/** Reject private, loopback, link-local, CGNAT and multicast addresses (SSRF protection for outgoing webhooks). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Enter a valid URL');
  }
  if (url.protocol !== 'https:' && !(env.allowPrivateWebhookTargets && url.protocol === 'http:')) throw badRequest('Webhook URLs must use https://');
  if (url.username || url.password) throw badRequest('URLs with embedded credentials are not allowed');
  if (env.allowPrivateWebhookTargets) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw badRequest('That hostname could not be resolved');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw badRequest('Webhook URLs must point to a public internet address');
  return url;
}

/** POST JSON with timeout; never follows redirects (a redirect could point at an internal address). */
export async function postJson(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; ok: boolean; text: string }> {
  await assertPublicUrl(url);
  const res = await deps().fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Alypne-Webhooks/1.0', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const text = (await res.text().catch(() => '')).slice(0, 500);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, text };
}

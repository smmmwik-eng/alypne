import type { MiddlewareHandler } from 'hono';
import { tooMany } from './errors.js';
import { clientIp } from './request.js';

/**
 * Fixed-window in-memory rate limiter. Suitable for a single instance; when
 * running several instances behind a load balancer, put a shared limiter
 * (e.g. Cloudflare rate limiting rules) in front as documented in docs/SECURITY.md.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function hit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    return true;
  }
  b.count++;
  return b.count <= limit;
}

export function resetRateLimits() {
  buckets.clear();
}

export function rateLimit(name: string, limit: number, windowMs: number, keyFn?: (c: any) => string): MiddlewareHandler {
  return async (c, next) => {
    if (process.env.ALYPNE_DISABLE_RATE_LIMIT === 'true') return next();
    const user = c.get('user') as { id: string } | undefined;
    const key = `${name}:${keyFn ? keyFn(c) : (user?.id ?? clientIp(c))}`;
    if (!hit(key, limit, windowMs)) throw tooMany();
    await next();
  };
}

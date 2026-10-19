import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { env } from '../env.js';
import { badRequest } from './errors.js';

export function clientIp(c: Context): string {
  if (env.trustProxy) {
    const fwd = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  const incoming = (c.env as any)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  return schema.parse(raw);
}

export function query<T>(c: Context, schema: ZodType<T>): T {
  return schema.parse(c.req.query());
}

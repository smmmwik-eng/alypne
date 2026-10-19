import type { Context } from 'hono';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, 'forbidden', message);
/** Used for missing *and* inaccessible resources so existence is not leaked. */
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);
export const tooMany = (message = 'Too many requests, please slow down') => new HttpError(429, 'rate_limited', message);
export const payloadTooLarge = (message: string) => new HttpError(413, 'payload_too_large', message);

export function errorHandler(err: Error, c: Context) {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as any);
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'validation_error',
          message: err.issues[0] ? `${err.issues[0].path.join('.') || 'input'}: ${err.issues[0].message}` : 'Invalid input',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
      400,
    );
  }
  if ((err as any)?.status === 413) {
    return c.json({ error: { code: 'payload_too_large', message: 'Request body is too large' } }, 413);
  }
  console.error('[alypne] unhandled error', err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } }, 500);
}

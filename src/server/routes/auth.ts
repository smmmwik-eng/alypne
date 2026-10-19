import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { users, authTokens, sessions } from '../db/schema.js';
import { type AppEnv, audit, createSession, destroySession, requireUser } from '../lib/auth.js';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, tooMany, unauthorized } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { hit, rateLimit } from '../lib/rateLimit.js';
import { emailLayout, sendMail, mailConfigured } from '../lib/mailer.js';
import { env } from '../env.js';

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(32)
  .regex(/^[a-zA-Z0-9_]+$/, 'Use letters, numbers and underscores only');
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(200);
const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);

async function issueToken(userId: string, kind: 'verify_email' | 'reset_password', ttlMs: number) {
  const token = randomToken(32);
  await db().insert(authTokens).values({ id: newId(), userId, kind, tokenHash: sha256(token), expiresAt: new Date(deps().now().getTime() + ttlMs) });
  return token;
}

async function consumeToken(token: string, kind: string) {
  const now = deps().now();
  const [row] = await db()
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.tokenHash, sha256(token)), eq(authTokens.kind, kind), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .returning();
  return row ?? null;
}

export async function sendVerificationEmail(user: { id: string; email: string; displayName: string }) {
  const token = await issueToken(user.id, 'verify_email', 24 * 3600_000);
  const url = `${env.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const { html, text } = emailLayout({
    heading: 'Confirm your email',
    body: `Hi ${user.displayName}, confirm this address to finish setting up your Alypne account. The link expires in 24 hours.`,
    actionLabel: 'Verify email',
    actionUrl: url,
  });
  await sendMail({ to: user.email, subject: 'Verify your Alypne email', html, text });
}

export const authRoutes = new Hono<AppEnv>()
  .get('/me', async (c) => {
    const user = c.get('user');
    return c.json({ user, mailConfigured: mailConfigured(), requireEmailVerification: env.requireEmailVerification });
  })

  .post('/signup', rateLimit('signup', 10, 3600_000), async (c) => {
    const input = await body(
      c,
      z.object({ email: emailSchema, username: usernameSchema, displayName: z.string().trim().min(1).max(60), password: passwordSchema, timezone: z.string().max(64).optional() }),
    );
    const existing = await db()
      .select({ email: users.email, username: users.username })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email} or lower(${users.username}) = ${input.username.toLowerCase()}`);
    if (existing.some((u) => u.email.toLowerCase() === input.email)) throw conflict('An account with this email already exists');
    if (existing.length) throw conflict('That username is taken');
    const id = newId();
    const tz = input.timezone && isValidTimezone(input.timezone) ? input.timezone : 'UTC';
    const [user] = await db()
      .insert(users)
      .values({ id, email: input.email, username: input.username, displayName: input.displayName, passwordHash: await hashPassword(input.password), timezone: tz })
      .returning();
    await sendVerificationEmail(user);
    await audit(c, { userId: id, action: 'user.signup' });
    if (env.requireEmailVerification) return c.json({ verificationRequired: true }, 201);
    await createSession(c, id);
    return c.json({ verificationRequired: false }, 201);
  })

  .post('/signin', rateLimit('signin-ip', 30, 15 * 60_000), async (c) => {
    const input = await body(c, z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }));
    const ident = input.identifier.toLowerCase();
    if (process.env.ALYPNE_DISABLE_RATE_LIMIT !== 'true' && !hit(`signin-id:${ident}`, 10, 15 * 60_000)) {
      throw tooMany('Too many sign-in attempts. Wait 15 minutes and try again.');
    }
    const [user] = await db()
      .select()
      .from(users)
      .where(and(sql`(lower(${users.email}) = ${ident} or lower(${users.username}) = ${ident})`, isNull(users.deletedAt)))
      .limit(1);
    const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      await audit(c, { userId: user?.id ?? null, action: 'user.signin_failed', data: { identifier: ident.slice(0, 64) } });
      throw unauthorized('Incorrect email/username or password');
    }
    if (env.requireEmailVerification && !user.emailVerifiedAt) {
      throw forbidden('Please verify your email address before signing in. Check your inbox for the link.');
    }
    await createSession(c, user.id);
    await audit(c, { userId: user.id, action: 'user.signin' });
    return c.json({ ok: true });
  })

  .post('/signout', async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  })

  .post('/forgot-password', rateLimit('forgot', 5, 3600_000), async (c) => {
    const input = await body(c, z.object({ email: emailSchema }));
    const [user] = await db().select().from(users).where(and(sql`lower(${users.email}) = ${input.email}`, isNull(users.deletedAt)));
    if (user) {
      const token = await issueToken(user.id, 'reset_password', 3600_000);
      const url = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
      const { html, text } = emailLayout({
        heading: 'Reset your password',
        body: `Someone (hopefully you) asked to reset the password for ${user.username}. The link expires in 1 hour. If this wasn't you, you can ignore this email.`,
        actionLabel: 'Choose a new password',
        actionUrl: url,
      });
      await sendMail({ to: user.email, subject: 'Reset your Alypne password', html, text });
      await audit(c, { userId: user.id, action: 'user.password_reset_requested' });
    }
    // Same response whether or not the account exists.
    return c.json({ ok: true, mailConfigured: mailConfigured() });
  })

  .post('/reset-password', rateLimit('reset', 10, 3600_000), async (c) => {
    const input = await body(c, z.object({ token: z.string().min(10).max(200), password: passwordSchema }));
    const tok = await consumeToken(input.token, 'reset_password');
    if (!tok) throw badRequest('This reset link is invalid or has expired. Request a new one.');
    await db().update(users).set({ passwordHash: await hashPassword(input.password), passwordChangedAt: deps().now(), emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` }).where(eq(users.id, tok.userId));
    await db().delete(sessions).where(eq(sessions.userId, tok.userId));
    await audit(c, { userId: tok.userId, action: 'user.password_reset' });
    await createSession(c, tok.userId);
    return c.json({ ok: true });
  })

  .post('/verify-email', rateLimit('verify', 20, 3600_000), async (c) => {
    const input = await body(c, z.object({ token: z.string().min(10).max(200) }));
    const tok = await consumeToken(input.token, 'verify_email');
    if (!tok) throw badRequest('This verification link is invalid or has expired.');
    await db().update(users).set({ emailVerifiedAt: deps().now() }).where(eq(users.id, tok.userId));
    return c.json({ ok: true });
  })

  .post('/resend-verification', rateLimit('resend-verify', 3, 3600_000), async (c) => {
    const me = requireUser(c);
    if (me.emailVerifiedAt) return c.json({ ok: true, alreadyVerified: true });
    await sendVerificationEmail(me);
    return c.json({ ok: true, mailConfigured: mailConfigured() });
  });

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}


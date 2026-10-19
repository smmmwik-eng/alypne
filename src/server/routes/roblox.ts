import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, gt, ne } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, deps } from '../deps.js';
import { externalAccounts, verificationChallenges } from '../db/schema.js';
import { type AppEnv, audit, requireUser } from '../lib/auth.js';
import { newId, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { body } from '../lib/request.js';
import { rateLimit } from '../lib/rateLimit.js';
import { ROBLOX_ID, ROBLOX_OAUTH, exchangeOAuthCode, getAvatarHeadshot, getExperience, getUser, lookupUserByName, universeForPlace } from '../lib/roblox.js';
import { env } from '../env.js';

const WORDS = ['amber', 'basalt', 'cobalt', 'delta', 'ember', 'falcon', 'glacier', 'harbor', 'indigo', 'juniper', 'kestrel', 'lumen', 'meadow', 'nebula', 'orbit', 'pebble', 'quartz', 'raven', 'summit', 'tundra', 'umber', 'vortex', 'willow', 'zephyr'];

function verificationCode(): string {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `alypne ${pick()} ${pick()} ${pick()} ${Math.floor(1000 + Math.random() * 9000)}`;
}

async function linkAccount(userId: string, info: { id: string; username: string; displayName: string; avatarUrl: string | null }, method: 'oauth' | 'profile_code') {
  const [taken] = await db().select().from(externalAccounts).where(and(eq(externalAccounts.provider, 'roblox'), eq(externalAccounts.providerUserId, info.id), ne(externalAccounts.userId, userId)));
  if (taken) throw conflict('That Roblox account is already linked to another Alypne account.');
  await db().delete(externalAccounts).where(and(eq(externalAccounts.userId, userId), eq(externalAccounts.provider, 'roblox')));
  const [row] = await db()
    .insert(externalAccounts)
    .values({ id: newId(), userId, provider: 'roblox', providerUserId: info.id, username: info.username, displayName: info.displayName, avatarUrl: info.avatarUrl, verificationMethod: method, verifiedAt: deps().now() })
    .returning();
  return row;
}

const pkce = () => {
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const redirectUri = () => `${env.appUrl}/api/roblox/oauth/callback`;

export const robloxRoutes = new Hono<AppEnv>()
  .get('/status', (c) => c.json({ oauthAvailable: !!(env.robloxClientId && env.robloxClientSecret) }))

  /* ------------------------------------------- profile-code verification */
  .post('/verify/start', rateLimit('roblox-start', 10, 3600_000), async (c) => {
    const me = requireUser(c);
    const { username } = await body(c, z.object({ username: z.string().trim().min(3).max(20) }));
    const found = await lookupUserByName(username);
    if (!found) throw notFound('Roblox user');
    await db().delete(verificationChallenges).where(and(eq(verificationChallenges.userId, me.id), eq(verificationChallenges.kind, 'roblox_profile_code')));
    const id = newId();
    const code = verificationCode();
    const expiresAt = new Date(deps().now().getTime() + 30 * 60_000);
    await db().insert(verificationChallenges).values({ id, userId: me.id, kind: 'roblox_profile_code', subject: found.id, code, data: { username: found.name, displayName: found.displayName }, expiresAt });
    return c.json({ challengeId: id, code, robloxUserId: found.id, username: found.name, displayName: found.displayName, expiresAt });
  })

  .post('/verify/check', rateLimit('roblox-check', 30, 3600_000), async (c) => {
    const me = requireUser(c);
    const { challengeId } = await body(c, z.object({ challengeId: z.string() }));
    const [ch] = await db()
      .select()
      .from(verificationChallenges)
      .where(and(eq(verificationChallenges.id, challengeId), eq(verificationChallenges.userId, me.id), eq(verificationChallenges.kind, 'roblox_profile_code'), gt(verificationChallenges.expiresAt, deps().now())));
    if (!ch) throw badRequest('This verification has expired. Start again to get a new code.');
    const user = await getUser(ch.subject);
    if (!user) throw notFound('Roblox user');
    // The check happens server-side against Roblox's public profile API.
    if (!user.description.toLowerCase().includes(ch.code.toLowerCase())) {
      return c.json({ verified: false, message: 'We could not find the code in your Roblox profile “About” section yet. Roblox can take a minute to update — save your profile and try again.' });
    }
    const avatarUrl = await getAvatarHeadshot(user.id);
    const account = await linkAccount(me.id, { id: user.id, username: user.name, displayName: user.displayName, avatarUrl }, 'profile_code');
    await db().delete(verificationChallenges).where(eq(verificationChallenges.id, ch.id));
    await audit(c, { action: 'roblox.linked', targetId: user.id, data: { method: 'profile_code' } });
    return c.json({ verified: true, account });
  })

  /* ---------------------------------------------------------------- OAuth */
  .get('/oauth/start', rateLimit('roblox-oauth', 20, 3600_000), async (c) => {
    const me = requireUser(c);
    if (!env.robloxClientId || !env.robloxClientSecret) throw badRequest('Roblox OAuth is not configured on this Alypne instance. Use profile verification instead.');
    const state = randomToken(24);
    const { verifier, challenge } = pkce();
    await db().insert(verificationChallenges).values({ id: newId(), userId: me.id, kind: 'roblox_oauth_state', code: state, data: { verifier }, expiresAt: new Date(deps().now().getTime() + 10 * 60_000) });
    const url = new URL(ROBLOX_OAUTH.authorize);
    url.search = new URLSearchParams({ client_id: env.robloxClientId, redirect_uri: redirectUri(), scope: 'openid profile', response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return c.json({ url: url.toString() });
  })

  .get('/oauth/callback', async (c) => {
    const me = c.get('user');
    const done = (status: string) => c.redirect(`/app/settings/connections?roblox=${status}`);
    if (!me) return c.redirect('/signin');
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (!state || !code) return done('cancelled');
    const [ch] = await db()
      .select()
      .from(verificationChallenges)
      .where(and(eq(verificationChallenges.userId, me.id), eq(verificationChallenges.kind, 'roblox_oauth_state'), eq(verificationChallenges.code, state), gt(verificationChallenges.expiresAt, deps().now())));
    if (!ch) return done('expired');
    await db().delete(verificationChallenges).where(eq(verificationChallenges.id, ch.id));
    try {
      const info = await exchangeOAuthCode({ code, verifier: String(ch.data.verifier), clientId: env.robloxClientId, clientSecret: env.robloxClientSecret, redirectUri: redirectUri() });
      const avatarUrl = info.picture ?? (await getAvatarHeadshot(info.id));
      await linkAccount(me.id, { id: info.id, username: info.username, displayName: info.displayName, avatarUrl }, 'oauth');
      await audit(c, { action: 'roblox.linked', targetId: info.id, data: { method: 'oauth' } });
      return done('linked');
    } catch (e: any) {
      return done(e?.code === 'conflict' ? 'taken' : 'failed');
    }
  })

  .delete('/account', async (c) => {
    const me = requireUser(c);
    await db().delete(externalAccounts).where(and(eq(externalAccounts.userId, me.id), eq(externalAccounts.provider, 'roblox')));
    await audit(c, { action: 'roblox.unlinked' });
    return c.json({ ok: true });
  })

  .post('/account/refresh', rateLimit('roblox-refresh', 10, 3600_000), async (c) => {
    const me = requireUser(c);
    const [acc] = await db().select().from(externalAccounts).where(and(eq(externalAccounts.userId, me.id), eq(externalAccounts.provider, 'roblox')));
    if (!acc) throw notFound('Linked Roblox account');
    const user = await getUser(acc.providerUserId);
    if (!user) throw notFound('Roblox user');
    const avatarUrl = await getAvatarHeadshot(user.id);
    await db().update(externalAccounts).set({ username: user.name, displayName: user.displayName, avatarUrl }).where(eq(externalAccounts.id, acc.id));
    return c.json({ ok: true });
  })

  /** Look up public experience metadata by place or universe ID (used when creating game projects). */
  .get('/experience', rateLimit('roblox-exp', 60, 3600_000), async (c) => {
    requireUser(c);
    const placeId = c.req.query('placeId');
    let universeId = c.req.query('universeId');
    if (placeId && !ROBLOX_ID.test(placeId)) throw badRequest('Place ID must be a number');
    if (universeId && !ROBLOX_ID.test(universeId)) throw badRequest('Universe ID must be a number');
    if (!universeId && placeId) universeId = (await universeForPlace(placeId)) ?? undefined;
    if (!universeId) throw notFound('Experience');
    const meta = await getExperience(universeId);
    if (!meta) throw notFound('Experience');
    return c.json({ experience: meta });
  });

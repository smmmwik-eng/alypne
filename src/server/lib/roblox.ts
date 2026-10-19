import { deps } from '../deps.js';
import { HttpError } from './errors.js';

/**
 * Thin, validated client for Roblox's public web APIs and OAuth 2.0.
 * Only public endpoints are used; Alypne never asks for passwords or .ROBLOSECURITY cookies.
 */

export const ROBLOX_ID = /^\d{1,20}$/;

const upstream = (message: string) => new HttpError(502, 'roblox_unavailable', message);

async function getJson(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await deps().fetch(url, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw upstream('Could not reach Roblox. Please try again in a moment.');
  }
  if (res.status === 429) throw new HttpError(429, 'roblox_rate_limited', 'Roblox is rate limiting requests. Please wait a minute and try again.');
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw upstream(`Roblox returned an error (${res.status}). Please try again later.`);
  try {
    return await res.json();
  } catch {
    throw upstream('Roblox returned an unexpected response.');
  }
}

export interface RobloxUser {
  id: string;
  name: string;
  displayName: string;
  description: string;
  isBanned: boolean;
}

export async function lookupUserByName(username: string): Promise<{ id: string; name: string; displayName: string } | null> {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return null;
  const data = await getJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  const u = data?.data?.[0];
  if (!u || typeof u.id !== 'number') return null;
  return { id: String(u.id), name: String(u.name), displayName: String(u.displayName ?? u.name) };
}

export async function getUser(id: string): Promise<RobloxUser | null> {
  if (!ROBLOX_ID.test(id)) return null;
  const u = await getJson(`https://users.roblox.com/v1/users/${id}`);
  if (!u || typeof u.id !== 'number') return null;
  return { id: String(u.id), name: String(u.name), displayName: String(u.displayName ?? u.name), description: String(u.description ?? ''), isBanned: !!u.isBanned };
}

export async function getAvatarHeadshot(id: string): Promise<string | null> {
  if (!ROBLOX_ID.test(id)) return null;
  const data = await getJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`).catch(() => null);
  const t = data?.data?.[0];
  return t?.state === 'Completed' && typeof t.imageUrl === 'string' && t.imageUrl.startsWith('https://') ? t.imageUrl : null;
}

export interface ExperienceMeta {
  universeId: string;
  rootPlaceId: string;
  name: string;
  description: string;
  creator: { name: string; type: string } | null;
  playing: number | null;
  visits: number | null;
  maxPlayers: number | null;
  created: string | null;
  updated: string | null;
  iconUrl: string | null;
  fetchedAt: string;
}

export async function universeForPlace(placeId: string): Promise<string | null> {
  if (!ROBLOX_ID.test(placeId)) return null;
  const data = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  return data?.universeId ? String(data.universeId) : null;
}

export async function getExperience(universeId: string): Promise<ExperienceMeta | null> {
  if (!ROBLOX_ID.test(universeId)) return null;
  const data = await getJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
  const g = data?.data?.[0];
  if (!g || typeof g.id !== 'number') return null;
  const icons = await getJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`).catch(() => null);
  const icon = icons?.data?.[0];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    universeId: String(g.id),
    rootPlaceId: String(g.rootPlaceId ?? ''),
    name: String(g.name ?? '').slice(0, 200),
    description: String(g.description ?? '').slice(0, 4000),
    creator: g.creator ? { name: String(g.creator.name ?? ''), type: String(g.creator.type ?? '') } : null,
    playing: num(g.playing),
    visits: num(g.visits),
    maxPlayers: num(g.maxPlayers),
    created: typeof g.created === 'string' ? g.created : null,
    updated: typeof g.updated === 'string' ? g.updated : null,
    iconUrl: icon?.state === 'Completed' && typeof icon.imageUrl === 'string' && icon.imageUrl.startsWith('https://') ? icon.imageUrl : null,
    fetchedAt: deps().now().toISOString(),
  };
}

/* ---------------------------------------------------------------- OAuth */

export const ROBLOX_OAUTH = {
  authorize: 'https://apis.roblox.com/oauth/v1/authorize',
  token: 'https://apis.roblox.com/oauth/v1/token',
  userinfo: 'https://apis.roblox.com/oauth/v1/userinfo',
};

export async function exchangeOAuthCode(opts: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string }) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: opts.code, code_verifier: opts.verifier, client_id: opts.clientId, client_secret: opts.clientSecret, redirect_uri: opts.redirectUri });
  const token = await getJson(ROBLOX_OAUTH.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  if (!token?.access_token) throw new HttpError(400, 'roblox_oauth', 'Roblox sign-in failed or was cancelled.');
  const info = await getJson(ROBLOX_OAUTH.userinfo, { headers: { authorization: `Bearer ${token.access_token}` } });
  if (!info?.sub || !ROBLOX_ID.test(String(info.sub))) throw new HttpError(400, 'roblox_oauth', 'Roblox did not return a user identity.');
  return {
    id: String(info.sub),
    username: String(info.preferred_username ?? info.name ?? ''),
    displayName: String(info.nickname ?? info.name ?? ''),
    picture: typeof info.picture === 'string' && info.picture.startsWith('https://') ? info.picture : null,
  };
}

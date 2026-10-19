import type { DB } from './db/client.js';

/** Process-wide service container. Set once at startup (or per test file). */
interface Deps {
  db: DB;
  /** Fetch used for outbound calls (Roblox, GitHub, webhooks). Swappable in tests. */
  fetch: typeof fetch;
  now: () => Date;
}

let current: Deps | null = null;

export function setDeps(d: Partial<Deps> & { db: DB }) {
  current = { fetch: globalThis.fetch.bind(globalThis), now: () => new Date(), ...current, ...d } as Deps;
}

export function deps(): Deps {
  if (!current) throw new Error('Dependencies not initialised');
  return current;
}

export const db = (): DB => deps().db;

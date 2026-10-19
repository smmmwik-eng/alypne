import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type DB = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type Executor = DB | Tx;

const here = path.dirname(fileURLToPath(import.meta.url));
/** drizzle/ lives at the repository root, both for src/ (tsx) and dist/ (compiled) layouts. */
export function migrationsFolder(): string {
  const candidates = [path.resolve(here, '../../../drizzle'), path.resolve(here, '../../../../drizzle'), path.resolve(process.cwd(), 'drizzle')];
  return candidates.find((c) => existsSync(path.join(c, 'meta'))) ?? candidates[2];
}

export interface Database {
  db: DB;
  kind: 'postgres' | 'pglite';
  close(): Promise<void>;
}

export async function openDatabase(url: string, opts: { migrate?: boolean } = {}): Promise<Database> {
  let database: Database;
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pg = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new pg.default.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
    const db = drizzle(pool, { schema });
    database = { db, kind: 'postgres', close: () => pool.end() };
    if (opts.migrate !== false) {
      const { migrate } = await import('drizzle-orm/node-postgres/migrator');
      await migrate(db, { migrationsFolder: migrationsFolder() });
    }
  } else if (url.startsWith('pglite:')) {
    const target = url.slice('pglite:'.length);
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    let client: InstanceType<typeof PGlite>;
    if (target === 'memory' || target === '') {
      client = new PGlite();
    } else {
      const dir = path.resolve(target);
      mkdirSync(path.dirname(dir), { recursive: true });
      client = new PGlite(dir);
    }
    const db = drizzle(client, { schema }) as unknown as DB;
    database = { db, kind: 'pglite', close: () => client.close() };
    if (opts.migrate !== false) {
      const { migrate } = await import('drizzle-orm/pglite/migrator');
      await migrate(db as any, { migrationsFolder: migrationsFolder() });
    }
  } else {
    throw new Error('DATABASE_URL must start with postgres://, postgresql:// or pglite:');
  }
  return database;
}

export { schema };

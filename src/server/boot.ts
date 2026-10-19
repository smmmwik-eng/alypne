import { openDatabase, type Database } from './db/client.js';
import { setDeps } from './deps.js';
import { env } from './env.js';
import { seedBuiltinTemplates } from './routes/templates.js';

/** Open the database, run migrations and seed built-in templates. */
export async function boot(url = env.databaseUrl): Promise<Database> {
  const database = await openDatabase(url);
  setDeps({ db: database.db });
  await seedBuiltinTemplates();
  return database;
}

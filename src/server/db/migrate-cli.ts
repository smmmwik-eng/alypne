import { openDatabase } from './client.js';
import { env } from '../env.js';

const database = await openDatabase(env.databaseUrl, { migrate: true });
console.info(`[alypne] migrations applied (${database.kind})`);
await database.close();

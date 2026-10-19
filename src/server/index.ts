import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { boot } from './boot.js';
import { createApp } from './app.js';
import { env } from './env.js';
import { attachRealtime } from './lib/realtime.js';
import { startWorker, stopWorker } from './jobs/queue.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { mailConfigured } from './lib/mailer.js';

const database = await boot();
const app = createApp();
const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.info(
    `[alypne] API listening on http://localhost:${info.port} (database: ${database.kind}${mailConfigured() ? ', SMTP configured' : ', SMTP not configured: emails are logged to the console'})`,
  );
});
attachRealtime(server as unknown as Server);
if (!env.disableWorker) {
  startWorker();
  startScheduler();
}

async function shutdown() {
  stopScheduler();
  stopWorker();
  server.close();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

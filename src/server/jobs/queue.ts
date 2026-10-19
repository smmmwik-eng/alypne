import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, deps } from '../deps.js';
import { jobs } from '../db/schema.js';
import { newId } from '../lib/crypto.js';

/**
 * Durable Postgres-backed job queue. Jobs survive restarts, are claimed with
 * `FOR UPDATE SKIP LOCKED` (safe across several worker processes), retried with
 * exponential backoff, and deduplicated via an optional unique `dedupeKey`.
 */

export type JobHandler = (payload: any, job: typeof jobs.$inferSelect) => Promise<void>;
const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export async function enqueue(type: string, payload: Record<string, unknown>, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  const id = newId();
  await db()
    .insert(jobs)
    .values({ id, type, payload, runAt: opts.runAt ?? deps().now(), dedupeKey: opts.dedupeKey ?? null, maxAttempts: opts.maxAttempts ?? 5 })
    .onConflictDoNothing();
  return id;
}

async function claim(limit: number) {
  const now = deps().now();
  // Recover jobs whose worker died mid-run.
  await db()
    .update(jobs)
    .set({ status: 'pending', lockedAt: null })
    .where(and(eq(jobs.status, 'running'), lt(jobs.lockedAt, new Date(now.getTime() - 10 * 60_000))));
  const res = await db().execute(sql`
    update ${jobs} set status = 'running', locked_at = ${now}, attempts = attempts + 1
    where id in (
      select id from ${jobs}
      where status = 'pending' and run_at <= ${now}
      order by run_at
      limit ${limit}
      for update skip locked
    )
    returning id`);
  const ids = ((res as any).rows ?? res).map((r: any) => r.id as string);
  if (!ids.length) return [];
  return db().select().from(jobs).where(inArray(jobs.id, ids));
}

async function runJob(job: typeof jobs.$inferSelect) {
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(job.payload, job);
    await db().update(jobs).set({ status: 'done', lockedAt: null, lastError: null }).where(eq(jobs.id, job.id));
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 2000);
    const exhausted = job.attempts >= job.maxAttempts;
    const backoff = Math.min(60 * 60_000, 2 ** job.attempts * 15_000);
    await db()
      .update(jobs)
      .set({
        status: exhausted ? 'failed' : 'pending',
        lockedAt: null,
        lastError: message,
        runAt: new Date(deps().now().getTime() + backoff),
      })
      .where(eq(jobs.id, job.id));
    if (!process.env.VITEST) console.warn(`[alypne:jobs] ${job.type} failed (attempt ${job.attempts}/${job.maxAttempts}): ${message}`);
  }
}

/** Process every runnable job (looping until the queue is drained). Used by the worker and by tests. */
export async function drainJobs(maxRounds = 20): Promise<number> {
  let total = 0;
  for (let round = 0; round < maxRounds; round++) {
    const batch = await claim(25);
    if (!batch.length) break;
    for (const job of batch) await runJob(job);
    total += batch.length;
  }
  return total;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startWorker(intervalMs = 2000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainJobs(5);
    } catch (e) {
      console.error('[alypne:jobs] worker error', e);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Remove finished jobs older than a week to bound table growth. */
export async function pruneJobs() {
  const cutoff = new Date(deps().now().getTime() - 7 * 86400_000);
  await db().delete(jobs).where(and(eq(jobs.status, 'done'), lt(jobs.createdAt, cutoff)));
}

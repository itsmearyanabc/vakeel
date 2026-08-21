import { Injectable } from '@nestjs/common';
import type { JSONValue } from 'postgres';
import { DatabaseService } from '../database.service';
import { JobRow, JobStats } from '../types';

/**
 * The job queue's data access layer.
 *
 * Every method is a call into a SQL function rather than a query, for the same
 * reason the credit wallet is: claiming a job is a read-check-write that has to
 * be atomic, and doing it in application code is a race whose losing side is
 * two workers handling one message. See migration 0013.
 */
@Injectable()
export class JobRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Add a job. Idempotent on `dedupeKey`.
   *
   * `inserted: false` means the key was already present, which is a success —
   * the message is queued either way. Meta redelivers webhooks aggressively and
   * this is what makes that harmless.
   */
  async enqueue(input: {
    queue: string;
    payload: Record<string, unknown>;
    dedupeKey?: string | null;
    lockKey?: string | null;
    maxAttempts?: number;
    delayMs?: number;
  }): Promise<{ jobId: string; inserted: boolean }> {
    const [row] = await this.db.sql<{ job_id: string; inserted: boolean }[]>`
      SELECT * FROM job_enqueue(
        ${input.queue}::varchar,
        ${this.db.sql.json(input.payload as unknown as JSONValue)},
        ${input.dedupeKey ?? null}::varchar,
        ${input.lockKey ?? null}::varchar,
        ${input.maxAttempts ?? 3}::smallint,
        ${input.delayMs ?? 0}::integer
      )
    `;
    return { jobId: row.job_id, inserted: row.inserted };
  }

  /**
   * Claim the next eligible job, or null.
   *
   * Never returns a job whose `lock_key` already has one running — that is the
   * per-advocate serialisation, enforced inside the function rather than by the
   * caller. See migration 0013 for why it is not merely a NOT EXISTS check.
   */
  async claim(queue: string, leaseSeconds: number): Promise<JobRow | null> {
    const [row] = await this.db.sql<JobRow[]>`
      SELECT * FROM job_claim(${queue}::varchar, ${leaseSeconds}::integer)
    `;
    return row ?? null;
  }

  async complete(jobId: string): Promise<void> {
    await this.db.sql`SELECT job_complete(${jobId}::uuid)`;
  }

  /** Records a failure and decides between a retry with backoff and death. */
  async fail(
    jobId: string,
    error: string,
    baseDelayMs = 2000,
  ): Promise<{ dead: boolean; attempts: number; retryAt: Date | null }> {
    const [row] = await this.db.sql<{ dead: boolean; attempts: number; retry_at: Date | null }[]>`
      SELECT * FROM job_fail(${jobId}::uuid, ${error.slice(0, 2000)}::text, ${baseDelayMs}::integer)
    `;
    return { dead: row?.dead ?? true, attempts: row?.attempts ?? 0, retryAt: row?.retry_at ?? null };
  }

  /** Return jobs whose worker died without finishing them. */
  async reclaimStalled(queue: string): Promise<number> {
    const [row] = await this.db.sql<{ job_reclaim_stalled: number }[]>`
      SELECT job_reclaim_stalled(${queue}::varchar)
    `;
    return row?.job_reclaim_stalled ?? 0;
  }

  async stats(queue: string): Promise<JobStats> {
    const [row] = await this.db.sql<JobStats[]>`
      SELECT * FROM job_stats(${queue}::varchar)
    `;
    return row ?? { waiting: 0, active: 0, dead: 0, done_24h: 0, oldest_wait_seconds: 0 };
  }

  /** Jobs that ran out of attempts, for the admin panel. */
  async listDead(queue: string, limit = 50): Promise<JobRow[]> {
    return this.db.sql<JobRow[]>`
      SELECT * FROM job_queue
       WHERE queue = ${queue} AND state = 'DEAD'
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
  }

  /**
   * Put a dead job back in the queue.
   *
   * Resets the attempt counter, because an operator retrying a job by hand has
   * usually fixed whatever killed it and wants a fresh set of attempts, not the
   * one that remained.
   */
  async retryDead(jobId: string): Promise<boolean> {
    const rows = await this.db.sql<{ id: string }[]>`
      UPDATE job_queue
         SET state = 'QUEUED', attempts = 0, run_at = NOW(),
             lease_until = NULL, finished_at = NULL, last_error = NULL
       WHERE id = ${jobId} AND state = 'DEAD'
   RETURNING id
    `;
    return rows.length > 0;
  }

  async purge(): Promise<number> {
    const [row] = await this.db.sql<{ job_purge: number }[]>`SELECT job_purge()`;
    return row?.job_purge ?? 0;
  }
}

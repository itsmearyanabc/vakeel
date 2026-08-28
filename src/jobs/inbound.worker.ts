import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getLogger, maskPhone } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { JobRepository } from '../database/repositories/job.repository';
import { MessageRepository } from '../database/repositories/message.repository';
import { ConversationService } from '../whatsapp/conversation.service';
import * as Replies from '../whatsapp/replies';
import { WhatsAppApiService } from '../whatsapp/whatsapp-api.service';
import { InboundMessageJob, QUEUE_WHATSAPP_INBOUND } from './queue.constants';

/**
 * Consumer side of the queue. Runs only in the worker process.
 *
 * ## What replaced BullMQ, and what had to be rebuilt
 *
 * BullMQ provided five things this had to reimplement: claiming without
 * double-delivery, retry with backoff, an attempt ceiling, stalled-job
 * recovery, and per-key serialisation. Four of them live in SQL (migration
 * 0013) because they are read-check-write operations that have to be atomic.
 * What remains here is the loop and the error handling.
 *
 * ## Why polling is fine
 *
 * The loop asks for work every `JOB_POLL_INTERVAL_MS`. That delay is added to
 * every reply, and it is invisible: the answer behind it takes seconds of model
 * time. LISTEN/NOTIFY would remove it and cannot be used over Supabase's
 * transaction pooler — see migration 0013.
 *
 * The cost is one cheap indexed query per interval per slot. Unlike the Redis
 * arrangement it replaces, an idle worker here is not the largest line on
 * anyone's bill.
 *
 * ## Serialisation moved into the claim
 *
 * Under BullMQ this class took a Redis lock per advocate and threw the job back
 * when it could not get one, so a burst of messages produced a burst of
 * failures-and-retries. Now `job_claim` simply will not hand out a job whose
 * lock key is busy, so a second message from the same advocate waits in the
 * queue instead of being claimed and rejected. Fewer moving parts, and the
 * retry counter is no longer consumed by contention that was never an error.
 */
@Injectable()
export class InboundWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = getLogger().child({ module: 'whatsapp:worker' });

  private running = false;
  private readonly slots: Promise<void>[] = [];
  private sweepTimer?: NodeJS.Timeout;
  /** Resolves when a shutdown is requested, so a sleeping slot wakes at once. */
  private wakeShutdown: () => void = () => undefined;
  private shutdownSignal = new Promise<void>((resolve) => {
    this.wakeShutdown = resolve;
  });

  constructor(
    private readonly jobs: JobRepository,
    private readonly conversation: ConversationService,
    private readonly api: WhatsAppApiService,
    private readonly messages: MessageRepository,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  onModuleInit(): void {
    this.running = true;

    for (let slot = 0; slot < this.env.WORKER_CONCURRENCY; slot++) {
      this.slots.push(this.runSlot(slot));
    }

    // Recovering stalled jobs is what stops a crash from silently losing every
    // message that was in flight. Without it those rows sit ACTIVE forever and,
    // because their lock key stays busy, they also block every later message
    // from the same advocate.
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.env.JOB_STALLED_SWEEP_MS);
    this.sweepTimer.unref();

    this.logger.info(
      {
        concurrency: this.env.WORKER_CONCURRENCY,
        pollMs: this.env.JOB_POLL_INTERVAL_MS,
        leaseSeconds: this.env.JOB_LEASE_SECONDS,
      },
      'Inbound worker started (Postgres queue)',
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wakeShutdown();
    if (this.sweepTimer) clearInterval(this.sweepTimer);

    // Let in-flight jobs finish so a deploy does not strand a half-sent reply.
    // A slot that is sleeping returns immediately; one that is working finishes
    // the message it is on.
    await Promise.allSettled(this.slots);
    this.logger.info('Inbound worker stopped');
  }

  /**
   * One concurrency slot.
   *
   * Each slot claims and processes independently. They do not coordinate,
   * because `job_claim` already guarantees no two slots get the same job and no
   * two get jobs from the same advocate.
   */
  private async runSlot(slot: number): Promise<void> {
    while (this.running) {
      let job: Awaited<ReturnType<JobRepository['claim']>> = null;

      try {
        job = await this.jobs.claim(QUEUE_WHATSAPP_INBOUND, this.env.JOB_LEASE_SECONDS);
      } catch (err) {
        // The database is unreachable. Back off further than the normal poll:
        // hammering a struggling database is how a blip becomes an outage.
        this.logger.error({ err, slot }, 'Could not claim a job; backing off');
        await this.sleep(this.env.JOB_POLL_INTERVAL_MS * 5);
        continue;
      }

      if (!job) {
        await this.sleep(this.env.JOB_POLL_INTERVAL_MS);
        continue;
      }

      await this.handle(job.id, job.payload as unknown as InboundMessageJob, job.attempts, job.max_attempts);
    }
  }

  private async handle(
    jobId: string,
    data: InboundMessageJob,
    attempts: number,
    maxAttempts: number,
  ): Promise<void> {
    /*
     * A second safety net under the single-attempt policy.
     *
     * maxAttempts=1 stops the two known replay paths, but both of them live in
     * SQL functions and a queue table that other code can touch. This one is a
     * single atomic INSERT that cannot be argued with: the first worker to
     * claim the key answers the message, and any other - now, or after a
     * redelivery, or from a second worker process - finds the key taken and
     * stops.
     *
     * Claimed before the reply rather than after, because the failure it exists
     * to prevent is a *duplicate answer*, and an answer that was half-sent when
     * the process died is still an answer somebody received.
     */
    const firstAttempt = await this.messages
      .claimWebhookEvent(`wa:answered:${data.waMessageId}`)
      .catch(() => true);

    if (!firstAttempt) {
      this.logger.warn(
        { from: maskPhone(data.from), waMessageId: data.waMessageId, attempts },
        'Message was already answered - dropping the replay instead of answering twice',
      );
      await this.jobs.complete(jobId).catch(() => undefined);
      return;
    }

    try {
      await this.messages.updateStatus(data.waMessageId, 'PROCESSING');
      await this.conversation.handle(data);
      await this.messages.updateStatus(data.waMessageId, 'RECEIVED');
      await this.jobs.complete(jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.error(
        { err, from: maskPhone(data.from), waMessageId: data.waMessageId, attempts },
        'Failed to handle inbound message',
      );

      await this.messages
        .updateStatus(data.waMessageId, 'FAILED', message)
        .catch(() => undefined);

      const outcome = await this.jobs
        .fail(jobId, message)
        .catch(() => ({ dead: attempts >= maxAttempts, attempts, retryAt: null }));

      // Apologise only once the retries are exhausted. An apology followed by a
      // successful retry is worse than silence: it makes a bot that recovered
      // look broken.
      if (outcome.dead) {
        await this.api.sendText(data.from, Replies.PROCESSING_ERROR).catch(() => undefined);
      }
    }
  }

  private async sweep(): Promise<void> {
    try {
      const reclaimed = await this.jobs.reclaimStalled(QUEUE_WHATSAPP_INBOUND);
      if (reclaimed > 0) {
        this.logger.warn({ reclaimed }, 'Reclaimed jobs whose worker stopped without finishing');
      }

      // Housekeeping rides along with the sweep rather than having a timer of
      // its own; both are cheap and neither is urgent.
      await this.jobs.purge();
    } catch (err) {
      this.logger.warn({ err }, 'Stalled-job sweep failed; will retry on the next interval');
    }
  }

  /**
   * Sleep, but wake immediately on shutdown.
   *
   * A plain `setTimeout` would make every slot hold the process open for up to
   * a full poll interval after SIGTERM, turning a one-second deploy into a
   * several-second one for no reason.
   */
  private sleep(ms: number): Promise<void> {
    return Promise.race([
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
      }),
      this.shutdownSignal,
    ]);
  }
}

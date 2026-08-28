import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { JobRepository } from '../database/repositories/job.repository';
import { InboundMessageJob, QUEUE_WHATSAPP_INBOUND, inboundJobId } from './queue.constants';

/**
 * Producer side of the queue.
 *
 * The webhook controller must acknowledge Meta within a few hundred
 * milliseconds or Meta retries and eventually disables the subscription. So the
 * HTTP handler does nothing but verify, enqueue and return 200; everything
 * expensive happens in the worker.
 *
 * Replaces the BullMQ producer. The contract is unchanged — enqueue is
 * idempotent on Meta's message id, so a redelivered webhook cannot queue the
 * same message twice.
 */
@Injectable()
export class JobQueueService {
  private readonly logger = getLogger().child({ module: 'queue' });

  constructor(private readonly jobs: JobRepository) {}

  async enqueueInbound(job: InboundMessageJob): Promise<void> {
    const result = await this.jobs.enqueue({
      queue: QUEUE_WHATSAPP_INBOUND,
      payload: job as unknown as Record<string, unknown>,
      dedupeKey: inboundJobId(job.waMessageId),
      // Serialises per advocate: a second message from the same number waits
      // for the first to finish rather than racing it through the same
      // conversation state. See migration 0013.
      lockKey: job.from,
      /*
       * One attempt. Never two.
       *
       * The default of three is right for work that can be repeated safely.
       * Answering a WhatsApp message cannot be: the reply is sent partway
       * through handling, and everything after it - saving conversation state,
       * recording analytics, appending to memory - happens with the message
       * already on the advocate's phone. A retry re-runs all of it and sends a
       * second answer, freshly generated, so it does not even look like a
       * duplicate. The same applies to the stalled-job sweep, which returns a
       * job to QUEUED when a worker dies mid-flight - including the ordinary
       * case of a deploy landing between the send and the completion.
       *
       * With one attempt, `job_reclaim_stalled` marks a stranded job DEAD
       * rather than requeueing it, and `job_fail` reports dead on the first
       * failure so the apology in InboundWorker.handle still goes out exactly
       * once.
       *
       * The cost is that a transient failure - a model timeout, a blip - is not
       * retried, and the advocate is told something went wrong instead of
       * getting a late answer. That is the better trade for a channel where the
       * previous behaviour was messaging people unprompted.
       */
      maxAttempts: 1,
    });

    this.logger.debug(
      { waMessageId: job.waMessageId, type: job.type, deduplicated: !result.inserted },
      result.inserted ? 'Inbound message queued' : 'Inbound message already queued; ignoring redelivery',
    );
  }

  /**
   * Queue depth, for the health endpoint and admin panel.
   *
   * `oldest_wait_seconds` is the number that actually matters operationally: a
   * rising figure means the worker is dead or stuck, which otherwise presents
   * to advocates as "the bot received my message and never replied" with
   * nothing in the web logs to explain it.
   */
  async stats(): Promise<Record<string, number>> {
    const stats = await this.jobs.stats(QUEUE_WHATSAPP_INBOUND);
    return {
      waiting: stats.waiting,
      active: stats.active,
      dead: stats.dead,
      completed24h: stats.done_24h,
      oldestWaitSeconds: stats.oldest_wait_seconds,
    };
  }
}

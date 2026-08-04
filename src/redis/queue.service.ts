import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { InboundMessageJob, QUEUE_WHATSAPP_INBOUND, inboundJobId } from './queue.constants';
import { RedisService } from './redis.service';

/**
 * Producer side of the queue.
 *
 * The webhook controller must return 200 to Meta within a few hundred
 * milliseconds or Meta retries and eventually throttles the number. So the HTTP
 * handler does nothing but validate, enqueue, and acknowledge; everything
 * expensive (retrieval, LLM calls, eCourts scraping) happens in the worker.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = getLogger().child({ module: 'queue' });
  private connection!: Redis;
  private inboundQueue!: Queue<InboundMessageJob>;

  constructor(
    private readonly redis: RedisService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  onModuleInit(): void {
    this.connection = this.redis.createQueueConnection();
    this.inboundQueue = new Queue<InboundMessageJob>(QUEUE_WHATSAPP_INBOUND, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: this.env.WORKER_MAX_ATTEMPTS,
        // Exponential rather than fixed: most failures here are a rate-limited
        // LLM or a flaky eCourts endpoint, and hammering either makes it worse.
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        // Keep failures around for a day so they can actually be inspected.
        removeOnFail: { age: 86400 },
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.inboundQueue?.close();
    this.connection?.disconnect();
  }

  /**
   * Enqueue an inbound message.
   *
   * The job id is derived from Meta's message id, so a duplicate delivery is
   * rejected by BullMQ itself even if it slips past the Redis and database
   * dedupe checks.
   */
  async enqueueInbound(job: InboundMessageJob): Promise<void> {
    await this.inboundQueue.add(QUEUE_WHATSAPP_INBOUND, job, { jobId: inboundJobId(job.waMessageId) });
    this.logger.debug({ waMessageId: job.waMessageId, type: job.type }, 'Inbound message queued');
  }

  /** Queue depth, surfaced on the health endpoint and admin stats. */
  async stats(): Promise<Record<string, number>> {
    const counts = await this.inboundQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    return counts as Record<string, number>;
  }
}

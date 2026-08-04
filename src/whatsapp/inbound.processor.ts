import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { getLogger, maskPhone } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { MessageRepository } from '../database/repositories/message.repository';
import { InboundMessageJob, QUEUE_WHATSAPP_INBOUND } from '../redis/queue.constants';
import { RedisService } from '../redis/redis.service';
import { ConversationService } from './conversation.service';
import * as Replies from './replies';
import { WhatsAppApiService } from './whatsapp-api.service';

/**
 * Consumer side of the queue. Runs only in the worker process.
 *
 * Per-user serialisation is the subtle part. An advocate who fires off three
 * messages in a row would otherwise have them picked up by three different
 * concurrency slots at once, all reading and writing the same conversation
 * state - producing interleaved answers and a corrupted flow. The lock makes
 * one message per user run at a time; the rest are retried by BullMQ moments
 * later, which is exactly the behaviour we want.
 */
@Injectable()
export class InboundProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = getLogger().child({ module: 'whatsapp:processor' });
  private worker?: Worker<InboundMessageJob>;
  private connection?: Redis;

  constructor(
    private readonly conversation: ConversationService,
    private readonly redis: RedisService,
    private readonly api: WhatsAppApiService,
    private readonly messages: MessageRepository,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  onModuleInit(): void {
    this.connection = this.redis.createQueueConnection();

    this.worker = new Worker<InboundMessageJob>(
      QUEUE_WHATSAPP_INBOUND,
      async (job) => this.process(job),
      {
        connection: this.connection,
        concurrency: this.env.WORKER_CONCURRENCY,
        // A single message should never occupy a slot for more than a minute -
        // that is far longer than even a slow LLM call plus retrieval.
        lockDuration: 60000,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        { jobId: job?.id, attempts: job?.attemptsMade, err },
        'Inbound message job failed',
      );
    });

    this.worker.on('error', (err) => this.logger.error({ err }, 'Worker error'));

    this.logger.info({ concurrency: this.env.WORKER_CONCURRENCY }, 'Inbound worker started');
  }

  async onModuleDestroy(): Promise<void> {
    // Let in-flight jobs finish so a deploy does not strand a half-sent reply.
    await this.worker?.close();
    this.connection?.disconnect();
  }

  private async process(job: Job<InboundMessageJob>): Promise<void> {
    const data = job.data;
    const lockKey = `lock:user:${data.from}`;

    const ran = await this.redis.withLock(lockKey, 60000, async () => {
      await this.messages.updateStatus(data.waMessageId, 'PROCESSING');

      try {
        await this.conversation.handle(data);
        await this.messages.updateStatus(data.waMessageId, 'RECEIVED');
      } catch (err) {
        this.logger.error(
          { err, from: maskPhone(data.from), waMessageId: data.waMessageId },
          'Failed to handle inbound message',
        );

        await this.messages.updateStatus(
          data.waMessageId,
          'FAILED',
          err instanceof Error ? err.message : String(err),
        );

        // Tell the user something went wrong, but only once we have exhausted
        // retries - an apology followed by a successful retry is worse than
        // silence, because it makes the bot look broken when it recovered.
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          await this.api.sendText(data.from, Replies.PROCESSING_ERROR).catch(() => undefined);
        }

        throw err;
      }
      return true;
    });

    if (ran === null) {
      // Another message from this user holds the lock. Throwing puts the job
      // back for a retry with backoff rather than dropping it.
      this.logger.debug({ from: maskPhone(data.from) }, 'User is busy; deferring message');
      throw new Error('User lock held by a concurrent message; will retry');
    }
  }
}

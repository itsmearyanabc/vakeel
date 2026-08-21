import { Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';

/**
 * The producer side of the job queue.
 *
 * Replaces RedisModule, which no longer exists. `JobRepository` comes from the
 * global DatabaseModule, so this module holds only the service that wraps it —
 * which is why it has no imports of its own.
 *
 * The consumer lives in WhatsAppWorkerModule, not here, because only the worker
 * process should run it: a web replica that also drained the queue would
 * compete for jobs and could not be scaled for its actual bottleneck.
 */
@Module({
  providers: [JobQueueService],
  exports: [JobQueueService],
})
export class JobsModule {}

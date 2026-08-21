import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { JobQueueService } from '../jobs/job-queue.service';

/**
 * Liveness and readiness.
 *
 * Railway's healthcheck points at /health/ready (see railway.web.json). Keeping
 * the two separate matters: a dependency blip should stop new traffic being
 * routed here, not cause the platform to kill and restart a process that is
 * otherwise fine.
 */
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: DatabaseService,
    private readonly queue: JobQueueService,
  ) {}


  /** Process is alive. Deliberately checks nothing external. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'ok', uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  /** Dependencies are reachable, so this replica can serve webhooks. */
  @Get('ready')
  async ready() {
    // Postgres is the only dependency now. Redis went in migration 0013, and
    // reporting on something that no longer exists is worse than not reporting.
    const database = await this.db.ping();

    if (!database) {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'The database is unreachable.',
        details: { database },
      });
    }

    return { status: 'ok', database };
  }

  /** Queue depth, for eyeballing whether the worker is keeping up. */
  @Get('queue')
  async queueStats() {
    return this.queue.stats();
  }
}

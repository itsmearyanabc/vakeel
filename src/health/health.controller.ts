import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { QueueService } from '../redis/queue.service';
import { RedisService } from '../redis/redis.service';

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
    private readonly redis: RedisService,
    private readonly queue: QueueService,
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
    const [database, redis] = await Promise.all([this.db.ping(), this.redis.ping()]);

    if (!database || !redis) {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'One or more dependencies are unreachable.',
        details: { database, redis },
      });
    }

    return { status: 'ok', database, redis };
  }

  /** Queue depth, for eyeballing whether the worker is keeping up. */
  @Get('queue')
  async queueStats() {
    return this.queue.stats();
  }
}

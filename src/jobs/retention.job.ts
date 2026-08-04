import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getLogger } from '../common/logger';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { RedisService } from '../redis/redis.service';

/**
 * Nightly data retention sweep (DPDP Act 2023, spec section 17).
 *
 * Runs in the worker process only. The Redis lock is what makes it safe to run
 * more than one worker replica - without it, every replica would fire the same
 * purge at 03:00 and they would contend on the same rows.
 */
@Injectable()
export class RetentionJob {
  private readonly logger = getLogger().child({ module: 'retention' });

  constructor(
    private readonly analytics: AnalyticsRepository,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 3 * * *', { name: 'retention-purge', timeZone: 'Asia/Kolkata' })
  async purge(): Promise<void> {
    // 10-minute lock: long enough for a large purge, short enough to self-heal
    // if a worker dies holding it.
    const result = await this.redis.withLock('lock:job:retention', 600000, async () => {
      this.logger.info('Starting retention purge');
      return this.analytics.purgeExpired();
    });

    if (result === null) {
      this.logger.debug('Retention purge already running on another replica');
      return;
    }

    this.logger.info(result, 'Retention purge complete');
  }
}

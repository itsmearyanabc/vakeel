import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getLogger } from '../common/logger';
import { DatabaseService } from '../database/database.service';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { CacheRepository } from '../database/repositories/cache.repository';
import { MemoryRepository } from '../database/repositories/memory.repository';

/**
 * Nightly data retention sweep (DPDP Act 2023, spec section 17).
 *
 * Runs in the worker process only. The advisory lock is what makes it safe to
 * run more than one worker replica - without it, every replica would fire the
 * same purge at 03:00 and they would contend on the same rows.
 */
@Injectable()
export class RetentionJob {
  private readonly logger = getLogger().child({ module: 'retention' });

  constructor(
    private readonly db: DatabaseService,
    private readonly analytics: AnalyticsRepository,
    private readonly cache: CacheRepository,
    private readonly memory: MemoryRepository,
  ) {}

  @Cron('0 3 * * *', { name: 'retention-purge', timeZone: 'Asia/Kolkata' })
  async purge(): Promise<void> {
    // A Postgres advisory lock, held by the session rather than by a TTL - so a
    // process that dies mid-purge releases it immediately instead of blocking
    // the next run until a timeout lapses. See DatabaseService.withLock.
    const result = await this.db.withLock('job:retention', async () => {
      this.logger.info('Starting retention purge');

      const purged = await this.analytics.purgeExpired();

      // Caches and WhatsApp memory expire logically on read, so this only
      // reclaims disk. It rides along here rather than having a schedule of its
      // own because neither is urgent.
      const cache = await this.cache.purgeExpired();
      const memory = await this.memory.purgeExpired();

      return { ...purged, cacheEntries: cache, memoryRows: memory };
    });

    if (result === null) {
      this.logger.debug('Retention purge already running on another replica');
      return;
    }

    this.logger.info(result, 'Retention purge complete');
  }
}

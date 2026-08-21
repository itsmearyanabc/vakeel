import { Injectable } from '@nestjs/common';
import type { JSONValue } from 'postgres';
import { getLogger } from '../../common/logger';
import { DatabaseService } from '../database.service';

/**
 * A durable cache, for responses that cost money to fetch again.
 *
 * ## What belongs here, and what does not
 *
 * Only Indian Kanoon results and embeddings. Both are billed per call, and both
 * are caching something immutable — a reported judgment does not change once
 * published, and the embedding of a fixed string is a pure function.
 *
 * Everything else stays in process memory. Putting an ordinary cache in
 * Postgres trades a memory lookup for a network round trip, which is the wrong
 * direction: it would be slower than not caching at all for anything the
 * database could have answered directly.
 *
 * ## Why not just the in-process LRU
 *
 * Deploys. An in-process cache is empty after every restart, so a release would
 * re-buy every Kanoon search an advocate had already paid for that day. This
 * table is what makes a deploy free rather than billable.
 *
 * ## Failure policy
 *
 * Every method here swallows its errors and returns as though the cache missed.
 * A cache is an optimisation, and an optimisation that can fail a request is a
 * liability — if this table is unreachable the caller should make the upstream
 * call it was trying to avoid, not return an error to an advocate.
 */
@Injectable()
export class CacheRepository {
  private readonly logger = getLogger().child({ module: 'cache' });

  constructor(private readonly db: DatabaseService) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const [row] = await this.db.sql<{ value: T }[]>`
        SELECT value FROM cache_entries WHERE key = ${key} AND expires_at > NOW()
      `;
      return row?.value ?? null;
    } catch (err) {
      this.logger.warn({ err, key }, 'Cache read failed; treating as a miss');
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.db.sql`
        INSERT INTO cache_entries (key, value, expires_at)
             VALUES (${key}, ${this.db.sql.json(value as JSONValue)},
                     NOW() + (${ttlSeconds}::int * INTERVAL '1 second'))
        ON CONFLICT (key) DO UPDATE
                SET value      = EXCLUDED.value,
                    expires_at = EXCLUDED.expires_at,
                    created_at = NOW()
      `;
    } catch (err) {
      this.logger.warn({ err, key }, 'Cache write failed; the value is simply not cached');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.db.sql`DELETE FROM cache_entries WHERE key = ${key}`;
    } catch (err) {
      this.logger.warn({ err, key }, 'Cache delete failed');
    }
  }

  /**
   * Drop expired rows.
   *
   * Runs from the nightly retention sweep rather than on a timer. Expired rows
   * are already invisible to `get()`, so this reclaims disk rather than
   * correcting behaviour and has no reason to be prompt.
   */
  async purgeExpired(): Promise<number> {
    try {
      const rows = await this.db.sql<{ key: string }[]>`
        DELETE FROM cache_entries WHERE expires_at < NOW() RETURNING key
      `;
      return rows.length;
    } catch (err) {
      this.logger.warn({ err }, 'Cache purge failed');
      return 0;
    }
  }
}

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import postgres, { Sql } from 'postgres';
import { getLogger } from '../common/logger';
import { APP_ENV, InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';

/**
 * Postgres access via postgres.js.
 *
 * ## Why not Prisma (which the architecture spec names)
 *
 * The retrieval core of this app is pgvector similarity, tsvector full-text and
 * an RRF fusion query. None of that is expressible through an ORM - it would be
 * `$queryRaw` regardless - and Prisma additionally has no first-class `vector`
 * type, so the schema would need `Unsupported("vector(3072)")` columns that the
 * client cannot read or write anyway.
 *
 * Given the ORM would be bypassed for every interesting query, postgres.js is
 * the better fit: tagged templates parameterise safely, results are typed at
 * the call site, and there is no generate step in the Docker build.
 *
 * ## Supabase connection notes
 *
 * DATABASE_URL should point at the *transaction pooler* (port 6543). Railway
 * containers are ephemeral and can scale horizontally; connecting each replica
 * directly to Postgres exhausts the connection limit quickly.
 *
 * The pooler runs in transaction mode, which means no prepared statements -
 * hence `prepare: false`. Leaving it on produces intermittent
 * "prepared statement already exists" errors under load, which are miserable to
 * diagnose because they only appear once connections start being reused.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = getLogger().child({ module: 'database' });
  readonly sql: Sql;

  constructor(@InjectEnv() private readonly env: AppEnv) {
    const usesPooler = env.DATABASE_URL.includes('pooler.supabase.com') || env.DATABASE_URL.includes(':6543');

    this.sql = postgres(env.DATABASE_URL, {
      max: env.DATABASE_POOL_MAX,
      idle_timeout: 30,
      connect_timeout: 15,
      ssl: env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : false,
      // Required on the Supabase transaction pooler; harmless otherwise, at the
      // cost of losing statement plan caching on direct connections.
      prepare: !usesPooler,
      onnotice: (notice) => this.logger.debug({ notice: notice.message }, 'postgres notice'),
      transform: { undefined: null },
    });
  }

  async onModuleInit(): Promise<void> {
    // Fail fast and loudly: a bad DATABASE_URL should stop the deploy, not
    // manifest as failing webhooks later.
    try {
      const [row] = await this.sql<{ version: string }[]>`SELECT version() AS version`;
      this.logger.info({ version: row?.version?.split(',')[0] }, 'Database connected');
    } catch (err) {
      this.logger.error({ err }, 'Database connection failed - check DATABASE_URL');
      throw err;
    }

    await this.assertSchemaReady();
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  /**
   * Run something while holding a named lock, or skip it if someone else is.
   *
   * Replaces the Redis lock (migration 0013). Advisory locks are better suited
   * to this than a key with a TTL, for one reason that matters: the lock is
   * held by a *session*, so a process that dies releases it immediately. A TTL
   * lock held by a dead process stays held until it lapses, and the window
   * where nothing can run is exactly the window after a crash when the work
   * most needs to.
   *
   * Returns null when the lock was not free, which callers read as "another
   * instance is already doing this" rather than as a failure.
   *
   * ## Why a transaction-scoped lock is not used here
   *
   * `pg_try_advisory_xact_lock` releases at commit, which is wrong for work
   * that spans several statements and is not one transaction. This takes a
   * session lock and releases it in a `finally`, on the same connection - the
   * `reserve()` is what guarantees that, since releasing from a different
   * pooled connection than the one that acquired it would silently do nothing.
   */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const key = lockKey(name);
    const connection = await this.sql.reserve();

    try {
      const [row] = await connection<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${key}::bigint) AS locked
      `;

      if (!row?.locked) return null;

      try {
        return await fn();
      } finally {
        await connection`SELECT pg_advisory_unlock(${key}::bigint)`.catch(() => undefined);
      }
    } finally {
      connection.release();
    }
  }

  /**
   * Verify the migrations have actually been applied.
   *
   * The alternative is a confusing "relation users does not exist" on the first
   * inbound WhatsApp message, some time after the deploy looked green.
   */
  private async assertSchemaReady(): Promise<void> {
    const rows = await this.sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('users', 'statutes', 'judgment_chunks', 'search_history')
    `;

    const found = new Set(rows.map((r) => r.table_name));
    const missing = ['users', 'statutes', 'judgment_chunks', 'search_history'].filter((t) => !found.has(t));

    if (missing.length > 0) {
      throw new Error(
        `Database schema is not initialised (missing tables: ${missing.join(', ')}).\n` +
          'Run `npm run db:migrate`, or paste supabase/migrations/*.sql into the Supabase SQL Editor in filename order.',
      );
    }
  }

  /** Cheap liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.sql`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Turn a lock name into the bigint advisory locks are keyed on.
 *
 * A 53-bit FNV-1a fold. Collisions are possible in principle and harmless in
 * practice: this application takes exactly two named locks, and a collision
 * would only mean one waits for the other. Staying inside 2^53 keeps the value
 * exact as a JavaScript number, which a full 64-bit hash would not.
 */
function lockKey(name: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash;
}

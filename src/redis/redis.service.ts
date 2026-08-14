import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';

/**
 * Redis connection plus the two primitives that need to be atomic across
 * replicas: distributed locks and quota counters.
 *
 * Both are implemented as Lua scripts. Redis executes a script as a single
 * atomic unit, which is the whole point - a read-then-write from Node would let
 * two workers on different Railway replicas interleave and both conclude the
 * user has quota left.
 */

/** Compare-and-delete: only the lock holder may release it. */
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/**
 * Atomic quota claim.
 *
 * KEYS[1] counter key, ARGV[1] limit, ARGV[2] ttl seconds.
 * Returns {allowed, used}. A negative limit means unlimited.
 *
 * The decrement on the over-limit path matters: without it a user who keeps
 * messaging after exhausting their quota inflates the counter indefinitely, and
 * the "used" number we show them stops meaning anything.
 */
const CLAIM_QUOTA_SCRIPT = `
local limit = tonumber(ARGV[1])
local ttl   = tonumber(ARGV[2])
local cost  = tonumber(ARGV[3])
local used  = redis.call('incrby', KEYS[1], cost)

if used == cost then
  redis.call('expire', KEYS[1], ttl)
end

if limit < 0 then
  return {1, used}
end

if used > limit then
  redis.call('decrby', KEYS[1], cost)
  -- Report what is actually spent, not the limit: a 2-credit search refused
  -- against a 5-credit day has 4 spent, and telling the advocate they are at
  -- the cap when they have one credit left is simply wrong.
  return {0, used - cost}
end

return {1, used}
`;

/**
 * Give back one unit of quota.
 *
 * Floors at zero and never creates the key. A refund for a day whose counter
 * has already expired must not resurrect it at -1, because the next claim would
 * then read 0 and hand out a free extra query every night.
 */
const REFUND_QUOTA_SCRIPT = `
local used = tonumber(redis.call('get', KEYS[1]))
local cost = tonumber(ARGV[1])

if used == nil or used <= 0 then
  return 0
end

-- Never refund more than was spent. A refund larger than the counter would
-- leave it negative, and the next claim would read a free allowance.
if cost > used then
  cost = used
end

return redis.call('decrby', KEYS[1], cost)
`;

export interface AcquiredLock {
  key: string;
  token: string;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = getLogger().child({ module: 'redis' });
  readonly client: Redis;

  constructor(@InjectEnv() private readonly env: AppEnv) {
    this.client = new Redis(env.REDIS_URL, this.baseOptions());
    this.client.on('error', (err) => this.logger.error({ err }, 'Redis error'));
  }

  private baseOptions(): RedisOptions {
    return {
      // Railway's Redis plugin is reachable over the private network without
      // TLS; a rediss:// URL turns it on automatically.
      lazyConnect: false,
      enableReadyCheck: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
      maxRetriesPerRequest: 3,
    };
  }

  /**
   * A dedicated connection for BullMQ.
   *
   * BullMQ blocks on BRPOPLPUSH while waiting for jobs; ioredis' default
   * `maxRetriesPerRequest` aborts long-blocking commands, so BullMQ requires it
   * to be null. Sharing this app's main client would break either the queue or
   * ordinary command retries, hence a separate connection.
   */
  createQueueConnection(): Redis {
    return new Redis(this.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.ping();
      this.logger.info('Redis connected');
    } catch (err) {
      this.logger.error({ err }, 'Redis connection failed - check REDIS_URL');
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  // --- Idempotency ----------------------------------------------------------

  /**
   * Claim a one-time key. True means the caller is the first to see it.
   *
   * Used to drop Meta's duplicate webhook deliveries before they cost us an LLM
   * call. The database unique constraint is the durable backstop; this is the
   * cheap one.
   */
  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  // --- Distributed lock -----------------------------------------------------

  /**
   * Try to acquire a lock. Returns null if someone else holds it.
   *
   * Serialises processing per user so two rapid-fire messages from the same
   * advocate don't produce two interleaved answers to the same half-finished
   * conversation state.
   */
  async acquireLock(key: string, ttlMs = 30000): Promise<AcquiredLock | null> {
    const token = randomUUID();
    const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { key, token } : null;
  }

  async releaseLock(lock: AcquiredLock): Promise<void> {
    await this.client.eval(RELEASE_LOCK_SCRIPT, 1, lock.key, lock.token);
  }

  /**
   * Run `fn` while holding a lock, releasing it even if `fn` throws.
   *
   * Returns null without running `fn` when the lock is already held.
   */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
    const lock = await this.acquireLock(key, ttlMs);
    if (!lock) return null;
    try {
      return await fn();
    } finally {
      await this.releaseLock(lock).catch((err) =>
        this.logger.warn({ err, key }, 'Failed to release lock; it will expire on its own'),
      );
    }
  }

  // --- Quota ----------------------------------------------------------------

  /**
   * Fast-path daily quota claim. `limit < 0` is unlimited.
   *
   * The durable ledger in Postgres is updated separately; this is what keeps
   * the hot path off the database.
   */
  async claimQuota(userId: string, limit: number, cost = 1): Promise<{ allowed: boolean; used: number }> {
    // Two days, so a counter created just before midnight UTC survives long
    // enough to be inspected rather than vanishing mid-conversation.
    const [allowed, used] = (await this.client.eval(
      CLAIM_QUOTA_SCRIPT,
      1,
      this.quotaKey(userId),
      String(limit),
      '172800',
      String(cost),
    )) as [number, number];
    return { allowed: allowed === 1, used };
  }

  /**
   * Return claimed credits, for work that was paid for but never delivered.
   *
   * Returns the counter's new value. See {@link REFUND_QUOTA_SCRIPT} for why it
   * refuses to go below zero or to create a missing key.
   */
  async refundQuota(userId: string, cost = 1): Promise<number> {
    return (await this.client.eval(
      REFUND_QUOTA_SCRIPT,
      1,
      this.quotaKey(userId),
      String(cost),
    )) as number;
  }

  /** Same key for both operations, so a refund can never miss the claim. */
  private quotaKey(userId: string): string {
    return `quota:${userId}:${new Date().toISOString().slice(0, 10)}`;
  }

  // --- Generic cache --------------------------------------------------------

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A poisoned cache entry should not take down the request path.
      await this.client.del(key);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

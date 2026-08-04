import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { UserRole } from '../database/types';
import { RedisService } from '../redis/redis.service';

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  limit: number;
  /** Convenience for message templates. */
  remaining: number | 'unlimited';
}

/**
 * Daily usage limits by role (spec section 16).
 *
 * This is explicitly NOT the credit wallet from the architecture document -
 * billing is out of scope for this build. It is a rate limit, which is what
 * actually protects the LLM spend in the meantime. When Razorpay is added, a
 * wallet ledger should sit alongside this rather than replacing it: quotas stop
 * abuse, credits price usage, and they answer different questions.
 *
 * The counter lives in Redis for speed and in Postgres for durability. Redis is
 * authoritative for the allow/deny decision; the database write is the audit
 * trail and the fallback if Redis is unavailable.
 */
@Injectable()
export class QuotaService {
  private readonly logger = getLogger().child({ module: 'quota' });

  constructor(
    private readonly redis: RedisService,
    private readonly analytics: AnalyticsRepository,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  limitForRole(role: UserRole): number {
    switch (role) {
      case 'GUEST_LAWYER':
        return this.env.QUOTA_GUEST_DAILY;
      case 'VERIFIED_ADVOCATE':
        return this.env.QUOTA_VERIFIED_DAILY;
      case 'LEGAL_AUDITOR':
      case 'SUPER_ADMIN':
        return this.env.QUOTA_ADMIN_DAILY;
      default:
        return this.env.QUOTA_GUEST_DAILY;
    }
  }

  /**
   * Consume one unit of today's quota.
   *
   * Redis decides. The Postgres counter is updated afterwards for reporting and
   * is not awaited on the deny path, because a rejected user does not need to
   * wait on a write they will never see.
   *
   * If Redis is down, this falls back to the SQL function, which is slower but
   * equally atomic. Failing open is not an option - it would leave the LLM
   * spend unbounded for exactly as long as Redis is unavailable.
   */
  async claim(userId: string, role: UserRole): Promise<QuotaDecision> {
    const limit = this.limitForRole(role);

    if (limit < 0) {
      // Unlimited: still record usage, but there is nothing to check.
      void this.analytics.claimQuota(userId, limit).catch((err) =>
        this.logger.warn({ err, userId }, 'Failed to record unlimited usage'),
      );
      return { allowed: true, used: 0, limit, remaining: 'unlimited' };
    }

    try {
      const decision = await this.redis.claimQuota(userId, limit);

      void this.analytics
        .claimQuota(userId, limit)
        .catch((err) => this.logger.warn({ err, userId }, 'Failed to mirror quota claim to database'));

      return {
        allowed: decision.allowed,
        used: decision.used,
        limit,
        remaining: Math.max(0, limit - decision.used),
      };
    } catch (err) {
      this.logger.error({ err, userId }, 'Redis quota check failed; falling back to database');

      const fallback = await this.analytics.claimQuota(userId, limit);
      return {
        allowed: fallback.allowed,
        used: fallback.used,
        limit,
        remaining: Math.max(0, limit - fallback.used),
      };
    }
  }

  async usageToday(userId: string): Promise<number> {
    return this.analytics.usageToday(userId);
  }
}

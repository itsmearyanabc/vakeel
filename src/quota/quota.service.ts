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
  /** What this action actually cost. Zero when it was free or already paid for. */
  charged: number;
}

/**
 * What each action costs.
 *
 * Case status is free on purpose. It is a lookup against a court record with no
 * model call behind it, it is the thing an advocate does standing outside a
 * courtroom, and charging for it would make the cheapest feature feel like the
 * most rationed one. Research costs two because it is two LLM calls and,
 * for precedents, a billed Kanoon search.
 */
export const CREDIT_COST = {
  CASE_STATUS: 0,
  SECTION_LOOKUP: 2,
  PRECEDENT_SEARCH: 2,
} as const;

/**
 * Has the advocate moved to a genuinely new question?
 *
 * Credits buy a *search*, not a message, so pressing for more detail on the
 * same question must not be charged twice - but jumping from IPC 420 to
 * section 53 must be. The comparison is exact-after-normalisation rather than
 * fuzzy on purpose: this decides what someone is billed, and a similarity
 * threshold that charges for one rephrasing and not another is impossible to
 * explain to the person paying. Predictable beats clever here.
 */
export function isSameSearchContext(previous: string | null | undefined, next: string): boolean {
  if (!previous) return false;
  return normaliseQuery(previous) === normaliseQuery(next);
}

function normaliseQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
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
  async claim(userId: string, role: UserRole, cost = 1): Promise<QuotaDecision> {
    const limit = this.limitForRole(role);

    // Free actions still need a balance to display, but must never be refused
    // and must never move the counter.
    if (cost === 0) {
      const decision = await this.peek(userId, role);
      return { ...decision, allowed: true, charged: 0 };
    }

    if (limit < 0) {
      // Unlimited: still record usage, but there is nothing to check.
      void this.analytics.claimQuota(userId, limit).catch((err) =>
        this.logger.warn({ err, userId }, 'Failed to record unlimited usage'),
      );
      return { allowed: true, used: 0, limit, remaining: 'unlimited', charged: cost };
    }

    try {
      const decision = await this.redis.claimQuota(userId, limit, cost);

      if (decision.allowed) {
        void this.analytics
          .claimQuota(userId, limit)
          .catch((err) => this.logger.warn({ err, userId }, 'Failed to mirror quota claim to database'));
      }

      return {
        allowed: decision.allowed,
        used: decision.used,
        limit,
        remaining: Math.max(0, limit - decision.used),
        charged: decision.allowed ? cost : 0,
      };
    } catch (err) {
      this.logger.error({ err, userId }, 'Redis quota check failed; falling back to database');

      const fallback = await this.analytics.claimQuota(userId, limit);
      return {
        allowed: fallback.allowed,
        used: fallback.used,
        limit,
        remaining: Math.max(0, limit - fallback.used),
        charged: fallback.allowed ? cost : 0,
      };
    }
  }

  /** Current balance without spending anything. Used to render the help menu. */
  async peek(userId: string, role: UserRole): Promise<QuotaDecision> {
    const limit = this.limitForRole(role);
    if (limit < 0) {
      return { allowed: true, used: 0, limit, remaining: 'unlimited', charged: 0 };
    }

    const used = await this.analytics.usageToday(userId).catch(() => 0);
    return {
      allowed: used < limit,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      charged: 0,
    };
  }

  /**
   * The balance line shown with every help menu.
   *
   * Phrased in credits rather than "queries left" because the two are no longer
   * the same number - a case status costs nothing and a precedent search costs
   * two, so "3 queries left" would be a lie in both directions.
   */
  creditLine(decision: QuotaDecision): string {
    if (decision.remaining === 'unlimited') return 'Credits: unlimited';
    return `Credits: ${decision.remaining} of ${decision.limit} left today`;
  }

  /**
   * Give a claimed unit back.
   *
   * Quota is claimed before the answer is generated, because that is the only
   * point at which it can actually stop the spend. But a claim is a promise to
   * deliver an answer, and WhatsApp can refuse the send after the model has
   * already run - most commonly error 131030, a number not on a test app's
   * allowed list. Charging a guest one of five daily queries for a reply they
   * never received is the wrong side of that trade.
   *
   * Best-effort on both stores and never throws: the caller is already on a
   * failure path, and a failed refund must not mask the delivery error that
   * caused it. Unlimited roles have nothing to refund.
   */
  async refund(userId: string, role: UserRole, cost = 1): Promise<void> {
    if (cost <= 0 || this.limitForRole(role) < 0) return;

    try {
      await this.redis.refundQuota(userId, cost);
    } catch (err) {
      this.logger.warn({ err, userId }, 'Failed to refund quota in Redis');
    }

    try {
      await this.analytics.refundQuota(userId);
    } catch (err) {
      this.logger.warn({ err, userId }, 'Failed to refund quota in the database');
    }
  }

  async usageToday(userId: string): Promise<number> {
    return this.analytics.usageToday(userId);
  }
}

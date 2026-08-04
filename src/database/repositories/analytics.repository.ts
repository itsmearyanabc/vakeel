import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { QuotaResult, SearchHistoryInput } from '../types';

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly db: DatabaseService) {}

  async recordSearch(input: SearchHistoryInput): Promise<void> {
    await this.db.sql`
      INSERT INTO search_history (
        user_id, query_text, detected_language, resolved_query, intent,
        citations, result_count, model_used, input_tokens, output_tokens,
        latency_ms, guardrail_flagged, guardrail_reason
      ) VALUES (
        ${input.userId},
        ${input.queryText},
        ${input.detectedLanguage},
        ${input.resolvedQuery ?? null},
        ${input.intent}::query_intent,
        ${input.citations}::text[],
        ${input.resultCount},
        ${input.modelUsed ?? null},
        ${input.inputTokens},
        ${input.outputTokens},
        ${input.latencyMs},
        ${input.guardrailFlagged},
        ${input.guardrailReason ?? null}
      )
    `;
  }

  /**
   * Durable daily quota claim.
   *
   * Delegates to the claim_daily_quota() SQL function so the read-check-write
   * happens in one statement under Postgres' row lock. Doing it in application
   * code would let two concurrent messages both see "4 of 5 used" and both
   * proceed.
   */
  async claimQuota(userId: string, limit: number): Promise<QuotaResult> {
    const [row] = await this.db.sql<QuotaResult[]>`
      SELECT * FROM claim_daily_quota(${userId}, ${limit})
    `;
    return row ?? { allowed: false, used: 0, quota: limit };
  }

  async usageToday(userId: string): Promise<number> {
    const [row] = await this.db.sql<{ query_count: number }[]>`
      SELECT query_count FROM daily_usage
       WHERE user_id = ${userId} AND usage_date = CURRENT_DATE
    `;
    return row?.query_count ?? 0;
  }

  async recentSearches(userId: string, limit = 10) {
    return this.db.sql`
      SELECT id, query_text, intent, citations, result_count, created_at
        FROM search_history
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
  }

  /** Admin dashboard counters. */
  async platformStats(days = 7) {
    const [row] = await this.db.sql<
      {
        total_users: string;
        verified_users: string;
        active_users: string;
        queries: string;
        flagged: string;
        avg_latency_ms: string | null;
      }[]
    >`
      SELECT (SELECT COUNT(*) FROM users)                                        AS total_users,
             (SELECT COUNT(*) FROM users
               WHERE verification_status = 'VERIFIED'::verification_status)      AS verified_users,
             (SELECT COUNT(DISTINCT user_id) FROM search_history
               WHERE created_at > NOW() - make_interval(days => ${days}))        AS active_users,
             (SELECT COUNT(*) FROM search_history
               WHERE created_at > NOW() - make_interval(days => ${days}))        AS queries,
             (SELECT COUNT(*) FROM search_history
               WHERE guardrail_flagged
                 AND created_at > NOW() - make_interval(days => ${days}))        AS flagged,
             (SELECT AVG(latency_ms) FROM search_history
               WHERE created_at > NOW() - make_interval(days => ${days}))        AS avg_latency_ms
    `;
    return {
      totalUsers: Number(row?.total_users ?? 0),
      verifiedUsers: Number(row?.verified_users ?? 0),
      activeUsers: Number(row?.active_users ?? 0),
      queries: Number(row?.queries ?? 0),
      guardrailFlagged: Number(row?.flagged ?? 0),
      avgLatencyMs: row?.avg_latency_ms ? Math.round(Number(row.avg_latency_ms)) : 0,
    };
  }

  /** Nightly retention sweep (DPDP Act 2023). */
  async purgeExpired(): Promise<Record<string, number>> {
    const [row] = await this.db.sql<
      {
        purged_search_history: string;
        purged_messages: string;
        purged_webhooks: string;
        purged_conversations: string;
      }[]
    >`SELECT * FROM purge_expired_data()`;
    return {
      searchHistory: Number(row?.purged_search_history ?? 0),
      messages: Number(row?.purged_messages ?? 0),
      webhooks: Number(row?.purged_webhooks ?? 0),
      conversations: Number(row?.purged_conversations ?? 0),
    };
  }
}

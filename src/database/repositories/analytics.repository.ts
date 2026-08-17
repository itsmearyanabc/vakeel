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
   * How many questions this user has had answered today.
   *
   * Counted from `search_history` rather than read from `daily_usage`. The two
   * used to be the same number and stopped being so when actions were priced
   * separately: `daily_usage` counted quota claims, so a free case-status
   * lookup was invisible in it and a two-credit precedent search counted once.
   * Neither matches what an advocate means by "how much have I used today".
   *
   * `search_history` has a row per answered query already, which makes this the
   * honest source and removes the need to maintain a second counter that can
   * drift from it. Credits are a separate question and are answered by the
   * ledger - see CreditsService.
   */
  async searchesToday(userId: string): Promise<number> {
    const [row] = await this.db.sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM search_history
       WHERE user_id = ${userId}
         AND created_at >= date_trunc('day', NOW())
    `;
    return Number(row?.count ?? 0);
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

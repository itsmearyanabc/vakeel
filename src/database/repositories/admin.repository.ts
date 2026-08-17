import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface TimeSeriesPoint {
  day: string;
  queries: number;
  users: number;
  flagged: number;
  avgLatencyMs: number;
}

export interface IntentSlice {
  intent: string;
  count: number;
  avgLatencyMs: number;
}

export interface AdminUserRow {
  id: string;
  phone_number: string | null;
  full_name: string | null;
  role: string;
  verification_status: string;
  preferred_language: string;
  /** Questions answered today, counted from search_history. */
  query_count: number;
  last_active_at: string;
  created_at: string;

  // --- Web account (migration 0010) ------------------------------------------
  email: string | null;
  email_verified: boolean;
  signup_source: string;
  phone_verified: boolean;
  free_credits: number;
  paid_credits: number;
}

export interface AdminSearchRow {
  id: string;
  phone_number: string;
  query_text: string;
  intent: string;
  citations: string[];
  result_count: number;
  model_used: string | null;
  latency_ms: number;
  guardrail_flagged: boolean;
  guardrail_reason: string | null;
  created_at: string;
}

export interface AdminMessageRow {
  id: string;
  phone_number: string;
  direction: string;
  message_type: string;
  body: string | null;
  status: string;
  error_detail: string | null;
  created_at: string;
}

/**
 * Read models for the admin panel.
 *
 * Kept apart from AnalyticsRepository because the concerns genuinely differ:
 * that one is on the hot path (every answered query writes through it), this one
 * runs a handful of times when a human opens a dashboard. Mixing them would put
 * expensive reporting aggregates next to code that has to stay fast.
 *
 * Every method here is read-only and bounded by an explicit LIMIT - an admin
 * page must never be able to pull the whole message log into memory.
 */
@Injectable()
export class AdminRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Daily activity for the dashboard chart.
   *
   * generate_series produces the full date range so days with no traffic appear
   * as zeroes. Without it the chart silently closes the gap and a dead weekend
   * looks like normal usage.
   */
  async timeSeries(days = 14): Promise<TimeSeriesPoint[]> {
    const rows = await this.db.sql<
      {
        day: string;
        queries: string;
        users: string;
        flagged: string;
        avg_latency: string | null;
      }[]
    >`
      SELECT to_char(d.day, 'YYYY-MM-DD')                       AS day,
             COUNT(s.id)                                        AS queries,
             COUNT(DISTINCT s.user_id)                          AS users,
             COUNT(*) FILTER (WHERE s.guardrail_flagged)        AS flagged,
             AVG(s.latency_ms)                                  AS avg_latency
        FROM generate_series(
               CURRENT_DATE - make_interval(days => ${days} - 1),
               CURRENT_DATE,
               '1 day'
             ) AS d(day)
        LEFT JOIN search_history s
               ON s.created_at >= d.day
              AND s.created_at <  d.day + INTERVAL '1 day'
       GROUP BY d.day
       ORDER BY d.day
    `;

    return rows.map((r) => ({
      day: r.day,
      queries: Number(r.queries),
      users: Number(r.users),
      flagged: Number(r.flagged),
      avgLatencyMs: r.avg_latency ? Math.round(Number(r.avg_latency)) : 0,
    }));
  }

  /** Intent mix, for the donut chart. */
  async intentBreakdown(days = 14): Promise<IntentSlice[]> {
    const rows = await this.db.sql<{ intent: string; count: string; avg_latency: string | null }[]>`
      SELECT intent::text        AS intent,
             COUNT(*)            AS count,
             AVG(latency_ms)     AS avg_latency
        FROM search_history
       WHERE created_at > NOW() - make_interval(days => ${days})
       GROUP BY intent
       ORDER BY COUNT(*) DESC
    `;
    return rows.map((r) => ({
      intent: r.intent,
      count: Number(r.count),
      avgLatencyMs: r.avg_latency ? Math.round(Number(r.avg_latency)) : 0,
    }));
  }

  /** Message volume and delivery outcomes, for the operations view. */
  async messageStats(days = 14): Promise<{ direction: string; status: string; count: number }[]> {
    const rows = await this.db.sql<{ direction: string; status: string; count: string }[]>`
      SELECT direction::text AS direction,
             status::text    AS status,
             COUNT(*)        AS count
        FROM whatsapp_messages
       WHERE created_at > NOW() - make_interval(days => ${days})
       GROUP BY direction, status
       ORDER BY COUNT(*) DESC
    `;
    return rows.map((r) => ({ direction: r.direction, status: r.status, count: Number(r.count) }));
  }

  /** User table, newest-active first. */
  /**
   * The users table.
   *
   * ## Why today's count no longer comes from `daily_usage`
   *
   * It used to `LEFT JOIN daily_usage`, which was correct until credits became
   * a ledger and nothing wrote to that table any more. The join kept working
   * and kept returning `COALESCE(..., 0)` - so the column silently read zero
   * for every user, on a page whose whole purpose is telling an operator who is
   * active. A wrong number that looks like a real one is worse than a missing
   * column, because nobody thinks to doubt it.
   *
   * `search_history` has a row per answered query already, so it is both the
   * honest source and one that cannot drift from what actually happened.
   *
   * Balances are read from the cached columns rather than through
   * `credit_balance()`, deliberately: this renders fifty rows, and the function
   * has the side effect of rolling the daily allowance over. Listing users
   * would otherwise write fifty ledger entries.
   */
  async listUsers(limit = 100, offset = 0, search?: string): Promise<AdminUserRow[]> {
    const pattern = search ? `%${search}%` : null;
    return this.db.sql<AdminUserRow[]>`
      SELECT u.id,
             u.phone_number,
             u.full_name,
             u.email,
             (u.email_verified_at IS NOT NULL) AS email_verified,
             (u.phone_verified_at IS NOT NULL) AS phone_verified,
             u.signup_source::text       AS signup_source,
             u.free_credits,
             u.paid_credits,
             u.role::text                AS role,
             u.verification_status::text AS verification_status,
             u.preferred_language,
             (SELECT COUNT(*) FROM search_history s
               WHERE s.user_id = u.id
                 AND s.created_at >= date_trunc('day', NOW()))::int AS query_count,
             u.last_active_at,
             u.created_at
        FROM users u
       WHERE ${pattern}::text IS NULL
          OR u.phone_number ILIKE ${pattern}
          OR u.full_name    ILIKE ${pattern}
          OR u.email        ILIKE ${pattern}
       ORDER BY u.last_active_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /**
   * Recent queries across all users, for the audit view.
   *
   * `flaggedOnly` is the hallucination review queue: everything the citation
   * validator had to intervene on.
   */
  async listSearches(limit = 100, offset = 0, flaggedOnly = false): Promise<AdminSearchRow[]> {
    return this.db.sql<AdminSearchRow[]>`
      SELECT s.id,
             u.phone_number,
             s.query_text,
             s.intent::text AS intent,
             s.citations,
             s.result_count,
             s.model_used,
             s.latency_ms,
             s.guardrail_flagged,
             s.guardrail_reason,
             s.created_at
        FROM search_history s
        JOIN users u ON u.id = s.user_id
       WHERE ${flaggedOnly} = FALSE OR s.guardrail_flagged
       ORDER BY s.created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /** Raw message log, for debugging "why did the bot not reply". */
  async listMessages(limit = 100, offset = 0, phone?: string): Promise<AdminMessageRow[]> {
    const pattern = phone ? `%${phone}%` : null;
    return this.db.sql<AdminMessageRow[]>`
      SELECT id,
             phone_number,
             direction::text    AS direction,
             message_type,
             body,
             status::text       AS status,
             error_detail,
             created_at
        FROM whatsapp_messages
       WHERE ${pattern}::text IS NULL OR phone_number ILIKE ${pattern}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /** Settings change log for the audit tab. */
  async listSettingsAudit(limit = 50): Promise<
    { id: string; key: string; action: string; new_preview: string | null; changed_by: string; changed_at: string }[]
  > {
    return this.db.sql`
      SELECT id, key, action, new_preview, changed_by, changed_at
        FROM settings_audit
       ORDER BY changed_at DESC
       LIMIT ${limit}
    `;
  }

  /**
   * Corpus readiness, broken down by court.
   *
   * `embedded` vs `chunks` is the number that matters operationally: chunks
   * without an embedding are invisible to dense retrieval, so a large gap here
   * explains "the bot cannot find cases I know are loaded".
   */
  async corpusBreakdown(): Promise<{ court: string; judgments: number; chunks: number; embedded: number }[]> {
    const rows = await this.db.sql<
      { court: string; judgments: string; chunks: string; embedded: string }[]
    >`
      SELECT COALESCE(j.court_name, 'Unknown')                        AS court,
             COUNT(DISTINCT j.id)                                     AS judgments,
             COUNT(c.id)                                              AS chunks,
             COUNT(c.id) FILTER (WHERE c.embedding IS NOT NULL)       AS embedded
        FROM judgments j
        LEFT JOIN judgment_chunks c ON c.judgment_id = j.id
       GROUP BY j.court_name
       ORDER BY COUNT(DISTINCT j.id) DESC
       LIMIT 30
    `;
    return rows.map((r) => ({
      court: r.court,
      judgments: Number(r.judgments),
      chunks: Number(r.chunks),
      embedded: Number(r.embedded),
    }));
  }
}

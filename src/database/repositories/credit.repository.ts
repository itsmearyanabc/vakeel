import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import {
  CreditBucket,
  CreditEntryKind,
  CreditGrantResult,
  CreditLedgerRow,
  CreditOrderRow,
  CreditSpendResult,
} from '../types';

/**
 * The credit wallet's data access layer.
 *
 * Almost every method here is a thin call into a SQL function rather than a
 * query. That is deliberate and it is the whole point: the arithmetic has to be
 * atomic, and read-then-write in application code is a race whose losing side
 * is either a double spend or a purchase that vanishes. `credit_spend()` and
 * `credit_grant()` do the read, the check and the write under one row lock, in
 * one round trip, inside one transaction. See migration 0010.
 *
 * The consequence worth knowing: this class cannot be unit tested without a
 * database, because the logic it guards does not live in TypeScript. The
 * arithmetic that *is* testable in isolation - what an action costs, whether a
 * question is a repeat - lives in CreditsService and quota.service.ts and is
 * covered there.
 */
@Injectable()
export class CreditRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Charge for an action.
   *
   * `reference` is the idempotency key and is not optional in practice: without
   * one, a retried request charges twice. Callers derive it from something
   * stable about the request - the chat message id, the WhatsApp message id -
   * never from a timestamp or a random value, which would defeat the point.
   */
  async spend(input: {
    userId: string;
    cost: number;
    action: string;
    reference: string;
    dailyAllowance: number;
  }): Promise<CreditSpendResult> {
    const [row] = await this.db.sql<CreditSpendResult[]>`
      SELECT * FROM credit_spend(
        ${input.userId}::uuid,
        ${input.cost}::integer,
        ${input.action}::varchar,
        ${input.reference}::varchar,
        ${input.dailyAllowance}::integer
      )
    `;
    return row;
  }

  /** Add credits. Idempotent on `reference`; see `credit_grant()` in 0010. */
  async grant(input: {
    userId: string;
    amount: number;
    kind: CreditEntryKind;
    bucket: CreditBucket;
    action: string;
    reason: string;
    reference: string;
    orderId?: string | null;
  }): Promise<CreditGrantResult> {
    const [row] = await this.db.sql<CreditGrantResult[]>`
      SELECT * FROM credit_grant(
        ${input.userId}::uuid,
        ${input.amount}::integer,
        ${input.kind}::credit_entry_kind,
        ${input.bucket}::credit_bucket,
        ${input.action}::varchar,
        ${input.reason}::text,
        ${input.reference}::varchar,
        ${input.orderId ?? null}::uuid
      )
    `;
    return row;
  }

  /**
   * Roll the daily allowance over if it is stale, then read both buckets.
   *
   * The refresh runs on a plain balance read, not only on a spend, so the
   * number the advocate sees at 00:01 is the new day's allowance rather than
   * yesterday's leftovers waiting to be corrected by their next action.
   */
  async balance(userId: string, dailyAllowance: number): Promise<{ free: number; paid: number }> {
    const [row] = await this.db.sql<{ free_credits: number; paid_credits: number }[]>`
      WITH refreshed AS (
        SELECT credit_refresh_free(${userId}::uuid, ${dailyAllowance}::integer)
      )
      SELECT u.free_credits, u.paid_credits
        FROM users u, refreshed
       WHERE u.id = ${userId}::uuid
    `;
    return { free: row?.free_credits ?? 0, paid: row?.paid_credits ?? 0 };
  }

  /**
   * Read both buckets without rolling the allowance over.
   *
   * For read-only surfaces that must not have side effects - the admin panel
   * listing a thousand users should not write a thousand ledger rows.
   */
  async peekBalance(userId: string): Promise<{ free: number; paid: number }> {
    const [row] = await this.db.sql<{ free_credits: number; paid_credits: number }[]>`
      SELECT free_credits, paid_credits FROM users WHERE id = ${userId}
    `;
    return { free: row?.free_credits ?? 0, paid: row?.paid_credits ?? 0 };
  }

  /**
   * Reverse a specific spend, bucket by bucket.
   *
   * Takes no amount on purpose - `credit_refund()` reads the original SPEND
   * rows and returns each to the bucket it came from. See migration 0010 for
   * why guessing the bucket is not an acceptable simplification.
   */
  async refundByReference(
    userId: string,
    reference: string,
    reason: string,
  ): Promise<{ refunded: number; free: number; paid: number }> {
    const [row] = await this.db.sql<{ refunded: number; free_left: number; paid_left: number }[]>`
      SELECT * FROM credit_refund(
        ${userId}::uuid,
        ${reference}::varchar,
        ${reason}::text
      )
    `;
    return { refunded: row?.refunded ?? 0, free: row?.free_left ?? 0, paid: row?.paid_left ?? 0 };
  }

  async history(userId: string, limit = 50, offset = 0): Promise<CreditLedgerRow[]> {
    return this.db.sql<CreditLedgerRow[]>`
      SELECT * FROM credit_ledger
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /** The ledger across all users, for the admin panel. */
  async recentEntries(limit = 100, offset = 0, userId?: string): Promise<(CreditLedgerRow & { full_name: string | null; email: string | null; phone_number: string | null })[]> {
    return this.db.sql<(CreditLedgerRow & { full_name: string | null; email: string | null; phone_number: string | null })[]>`
      SELECT l.*, u.full_name, u.email, u.phone_number
        FROM credit_ledger l
        JOIN users u ON u.id = l.user_id
       WHERE ${userId ? this.db.sql`l.user_id = ${userId}` : this.db.sql`TRUE`}
       ORDER BY l.created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /**
   * Totals for the admin dashboard.
   *
   * Summed from the ledger rather than from the denormalised columns on
   * `users`, because the ledger is the authoritative record and this is the
   * report that would reveal a divergence between the two.
   */
  async totals(days: number): Promise<{
    granted: number;
    spent: number;
    purchased: number;
    refunded: number;
    expired: number;
  }> {
    const [row] = await this.db.sql<
      { granted: number; spent: number; purchased: number; refunded: number; expired: number }[]
    >`
      SELECT
        COALESCE(SUM(delta) FILTER (WHERE kind IN ('DAILY_GRANT','SIGNUP_BONUS','ADMIN_GRANT')), 0)::int AS granted,
        COALESCE(-SUM(delta) FILTER (WHERE kind = 'SPEND'), 0)::int    AS spent,
        COALESCE(SUM(delta) FILTER (WHERE kind = 'PURCHASE'), 0)::int  AS purchased,
        COALESCE(SUM(delta) FILTER (WHERE kind = 'REFUND'), 0)::int    AS refunded,
        COALESCE(-SUM(delta) FILTER (WHERE kind = 'EXPIRY'), 0)::int   AS expired
      FROM credit_ledger
      WHERE created_at >= NOW() - (${days}::int * INTERVAL '1 day')
    `;
    return row ?? { granted: 0, spent: 0, purchased: 0, refunded: 0, expired: 0 };
  }

  // ---------------------------------------------------------------------------
  // Orders
  //
  // No gateway is wired up yet. These exist because the schema and the access
  // path are the parts that are expensive to get wrong once real orders exist -
  // adding the Razorpay HTTP calls on top of a correct ledger is a small change,
  // and retrofitting idempotency onto a live payment flow is not.
  // ---------------------------------------------------------------------------

  async createOrder(input: {
    userId: string;
    receipt: string;
    credits: number;
    packCode: string;
    amountPaise: number;
    basePaise: number;
    taxPaise: number;
    taxRateBps: number;
  }): Promise<CreditOrderRow> {
    const [row] = await this.db.sql<CreditOrderRow[]>`
      INSERT INTO credit_orders
             (user_id, receipt, credits, pack_code, amount_paise, base_paise, tax_paise, tax_rate_bps)
      VALUES (${input.userId}, ${input.receipt}, ${input.credits}, ${input.packCode},
              ${input.amountPaise}, ${input.basePaise}, ${input.taxPaise}, ${input.taxRateBps})
      ON CONFLICT (receipt) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `;
    return row;
  }

  async findOrderByReceipt(receipt: string): Promise<CreditOrderRow | null> {
    const [row] = await this.db.sql<CreditOrderRow[]>`
      SELECT * FROM credit_orders WHERE receipt = ${receipt} LIMIT 1
    `;
    return row ?? null;
  }

  async listOrders(limit = 50, offset = 0): Promise<CreditOrderRow[]> {
    return this.db.sql<CreditOrderRow[]>`
      SELECT * FROM credit_orders ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /**
   * Orders the gateway reports as paid that never produced credits.
   *
   * This is the query that matters most operationally. Every other failure in a
   * payment flow is visible to the person paying; this one is invisible to them
   * and to us unless something looks for it.
   */
  async uncreditedOrders(limit = 50): Promise<CreditOrderRow[]> {
    return this.db.sql<CreditOrderRow[]>`
      SELECT * FROM credit_orders
       WHERE status = 'PAID' AND credited_at IS NULL
       ORDER BY created_at
       LIMIT ${limit}
    `;
  }
}

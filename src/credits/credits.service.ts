import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CreditRepository } from '../database/repositories/credit.repository';
import { CreditLedgerRow, UserRole } from '../database/types';

/**
 * What each action costs.
 *
 * One credit per question, with one exception: case status is free. It is a
 * lookup against a court record with no model call behind it, it is the thing
 * an advocate does standing outside a courtroom, and charging for it would make
 * the cheapest feature feel like the most rationed one. It is also the reason
 * to open the app on a day you have nothing to research.
 *
 * Research used to cost two, on the reasoning that it is two LLM calls plus a
 * billed Kanoon search. That is true and it is the wrong thing to price on:
 * "one question, one credit" is a rule an advocate can hold in their head and
 * predict, and a pricing page that needs a table of costs has already lost.
 *
 * Moved here from quota.service.ts, which now imports it back. The costs belong
 * next to the wallet that applies them, not next to the rate limiter that used
 * to be the only thing enforcing them.
 */
export const CREDIT_COST = {
  CASE_STATUS: 0,
  SECTION_LOOKUP: 1,
  PRECEDENT_SEARCH: 1,
} as const;

export type CreditAction = keyof typeof CREDIT_COST;

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

/**
 * The balance an unlimited role reports.
 *
 * A frozen object rather than a literal repeated at four call sites, so a field
 * added to CreditBalance cannot be forgotten in one of them.
 */
const UNLIMITED: CreditBalance = Object.freeze({
  free: 0,
  paid: 0,
  total: 0,
  monthlyAllowance: -1,
  resetsInDays: 0,
  unlimited: true,
});

/**
 * Whole days until the free allowance refills.
 *
 * Computed in Asia/Kolkata, matching `credit_refresh_monthly()`. Doing it in
 * the server's local zone would tell an advocate in Delhi their credits reset
 * tomorrow when the database intends to reset them the day after - a small lie
 * that arrives on the last day of every month.
 */
export function daysUntilNextMonth(now: Date = new Date()): number {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const firstOfNext = new Date(ist.getFullYear(), ist.getMonth() + 1, 1);
  const startOfToday = new Date(ist.getFullYear(), ist.getMonth(), ist.getDate());

  return Math.round((firstOfNext.getTime() - startOfToday.getTime()) / 86_400_000);
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

export interface CreditBalance {
  /** This month's allowance remaining. Resets on the 1st, in Asia/Kolkata. */
  free: number;
  /** Durable credits: purchased, bonus or granted. Never expire. */
  paid: number;
  /** What can actually be spent right now. */
  total: number;
  /** The role's monthly allowance, or -1 when the role is unlimited. */
  monthlyAllowance: number;
  /**
   * Days until the free bucket refills, so the interface can say "resets in 9
   * days" rather than leaving someone at zero with no idea when that changes.
   * Zero for unlimited roles.
   */
  resetsInDays: number;
  /**
   * True when this role bypasses the wallet entirely.
   *
   * Verified advocates and admins are unlimited by configuration
   * (`CREDITS_VERIFIED_MONTHLY = -1`). Their spends are not written to the ledger:
   * it is a record of credit movements, and nothing moves. Their *usage* is
   * still recorded in `search_history`, which is where usage questions are
   * answered from.
   */
  unlimited: boolean;
}

export interface SpendDecision {
  allowed: boolean;
  /** What this actually cost. Zero when free, unlimited, or already charged. */
  charged: number;
  balance: CreditBalance;
  /** True when this reference had already been charged and nothing moved. */
  replay: boolean;
}

/**
 * The credit wallet.
 *
 * ## What changed, and why it is not just the old quota counter renamed
 *
 * The previous implementation was a Redis `INCR` against a daily limit, mirrored
 * to a `daily_usage` row. That is a rate limiter, and it was the right thing
 * while there was nothing to bill: it bounded the LLM spend and needed no
 * schema. It cannot answer the first question anyone asks once money is
 * involved - "what did this advocate pay for, and what happened to it" - because
 * a counter has no history, only a current value.
 *
 * This is a ledger. Every movement is a row, the balance is derived and also
 * cached on `users`, and the two are reconcilable. The behaviour an advocate
 * A guest gets 30 credits a month, verified advocates are unlimited, and a
 * failed delivery is always refunded.
 *
 * ## The two buckets
 *
 * Free credits are the monthly allowance and are *reset*, not accumulated. Paid
 * credits are durable. Spending draws down free first. The reasoning for all
 * three of those decisions is in migration 0010, and the move from a daily to a
 * monthly period is in 0012 - they are the parts of this design that are
 * expensive to change once real rows exist, so they are written down where the
 * schema is.
 *
 * ## Idempotency is the caller's job
 *
 * Every spend and grant takes a `reference`, and it must be derived from
 * something stable about the request - a message id, a payment id - never a
 * timestamp or a random value. The database enforces uniqueness on it, so a
 * retried request is rejected by an index rather than charged twice. A caller
 * that invents a fresh reference on retry has opted out of the protection.
 */
@Injectable()
export class CreditsService {
  private readonly logger = getLogger().child({ module: 'credits' });

  constructor(
    private readonly credits: CreditRepository,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /**
   * The daily allowance for a role. Negative means unlimited.
   *
   * Renamed from the daily equivalent in migration 0012. The variables were
   * renamed with it rather than reinterpreted, because a value called
   * QUOTA_GUEST_DAILY holding a monthly figure would outlive everyone who
   * remembered the change.
   */
  monthlyAllowance(role: UserRole): number {
    switch (role) {
      case 'GUEST_LAWYER':
        return this.env.CREDITS_FREE_MONTHLY;
      case 'VERIFIED_ADVOCATE':
        return this.env.CREDITS_VERIFIED_MONTHLY;
      case 'LEGAL_AUDITOR':
      case 'SUPER_ADMIN':
        return this.env.CREDITS_ADMIN_MONTHLY;
      default:
        return this.env.CREDITS_FREE_MONTHLY;
    }
  }

  isUnlimited(role: UserRole): boolean {
    return this.monthlyAllowance(role) < 0;
  }

  /**
   * Current balance, rolling the monthly allowance over first if it is stale.
   *
   * The rollover happens on a read and not only on a spend, so the number shown
   * at one minute past midnight on the 1st is the new month's allowance rather
   * than last month's remainder waiting to be corrected by the next action.
   */
  async balance(userId: string, role: UserRole): Promise<CreditBalance> {
    const allowance = this.monthlyAllowance(role);

    if (allowance < 0) return UNLIMITED;

    const { free, paid } = await this.credits.balance(userId, allowance);
    return {
      free,
      paid,
      total: free + paid,
      monthlyAllowance: allowance,
      resetsInDays: daysUntilNextMonth(),
      unlimited: false,
    };
  }

  /** Balance with no side effects, for list views that must not write. */
  async peek(userId: string, role: UserRole): Promise<CreditBalance> {
    const allowance = this.monthlyAllowance(role);

    if (allowance < 0) return UNLIMITED;

    const { free, paid } = await this.credits.peekBalance(userId);
    return {
      free,
      paid,
      total: free + paid,
      monthlyAllowance: allowance,
      resetsInDays: daysUntilNextMonth(),
      unlimited: false,
    };
  }

  /**
   * Charge for an action.
   *
   * Free actions (case status) and unlimited roles both short-circuit before
   * touching the database: neither has anything to move, and writing a
   * zero-delta ledger row for them would fill the audit trail with entries that
   * record nothing.
   */
  async spend(input: {
    userId: string;
    role: UserRole;
    cost: number;
    action: string;
    /** Stable per request. See the class comment on idempotency. */
    reference: string;
  }): Promise<SpendDecision> {
    const allowance = this.monthlyAllowance(input.role);

    if (allowance < 0) {
      return { allowed: true, charged: 0, balance: UNLIMITED, replay: false };
    }

    if (input.cost <= 0) {
      const balance = await this.balance(input.userId, input.role);
      return { allowed: true, charged: 0, balance, replay: false };
    }

    const result = await this.credits.spend({
      userId: input.userId,
      cost: input.cost,
      action: input.action,
      reference: input.reference,
      monthlyAllowance: allowance,
    });

    const balance: CreditBalance = {
      free: result.free_left,
      paid: result.paid_left,
      total: result.free_left + result.paid_left,
      monthlyAllowance: allowance,
      resetsInDays: daysUntilNextMonth(),
      unlimited: false,
    };

    if (!result.allowed) {
      this.logger.info(
        { userId: input.userId, cost: input.cost, balance: balance.total },
        'Credit spend refused: insufficient balance',
      );
    }

    return {
      allowed: result.allowed,
      charged: result.charged,
      balance,
      replay: result.already_spent,
    };
  }

  /**
   * Give back what a specific spend took.
   *
   * Best-effort and never throws. The caller is already on a failure path - a
   * message that could not be delivered, a model that timed out - and an error
   * raised here would mask the failure that caused it.
   *
   * The amount is not passed in: the SQL function reads the original SPEND rows
   * and reverses each into the bucket it came from. Passing a number would mean
   * guessing which bucket to credit, and both wrong answers cost somebody real
   * money. See `credit_refund()` in migration 0010.
   */
  async refund(userId: string, role: UserRole, reference: string, reason: string): Promise<void> {
    if (this.isUnlimited(role)) return;

    try {
      await this.credits.refundByReference(userId, reference, reason);
    } catch (err) {
      this.logger.warn({ err, userId, reference }, 'Credit refund failed');
    }
  }

  /**
   * One-off credits for a new web account.
   *
   * Lands in the durable bucket, not the daily one: a welcome gift that expires
   * before the advocate has finished reading the welcome screen is worse than
   * no gift at all. Idempotent per user, so re-running it - or a signup handler
   * retried after a timeout - grants once.
   */
  async grantSignupBonus(userId: string): Promise<void> {
    const amount = this.env.CREDITS_SIGNUP_BONUS;
    if (amount <= 0) return;

    await this.credits.grant({
      userId,
      amount,
      kind: 'SIGNUP_BONUS',
      bucket: 'PAID',
      action: 'signup_bonus',
      reason: 'Welcome credits',
      reference: `signup:${userId}`,
    });
  }

  /**
   * A manual grant from the admin panel.
   *
   * The reference includes the operator and a caller-supplied idempotency key
   * so a double-clicked Grant button does not hand out twice, while a genuine
   * second grant to the same advocate still goes through.
   */
  async adminGrant(input: {
    userId: string;
    amount: number;
    reason: string;
    grantedBy: string;
    idempotencyKey: string;
  }): Promise<{ applied: boolean; free: number; paid: number }> {
    const result = await this.credits.grant({
      userId: input.userId,
      amount: input.amount,
      kind: 'ADMIN_GRANT',
      bucket: 'PAID',
      action: 'admin_grant',
      reason: `${input.reason} (granted by ${input.grantedBy})`,
      reference: `admin:${input.idempotencyKey}`,
    });

    this.logger.info(
      { userId: input.userId, amount: input.amount, by: input.grantedBy, applied: result.applied },
      'Admin credit grant',
    );

    return { applied: result.applied, free: result.free_left, paid: result.paid_left };
  }

  /**
   * Take credits back, from the admin panel.
   *
   * The mirror of {@link adminGrant}, and the reason the ledger never edits a
   * row: a mistaken grant is corrected by a compensating entry, so the history
   * shows both what happened and that it was undone. An edit would make the
   * mistake disappear along with the evidence that it was made.
   *
   * Floors at the available balance rather than failing. A deduction larger than
   * what is left means the advocate already spent it, and refusing the whole
   * operation would leave an administrator unable to correct anything at all.
   */
  async adminDeduct(input: {
    userId: string;
    amount: number;
    reason: string;
    deductedBy: string;
    idempotencyKey: string;
  }): Promise<{ applied: boolean; deducted: number; free: number; paid: number }> {
    const result = await this.credits.deduct({
      userId: input.userId,
      amount: input.amount,
      reason: `${input.reason} (by ${input.deductedBy})`,
      reference: `deduct:${input.idempotencyKey}`,
    });

    this.logger.info(
      {
        userId: input.userId,
        requested: input.amount,
        deducted: result.deducted,
        by: input.deductedBy,
      },
      'Admin credit deduction',
    );

    return result;
  }

  async history(userId: string, limit = 50, offset = 0): Promise<CreditLedgerRow[]> {
    return this.credits.history(userId, limit, offset);
  }

  /**
   * The balance line shown with every WhatsApp help menu.
   *
   * Phrased in credits rather than "questions left" because they are not quite
   * the same number: a case status costs nothing, so an advocate with 3 credits
   * can ask an unbounded number of those and exactly 3 of anything else.
   */
  creditLine(balance: CreditBalance): string {
    if (balance.unlimited) return 'Credits: unlimited';
    if (balance.paid > 0) {
      return `Credits: ${balance.total} left (${balance.free} free this month + ${balance.paid} purchased)`;
    }
    return `Credits: ${balance.free} of ${balance.monthlyAllowance} left this month`;
  }
}

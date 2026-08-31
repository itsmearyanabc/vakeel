/**
 * Row shapes returned by the repositories.
 *
 * These mirror the SQL in supabase/migrations. postgres.js does not generate
 * types, so this file is the contract - if you change a migration, change the
 * matching interface here.
 */

export type VerificationStatus = 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';

export type UserRole = 'GUEST_LAWYER' | 'VERIFIED_ADVOCATE' | 'LEGAL_AUDITOR' | 'SUPER_ADMIN';

export type QueryIntent =
  | 'CASE_STATUS'
  | 'SECTION_LOOKUP'
  | 'PRECEDENT_SEARCH'
  | 'DRAFTING_HELP'
  | 'GENERAL_LEGAL'
  | 'SMALL_TALK'
  | 'MENU_NAVIGATION'
  | 'UNSUPPORTED';

export type MessageDirection = 'INBOUND' | 'OUTBOUND';

export type MessageStatus = 'RECEIVED' | 'QUEUED' | 'PROCESSING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/** How an account first came to exist. See migration 0010. */
export type AccountSource = 'WHATSAPP' | 'WEB_PASSWORD' | 'WEB_GOOGLE';

export interface UserRow {
  id: string;
  /**
   * Nullable since migration 0010: a web signup has no phone number until the
   * advocate links one. Still UNIQUE, and still the WhatsApp lookup key.
   */
  phone_number: string | null;
  full_name: string | null;
  bar_council_id_enc: string | null;
  bar_council_id_hash: string | null;
  bar_council_state: string | null;
  /** Practice city, from onboarding. */
  city: string | null;
  verification_status: VerificationStatus;
  role: UserRole;
  preferred_language: string;
  id_card_storage_path: string | null;
  verification_notes: string | null;
  verified_at: Date | null;
  is_blocked: boolean;
  opted_out_at: Date | null;
  last_active_at: Date;
  created_at: Date;
  updated_at: Date;

  // --- Web account (migration 0010) ------------------------------------------
  email: string | null;
  /** scrypt, encoded by src/auth/password.ts. Null for Google-only accounts. */
  password_hash: string | null;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  avatar_url: string | null;
  signup_source: AccountSource;
  last_web_login_at: Date | null;

  // --- Wallet (migrations 0010, 0012) ----------------------------------------
  /** The one-time free allowance remaining. Granted once per account; never refilled. */
  free_credits: number;
  /** Superseded by `free_period` in migration 0012. No longer read or written. */
  free_credits_date: Date | null;
  /** First day (Asia/Kolkata) of the month `free_credits` belongs to. */
  free_period: Date | null;
  /** Purchased credits. Never expire. Spent only after the free bucket. */
  paid_credits: number;
}

/**
 * A user reached over WhatsApp.
 *
 * `phone_number` became nullable in migration 0010 so that web-only accounts
 * could exist, which is correct for the column and inconvenient for the
 * WhatsApp path - where the row was *found by* its phone number and therefore
 * always has one. This narrowing states that fact in the type system rather
 * than scattering non-null assertions through the conversation code, each of
 * which would be an unchecked claim rather than a guaranteed one.
 */
export type WhatsAppUserRow = UserRow & { phone_number: string };

export interface ConversationStateRow {
  user_id: string;
  state: string;
  context: Record<string, unknown>;
  expires_at: Date | null;
  updated_at: Date;
}

export interface StatuteRow {
  id: string;
  act_code: string;
  act_name: string;
  section_number: string;
  section_title: string;
  section_text: string;
  punishment: string | null;
  is_cognizable: boolean | null;
  is_bailable: boolean | null;
  is_compoundable: boolean | null;
  triable_by: string | null;
  corresponding_act: string | null;
  corresponding_section: string | null;
  match_type: 'EXACT' | 'FULLTEXT' | 'FUZZY';
  score: number;
}

/** A retrieved passage, as returned by hybrid_search_judgments(). */
export interface RetrievedChunk {
  chunk_id: string;
  judgment_id: string;
  content: string;
  para_number: number | null;
  case_title: string;
  neutral_citation: string | null;
  reporter_citations: string[];
  court_name: string | null;
  judgment_date: Date | null;
  ratio_decidendi: string | null;
  dense_rank: number | null;
  sparse_rank: number | null;
  score: number;
}

/**
 * One judgment in a precedent list (priority feature 3).
 *
 * Distinct from {@link RetrievedChunk}: that is a passage, and three of them can
 * come from the same case. This is one row per authority, carrying the
 * judgment-level metadata an advocate needs to decide whether to read it -
 * bench, disposition, citations - plus the single best-matching passage as a
 * synopsis.
 */
export interface PrecedentRow {
  judgment_id: string;
  case_title: string;
  neutral_citation: string | null;
  reporter_citations: string[];
  court_name: string | null;
  court_type: string | null;
  judgment_date: Date | null;
  bench: string[];
  bench_strength: number | null;
  act_sections: string[];
  headnote: string | null;
  ratio_decidendi: string | null;
  disposition: string | null;
  source_url: string | null;
  best_excerpt: string;
  para_number: number | null;
  score: number;
  /** 1 = most relevant. Rows arrive date-sorted, so this is not the row order. */
  relevance_rank: number;
  /** Total judgments that matched before the per-session cap was applied. */
  total_matches: number;
}

/**
 * Guardrail lookup results.
 *
 * The column is `found`, not `exists`: `exists` is a reserved word in Postgres
 * and parses as the EXISTS operator, so a function returning a column by that
 * name is a syntax error. Quoting it would work but would force every future
 * query to quote it too.
 */
export interface CitationCheck {
  citation: string;
  found: boolean;
  judgment_id: string | null;
  case_title: string | null;
}

export interface StatuteRefCheck {
  ref: string;
  found: boolean;
  act_code: string | null;
  section_number: string | null;
  section_title: string | null;
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  quota: number;
}

// -----------------------------------------------------------------------------
// Credits (migration 0010)
// -----------------------------------------------------------------------------

export type CreditEntryKind =
  /** Superseded by MONTHLY_GRANT in migration 0012; kept for historical rows. */
  | 'DAILY_GRANT'
  | 'MONTHLY_GRANT'
  | 'SIGNUP_BONUS'
  | 'ADMIN_GRANT'
  | 'REFERRAL'
  | 'PURCHASE'
  | 'SPEND'
  | 'REFUND'
  | 'EXPIRY'
  | 'DEDUCTION'
  | 'ADJUSTMENT';

export type CreditBucket = 'FREE' | 'PAID';

export type PaymentOrderStatus = 'CREATED' | 'ATTEMPTED' | 'PAID' | 'FAILED' | 'REFUNDED';

export interface CreditLedgerRow {
  id: string;
  user_id: string;
  kind: CreditEntryKind;
  bucket: CreditBucket;
  /** Signed: negative for SPEND and EXPIRY. */
  delta: number;
  balance_after: number;
  action: string | null;
  reason: string | null;
  /** Idempotency key. Unique across the table. */
  reference: string | null;
  order_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** The shape returned by the `credit_spend()` SQL function. */
export interface CreditSpendResult {
  allowed: boolean;
  charged: number;
  free_left: number;
  paid_left: number;
  from_free: number;
  from_paid: number;
  /** True when this reference had already been charged, so nothing moved. */
  already_spent: boolean;
}

/** The shape returned by the `credit_grant()` SQL function. */
export interface CreditGrantResult {
  applied: boolean;
  free_left: number;
  paid_left: number;
}

/**
 * A credit purchase. Every money field is integer PAISE, matching Razorpay's
 * API in both directions - see migration 0010 for why this is not rupees.
 */
/**
 * A purchasable credit pack, defined in the admin panel.
 *
 * Every money field is integer PAISE, matching Razorpay - see migration 0010.
 * `base_paise + tax_paise = price_paise` is enforced by the schema, so an
 * invoice can never fail to add up.
 */
export interface CreditPlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  credits: number;
  base_paise: number;
  tax_rate_bps: number;
  tax_paise: number;
  price_paise: number;
  currency: string;
  badge: string | null;
  sort_order: number;
  is_active: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreditOrderRow {
  id: string;
  user_id: string;
  receipt: string;
  credits: number;
  pack_code: string | null;
  amount_paise: number;
  base_paise: number;
  tax_paise: number;
  tax_rate_bps: number;
  currency: string;
  status: PaymentOrderStatus;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  razorpay_signature: string | null;
  payment_method: string | null;
  failure_reason: string | null;
  credited_at: Date | null;
  refunded_at: Date | null;
  notes: Record<string, unknown>;
  /** The plan bought, when there was one. Null once that plan is deleted. */
  plan_id: string | null;
  created_at: Date;
  updated_at: Date;
}

// -----------------------------------------------------------------------------
// Web accounts and chat (migration 0010)
// -----------------------------------------------------------------------------

export interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  provider_account_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  last_login_at: Date | null;
  created_at: Date;
}

export interface WebSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export type AuthTokenPurpose =
  | 'EMAIL_VERIFY'
  | 'PASSWORD_RESET'
  | 'PHONE_LINK'
  /** Sign-up verification: a code sent TO the handset, redeemed in the browser. */
  | 'PHONE_VERIFY'
  /** Password reset driven by the same code, for deployments with no email. */
  | 'PHONE_RESET';

export interface AuthTokenRow {
  id: string;
  user_id: string;
  purpose: AuthTokenPurpose;
  token_hash: string;
  /** The email or phone number the token was issued against. */
  subject: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  attempts: number;
  created_at: Date;
}

export interface ChatThreadRow {
  id: string;
  user_id: string;
  title: string;
  archived_at: Date | null;
  last_message_at: Date;
  message_count: number;
  created_at: Date;
  updated_at: Date;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessageRow {
  id: string;
  thread_id: string;
  user_id: string;
  role: ChatRole;
  content: string;
  intent: QueryIntent | null;
  citations: string[];
  /** Renderable payload - precedent cards, case status - for the web client. */
  structured: Record<string, unknown> | null;
  model_used: string | null;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  credits_charged: number;
  guardrail_flagged: boolean;
  guardrail_reason: string | null;
  error_detail: string | null;
  created_at: Date;
}

// -----------------------------------------------------------------------------
// Job queue (migration 0013)
// -----------------------------------------------------------------------------

export type JobState = 'QUEUED' | 'ACTIVE' | 'DONE' | 'FAILED' | 'DEAD';

export interface JobRow {
  id: string;
  queue: string;
  /** Idempotency key. Unique; a redelivered webhook collides here. */
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  /** Jobs sharing this never run concurrently. See migration 0013. */
  lock_key: string | null;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  lease_until: Date | null;
  claimed_at: Date | null;
  finished_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface JobStats {
  waiting: number;
  active: number;
  dead: number;
  done_24h: number;
  /**
   * How long the oldest waiting job has been waiting.
   *
   * The operationally important number: a rising figure with a flat completion
   * count means the worker is dead or stuck, which presents to advocates as
   * "the bot never replied" and leaves nothing in the web logs.
   */
  oldest_wait_seconds: number;
}

export interface SearchHistoryInput {
  userId: string;
  queryText: string;
  detectedLanguage: string;
  resolvedQuery?: string | null;
  intent: QueryIntent;
  citations: string[];
  resultCount: number;
  modelUsed?: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  guardrailFlagged: boolean;
  guardrailReason?: string | null;
}

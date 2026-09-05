import { z } from 'zod';

/**
 * Environment parsing and validation.
 *
 * Everything the app reads from the environment is declared here and validated
 * once, at boot. A missing WHATSAPP_APP_SECRET should crash the container on
 * startup with a readable message, not surface three hours later as a stream of
 * rejected webhooks.
 *
 * Nothing in this file imports Nest, so scripts/ can use it too.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const port = z.coerce.number().int().min(1).max(65535);

/**
 * Providers each AI task can be routed to. `mock` needs no credentials.
 *
 * deepseek and groq are OpenAI-wire-compatible, which is why they need nothing
 * beyond a key and a base URL.
 */
const providerEnum = z.enum(['anthropic', 'openai', 'google', 'deepseek', 'groq', 'mock']);

const envSchema = z.object({
  // --- Application ----------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  // --- Supabase / Postgres --------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Supabase connection string)'),
  // Falls back to DATABASE_URL; only migrations really need the direct port.
  DIRECT_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z.enum(['require', 'disable']).default('require'),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('vakeel-documents'),

  // --- Job queue ------------------------------------------------------------
  // Postgres-backed since migration 0013. There is no Redis in this service.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  /**
   * How long a slot waits before asking for work again.
   *
   * Added to the latency of every reply, and invisible against a model call
   * that takes seconds. LISTEN/NOTIFY would remove it entirely and cannot be
   * used over Supabase's transaction pooler, which cannot hold a listening
   * session - see migration 0013.
   */
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),

  /**
   * How long a claimed job is reserved for.
   *
   * Must exceed the longest a single message can legitimately take - retrieval
   * plus a synthesis call plus the send - or a slow job is reclaimed while it
   * is still running and answered twice. Two minutes against a 45s model
   * timeout leaves generous headroom.
   */
  JOB_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),

  /**
   * How often to look for jobs whose worker died mid-flight.
   *
   * This is crash-recovery latency. Until the sweep runs, a job stranded by a
   * SIGKILL is not retried - and because its lock key stays busy, every later
   * message from that advocate waits behind it.
   */
  JOB_STALLED_SWEEP_MS: z.coerce.number().int().min(5_000).default(60_000),

  // --- WhatsApp Cloud API ---------------------------------------------------
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WHATSAPP_VERIFY_TOKEN is required'),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(''),
  /**
   * The dialable number advocates message, in international format.
   *
   * Not derivable from WHATSAPP_PHONE_NUMBER_ID, which is an opaque Meta
   * identifier and not a phone number - a fact that is easy to miss until the
   * web app shows it to someone and asks them to message it. Used by the phone
   * linking screen and the wa.me deep link.
   */
  WHATSAPP_DISPLAY_NUMBER: z.string().default(''),
  WHATSAPP_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  WHATSAPP_API_VERSION: z.string().default('v23.0'),

  // Authentication-category template used to deliver one-time codes. Named
  // rather than hardcoded because the name is chosen in Meta's dashboard and
  // has to match exactly; a mismatch fails at send time with error 132001.
  WHATSAPP_OTP_TEMPLATE_NAME: z.string().default('otp_verify'),
  WHATSAPP_OTP_TEMPLATE_LANG: z.string().default('en'),
  WHATSAPP_DEDUPE_TTL_SECONDS: z.coerce.number().int().min(60).default(86400),

  // --- Security -------------------------------------------------------------
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes) - generate with: openssl rand -hex 32'),
  ADMIN_PHONE_NUMBERS: z.string().default(''),

  /**
   * How long a WhatsApp conversation stays "in session".
   *
   * After this much silence the next message is treated as a fresh start: the
   * greeting is re-sent, the language is asked again, and whatever half-finished
   * state the advocate was in is discarded. Until this existed the state simply
   * persisted, so a reply typed the next morning was read as an answer to a
   * question asked the previous evening.
   *
   * Was 2 minutes, to make the flow quick to exercise end to end, with a note
   * saying to raise it before real advocates used this. They do, the note was
   * the only thing standing between them and it, and nothing overrides the
   * default in `.env.example` or `render.yaml` - so the deployed bot re-greeted
   * anybody who took two minutes to read an answer, asked their language again,
   * and dropped whatever flow they were in.
   *
   * Thirty minutes is long enough to read five judgments and follow up, short
   * enough that tomorrow's message starts cleanly. Set SESSION_TTL_SECONDS=120
   * to get the old behaviour back while testing.
   */
  SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(1800),

  // Admin panel sign-in. Both must be set for the login form to work; if either
  // is blank the panel falls back to accepting JWT_SECRET as a bearer token,
  // which is the pre-login behaviour and is kept so automation does not break.
  ADMIN_EMAIL: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'ADMIN_EMAIL must be a valid email address')
    .default(''),
  ADMIN_PASSWORD: z
    .string()
    .refine((v) => v === '' || v.length >= 10, 'ADMIN_PASSWORD must be at least 10 characters')
    .default(''),

  // Bearer token for scripted admin API access (curl, CI). Separate from
  // JWT_SECRET on purpose - see `adminServiceToken` below for why.
  ADMIN_SERVICE_TOKEN: z
    .string()
    .refine((v) => v === '' || v.length >= 24, 'ADMIN_SERVICE_TOKEN must be at least 24 characters')
    .default(''),

  // --- LLM routing ----------------------------------------------------------
  LLM_SYNTHESIS_PROVIDER: providerEnum.default('mock'),
  LLM_ROUTER_PROVIDER: providerEnum.default('mock'),
  EMBEDDING_PROVIDER: providerEnum.default('mock'),

  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_SYNTHESIS_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_ROUTER_MODEL: z.string().default('claude-haiku-4-5'),
  ANTHROPIC_SYNTHESIS_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  ANTHROPIC_ROUTER_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_SYNTHESIS_MODEL: z.string().default('gpt-4.1'),
  OPENAI_ROUTER_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-large'),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  /** Override to point the OpenAI client at any wire-compatible endpoint. */
  OPENAI_BASE_URL: z.string().default(''),

  // DeepSeek - OpenAI-compatible wire format, markedly cheaper per token.
  DEEPSEEK_API_KEY: z.string().default(''),
  DEEPSEEK_SYNTHESIS_MODEL: z.string().default('deepseek-chat'),
  DEEPSEEK_ROUTER_MODEL: z.string().default('deepseek-chat'),
  DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),

  // Groq - OpenAI-compatible, very fast inference on open-weight models.
  GROQ_API_KEY: z.string().default(''),
  GROQ_SYNTHESIS_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_ROUTER_MODEL: z.string().default('llama-3.1-8b-instant'),
  GROQ_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),

  GOOGLE_API_KEY: z.string().default(''),
  GOOGLE_SYNTHESIS_MODEL: z.string().default('gemini-2.5-pro'),
  GOOGLE_ROUTER_MODEL: z.string().default('gemini-2.5-flash'),
  GOOGLE_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),

  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4000).default(3072),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(45000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // --- Per-user conversation memory -----------------------------------------
  // Isolated per advocate, so two people talking to the bot at the same time
  // never see each other's context. See src/ai/memory/chat-memory.service.ts.
  MEMORY_ENABLED: bool.default(true),
  /** User+assistant pairs retained. Each turn costs tokens on every later call. */
  MEMORY_MAX_TURNS: z.coerce.number().int().min(0).max(50).default(10),
  /** Hard character ceiling, so one enormous message cannot blow the budget. */
  MEMORY_MAX_CHARS: z.coerce.number().int().min(500).max(100_000).default(6000),
  /** Idle expiry. Also acts as automatic data minimisation under the DPDP Act. */
  MEMORY_TTL_SECONDS: z.coerce.number().int().min(300).default(86_400),

  // --- Retrieval ------------------------------------------------------------
  RAG_DENSE_TOP_K: z.coerce.number().int().min(1).max(500).default(50),
  RAG_SPARSE_TOP_K: z.coerce.number().int().min(1).max(500).default(50),
  RAG_RRF_K: z.coerce.number().int().min(1).max(1000).default(60),
  RAG_FINAL_TOP_K: z.coerce.number().int().min(1).max(50).default(5),
  RAG_MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.15),

  // Precedent listing (priority feature 3). Distinct from RAG_FINAL_TOP_K:
  // that governs how much context the LLM is given, this governs how many
  // distinct authorities the advocate is shown.
  // Ten, shown five at a time, so "more" is one page rather than two. Past
  // about ten an advocate is no longer reading judgments, they are scrolling.
  PRECEDENT_MAX_RESULTS: z.coerce.number().int().min(1).max(50).default(10),
  PRECEDENT_PAGE_SIZE: z.coerce.number().int().min(1).max(15).default(5),

  /**
   * Where precedents come from.
   *   local  - the ingested Postgres corpus only
   *   kanoon - Indian Kanoon's live API only
   *   auto   - Kanoon when a key is set, otherwise local; local as fallback
   *            whenever Kanoon fails
   */
  PRECEDENT_SOURCE: z.enum(['local', 'kanoon', 'auto']).default('auto'),

  // --- Indian Kanoon --------------------------------------------------------
  // Billed per query, so caching is on by default and the TTL is long: reported
  // judgments do not change once published.
  KANOON_API_KEY: z.string().default(''),
  KANOON_BASE_URL: z.string().default('https://api.indiankanoon.org'),
  KANOON_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),

  /**
   * How many results per page get their full document fetched.
   *
   * Indian Kanoon exposes no case number and no coram as fields - the search
   * result carries `bench: [888, 1990]`, which are author ids nobody can read.
   * Both live in the judgment's own header, and reaching them means fetching
   * the document: one extra billed call per row, and the sample document was
   * 1.1 MB.
   *
   * So it is capped at the page size rather than the result set. Five rows are
   * shown at a time and enriching the other ten would be paid for and never
   * seen. Set to 0 to turn it off entirely, at the cost of CASE NO. and BENCH
   * going back to "Not available".
   */
  KANOON_ENRICH_MAX: z.coerce.number().int().min(0).max(20).default(5),
  KANOON_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(86_400),
  KANOON_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(5),
  KANOON_BREAKER_RESET_MS: z.coerce.number().int().min(1000).default(60_000),

  // --- Free allowance -------------------------------------------------------
  /**
   * The one-time free credit allowance per role. Negative means unlimited.
   *
   * Granted once for the life of the account since migration 0014 - it does not
   * reset daily, monthly, or at all. The `_MONTHLY` in the names is two cycles
   * out of date and is kept only because renaming them means moving an env var,
   * a SQL function argument and every caller in one commit; an old QUOTA_*
   * value left in a deployment's environment is ignored rather than silently
   * reinterpreted.
   *
   * ## Why a verified advocate is no longer unlimited
   *
   * This was -1, which made VERIFIED_ADVOCATE bypass the wallet entirely - and
   * because an unlimited role's spends are not written to the ledger at all,
   * their usage left no financial record either. That was coherent while
   * verification was the thing being sold. It is not the product: usage is
   * credits, for everyone, and verification confirms a licence rather than
   * buying an exemption from the meter.
   *
   * Set to the same figure as a guest, so verification changes standing and not
   * balance. Existing verified accounts receive their one-time grant the first
   * time they are read after this lands, and keep whatever they had already
   * spent down to.
   *
   * Admins and auditors stay unlimited: they are staff, their usage is not
   * revenue, and metering it would mean topping up the people investigating a
   * billing complaint.
   */
  CREDITS_FREE_MONTHLY: z.coerce.number().int().default(30),
  CREDITS_VERIFIED_MONTHLY: z.coerce.number().int().default(30),
  CREDITS_ADMIN_MONTHLY: z.coerce.number().int().default(-1),

  // --- Credits --------------------------------------------------------------
  /**
   * One-off credits for a new web account, into the durable bucket.
   *
   * Durable rather than daily on purpose: a welcome gift that expires at
   * midnight before the advocate has finished reading the welcome screen is
   * worse than no gift. Set to 0 to disable.
   */
  CREDITS_SIGNUP_BONUS: z.coerce.number().int().min(0).max(10_000).default(10),

  // --- End-user web sessions ------------------------------------------------
  SESSION_COOKIE_NAME: z.string().min(1).default('vs_session'),
  /**
   * How long a web session lasts. Thirty days is the ordinary "stay signed in"
   * expectation; the token is opaque and revocable, so a long life costs less
   * here than it would with a JWT that cannot be withdrawn.
   */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /**
   * Minimum password length.
   *
   * Length is the only rule enforced. Composition rules (an uppercase, a digit,
   * a symbol) measurably push people towards `Password1!` and are no longer
   * recommended by NIST; a longer minimum is worth more than a more elaborate
   * one.
   */
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(10),

  /*
   * Who the privacy policy names as Data Fiduciary, and where data requests go.
   *
   * Left blank by default and rendered as a placeholder rather than invented.
   * A policy that names the wrong entity is a dated, published, false statement
   * about who is accountable under the DPDP Act.
   */
  LEGAL_OPERATOR_NAME: z.string().default(''),
  LEGAL_CONTACT_EMAIL: z.string().default(''),

  /*
   * Whether an unverified number blocks access.
   *
   * Exists because the gate and the thing that lifts it go live at different
   * moments: the code ships when it is ready, and the WhatsApp template it
   * depends on ships when Meta finishes reviewing it. Deploying the gate into
   * that window locks out every existing account and every new signup, with no
   * way through, because the codes that would open it cannot be sent yet.
   *
   * Defaults to on. It is a deployment sequencing tool, not a feature toggle -
   * turn it on once a real code has arrived on a real handset.
   */
  PHONE_VERIFICATION_REQUIRED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // --- Google sign-in -------------------------------------------------------
  // Both must be set for the button to appear. The flow is the server-side
  // authorization-code flow: the browser never sees the client secret, and the
  // code is exchanged from our backend over TLS.
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  /**
   * Must match a redirect URI registered on the Google Cloud credential
   * exactly, including scheme and trailing path. Joined onto APP_PUBLIC_URL.
   */
  GOOGLE_OAUTH_REDIRECT_PATH: z.string().default('/auth/google/callback'),

  // --- Transactional email --------------------------------------------------
  /**
   * How verification and password-reset mail is sent.
   *
   *   log    - written to the log instead of sent. The default, and the only
   *            honest one with no credentials: the UI is told email is
   *            unavailable and never claims to have sent anything.
   *   resend - Resend's HTTP API. Chosen over SMTP because it needs no
   *            dependency, only fetch.
   */
  EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('Vakeel Saathi <onboarding@resend.dev>'),

  // --- Payments (Razorpay) --------------------------------------------------
  // No gateway calls are made anywhere in this build. These exist so the
  // configuration surface is settled and `razorpayConfigured` can gate the UI
  // honestly - a "Buy credits" button that cannot take money should not be on
  // screen.
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  /**
   * GST on digital services, in basis points. 18% is 1800.
   *
   * Basis points rather than a float because tax is applied to money: 0.18 is
   * not exactly representable in binary floating point, and the error surfaces
   * as an invoice whose components do not add up to its total.
   */
  GST_RATE_BPS: z.coerce.number().int().min(0).max(10_000).default(1800),

  // --- eCourts --------------------------------------------------------------
  ECOURTS_MODE: z.enum(['mock', 'http']).default('mock'),
  ECOURTS_BASE_URL: z.string().default(''),
  ECOURTS_API_KEY: z.string().default(''),
  ECOURTS_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  ECOURTS_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(5),
  ECOURTS_BREAKER_RESET_MS: z.coerce.number().int().min(1000).default(60000),
});

export type RawEnv = z.infer<typeof envSchema>;

export type AppEnv = RawEnv & {
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  /** DIRECT_URL when set, else DATABASE_URL. Migrations prefer the direct port. */
  readonly migrationDatabaseUrl: string;
  /** Parsed ADMIN_PHONE_NUMBERS, normalised to digits only. */
  readonly adminPhoneNumbers: readonly string[];
  /** Graph API root for the configured phone number, e.g. .../v23.0/123456. */
  readonly whatsappApiBase: string;
  /** True when we can actually send messages (vs. log-only local dev). */
  readonly whatsappConfigured: boolean;
  /** True when the admin panel has a real email/password pair configured. */
  readonly adminLoginConfigured: boolean;
  /**
   * The bearer token accepted by AdminGuard for non-browser callers, or `''`
   * for none.
   *
   * ## Why this is not simply JWT_SECRET
   *
   * It used to be. JWT_SECRET is the HMAC key that signs admin sessions, so
   * accepting it as a bearer token meant the same string both *proved* identity
   * and *minted* it: anyone holding it could forge a SUPER_ADMIN session with
   * any expiry they liked. Revoking a leaked copy therefore meant rotating the
   * signing key, which invalidates every live session at the same time. Two
   * jobs, one string, and no way to revoke either independently.
   *
   * The resolution order below keeps every deployment reachable:
   *
   *  1. `ADMIN_SERVICE_TOKEN` when set - a credential that can be rotated on
   *     its own without signing anything out.
   *  2. Otherwise `JWT_SECRET`, but *only* while email login is unconfigured.
   *     That is the state a fresh deployment starts in, and refusing it would
   *     leave no way to reach the panel at all.
   *  3. Once ADMIN_EMAIL and ADMIN_PASSWORD are set and no service token is,
   *     there is no shared bearer credential. Sessions only.
   */
  readonly adminServiceToken: string;

  /** True when Google sign-in has both halves of its credential. */
  readonly googleOAuthConfigured: boolean;
  /**
   * The absolute redirect URI sent to Google.
   *
   * Built from APP_PUBLIC_URL so there is one place to change when the domain
   * does. Google compares this string exactly against the registered value - a
   * trailing slash or http-for-https is a `redirect_uri_mismatch`, which is the
   * single most common way this integration fails.
   */
  readonly googleOAuthRedirectUri: string;
  /**
   * Whether session cookies carry the Secure attribute.
   *
   * Derived from the public URL rather than configured, because the two cannot
   * disagree usefully: Secure on plain http means the browser silently discards
   * the cookie and sign-in appears to succeed and then fail, which is a
   * miserable thing to debug. Local http development therefore gets a
   * non-Secure cookie automatically.
   */
  readonly cookieSecure: boolean;
  /** Session lifetime in seconds, from SESSION_TTL_DAYS. */
  readonly sessionTtlSeconds: number;
  /** True when verification and reset mail can actually be delivered. */
  readonly emailConfigured: boolean;
  /** True when Razorpay has both keys. Gates the buy-credits UI. */
  readonly razorpayConfigured: boolean;
};

/**
 * Validate a raw environment object.
 *
 * Kept separate from {@link loadEnv} so tests can feed in a fixture without
 * mutating process.env.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the required values.',
    );
  }

  const env = result.data;

  const adminPhoneNumbers = env.ADMIN_PHONE_NUMBERS.split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter((n) => n.length > 0);

  const whatsappConfigured = Boolean(
    env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_APP_SECRET,
  );

  const adminLoginConfigured = Boolean(env.ADMIN_EMAIL && env.ADMIN_PASSWORD);

  const googleOAuthConfigured = Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);

  // Trailing slashes are stripped from the base and required on the path, so
  // that APP_PUBLIC_URL with or without one produces the same redirect URI.
  const publicBase = env.APP_PUBLIC_URL.replace(/\/+$/, '');
  const redirectPath = env.GOOGLE_OAUTH_REDIRECT_PATH.startsWith('/')
    ? env.GOOGLE_OAUTH_REDIRECT_PATH
    : `/${env.GOOGLE_OAUTH_REDIRECT_PATH}`;

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    migrationDatabaseUrl: env.DIRECT_URL || env.DATABASE_URL,
    adminPhoneNumbers,
    whatsappApiBase: `${env.WHATSAPP_GRAPH_BASE_URL}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}`,
    whatsappConfigured,
    adminLoginConfigured,
    adminServiceToken: env.ADMIN_SERVICE_TOKEN || (adminLoginConfigured ? '' : env.JWT_SECRET),

    googleOAuthConfigured,
    googleOAuthRedirectUri: `${publicBase}${redirectPath}`,
    cookieSecure: publicBase.startsWith('https://'),
    sessionTtlSeconds: env.SESSION_TTL_DAYS * 86_400,
    emailConfigured: env.EMAIL_PROVIDER === 'resend' && Boolean(env.RESEND_API_KEY),
    razorpayConfigured: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
  };
}

let cached: AppEnv | undefined;

/** Parse process.env once and memoise. */
export function loadEnv(): AppEnv {
  cached ??= parseEnv();
  return cached;
}

/** Test hook: drop the memoised env so the next loadEnv() re-reads. */
export function resetEnvCache(): void {
  cached = undefined;
}

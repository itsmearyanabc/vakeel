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

/** Providers each AI task can be routed to. `mock` needs no credentials. */
const providerEnum = z.enum(['anthropic', 'openai', 'google', 'mock']);

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

  // --- Redis ----------------------------------------------------------------
  REDIS_URL: z.string().min(1, 'REDIS_URL is required (Railway Redis plugin)'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  // --- WhatsApp Cloud API ---------------------------------------------------
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WHATSAPP_VERIFY_TOKEN is required'),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(''),
  WHATSAPP_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  WHATSAPP_API_VERSION: z.string().default('v23.0'),
  WHATSAPP_DEDUPE_TTL_SECONDS: z.coerce.number().int().min(60).default(86400),

  // --- Security -------------------------------------------------------------
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes) - generate with: openssl rand -hex 32'),
  ADMIN_PHONE_NUMBERS: z.string().default(''),

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

  GOOGLE_API_KEY: z.string().default(''),
  GOOGLE_SYNTHESIS_MODEL: z.string().default('gemini-2.5-pro'),
  GOOGLE_ROUTER_MODEL: z.string().default('gemini-2.5-flash'),
  GOOGLE_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),

  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4000).default(3072),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(45000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // --- Retrieval ------------------------------------------------------------
  RAG_DENSE_TOP_K: z.coerce.number().int().min(1).max(500).default(50),
  RAG_SPARSE_TOP_K: z.coerce.number().int().min(1).max(500).default(50),
  RAG_RRF_K: z.coerce.number().int().min(1).max(1000).default(60),
  RAG_FINAL_TOP_K: z.coerce.number().int().min(1).max(50).default(5),
  RAG_MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.15),

  // --- Quotas ---------------------------------------------------------------
  QUOTA_GUEST_DAILY: z.coerce.number().int().default(5),
  QUOTA_VERIFIED_DAILY: z.coerce.number().int().default(-1),
  QUOTA_ADMIN_DAILY: z.coerce.number().int().default(-1),

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

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    migrationDatabaseUrl: env.DIRECT_URL || env.DATABASE_URL,
    adminPhoneNumbers,
    whatsappApiBase: `${env.WHATSAPP_GRAPH_BASE_URL}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}`,
    whatsappConfigured,
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

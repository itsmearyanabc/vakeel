/**
 * The catalogue of settings that can be changed at runtime from the admin panel.
 *
 * This list is the single source of truth for three things at once:
 *
 *   1. which keys {@link SettingsService} will read from the database at all
 *      (anything not declared here is env-only and cannot be overridden),
 *   2. which values get encrypted on write and redacted on read,
 *   3. the form the admin panel renders - fields, groups, help text and
 *      validation all come from here, so adding a setting is a one-file change.
 *
 * Keys deliberately match their environment variable names. That is what makes
 * the resolution chain readable: `app_settings['WHATSAPP_ACCESS_TOKEN']` falls
 * back to `process.env.WHATSAPP_ACCESS_TOKEN`.
 *
 * ## What is NOT here, and why
 *
 * DATABASE_URL, REDIS_URL, ENCRYPTION_KEY and JWT_SECRET are intentionally
 * absent. They are needed to reach or decrypt this table in the first place, so
 * storing them in it is circular - and an admin who pastes a bad DATABASE_URL
 * into a web form would lock themselves out of the form. Those stay on Railway.
 */

export type SettingType = 'text' | 'secret' | 'number' | 'select' | 'boolean' | 'textarea';

export interface SettingDefinition {
  key: string;
  group: SettingGroupId;
  label: string;
  type: SettingType;
  /** Shown under the field in the admin panel. Explain consequences, not syntax. */
  help: string;
  placeholder?: string;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Warn in the UI when this is blank and the feature it powers is switched on. */
  requiredFor?: string;
}

export type SettingGroupId = 'whatsapp' | 'ai' | 'retrieval' | 'quotas' | 'ecourts';

export interface SettingGroup {
  id: SettingGroupId;
  title: string;
  description: string;
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: 'whatsapp',
    title: 'WhatsApp connection',
    description:
      'Credentials for the WhatsApp Business number the bot answers on. Changing these switches the bot to a different number without a redeploy - both the web and worker processes pick it up within seconds.',
  },
  {
    id: 'ai',
    title: 'AI providers',
    description:
      'Which model answers which kind of question. Any task left on "mock" returns a canned placeholder instead of calling a real model, which is what lets you exercise the bot before you have keys.',
  },
  {
    id: 'retrieval',
    title: 'Retrieval tuning',
    description:
      'How many candidate passages the hybrid search considers and how aggressively weak matches are discarded. Raising the candidate pools costs latency; raising the relevance floor costs recall.',
  },
  {
    id: 'quotas',
    title: 'Daily quotas',
    description:
      'Per-role message allowances, reset at midnight UTC. Set to -1 for unlimited. These are rate limits, not billing - there is no credit wallet.',
  },
  {
    id: 'ecourts',
    title: 'eCourts / CNR lookup',
    description:
      'Case status lookups by CNR number. India’s eCourts has no free public API, so "mock" returns deterministic sample data until you subscribe to a provider.',
  },
] as const;

const PROVIDER_OPTIONS = [
  { value: 'mock', label: 'Mock (no API key needed)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google (Gemini)' },
] as const;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // --- WhatsApp -------------------------------------------------------------
  {
    key: 'WHATSAPP_PHONE_NUMBER_ID',
    group: 'whatsapp',
    label: 'Phone number ID',
    type: 'text',
    placeholder: '123456789012345',
    help: 'The numeric ID Meta assigns to your sending number - NOT the phone number itself. Meta dashboard: WhatsApp > API Setup, under "From".',
    requiredFor: 'sending any message',
  },
  {
    key: 'WHATSAPP_ACCESS_TOKEN',
    group: 'whatsapp',
    label: 'Access token',
    type: 'secret',
    placeholder: 'EAAG...',
    help: 'Use a permanent System User token. The 24-hour temporary token in the dashboard is fine for a first test but will silently stop the bot tomorrow.',
    requiredFor: 'sending any message',
  },
  {
    key: 'WHATSAPP_APP_SECRET',
    group: 'whatsapp',
    label: 'App secret',
    type: 'secret',
    placeholder: '32-character hex string',
    help: 'Meta dashboard: App Settings > Basic > App Secret. Every inbound webhook is HMAC-verified against this. Without it, anyone who finds your webhook URL can send the bot fake messages.',
    requiredFor: 'accepting webhooks',
  },
  {
    key: 'WHATSAPP_VERIFY_TOKEN',
    group: 'whatsapp',
    label: 'Webhook verify token',
    type: 'secret',
    placeholder: 'any long random string you invent',
    help: 'You invent this. Paste the identical string into Meta’s webhook configuration - it is only used for the one-time callback URL handshake.',
    requiredFor: 'the Meta webhook handshake',
  },
  {
    key: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
    group: 'whatsapp',
    label: 'Business account ID (WABA)',
    type: 'text',
    placeholder: '987654321098765',
    help: 'Optional. Only needed for template management and account-level reporting; sending and receiving work without it.',
  },
  {
    key: 'WHATSAPP_API_VERSION',
    group: 'whatsapp',
    label: 'Graph API version',
    type: 'text',
    placeholder: 'v23.0',
    help: 'Meta deprecates versions roughly every two years. Bump this when you migrate; leaving it stale eventually breaks sending.',
  },

  // --- AI providers ---------------------------------------------------------
  {
    key: 'LLM_SYNTHESIS_PROVIDER',
    group: 'ai',
    label: 'Synthesis provider',
    type: 'select',
    options: PROVIDER_OPTIONS,
    help: 'Answers the actual legal question - section explanations and precedent analysis. This is where answer quality is won or lost.',
  },
  {
    key: 'LLM_ROUTER_PROVIDER',
    group: 'ai',
    label: 'Router provider',
    type: 'select',
    options: PROVIDER_OPTIONS,
    help: 'Classifies intent and expands queries on every single message. High volume, cheap model - keep this on a small/fast model.',
  },
  {
    key: 'EMBEDDING_PROVIDER',
    group: 'ai',
    label: 'Embedding provider',
    type: 'select',
    options: [
      { value: 'mock', label: 'Mock (hashed, not semantic)' },
      { value: 'openai', label: 'OpenAI' },
      { value: 'google', label: 'Google (Gemini)' },
    ],
    help: 'Anthropic has no embeddings endpoint, so this must be OpenAI or Google. On "mock", dense search is disabled and retrieval falls back to keyword-only - workable, noticeably worse.',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    group: 'ai',
    label: 'Anthropic API key',
    type: 'secret',
    placeholder: 'sk-ant-...',
    help: 'From console.anthropic.com. Needed only if a task above is set to Anthropic.',
  },
  {
    key: 'ANTHROPIC_SYNTHESIS_MODEL',
    group: 'ai',
    label: 'Anthropic synthesis model',
    type: 'text',
    placeholder: 'claude-opus-5',
    help: 'claude-opus-5 is the most capable. claude-sonnet-5 costs less per token if you want to trade some quality.',
  },
  {
    key: 'ANTHROPIC_ROUTER_MODEL',
    group: 'ai',
    label: 'Anthropic router model',
    type: 'text',
    placeholder: 'claude-haiku-4-5',
    help: 'Runs on every message. claude-haiku-4-5 is the cheap tier and is more than adequate for intent classification.',
  },
  {
    key: 'OPENAI_API_KEY',
    group: 'ai',
    label: 'OpenAI API key',
    type: 'secret',
    placeholder: 'sk-...',
    help: 'Needed for OpenAI synthesis/routing, for OpenAI embeddings, and for voice-note transcription (Whisper) regardless of the other providers.',
  },
  {
    key: 'OPENAI_EMBEDDING_MODEL',
    group: 'ai',
    label: 'OpenAI embedding model',
    type: 'text',
    placeholder: 'text-embedding-3-large',
    help: 'Must produce 3072 dimensions to match the database schema. Changing to a narrower model means re-running the migrations and re-embedding the whole corpus.',
  },
  {
    key: 'GOOGLE_API_KEY',
    group: 'ai',
    label: 'Google API key',
    type: 'secret',
    placeholder: 'AIza...',
    help: 'From Google AI Studio. Needed only if a task above is set to Google.',
  },

  // --- Retrieval ------------------------------------------------------------
  {
    key: 'RAG_DENSE_TOP_K',
    group: 'retrieval',
    label: 'Dense candidates',
    type: 'number',
    min: 1,
    max: 500,
    help: 'Passages pulled from vector search before fusion. Higher finds more obscure authorities and costs latency.',
  },
  {
    key: 'RAG_SPARSE_TOP_K',
    group: 'retrieval',
    label: 'Keyword candidates',
    type: 'number',
    min: 1,
    max: 500,
    help: 'Passages pulled from full-text search before fusion. Keyword search is what catches exact citations and section numbers.',
  },
  {
    key: 'RAG_FINAL_TOP_K',
    group: 'retrieval',
    label: 'Passages sent to the model',
    type: 'number',
    min: 1,
    max: 50,
    help: 'How much context the answer is grounded in. Raising this raises token cost on every query and eventually dilutes the answer.',
  },
  {
    key: 'RAG_MIN_RELEVANCE',
    group: 'retrieval',
    label: 'Relevance floor',
    type: 'text',
    placeholder: '0.15',
    help: 'Fused results scoring below this are discarded. Raise it if answers cite marginally-related cases; lower it if the bot too often says it found nothing.',
  },
  {
    key: 'PRECEDENT_MAX_RESULTS',
    group: 'retrieval',
    label: 'Max precedents per session',
    type: 'number',
    min: 1,
    max: 50,
    help: 'Cap on precedents returned for one research question. The chat pages through them in batches.',
  },
  {
    key: 'PRECEDENT_PAGE_SIZE',
    group: 'retrieval',
    label: 'Precedents per message',
    type: 'number',
    min: 1,
    max: 15,
    help: 'How many precedents appear in one WhatsApp message before a "Show more" button. Keep it low - WhatsApp truncates long messages.',
  },

  // --- Quotas ---------------------------------------------------------------
  {
    key: 'QUOTA_GUEST_DAILY',
    group: 'quotas',
    label: 'Unverified advocate / day',
    type: 'number',
    min: -1,
    help: 'Daily queries before an unverified user is asked to complete bar council verification. -1 for unlimited.',
  },
  {
    key: 'QUOTA_VERIFIED_DAILY',
    group: 'quotas',
    label: 'Verified advocate / day',
    type: 'number',
    min: -1,
    help: 'Daily queries for a verified advocate. -1 for unlimited.',
  },

  // --- eCourts --------------------------------------------------------------
  {
    key: 'ECOURTS_MODE',
    group: 'ecourts',
    label: 'Mode',
    type: 'select',
    options: [
      { value: 'mock', label: 'Mock - deterministic sample case data' },
      { value: 'http', label: 'HTTP - call a real eCourts API provider' },
    ],
    help: 'Leave on mock until you have a provider. In mock mode a valid CNR returns realistic but fabricated case details, clearly labelled as sample data in the reply.',
  },
  {
    key: 'ECOURTS_BASE_URL',
    group: 'ecourts',
    label: 'Provider base URL',
    type: 'text',
    placeholder: 'https://api.example.com/ecourts',
    help: 'Root URL of your eCourts data provider. Only used when mode is HTTP.',
    requiredFor: 'HTTP mode',
  },
  {
    key: 'ECOURTS_API_KEY',
    group: 'ecourts',
    label: 'Provider API key',
    type: 'secret',
    help: 'Sent as a bearer token to the provider above.',
    requiredFor: 'HTTP mode',
  },
] as const;

/** Fast lookup by key. */
export const SETTING_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((d) => [d.key, d]),
);

export function isSecretSetting(key: string): boolean {
  return SETTING_BY_KEY.get(key)?.type === 'secret';
}

export function isKnownSetting(key: string): boolean {
  return SETTING_BY_KEY.has(key);
}

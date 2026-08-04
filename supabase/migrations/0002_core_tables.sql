-- =============================================================================
-- 0002_core_tables.sql
-- Users, conversation state, message log, usage history and daily quotas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
--
-- One row per WhatsApp phone number. Created lazily on first inbound message,
-- so there is no separate signup step.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- E.164 without the leading '+', exactly as Meta delivers it (e.g. 919876543210).
    phone_number          VARCHAR(20) UNIQUE NOT NULL,
    full_name             VARCHAR(160),

    -- AES-256-GCM ciphertext produced by src/security/crypto.service.ts.
    -- Never store the bar council number in plaintext: it is PII under the
    -- DPDP Act 2023. The blind index below is what we actually search on.
    bar_council_id_enc    TEXT,
    -- HMAC-SHA256(bar_council_id) - lets us enforce uniqueness and look up a
    -- registration without ever decrypting, and without a plaintext index.
    bar_council_id_hash   VARCHAR(64) UNIQUE,
    bar_council_state     VARCHAR(60),

    verification_status   verification_status NOT NULL DEFAULT 'PENDING',
    role                  user_role           NOT NULL DEFAULT 'GUEST_LAWYER',

    -- ISO 639-1. Detected from the user's messages, overridable from the menu.
    preferred_language    VARCHAR(10) NOT NULL DEFAULT 'en',

    -- Supabase Storage object path for the uploaded bar council ID card.
    id_card_storage_path  TEXT,
    verification_notes    TEXT,
    verified_at           TIMESTAMPTZ,

    -- Set when a user sends "stop". We keep the row (audit) but send nothing.
    is_blocked            BOOLEAN NOT NULL DEFAULT FALSE,
    opted_out_at          TIMESTAMPTZ,

    last_active_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone       ON users (phone_number);
CREATE INDEX IF NOT EXISTS idx_users_role        ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_status      ON users (verification_status);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- conversation_states
--
-- The WhatsApp chat is a state machine (onboarding steps, "awaiting CNR",
-- "awaiting bar council number", ...). Redis holds the hot copy; this table is
-- the durable one so a Redis flush doesn't strand a half-finished onboarding.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_states (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state       VARCHAR(60) NOT NULL DEFAULT 'IDLE',
    context     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    expires_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_states_expiry ON conversation_states (expires_at);

DROP TRIGGER IF EXISTS trg_conversation_states_updated_at ON conversation_states;
CREATE TRIGGER trg_conversation_states_updated_at
    BEFORE UPDATE ON conversation_states
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- whatsapp_messages
--
-- Append-only log of everything in and out. `wa_message_id` is unique, which is
-- what makes webhook processing idempotent: Meta retries aggressively, and the
-- ON CONFLICT DO NOTHING insert is our second line of defence behind the Redis
-- dedupe key.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wa_message_id  VARCHAR(128) UNIQUE,
    user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
    phone_number   VARCHAR(20) NOT NULL,

    direction      message_direction NOT NULL,
    message_type   VARCHAR(32)       NOT NULL,   -- text | interactive | audio | document | image | template
    body           TEXT,
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,

    status         message_status NOT NULL DEFAULT 'RECEIVED',
    error_detail   TEXT,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_user_time ON whatsapp_messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_status    ON whatsapp_messages (status)
    WHERE status IN ('QUEUED', 'PROCESSING', 'FAILED');


-- -----------------------------------------------------------------------------
-- search_history
--
-- One row per answered query. Powers the admin analytics, the auditor review
-- queue, and per-user "show my recent searches".
--
-- DPDP Act 2023 note: `query_text` is user content. It is never used for model
-- training and is purged by the retention job in 0005.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_history (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    query_text        TEXT        NOT NULL,
    detected_language VARCHAR(10) NOT NULL DEFAULT 'en',
    -- Query after translation + expansion; this is what actually hit retrieval.
    resolved_query    TEXT,
    intent            query_intent NOT NULL DEFAULT 'GENERAL_LEGAL',

    -- Citations we returned, so an auditor can spot-check for hallucination.
    citations         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    result_count      INTEGER NOT NULL DEFAULT 0,

    model_used        VARCHAR(80),
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER NOT NULL DEFAULT 0,

    -- Set by the citation validator when it strips an ungrounded citation.
    guardrail_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    guardrail_reason  TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_history_user_time ON search_history (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_history_intent    ON search_history (intent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_history_flagged   ON search_history (created_at DESC)
    WHERE guardrail_flagged;


-- -----------------------------------------------------------------------------
-- daily_usage
--
-- Role-based daily quota counters. Redis is the fast path (atomic INCR); this
-- table is the durable ledger that survives a Redis restart and backs the
-- admin usage reports.
--
-- This is deliberately NOT a credit wallet - billing is out of scope for now.
-- When you add Razorpay, add a `wallet_ledger` table alongside this one rather
-- than overloading it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_usage (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date  DATE NOT NULL DEFAULT CURRENT_DATE,
    query_count INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage (usage_date DESC);


-- -----------------------------------------------------------------------------
-- processed_webhooks
--
-- Belt-and-braces idempotency for Meta webhook deliveries, independent of the
-- message log (status callbacks have no message row of their own).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_webhooks (
    event_key    VARCHAR(200) PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_time ON processed_webhooks (processed_at);

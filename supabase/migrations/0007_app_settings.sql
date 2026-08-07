-- =============================================================================
-- 0007_app_settings.sql
-- Runtime-editable configuration, so the admin panel can change how the bot
-- behaves without a redeploy.
--
-- ## Why this table exists
--
-- Everything used to come from environment variables, which are frozen at
-- process boot. That makes "paste in the WhatsApp credentials for the number I
-- want the bot to run on" impossible from a web UI - you would have to edit
-- Railway variables and wait for both services to restart.
--
-- This table is the override layer. Resolution order at runtime is:
--
--     app_settings row  ->  environment variable  ->  schema default
--
-- so an untouched deployment behaves exactly as before, and anything set here
-- wins. Deleting a row reverts that setting to the environment value.
--
-- ## Secrets
--
-- Values for keys marked `is_secret` are AES-256-GCM ciphertext produced by
-- src/security/crypto.service.ts, using ENCRYPTION_KEY. That key deliberately
-- stays an environment variable: if it lived here, the database would hold both
-- the lock and the key.
--
-- The admin API never returns a secret value - only whether one is set, and a
-- masked hint (last 4 characters). Writes are one-way.
-- =============================================================================

CREATE TABLE IF NOT EXISTS app_settings (
    key         VARCHAR(80) PRIMARY KEY,

    -- Plaintext for ordinary settings; iv.ciphertext.authTag for secrets.
    value       TEXT NOT NULL,

    -- Drives both encryption on write and redaction on read. Stored per-row
    -- rather than derived from the key name so the catalogue in
    -- src/settings/settings.catalog.ts stays the single source of truth without
    -- the database needing to know about it.
    is_secret   BOOLEAN NOT NULL DEFAULT FALSE,

    -- Free-text audit: which admin, or 'system' for automated writes.
    updated_by  VARCHAR(120) NOT NULL DEFAULT 'system',
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON app_settings;
CREATE TRIGGER trg_app_settings_updated_at
    BEFORE UPDATE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- settings_audit
--
-- Who changed which setting, and when. Secret *values* are never recorded -
-- only the fact that the key changed. This is what lets you answer "the bot
-- stopped replying at 3pm, what changed?" without keeping a copy of every token
-- that was ever pasted in.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings_audit (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         VARCHAR(80)  NOT NULL,
    action      VARCHAR(20)  NOT NULL,   -- SET | CLEAR
    -- NULL for secrets. Truncated for long values.
    old_preview TEXT,
    new_preview TEXT,
    changed_by  VARCHAR(120) NOT NULL DEFAULT 'admin',
    changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_time ON settings_audit (changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_settings_audit_key  ON settings_audit (key, changed_at DESC);

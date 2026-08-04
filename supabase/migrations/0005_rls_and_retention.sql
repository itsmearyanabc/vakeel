-- =============================================================================
-- 0005_rls_and_retention.sql
-- Row Level Security and the DPDP Act 2023 retention job.
--
-- ## Why RLS matters even though the backend bypasses it
--
-- This service connects to Postgres directly as the database owner, which is
-- not subject to RLS. But a Supabase project also exposes every table in
-- `public` over PostgREST using the anon key, which ships in browser code.
-- Without RLS, that key can read the whole users table.
--
-- Enabling RLS with no permissive policy is deny-by-default for anon and
-- authenticated. We then open up exactly one thing: read access to the bare
-- acts, which are public legal texts. Everything else stays closed until the
-- web portal is built and needs specific policies.
-- =============================================================================

ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_usage         ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_webhooks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE statutes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE judgments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE judgment_chunks     ENABLE ROW LEVEL SECURITY;

-- Force RLS even for the table owner, so a misconfigured connection cannot
-- quietly read everything. The `postgres` superuser still bypasses it, which
-- is what our migration runner and the backend pool use.
ALTER TABLE users             FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE search_history    FORCE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- Bare acts are public legal texts - safe to read from a browser.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS statutes_public_read ON statutes;
CREATE POLICY statutes_public_read
    ON statutes FOR SELECT
    TO anon, authenticated
    USING (true);


-- -----------------------------------------------------------------------------
-- Judgments: readable by signed-in users only. Chunk text stays closed - it is
-- the retrieval corpus and there is no reason to expose it wholesale.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS judgments_auth_read ON judgments;
CREATE POLICY judgments_auth_read
    ON judgments FOR SELECT
    TO authenticated
    USING (true);


-- -----------------------------------------------------------------------------
-- service_role explicitly gets everything. It bypasses RLS regardless; these
-- policies exist so the intent is visible in the schema rather than implied.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users', 'conversation_states', 'whatsapp_messages', 'search_history',
        'daily_usage', 'processed_webhooks', 'statutes', 'judgments',
        'judgment_chunks'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_service_all', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
            t || '_service_all', t
        );
    END LOOP;
END $$;


-- =============================================================================
-- Retention
--
-- DPDP Act 2023: personal data is kept only as long as it serves the purpose it
-- was collected for. Raw query text is never used for model training and is
-- purged on the schedule below.
--
-- Run this daily. Either:
--   - Supabase Dashboard -> Database -> Cron (pg_cron), or
--   - the @Cron('0 3 * * *') job already wired up in the worker process.
-- =============================================================================
CREATE OR REPLACE FUNCTION purge_expired_data(
    p_search_history_days INTEGER DEFAULT 180,
    p_message_log_days    INTEGER DEFAULT 90,
    p_webhook_days        INTEGER DEFAULT 7
)
RETURNS TABLE (
    purged_search_history BIGINT,
    purged_messages       BIGINT,
    purged_webhooks       BIGINT,
    purged_conversations  BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_history       BIGINT;
    v_messages      BIGINT;
    v_webhooks      BIGINT;
    v_conversations BIGINT;
BEGIN
    DELETE FROM search_history
     WHERE created_at < NOW() - make_interval(days => p_search_history_days);
    GET DIAGNOSTICS v_history = ROW_COUNT;

    DELETE FROM whatsapp_messages
     WHERE created_at < NOW() - make_interval(days => p_message_log_days);
    GET DIAGNOSTICS v_messages = ROW_COUNT;

    DELETE FROM processed_webhooks
     WHERE processed_at < NOW() - make_interval(days => p_webhook_days);
    GET DIAGNOSTICS v_webhooks = ROW_COUNT;

    DELETE FROM conversation_states
     WHERE expires_at IS NOT NULL AND expires_at < NOW();
    GET DIAGNOSTICS v_conversations = ROW_COUNT;

    RETURN QUERY SELECT v_history, v_messages, v_webhooks, v_conversations;
END;
$$;


-- -----------------------------------------------------------------------------
-- delete_user_data
--
-- Right to erasure. Cascades handle the child rows; the message log is cleared
-- by phone number too, since inbound messages can predate the user row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_user_data(p_phone_number TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    SELECT id INTO v_user_id FROM users WHERE phone_number = p_phone_number;
    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    DELETE FROM whatsapp_messages WHERE phone_number = p_phone_number;
    DELETE FROM users WHERE id = v_user_id;   -- cascades to the rest
    RETURN TRUE;
END;
$$;

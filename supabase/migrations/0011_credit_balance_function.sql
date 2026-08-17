-- =============================================================================
-- 0011 — Read the wallet and roll it over in one call
--
-- ## The bug this fixes
--
-- CreditRepository.balance() refreshed the daily allowance and read the result
-- in a single statement:
--
--     WITH refreshed AS (SELECT credit_refresh_free($1, $2))
--     SELECT u.free_credits, u.paid_credits FROM users u, refreshed WHERE ...
--
-- That returns stale numbers, and it does so silently. A statement in Postgres
-- executes against one snapshot, taken before it starts. `credit_refresh_free`
-- updates `users` — but the `SELECT` in the same statement is reading from the
-- snapshot that predates the update, so it returns the row as it was *before*
-- the allowance was granted. The write lands; the read cannot see it.
--
-- Observed exactly as that predicts: a newly created account reported
-- `free: 0` on the first request and `free: 5` on the second. The credits were
-- always there. The first read simply could not see them, so every advocate's
-- first impression of the product was a wallet that looked empty.
--
-- ## Why a plpgsql function is the fix rather than two statements
--
-- Two round trips would also be correct - the second statement gets a fresh
-- snapshot - but it doubles the latency of the most frequently called query in
-- the application, and it leaves the same trap set for the next person who
-- writes a CTE that looks like it should work.
--
-- Inside plpgsql each statement gets its own snapshot, so the SELECT below runs
-- after the UPDATE and sees it. One round trip, correct by construction, and
-- the ordering is now a property of the function rather than an assumption at
-- the call site.
-- =============================================================================

CREATE OR REPLACE FUNCTION credit_balance(
    p_user_id UUID,
    p_daily   INTEGER
)
RETURNS TABLE (
    free_credits INTEGER,
    paid_credits INTEGER
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- Rolls the day over if the bucket is stale. Idempotent within a day, so
    -- calling this on every balance read costs one cheap comparison.
    PERFORM credit_refresh_free(p_user_id, p_daily);

    -- A separate statement, and therefore a snapshot taken after the refresh
    -- committed its changes to this transaction. This is the whole point.
    RETURN QUERY
        SELECT u.free_credits, u.paid_credits
          FROM users u
         WHERE u.id = p_user_id;
END;
$$;

COMMENT ON FUNCTION credit_balance IS
    'Refresh the daily allowance if stale, then return both buckets. Use this rather than '
    'calling credit_refresh_free() alongside a SELECT in one statement - the SELECT would '
    'read a snapshot older than the refresh and report the balance before the top-up.';

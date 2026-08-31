-- =============================================================================
-- 0014 — the free allowance stops being monthly
--
-- The product decision: the free credits an advocate starts with are theirs
-- once, for the life of the account. They are no longer topped up on the 1st.
--
-- ## What actually changes
--
-- Only `credit_refresh_monthly()`. Everything else about the design in 0012 is
-- unchanged and still correct: two buckets, free spent before paid, the ledger
-- append-only, the FOR UPDATE that stops two concurrent requests both deciding
-- they are the one to grant.
--
-- The function's whole job was "is this bucket stale, and if so reset it". The
-- staleness test compared `free_period` against the current month. Now the test
-- is simply whether a grant has ever happened - `free_period IS NULL` - so the
-- first touch of a new account grants, and no touch after that ever does.
--
-- ## Why the name is left alone
--
-- `credit_refresh_monthly` no longer refreshes and is not monthly, which is a
-- poor name for what it does. Renaming it means changing the caller in
-- credit_balance() and credit_spend() in the same breath, and a rename inside a
-- migration is the kind of change that looks trivial and takes a production
-- outage to discover. The comment below carries the truth; the name carries the
-- history.
--
-- ## Existing accounts
--
-- Every account that has ever spent or been granted has a non-NULL
-- `free_period`, so all of them stop being refilled from this migration
-- forward, keeping whatever balance they currently hold. Nobody loses credits
-- and nobody gains any. Accounts that have never been touched still have NULL
-- and receive their one grant when they first act.
--
-- No backfill, and deliberately no grant here: writing ledger rows dated to a
-- deploy rather than to real activity is the thing 0012's header warns against,
-- and it is just as wrong in this direction.
-- =============================================================================

COMMENT ON COLUMN users.free_credits IS
    'Free allowance remaining. Granted once, for the life of the account, and never topped up. Was monthly until migration 0014.';

COMMENT ON COLUMN users.free_period IS
    'The month the one-time free grant was made in. Since 0014 its only meaning is NULL vs NOT NULL: NULL means the grant has never happened. Retained as a DATE rather than a boolean so the grant date stays auditable.';


CREATE OR REPLACE FUNCTION credit_refresh_monthly(
    p_user_id UUID,
    p_monthly INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_period  DATE;
    v_now     DATE := date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata'))::date;
BEGIN
    -- FOR UPDATE for the same reason as before: two requests arriving together
    -- on a brand-new account must not both decide they are the one to grant.
    SELECT free_period
      INTO v_period
      FROM users
     WHERE id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- The grant has already happened. This is now the path taken by every
    -- request an account will ever make after its first, forever - where it
    -- used to be "every request except the first of each month".
    IF v_period IS NOT NULL THEN
        RETURN;
    END IF;

    -- Nothing to grant. Recorded as a period anyway, so an account on a role
    -- with a zero allowance is not re-examined on every single request.
    IF p_monthly <= 0 THEN
        UPDATE users SET free_period = v_now WHERE id = p_user_id;
        RETURN;
    END IF;

    UPDATE users
       SET free_credits = p_monthly,
           free_period  = v_now
     WHERE id = p_user_id;

    INSERT INTO credit_ledger (user_id, kind, bucket, delta, balance_after, action, reason, reference)
    VALUES (
        p_user_id,
        'MONTHLY_GRANT',
        'FREE',
        p_monthly,
        p_monthly,
        'lifetime_grant',
        'One-time free allowance',
        -- Unique per user rather than per user and month: there is only ever
        -- one of these now, and the uniqueness is what makes a double grant
        -- impossible even if two callers somehow get past the row lock.
        'grant:lifetime:' || p_user_id::text
    )
    ON CONFLICT (reference) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION credit_refresh_monthly(UUID, INTEGER) IS
    'Grants the one-time free allowance on an account''s first touch. Despite the name it neither refreshes nor is monthly - see migration 0014. The name is retained because its callers are inside credit_balance() and credit_spend().';

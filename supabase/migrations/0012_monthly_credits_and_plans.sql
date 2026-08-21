-- =============================================================================
-- 0012 — A monthly allowance, one credit per question, and sellable plans
--
-- Three changes, and the first one is the reason the other two are possible.
--
-- ## 1. The free allowance becomes monthly
--
-- It was 5 credits a day, reset at midnight. It becomes 30 a month, reset on
-- the 1st. The wallet's two-bucket design does not change at all — free
-- credits still expire, purchased ones still do not, and spending still draws
-- down free first. Only the *period* changes.
--
-- ### The timezone is the part that is easy to get wrong
--
-- Every user of this product is in India. `date_trunc('month', NOW())` computes
-- the boundary in UTC, and Asia/Kolkata is UTC+5:30 — so the "1st of the month"
-- in UTC arrives at 05:30 IST on the 1st, and, worse, a user acting at 23:00
-- IST on the 31st is still in the *previous* UTC month for another 5.5 hours.
-- Getting this wrong does not throw; it silently grants a month's credits at
-- the wrong moment, forever. Every date in this file is therefore computed
-- `AT TIME ZONE 'Asia/Kolkata'`.
--
-- ## 2. Every question costs one credit
--
-- The cost table lives in TypeScript (src/credits/credits.service.ts) because
-- it is product pricing rather than schema. Nothing here enforces a price. This
-- migration only makes the allowance that pays for it monthly.
--
-- ## 3. Plans become data, not code
--
-- `credit_plans` holds what the admin creates and what the pricing page renders.
-- A plan is never hard-deleted: an order references the plan it was bought
-- under, and two years from now that row still has to explain what somebody
-- paid for. Archiving hides it from the pricing page and leaves history intact.
--
-- ## What this migration deliberately does NOT do
--
-- It does not backfill anyone's balance. Existing accounts have a stale period,
-- which `credit_refresh_monthly()` reads as "needs a top-up" and fills on their
-- next action — through the same idempotent path as everyone else. Granting
-- here would write ledger rows dated to the deploy rather than to real activity,
-- and the ledger's whole value is that its dates mean something.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- The new period column, and the new ledger kinds
-- -----------------------------------------------------------------------------

-- The first day of the month (in IST) that `free_credits` belongs to. Replaces
-- `free_credits_date`, which held a day. The old column is left in place rather
-- than dropped: it is a bookkeeping cache, nothing reads it after this
-- migration, and keeping it means a rollback to the previous release still
-- finds the column it expects.
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_period DATE;

COMMENT ON COLUMN users.free_period IS
    'First day (Asia/Kolkata) of the month free_credits belongs to. Older than the current month means the bucket is stale and is refilled on next touch.';
COMMENT ON COLUMN users.free_credits_date IS
    'SUPERSEDED by free_period in migration 0012. No longer read or written; retained so a rollback still finds the column.';
COMMENT ON COLUMN users.free_credits IS
    'Free allowance remaining this month. Reset — not incremented — on the 1st. See credit_refresh_monthly().';

-- ADD VALUE cannot be used in the same transaction that adds it, but a function
-- body is not resolved until it runs, so the definitions below are fine.
ALTER TYPE credit_entry_kind ADD VALUE IF NOT EXISTS 'MONTHLY_GRANT';
ALTER TYPE credit_entry_kind ADD VALUE IF NOT EXISTS 'REFERRAL';
ALTER TYPE credit_entry_kind ADD VALUE IF NOT EXISTS 'DEDUCTION';


-- -----------------------------------------------------------------------------
-- credit_plans
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_plans (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Stable identifier used in order rows and analytics. Never reused, even
    -- after a plan is archived, or two different prices share a name in the
    -- historical record.
    code          VARCHAR(40) NOT NULL UNIQUE,
    name          VARCHAR(80) NOT NULL,
    description   TEXT,

    credits       INTEGER NOT NULL CHECK (credits > 0),

    -- Integer paise, matching Razorpay in both directions. base + tax = total,
    -- enforced, so an invoice can never fail to add up. See migration 0010.
    base_paise    INTEGER NOT NULL CHECK (base_paise > 0),
    tax_rate_bps  INTEGER NOT NULL DEFAULT 1800,
    tax_paise     INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
    price_paise   INTEGER NOT NULL CHECK (price_paise > 0),
    currency      CHAR(3) NOT NULL DEFAULT 'INR',

    -- "Most popular", "Best value". Purely presentational.
    badge         VARCHAR(30),
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    archived_at   TIMESTAMPTZ,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT credit_plans_amount_adds_up CHECK (base_paise + tax_paise = price_paise)
);

-- The pricing page's query, exactly: live plans in display order.
CREATE INDEX IF NOT EXISTS idx_credit_plans_live
    ON credit_plans (sort_order, price_paise) WHERE is_active AND archived_at IS NULL;

DROP TRIGGER IF EXISTS trg_credit_plans_updated_at ON credit_plans;
CREATE TRIGGER trg_credit_plans_updated_at
    BEFORE UPDATE ON credit_plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE credit_plans IS
    'Purchasable credit packs, managed from the admin panel. Archive rather than delete - orders reference the plan they were bought under.';

-- Link an order back to the plan it was bought under. Nullable, because an
-- order can exist for a plan that was later archived, and SET NULL on delete
-- would lose the connection entirely.
ALTER TABLE credit_orders ADD COLUMN IF NOT EXISTS plan_id UUID;

DO $$ BEGIN
    ALTER TABLE credit_orders ADD CONSTRAINT credit_orders_plan_fk
        FOREIGN KEY (plan_id) REFERENCES credit_plans(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- Three starting plans, priced so the per-credit rate falls as the pack grows -
-- the only pricing shape that makes a larger pack feel like a better deal.
-- 18% GST is included in the displayed price, which is what Indian consumers
-- expect to see.
INSERT INTO credit_plans (code, name, description, credits, base_paise, tax_rate_bps, tax_paise, price_paise, badge, sort_order)
VALUES
  ('starter',  'Starter',  '100 questions. Good for a light month.',              100,   84746, 1800,  15254,  100000, NULL,           10),
  ('practice', 'Practice', '300 questions. The usual choice for daily research.', 300,  211864, 1800,  38136,  250000, 'Most popular', 20),
  ('chambers', 'Chambers', '1000 questions. Best rate per question.',            1000,  635593, 1800, 114407,  750000, 'Best value',   30)
ON CONFLICT (code) DO NOTHING;


-- =============================================================================
-- Credit functions, reworked for a monthly period
-- =============================================================================

-- -----------------------------------------------------------------------------
-- credit_refresh_monthly — roll the allowance over on the 1st
--
-- Replaces credit_refresh_free(). Idempotent within a month: the guard on
-- free_period means every call after the first does nothing at all.
--
-- Expiry is recorded before the top-up so the history reads honestly - "12
-- expired, 30 granted" rather than a bare "+18" that implies the advocate was
-- given eighteen credits.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_refresh_monthly(
    p_user_id UUID,
    p_monthly INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_current INTEGER;
    v_period  DATE;
    -- The current month, as the advocate experiences it. See the header.
    v_now     DATE := date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata'))::date;
BEGIN
    -- FOR UPDATE: two requests arriving at midnight on the 1st must not both
    -- decide they are the one to refill, or the ledger gets two grants.
    SELECT free_credits, free_period
      INTO v_current, v_period
      FROM users
     WHERE id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Already refreshed this month. The overwhelmingly common path.
    IF v_period IS NOT DISTINCT FROM v_now THEN
        RETURN;
    END IF;

    -- Last month's unused allowance lapses. Recorded rather than silently
    -- dropped: an advocate asking why their balance fell deserves a row saying so.
    IF v_current > 0 AND v_period IS NOT NULL THEN
        INSERT INTO credit_ledger (user_id, kind, bucket, delta, balance_after, action, reason, reference)
        VALUES (
            p_user_id, 'EXPIRY', 'FREE', -v_current, 0, 'monthly_rollover',
            format('%s unused free credit(s) from %s expired', v_current, to_char(v_period, 'FMMonth YYYY')),
            format('expiry:%s:%s', p_user_id, to_char(v_period, 'YYYY-MM'))
        )
        ON CONFLICT (reference) DO NOTHING;
    END IF;

    UPDATE users
       SET free_credits = p_monthly,
           free_period  = v_now
     WHERE id = p_user_id;

    IF p_monthly > 0 THEN
        INSERT INTO credit_ledger (user_id, kind, bucket, delta, balance_after, action, reason, reference)
        VALUES (
            p_user_id, 'MONTHLY_GRANT', 'FREE', p_monthly, p_monthly, 'monthly_allowance',
            format('Free monthly allowance for %s', to_char(v_now, 'FMMonth YYYY')),
            format('monthly:%s:%s', p_user_id, to_char(v_now, 'YYYY-MM'))
        )
        ON CONFLICT (reference) DO NOTHING;
    END IF;
END;
$$;


-- -----------------------------------------------------------------------------
-- credit_balance — refresh, then read, in one round trip
--
-- Recreated rather than replaced because the parameter is renamed, and
-- CREATE OR REPLACE refuses to change an input parameter's name.
--
-- The two statements must stay in plpgsql: a CTE calling the refresh beside a
-- SELECT on `users` reads a snapshot older than the refresh and reports the
-- balance before the top-up. That bug shipped once already - see migration 0011.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS credit_balance(UUID, INTEGER);

CREATE FUNCTION credit_balance(
    p_user_id UUID,
    p_monthly INTEGER
)
RETURNS TABLE (
    free_credits INTEGER,
    paid_credits INTEGER
)
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM credit_refresh_monthly(p_user_id, p_monthly);

    RETURN QUERY
        SELECT u.free_credits, u.paid_credits
          FROM users u
         WHERE u.id = p_user_id;
END;
$$;


-- -----------------------------------------------------------------------------
-- credit_spend — unchanged in behaviour, monthly in period
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS credit_spend(UUID, INTEGER, VARCHAR, VARCHAR, INTEGER);

CREATE FUNCTION credit_spend(
    p_user_id   UUID,
    p_cost      INTEGER,
    p_action    VARCHAR,
    p_reference VARCHAR,
    p_monthly   INTEGER
)
RETURNS TABLE (
    allowed       BOOLEAN,
    charged       INTEGER,
    free_left     INTEGER,
    paid_left     INTEGER,
    from_free     INTEGER,
    from_paid     INTEGER,
    already_spent BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_free      INTEGER;
    v_paid      INTEGER;
    v_from_free INTEGER;
    v_from_paid INTEGER;
    v_existing  INTEGER;
BEGIN
    -- Replay check first, before anything is locked or moved. Matched against
    -- the two exact suffixes rather than with LIKE, which would treat '%' or
    -- '_' inside a reference as a wildcard.
    IF p_reference IS NOT NULL THEN
        SELECT COUNT(*) INTO v_existing
          FROM credit_ledger
         WHERE reference IN (p_reference || ':free', p_reference || ':paid')
           AND kind = 'SPEND';

        IF v_existing > 0 THEN
            SELECT u.free_credits, u.paid_credits INTO v_free, v_paid
              FROM users u WHERE u.id = p_user_id;
            RETURN QUERY SELECT TRUE, 0, COALESCE(v_free, 0), COALESCE(v_paid, 0), 0, 0, TRUE;
            RETURN;
        END IF;
    END IF;

    PERFORM credit_refresh_monthly(p_user_id, p_monthly);

    SELECT u.free_credits, u.paid_credits
      INTO v_free, v_paid
      FROM users u
     WHERE u.id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, 0, 0, 0, 0, FALSE;
        RETURN;
    END IF;

    IF v_free + v_paid < p_cost THEN
        RETURN QUERY SELECT FALSE, 0, v_free, v_paid, 0, 0, FALSE;
        RETURN;
    END IF;

    -- Free first, so a purchase is never burned while an allowance expires
    -- beside it.
    v_from_free := LEAST(v_free, p_cost);
    v_from_paid := p_cost - v_from_free;

    UPDATE users
       SET free_credits = free_credits - v_from_free,
           paid_credits = paid_credits - v_from_paid
     WHERE id = p_user_id;

    IF v_from_free > 0 THEN
        INSERT INTO credit_ledger (user_id, kind, bucket, delta, balance_after, action, reason, reference)
        VALUES (p_user_id, 'SPEND', 'FREE', -v_from_free, v_free - v_from_free, p_action,
                format('%s (%s free credit(s))', p_action, v_from_free),
                p_reference || ':free');
    END IF;

    IF v_from_paid > 0 THEN
        INSERT INTO credit_ledger (user_id, kind, bucket, delta, balance_after, action, reason, reference)
        VALUES (p_user_id, 'SPEND', 'PAID', -v_from_paid, v_paid - v_from_paid, p_action,
                format('%s (%s paid credit(s))', p_action, v_from_paid),
                p_reference || ':paid');
    END IF;

    RETURN QUERY SELECT TRUE, p_cost, v_free - v_from_free, v_paid - v_from_paid,
                        v_from_free, v_from_paid, FALSE;
END;
$$;


-- -----------------------------------------------------------------------------
-- credit_deduct — take credits back
--
-- The counterpart to credit_grant, for an administrator correcting a mistake or
-- clawing back a refunded purchase. Draws from the paid bucket first, which is
-- the opposite of a spend and deliberately so: deducting from a free allowance
-- that expires in a few days is a punishment the advocate barely feels, while
-- the credits actually worth reclaiming are the durable ones.
--
-- Floors at zero rather than failing. A deduction larger than the balance means
-- somebody has already spent what is being reclaimed, and refusing the whole
-- operation would leave the account in a state the administrator cannot correct.
-- The ledger records what was actually taken.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_deduct(
    p_user_id   UUID,
    p_amount    INTEGER,
    p_reason    TEXT,
    p_reference VARCHAR
)
RETURNS TABLE (
    applied   BOOLEAN,
    deducted  INTEGER,
    free_left INTEGER,
    paid_left INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_free      INTEGER;
    v_paid      INTEGER;
    v_from_paid INTEGER;
    v_from_free INTEGER;
BEGIN
    IF p_amount <= 0 THEN
        SELECT u.free_credits, u.paid_credits INTO v_free, v_paid FROM users u WHERE u.id = p_user_id;
        RETURN QUERY SELECT FALSE, 0, COALESCE(v_free, 0), COALESCE(v_paid, 0);
        RETURN;
    END IF;

    IF p_reference IS NOT NULL AND EXISTS (
        SELECT 1 FROM credit_ledger WHERE reference IN (p_reference || ':free', p_reference || ':paid')
    ) THEN
        SELECT u.free_credits, u.paid_credits INTO v_free, v_paid FROM users u WHERE u.id = p_user_id;
        RETURN QUERY SELECT FALSE, 0, COALESCE(v_free, 0), COALESCE(v_paid, 0);
        RETURN;
    END IF;

    SELECT u.free_credits, u.paid_credits
      INTO v_free, v_paid
      FROM users u
     WHERE u.id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, 0, 0;
        RETURN;
    END IF;

    v_from_paid := LEAST(v_paid, p_amount);
    v_from_free := LEAST(v_free, p_amount - v_from_paid);

    IF v_from_paid + v_from_free = 0 THEN
        RETURN QUERY SELECT FALSE, 0, v_free, v_paid;
        RETURN;
    END IF;

    UPDATE users
       SET paid_credits = paid_credits - v_from_paid,
           free_credits = free_credits - v_from_free
     WHERE id = p_user_id;

    IF v_from_paid > 0 THEN
        INSERT INTO credit_ledger (user_id, kind, bucket, delta, balance_after, action, reason, reference)
        VALUES (p_user_id, 'DEDUCTION', 'PAID', -v_from_paid, v_paid - v_from_paid,
                'admin_deduct', p_reason, p_reference || ':paid');
    END IF;

    IF v_from_free > 0 THEN
        INSERT INTO credit_ledger (user_id, kind, bucket, delta, balance_after, action, reason, reference)
        VALUES (p_user_id, 'DEDUCTION', 'FREE', -v_from_free, v_free - v_from_free,
                'admin_deduct', p_reason, p_reference || ':free');
    END IF;

    RETURN QUERY SELECT TRUE, v_from_paid + v_from_free,
                        v_free - v_from_free, v_paid - v_from_paid;
END;
$$;


-- -----------------------------------------------------------------------------
-- The old daily function is retired.
--
-- Dropped rather than left in place: it writes DAILY_GRANT rows against
-- free_credits_date, and a caller that reached it after this migration would
-- quietly reinstate the daily allowance alongside the monthly one. A missing
-- function is a loud error; a working one that does the wrong thing is not.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS credit_refresh_free(UUID, INTEGER);


-- =============================================================================
-- Row level security for the new table
-- =============================================================================
ALTER TABLE credit_plans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    DROP POLICY IF EXISTS credit_plans_service_all ON credit_plans;
    CREATE POLICY credit_plans_service_all ON credit_plans
        FOR ALL TO service_role USING (true) WITH CHECK (true);
END $$;

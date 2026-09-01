-- =============================================================================
-- 0015 — a price list the operator owns
--
-- Until now `credit_orders.pack_code` was a free-text column referencing
-- nothing: the packs themselves lived only in whatever the checkout screen
-- happened to hard-code. That is workable exactly until the first price change,
-- at which point the code that charged and the code that displayed disagree and
-- the only record of what a pack used to cost is the orders that bought it.
--
-- ## Why this is a table and not a setting
--
-- `SettingsService.set()` refuses every write, and that rule is right: it exists
-- because operational settings saved in the panel were silently overriding the
-- environment, or being saved and never read at all. This is not configuration.
-- A price list is domain data - it has identity, history, an active flag and
-- rows an invoice points at - and the reason the panel may write it is the same
-- reason the panel may grant credits: it is a business action, not a deployment
-- decision.
--
-- ## What the schema commits to
--
--   - **Price is integer paise**, like `credit_orders`. Rupees as NUMERIC means
--     a division by 100 at every boundary and a rounding error in somebody's
--     money the first time one is missed.
--   - **A pack is never deleted, only deactivated.** `credit_orders.pack_code`
--     is what an invoice and a dispute resolve against months later, so a code
--     that stops resolving is a hole in the financial record. `is_active`
--     controls whether it can be *bought*, which is the thing an operator
--     actually means when they say "remove this pack".
--   - **Tax is not stored here.** The GST rate applies at order time from
--     `GST_RATE_BPS` and is broken out onto the order, because the rate can
--     change between a pack being listed and an order being placed, and the
--     invoice has to carry the rate that was actually charged. Storing it on
--     the pack would freeze it at the wrong moment.
--   - **`billing_period` is descriptive, not mechanical.** A pack marked
--     MONTHLY is a bundle sized for a month and sold as a one-time purchase.
--     Nothing here auto-renews and nothing holds a mandate - that would be
--     Razorpay's Subscriptions API, a different integration with a different
--     lifecycle. The column exists so the panel and the pricing page can say
--     "monthly" honestly, and so that adding real recurring billing later has
--     somewhere to hang `razorpay_plan_id` rather than needing a new table.
-- =============================================================================


-- How the pack is described to the advocate. Purely a label on a one-time
-- purchase; see the header on why nothing here recurs.
DO $$ BEGIN
    CREATE TYPE credit_pack_period AS ENUM (
        'ONE_TIME',   -- a top-up, bought whenever it runs out
        'MONTHLY',    -- a bundle sized for a month
        'ANNUAL'      -- a bundle sized for a year
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


CREATE TABLE IF NOT EXISTS credit_packs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Stable, operator-chosen, and what `credit_orders.pack_code` records. It
    -- is the join between an order and what that order bought, so it is
    -- immutable once orders exist - the panel refuses to change it.
    code           VARCHAR(40) NOT NULL UNIQUE,

    name           VARCHAR(80) NOT NULL,
    description    TEXT,

    credits        INTEGER NOT NULL CHECK (credits > 0),
    price_paise    INTEGER NOT NULL CHECK (price_paise > 0),
    currency       CHAR(3) NOT NULL DEFAULT 'INR',

    billing_period credit_pack_period NOT NULL DEFAULT 'ONE_TIME',

    -- Buyable. Deactivating retires a pack without breaking the orders that
    -- reference it - see the header.
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,

    -- Display order on the pricing screen. Operators think in "put this one
    -- first", not in ids or prices.
    sort_order     INTEGER NOT NULL DEFAULT 0,

    -- One pack may be marked as the suggested one. Enforced as at most one by
    -- the partial unique index below rather than by trusting the panel.
    is_featured    BOOLEAN NOT NULL DEFAULT FALSE,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Razorpay Plan id, for the day recurring billing is wired. Unused today
    -- and nullable; named now so the column does not have to be added in the
    -- same change that has to get the mandate flow right.
    razorpay_plan_id VARCHAR(64)
);

-- The pricing screen's query: active packs, in the operator's order.
CREATE INDEX IF NOT EXISTS idx_credit_packs_listing
    ON credit_packs (is_active, sort_order, price_paise);

-- At most one featured pack. A UI that lets two be ticked is a UI bug; a
-- database that allows it is a report that cannot be trusted.
--
-- Indexed on the column rather than on a constant: an index expression that
-- references no column is not something Postgres reliably accepts, and the
-- partial predicate is what makes this "at most one TRUE" either way.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_packs_one_featured
    ON credit_packs (is_featured) WHERE is_featured;

DROP TRIGGER IF EXISTS trg_credit_packs_updated_at ON credit_packs;
CREATE TRIGGER trg_credit_packs_updated_at
    BEFORE UPDATE ON credit_packs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS on, like every other table. The backend connects as owner and bypasses
-- it; the point is that Supabase also exposes this over PostgREST with the anon
-- key, which ships in browser code. See migration 0005.
ALTER TABLE credit_packs ENABLE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- Seed
--
-- Three packs, so the pricing screen is not empty on a fresh deployment and the
-- operator has something to edit rather than a blank form. Priced off the
-- costs the product actually charges - a search is 2 credits, a case status 1 -
-- so 100 credits is roughly fifty searches.
--
-- ON CONFLICT DO NOTHING: re-running the migration must not overwrite prices an
-- operator has since changed. This seeds an empty table and is inert on a
-- populated one.
-- -----------------------------------------------------------------------------
INSERT INTO credit_packs (code, name, description, credits, price_paise, billing_period, sort_order, is_featured)
VALUES
    ('starter-100',  'Starter',  'About 50 searches.',            100,   49900, 'ONE_TIME', 10, FALSE),
    ('monthly-300',  'Monthly',  'About 150 searches a month.',   300,  129900, 'MONTHLY',  20, TRUE),
    ('bulk-1000',    'Chambers', 'About 500 searches.',          1000,  399900, 'ONE_TIME', 30, FALSE)
ON CONFLICT (code) DO NOTHING;


COMMENT ON TABLE credit_packs IS
    'What credits can be bought for. Managed from the admin panel; deactivated rather than deleted so credit_orders.pack_code keeps resolving.';

COMMENT ON COLUMN credit_packs.billing_period IS
    'Descriptive only. Every pack is a one-time purchase; MONTHLY means "a bundle sized for a month", not an auto-renewing subscription. See the migration header.';

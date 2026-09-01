-- =============================================================================
-- 0015 — how a plan is described
--
-- `credit_plans` (migration 0012) already models purchasable packs, correctly:
-- integer paise, tax broken out and constrained to add up, archive rather than
-- delete, and `credit_orders.plan_id` pointing back at what an order bought.
-- Nothing about that needed replacing.
--
-- What it could not express is the *shape* of a pack. An operator selling a
-- bundle sized for a month had only `badge` to say so, which is presentational
-- text with no meaning to anything reading the table - so "is this a monthly
-- plan" was answerable only by reading the badge and hoping.
--
-- ## This is descriptive, not mechanical
--
-- A MONTHLY plan is a bundle sized for a month, sold as a one-time purchase.
-- Nothing here auto-renews and nothing holds a mandate: that is Razorpay's
-- Subscriptions API, a different integration with plans, mandates, a
-- `subscription.charged` lifecycle and cancellation states, none of which this
-- schema models. The column exists so the pricing screen can say "monthly"
-- honestly, and so `razorpay_plan_id` has somewhere to live on the day real
-- recurring billing is wired - rather than that change needing a new table.
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE credit_plan_period AS ENUM (
        'ONE_TIME',   -- a top-up, bought whenever it runs out
        'MONTHLY',    -- a bundle sized for a month
        'ANNUAL'      -- a bundle sized for a year
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE credit_plans
    ADD COLUMN IF NOT EXISTS billing_period credit_plan_period NOT NULL DEFAULT 'ONE_TIME';

-- Unused today; see the header. Named now so the migration that wires recurring
-- billing is about the mandate flow and not about a column.
ALTER TABLE credit_plans
    ADD COLUMN IF NOT EXISTS razorpay_plan_id VARCHAR(64);

COMMENT ON COLUMN credit_plans.billing_period IS
    'Descriptive only. Every plan is a one-time purchase; MONTHLY means "a bundle sized for a month", not an auto-renewing subscription. See migration 0015.';

-- The plan seeded in 0012 as the everyday choice is the one an operator means
-- by "the monthly package". Named as such rather than left to the badge.
UPDATE credit_plans
   SET billing_period = 'MONTHLY'
 WHERE code = 'practice' AND billing_period = 'ONE_TIME';

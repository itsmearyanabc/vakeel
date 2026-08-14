-- ---------------------------------------------------------------------------
-- 0009 — Onboarding profile, and Bar Council ID as the identity
--
-- ## What changed and why
--
-- Onboarding now collects Name, Bar Council ID, City and State before an
-- advocate can ask anything. `city` is the only genuinely new column;
-- `bar_council_state` already existed and carries the state.
--
-- ## The identity change
--
-- The account used to BE the phone number: `users.phone_number` is UNIQUE and
-- every lookup started there. That makes a second WhatsApp number a second
-- account with its own daily credits, which is the exact behaviour the credit
-- limit exists to prevent.
--
-- The Bar Council ID is the real identity - one per advocate, issued by a
-- authority, and already stored here as an HMAC blind index
-- (`bar_council_id_hash`, also UNIQUE) so it can be matched without decrypting.
-- The phone number becomes a channel: whichever number the advocate last used.
-- Credits, verification and history stay on the row the Bar Council ID names.
--
-- No schema change is needed for that - both UNIQUE constraints already exist
-- and the merge is handled in UserRepository.adoptPhone(). This migration only
-- adds the profile columns and the index that makes onboarding lookups cheap.
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(80);

-- Onboarding completeness is checked on every inbound message from a user who
-- has not finished it, so it must not be a sequential scan once the table is
-- large. Partial, because the only rows ever queried this way are the
-- incomplete ones.
CREATE INDEX IF NOT EXISTS idx_users_incomplete_profile
    ON users (id)
 WHERE bar_council_id_hash IS NULL;

COMMENT ON COLUMN users.city IS
    'Practice city, collected during onboarding. Free text - there is no canonical list.';

COMMENT ON COLUMN users.bar_council_state IS
    'Practice state. Also selects the advocate''s home High Court for precedent ordering.';

COMMENT ON COLUMN users.phone_number IS
    'The WhatsApp number last used by this advocate. A channel, not the identity - '
    'bar_council_id_hash is the identity. See migration 0009.';

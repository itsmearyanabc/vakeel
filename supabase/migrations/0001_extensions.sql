-- =============================================================================
-- 0001_extensions.sql
-- Extensions and shared enum types.
--
-- Run these against your Supabase project BEFORE anything else, either with
-- `npm run db:migrate` or by pasting each file into the Supabase SQL Editor
-- in filename order.
-- =============================================================================

-- gen_random_uuid(), digest() for content hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Dense vector search. Supabase ships pgvector; 0.7.0+ is required for the
-- halfvec type we use to index 3072-dimension embeddings (see 0003).
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram matching, used for fuzzy section-number and case-title lookups
-- ("sec 302 ipc", "302 IPC", "s.302").
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Case-insensitive, accent-insensitive citation matching.
CREATE EXTENSION IF NOT EXISTS unaccent;


-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

-- Advocate onboarding lifecycle.
DO $$ BEGIN
    CREATE TYPE verification_status AS ENUM (
        'PENDING',    -- registered, has not submitted bar council details
        'SUBMITTED',  -- details + ID card uploaded, awaiting review
        'VERIFIED',   -- approved, full access
        'REJECTED'    -- rejected, stays on guest quotas
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Authorization roles, per section 16 of the architecture spec.
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM (
        'GUEST_LAWYER',       -- restricted daily quota, WhatsApp only
        'VERIFIED_ADVOCATE',  -- full RAG access, higher limits
        'LEGAL_AUDITOR',      -- reviews AI responses, quality scoring
        'SUPER_ADMIN'         -- full system + audit access
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- What the user actually asked for. Drives routing and cost accounting.
DO $$ BEGIN
    CREATE TYPE query_intent AS ENUM (
        'CASE_STATUS',       -- CNR / case number lookup
        'SECTION_LOOKUP',    -- "what is section 302 IPC"
        'PRECEDENT_SEARCH',  -- natural-language case law research
        'DRAFTING_HELP',     -- notice / application drafting assistance
        'GENERAL_LEGAL',     -- general legal question, no corpus hit needed
        'SMALL_TALK',        -- greetings, thanks
        'MENU_NAVIGATION',   -- button/list replies, "menu", "help"
        'UNSUPPORTED'        -- out of scope or blocked by guardrails
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE message_direction AS ENUM ('INBOUND', 'OUTBOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE message_status AS ENUM (
        'RECEIVED', 'QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'READ', 'FAILED'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest without relying on the application.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

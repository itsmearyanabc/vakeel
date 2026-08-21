-- =============================================================================
-- 0013 — A job queue, a cache and a memory store, all in Postgres
--
-- This migration exists to remove Redis. Everything it held was either
-- ephemeral (caches, rate-limit counters, OAuth flow state) or durable state
-- that was in the wrong place (the job queue, WhatsApp conversation memory).
--
-- On a single VPS none of it needs to be distributed, and Postgres is already
-- there. What follows replaces the two pieces that genuinely needed a store:
-- the BullMQ queue, and the caches that cost money when they miss.
--
-- ## The queue, and the one hard part
--
-- Claiming is easy: `FOR UPDATE SKIP LOCKED` is the standard Postgres queue
-- pattern and two workers can never take the same row.
--
-- Per-user serialisation is the hard part, and it is not optional. An advocate
-- who fires off three messages in a row must have them handled one at a time —
-- otherwise three concurrent handlers read and write the same conversation
-- state and produce interleaved answers to a half-finished flow. BullMQ did not
-- give us this either; it was a separate Redis lock, and a job that lost the
-- lock was thrown back for a retry.
--
-- Doing it with `NOT EXISTS (... state = 'ACTIVE' ...)` alone has a race: two
-- concurrent claims both check before either commits, both see no active job
-- for that user, and both proceed. `SKIP LOCKED` does not help, because they
-- are looking at *different* rows that happen to share a lock key.
--
-- So `job_claim` takes a queue-level advisory lock for the duration of its
-- transaction, making claims sequential. That sounds expensive and is not: a
-- claim is one indexed select and one update, measured in microseconds, while
-- the *work* still runs concurrently afterwards. Serialising the cheap part to
-- make the expensive part safe is the right trade.
--
-- ## Why polling, and not LISTEN/NOTIFY
--
-- NOTIFY would remove the poll delay, and it cannot be used here: Supabase's
-- pooler on port 6543 runs in transaction mode, which cannot hold a listening
-- session. Using it would mean a second, session-mode connection on 5432 held
-- open permanently — a real cost against the free tier's connection budget, to
-- save a delay that is invisible next to a multi-second model call.
-- =============================================================================


DO $$ BEGIN
    CREATE TYPE job_state AS ENUM (
        'QUEUED',   -- waiting to be claimed
        'ACTIVE',   -- claimed, lease running
        'DONE',
        'FAILED',   -- failed, will be retried
        'DEAD'      -- out of attempts; needs a human
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


CREATE TABLE IF NOT EXISTS job_queue (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue        VARCHAR(60) NOT NULL,

    -- Idempotency. Derived from Meta's message id, so a redelivered webhook
    -- collides here instead of enqueueing the same message twice. This is the
    -- same job BullMQ's `jobId` was doing.
    dedupe_key   VARCHAR(200) UNIQUE,

    payload      JSONB NOT NULL,

    -- Jobs sharing a lock key never run concurrently. For inbound messages this
    -- is the sender's phone number: one message per advocate at a time.
    lock_key     VARCHAR(120),

    state        job_state NOT NULL DEFAULT 'QUEUED',
    attempts     SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 3,

    -- When this becomes eligible. Pushed forward on failure for backoff.
    run_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- How long the claim is good for. A worker that dies without releasing its
    -- job leaves a lease that expires, and job_reclaim_stalled() takes it back.
    lease_until  TIMESTAMPTZ,
    claimed_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    last_error   TEXT,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The claim query, exactly: eligible jobs on this queue, oldest first.
CREATE INDEX IF NOT EXISTS idx_job_queue_claimable
    ON job_queue (queue, run_at, created_at) WHERE state = 'QUEUED';

-- The serialisation guard's lookup.
CREATE INDEX IF NOT EXISTS idx_job_queue_active_lock
    ON job_queue (queue, lock_key) WHERE state = 'ACTIVE';

-- The stalled sweep.
CREATE INDEX IF NOT EXISTS idx_job_queue_lease
    ON job_queue (lease_until) WHERE state = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_job_queue_dead
    ON job_queue (created_at DESC) WHERE state = 'DEAD';

DROP TRIGGER IF EXISTS trg_job_queue_updated_at ON job_queue;
CREATE TRIGGER trg_job_queue_updated_at
    BEFORE UPDATE ON job_queue
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE job_queue IS
    'Durable job queue, replacing BullMQ (migration 0013). Claim with job_claim(); never SELECT and UPDATE by hand.';
COMMENT ON COLUMN job_queue.lock_key IS
    'Jobs sharing this value never run concurrently. Inbound WhatsApp jobs use the sender phone number.';


-- -----------------------------------------------------------------------------
-- job_enqueue — idempotent on dedupe_key
--
-- Returns the job id, whether it was inserted now or already present. A caller
-- that gets back an id for a job it did not create has been deduplicated, which
-- is success rather than failure - the message is queued either way.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_enqueue(
    p_queue        VARCHAR,
    p_payload      JSONB,
    p_dedupe_key   VARCHAR DEFAULT NULL,
    p_lock_key     VARCHAR DEFAULT NULL,
    p_max_attempts SMALLINT DEFAULT 3,
    p_delay_ms     INTEGER DEFAULT 0
)
RETURNS TABLE (job_id UUID, inserted BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
    v_id       UUID;
    v_inserted BOOLEAN := FALSE;
BEGIN
    INSERT INTO job_queue (queue, payload, dedupe_key, lock_key, max_attempts, run_at)
    VALUES (p_queue, p_payload, p_dedupe_key, p_lock_key, p_max_attempts,
            NOW() + (p_delay_ms || ' milliseconds')::interval)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
        v_inserted := TRUE;
    ELSE
        SELECT j.id INTO v_id FROM job_queue j WHERE j.dedupe_key = p_dedupe_key;
    END IF;

    RETURN QUERY SELECT v_id, v_inserted;
END;
$$;


-- -----------------------------------------------------------------------------
-- job_claim — take one job, respecting per-lock-key serialisation
--
-- Returns zero or one row. See the header for why the whole claim is serialised
-- behind an advisory lock rather than relying on SKIP LOCKED alone.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_claim(
    p_queue         VARCHAR,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS SETOF job_queue
LANGUAGE plpgsql
AS $$
DECLARE
    v_id UUID;
BEGIN
    -- Sequential claims. Held only for this transaction, which does one select
    -- and one update - the work itself happens after the claim commits and is
    -- fully concurrent.
    PERFORM pg_advisory_xact_lock(hashtext('jobclaim:' || p_queue));

    SELECT j.id INTO v_id
      FROM job_queue j
     WHERE j.queue = p_queue
       AND j.state = 'QUEUED'
       AND j.run_at <= NOW()
       -- Nothing else from the same advocate may be running. A stale lease does
       -- not count as running: the worker holding it is gone.
       AND (
             j.lock_key IS NULL
             OR NOT EXISTS (
                  SELECT 1 FROM job_queue a
                   WHERE a.queue    = j.queue
                     AND a.lock_key = j.lock_key
                     AND a.state    = 'ACTIVE'
                     AND a.lease_until > NOW()
                )
           )
     ORDER BY j.run_at, j.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF v_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
        UPDATE job_queue
           SET state       = 'ACTIVE',
               attempts    = attempts + 1,
               claimed_at  = NOW(),
               lease_until = NOW() + (p_lease_seconds || ' seconds')::interval
         WHERE id = v_id
     RETURNING *;
END;
$$;


-- -----------------------------------------------------------------------------
-- job_complete / job_fail
--
-- Failure decides between a retry and death by comparing attempts against the
-- ceiling. Backoff is exponential because most failures here are a rate-limited
-- model or a flaky court API, and hammering either makes it worse.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_complete(p_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE job_queue
       SET state = 'DONE', finished_at = NOW(), lease_until = NULL, last_error = NULL
     WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION job_fail(
    p_id           UUID,
    p_error        TEXT,
    p_base_delay_ms INTEGER DEFAULT 2000
)
RETURNS TABLE (dead BOOLEAN, attempts SMALLINT, retry_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
    v_job     job_queue;
    v_dead    BOOLEAN;
    v_delay   BIGINT;
    v_retry   TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_job FROM job_queue WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT TRUE, 0::smallint, NULL::timestamptz;
        RETURN;
    END IF;

    v_dead := v_job.attempts >= v_job.max_attempts;

    IF v_dead THEN
        UPDATE job_queue
           SET state = 'DEAD', finished_at = NOW(), lease_until = NULL, last_error = p_error
         WHERE id = p_id;

        RETURN QUERY SELECT TRUE, v_job.attempts, NULL::timestamptz;
        RETURN;
    END IF;

    -- 2s, 4s, 8s... capped, so a poison job cannot push its own retry a day out.
    v_delay := LEAST(p_base_delay_ms::bigint * (2 ^ (v_job.attempts - 1))::bigint, 300000);
    v_retry := NOW() + (v_delay || ' milliseconds')::interval;

    UPDATE job_queue
       SET state       = 'QUEUED',
           lease_until = NULL,
           run_at      = v_retry,
           last_error  = p_error
     WHERE id = p_id;

    RETURN QUERY SELECT FALSE, v_job.attempts, v_retry;
END;
$$;


-- -----------------------------------------------------------------------------
-- job_reclaim_stalled — recover jobs whose worker died
--
-- A job is stalled when the process holding it went away without finishing:
-- SIGKILL, an OOM, a container replaced mid-deploy. Its lease expires and this
-- puts it back. Without it, a crash silently loses every message in flight.
--
-- Returns them to QUEUED rather than failing them - the attempt was made and is
-- already counted, and the advocate is still waiting for an answer.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_reclaim_stalled(p_queue VARCHAR)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    WITH reclaimed AS (
        UPDATE job_queue
           SET state       = CASE WHEN attempts >= max_attempts THEN 'DEAD'::job_state
                                  ELSE 'QUEUED'::job_state END,
               lease_until = NULL,
               last_error  = 'Worker stopped without finishing the job'
         WHERE queue = p_queue
           AND state = 'ACTIVE'
           AND lease_until < NOW()
     RETURNING id
    )
    SELECT COUNT(*)::int INTO v_count FROM reclaimed;

    RETURN v_count;
END;
$$;


-- -----------------------------------------------------------------------------
-- job_stats — what the health endpoint and admin panel report
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_stats(p_queue VARCHAR)
RETURNS TABLE (waiting INTEGER, active INTEGER, dead INTEGER, done_24h INTEGER, oldest_wait_seconds INTEGER)
LANGUAGE sql
AS $$
    SELECT
      COUNT(*) FILTER (WHERE state = 'QUEUED')::int                                    AS waiting,
      COUNT(*) FILTER (WHERE state = 'ACTIVE')::int                                    AS active,
      COUNT(*) FILTER (WHERE state = 'DEAD')::int                                      AS dead,
      COUNT(*) FILTER (WHERE state = 'DONE' AND finished_at > NOW() - INTERVAL '24 hours')::int AS done_24h,
      -- FILTER belongs on the aggregate, not on EXTRACT: EXTRACT is a plain
      -- function and Postgres rejects FILTER on one outright.
      COALESCE(
        EXTRACT(EPOCH FROM (NOW() - MIN(run_at) FILTER (WHERE state = 'QUEUED'))), 0
      )::int                                                                           AS oldest_wait_seconds
    FROM job_queue
    WHERE queue = p_queue;
$$;


-- -----------------------------------------------------------------------------
-- job_purge — housekeeping
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_purge()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    WITH gone AS (
        DELETE FROM job_queue
         -- Completed work is kept an hour, which is long enough to debug a
         -- complaint that just came in and short enough that the table stays
         -- small. Dead jobs are kept a fortnight because somebody has to look
         -- at them.
         WHERE (state = 'DONE' AND finished_at < NOW() - INTERVAL '1 hour')
            OR (state = 'DEAD' AND finished_at < NOW() - INTERVAL '14 days')
     RETURNING id
    )
    SELECT COUNT(*)::int INTO v_count FROM gone;

    RETURN v_count;
END;
$$;


-- =============================================================================
-- cache_entries
--
-- Only for caches whose misses cost money or a lot of latency: Indian Kanoon is
-- billed per query, and embeddings are billed per token. Everything else stays
-- in process memory, where it belongs.
--
-- The point of putting these in Postgres rather than memory is deploys. An
-- in-process cache is empty after every restart, so a release would re-buy
-- every search an advocate had already paid for that day.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cache_entries (
    key        VARCHAR(255) PRIMARY KEY,
    value      JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cache_expiry ON cache_entries (expires_at);

COMMENT ON TABLE cache_entries IS
    'Durable cache for responses that cost money to fetch again (Kanoon, embeddings). Ephemeral caches live in process memory.';


-- =============================================================================
-- whatsapp_memory
--
-- Conversation memory for the WhatsApp side, which had no durable home and kept
-- it in Redis. The web side already reads history from chat_messages; this gives
-- WhatsApp the same property, so a restart no longer wipes what the advocate was
-- in the middle of discussing.
--
-- `expires_at` is data minimisation under the DPDP Act as much as housekeeping:
-- the retention sweep deletes it, and nothing keeps an advocate's questions
-- longer than the conversation they belong to.
-- =============================================================================
CREATE TABLE IF NOT EXISTS whatsapp_memory (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- [{ role: 'user'|'assistant', content: string }], oldest first, already
    -- trimmed to MEMORY_MAX_TURNS by the application.
    turns      JSONB NOT NULL DEFAULT '[]'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_memory_expiry ON whatsapp_memory (expires_at);


-- =============================================================================
-- Row level security
-- =============================================================================
ALTER TABLE job_queue       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cache_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_memory ENABLE ROW LEVEL SECURITY;

ALTER TABLE whatsapp_memory FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['job_queue', 'cache_entries', 'whatsapp_memory']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_service_all', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
            t || '_service_all', t
        );
    END LOOP;
END $$;

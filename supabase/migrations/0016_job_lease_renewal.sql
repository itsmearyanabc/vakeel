-- -----------------------------------------------------------------------------
-- 0016 — job_touch: renewing a lease while the work is still running
--
-- ## The hazard this closes
--
-- Per-advocate serialisation is the invariant that stops two messages from the
-- same number racing each other through one conversation row. `job_claim`
-- enforces it by refusing to hand out a job whose `lock_key` already has a live
-- lease - and "live" is decided by the clock, not by whether the worker is
-- actually alive. A stale lease deliberately does not count, because that is
-- how a crashed worker's job gets recovered instead of blocking the advocate
-- forever.
--
-- Which means the invariant holds only while the lease outlasts the work. It
-- does not. One inbound message makes at least two provider calls, and each can
-- take LLM_TIMEOUT_MS x (1 + LLM_MAX_RETRIES) - 45s x 3 on the defaults, so a
-- single classify can spend longer than the whole 120-second lease before the
-- answer has even started generating.
--
-- What follows is quiet and bad. The sweep sees an expired lease, marks the job
-- DEAD (max_attempts is 1 for inbound messages), and frees the lock key. The
-- worker that is still working on it has no idea. The advocate's next message
-- is now claimable and runs *concurrently* with the first, both writing the
-- same `conversation_states` row - so the paging offset from one message can
-- land on top of the state from another, and the session the advocate sees is
-- whichever write finished last. Then the original worker finishes and calls
-- job_complete on the DEAD row, flipping it to DONE, so the incident does not
-- even appear in the queue stats.
--
-- ## Why renewal rather than a longer lease
--
-- A longer lease trades this race for a worse one. Recovery time is the same
-- number: raise it to ten minutes and an advocate whose message was in flight
-- when a deploy landed waits ten minutes before their next message can be
-- claimed, because the stale lock is still holding. The lease has to be short
-- to recover quickly and long to cover the work, and those cannot both be
-- satisfied by one constant.
--
-- Renewal separates them. The lease stays short, so a dead worker is detected
-- quickly; a live worker keeps saying so, so long work is never mistaken for a
-- crash. This is the standard arrangement and there is no reason to invent
-- another one.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION job_touch(
    p_id            UUID,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_updated INTEGER;
BEGIN
    -- Only an ACTIVE job may be renewed. A job already reclaimed by the sweep,
    -- completed, or failed must not be dragged back into ACTIVE by a heartbeat
    -- that was in flight when its state changed.
    UPDATE job_queue
       SET lease_until = NOW() + (p_lease_seconds || ' seconds')::interval
     WHERE id = p_id
       AND state = 'ACTIVE';

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    -- FALSE tells the caller its claim is gone: the sweep decided this worker
    -- was dead and the lock key has been handed on. Worth logging loudly,
    -- because it means a second message from the same advocate may now be
    -- running alongside this one.
    RETURN v_updated > 0;
END;
$$;

COMMENT ON FUNCTION job_touch(UUID, INTEGER) IS
    'Extend an ACTIVE job''s lease while it is still being worked on. Returns FALSE if the claim was already lost. See migration 0016.';

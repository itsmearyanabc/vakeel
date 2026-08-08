-- =============================================================================
-- 0004_search_functions.sql
-- Hybrid retrieval (dense + lexical, fused with RRF) and the guardrail lookups.
--
-- Keeping fusion in SQL rather than in Node matters: we would otherwise ship
-- 100 rows of chunk text over the wire just to throw 95 of them away.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- hybrid_search_judgments
--
-- Runs two independent retrievers and fuses them with Reciprocal Rank Fusion:
--
--     score(d) = SUM over lists L of  1 / (k + rank_L(d))
--
-- RRF is used instead of a weighted sum of raw scores because cosine distance
-- and ts_rank are not on comparable scales - normalising them requires
-- corpus-wide statistics that shift every time you ingest. RRF only needs the
-- ranks, so it is stable as the corpus grows. k (default 60) damps the
-- influence of the very top ranks; larger k flattens the curve.
--
-- IMPORTANT: the ORDER BY below must keep the exact `embedding::halfvec(3072)`
-- form or the HNSW index from 0003 is not used. See that file's header.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hybrid_search_judgments(
    p_query_embedding vector(3072),
    p_query_text      TEXT,
    p_dense_k         INTEGER DEFAULT 50,
    p_sparse_k        INTEGER DEFAULT 50,
    p_rrf_k           INTEGER DEFAULT 60,
    p_final_k         INTEGER DEFAULT 5,
    p_court_type      TEXT    DEFAULT NULL,
    p_date_from       DATE    DEFAULT NULL,
    p_date_to         DATE    DEFAULT NULL,
    p_sections        TEXT[]  DEFAULT NULL
)
RETURNS TABLE (
    chunk_id         UUID,
    judgment_id      UUID,
    content          TEXT,
    para_number      INTEGER,
    case_title       TEXT,
    neutral_citation VARCHAR(120),
    reporter_citations TEXT[],
    court_name       VARCHAR(200),
    judgment_date    DATE,
    ratio_decidendi  TEXT,
    dense_rank       INTEGER,
    sparse_rank      INTEGER,
    score            DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
WITH
-- Shared filter. Applied inside both retrievers so each still returns a full
-- k candidates after filtering, rather than filtering a fixed top-k down to
-- nothing (which is what happens if you filter after the fact).
dense AS (
    SELECT c.id,
           ROW_NUMBER() OVER (
               ORDER BY c.embedding::halfvec(3072) <=> p_query_embedding::halfvec(3072)
           )::INTEGER AS rnk
      FROM judgment_chunks c
     WHERE c.embedding IS NOT NULL
       AND (p_court_type IS NULL OR c.court_type = p_court_type)
       AND (p_date_from  IS NULL OR c.judgment_date >= p_date_from)
       AND (p_date_to    IS NULL OR c.judgment_date <= p_date_to)
       AND (p_sections   IS NULL OR c.act_sections && p_sections)
     ORDER BY c.embedding::halfvec(3072) <=> p_query_embedding::halfvec(3072)
     LIMIT p_dense_k
),
-- websearch_to_tsquery tolerates whatever an advocate types - quoted phrases,
-- OR, leading minus - without throwing the syntax errors that to_tsquery does.
sparse AS (
    SELECT c.id,
           ROW_NUMBER() OVER (
               ORDER BY ts_rank_cd(c.search_vector, q.query) DESC
           )::INTEGER AS rnk
      FROM judgment_chunks c,
           websearch_to_tsquery('english', p_query_text) AS q(query)
     WHERE c.search_vector @@ q.query
       AND (p_court_type IS NULL OR c.court_type = p_court_type)
       AND (p_date_from  IS NULL OR c.judgment_date >= p_date_from)
       AND (p_date_to    IS NULL OR c.judgment_date <= p_date_to)
       AND (p_sections   IS NULL OR c.act_sections && p_sections)
     ORDER BY ts_rank_cd(c.search_vector, q.query) DESC
     LIMIT p_sparse_k
),
fused AS (
    SELECT COALESCE(d.id, s.id) AS id,
           d.rnk AS dense_rank,
           s.rnk AS sparse_rank,
           COALESCE(1.0 / (p_rrf_k + d.rnk), 0.0)
         + COALESCE(1.0 / (p_rrf_k + s.rnk), 0.0) AS score
      FROM dense d
      FULL OUTER JOIN sparse s ON s.id = d.id
)
SELECT c.id,
       c.judgment_id,
       c.content,
       c.para_number,
       j.case_title,
       j.neutral_citation,
       j.reporter_citations,
       c.court_name,
       c.judgment_date,
       j.ratio_decidendi,
       f.dense_rank,
       f.sparse_rank,
       f.score::DOUBLE PRECISION
  FROM fused f
  JOIN judgment_chunks c ON c.id = f.id
  JOIN judgments       j ON j.id = c.judgment_id
 ORDER BY f.score DESC
 LIMIT p_final_k;
$$;


-- -----------------------------------------------------------------------------
-- search_statutes
--
-- Section lookup. Tries three strategies and returns the best match first:
--   1. exact section number (+ optional act) - "302 IPC"
--   2. full-text over title and body            - "punishment for murder"
--   3. trigram fuzzy on the section number      - "s.302", "sec-302"
--
-- Exact matches are scored above everything else so a section number never
-- loses to a body-text mention of that number.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_statutes(
    p_query_text     TEXT,
    p_section_number TEXT    DEFAULT NULL,
    p_act_code       TEXT    DEFAULT NULL,
    p_limit          INTEGER DEFAULT 5
)
RETURNS TABLE (
    id                    UUID,
    act_code              VARCHAR(20),
    act_name              VARCHAR(200),
    section_number        VARCHAR(20),
    section_title         VARCHAR(400),
    section_text          TEXT,
    punishment            TEXT,
    is_cognizable         BOOLEAN,
    is_bailable           BOOLEAN,
    is_compoundable       BOOLEAN,
    triable_by            VARCHAR(160),
    corresponding_act     VARCHAR(20),
    corresponding_section VARCHAR(20),
    match_type            TEXT,
    score                 DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
WITH candidates AS (
    -- 1. Exact section number.
    SELECT s.*, 'EXACT'::TEXT AS match_type, 1000.0::DOUBLE PRECISION AS score
      FROM statutes s
     WHERE p_section_number IS NOT NULL
       AND upper(s.section_number) = upper(p_section_number)
       AND (p_act_code IS NULL OR upper(s.act_code) = upper(p_act_code))

    UNION ALL

    -- 2. Full text.
    SELECT s.*, 'FULLTEXT'::TEXT,
           (ts_rank_cd(s.search_vector, q.query) * 10.0)::DOUBLE PRECISION
      FROM statutes s,
           websearch_to_tsquery('english', p_query_text) AS q(query)
     WHERE s.search_vector @@ q.query
       AND (p_act_code IS NULL OR upper(s.act_code) = upper(p_act_code))

    UNION ALL

    -- 3. Fuzzy section number, for typos and odd formatting.
    SELECT s.*, 'FUZZY'::TEXT,
           similarity(s.section_number, p_section_number)::DOUBLE PRECISION
      FROM statutes s
     WHERE p_section_number IS NOT NULL
       AND s.section_number % p_section_number
       AND (p_act_code IS NULL OR upper(s.act_code) = upper(p_act_code))
),
-- Same section can surface from several strategies; keep its best score.
deduped AS (
    SELECT DISTINCT ON (c.id)
           c.*
      FROM candidates c
     ORDER BY c.id, c.score DESC
)
SELECT d.id, d.act_code, d.act_name, d.section_number, d.section_title,
       d.section_text, d.punishment, d.is_cognizable, d.is_bailable,
       d.is_compoundable, d.triable_by, d.corresponding_act,
       d.corresponding_section, d.match_type, d.score
  FROM deduped d
 ORDER BY d.score DESC
 LIMIT p_limit;
$$;


-- -----------------------------------------------------------------------------
-- verify_citations
--
-- Anti-hallucination check (spec section 9.2). Given the citations the model
-- produced, return which ones actually exist in the corpus. Anything that
-- comes back `found = false` is stripped from the answer before it is sent.
--
-- Matching is deliberately loose on whitespace and case, because models
-- reformat citations ("AIR 2018 SC 1234" vs "AIR 2018 S.C. 1234"), but it never
-- does fuzzy matching on the numbers - a wrong number is a wrong case.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_citations(p_citations TEXT[])
RETURNS TABLE (
    citation    TEXT,
    found       BOOLEAN,
    judgment_id UUID,
    case_title  TEXT
)
LANGUAGE sql
STABLE
AS $$
SELECT c.citation,
       j.id IS NOT NULL AS found,
       j.id,
       j.case_title
  FROM unnest(p_citations) AS c(citation)
  LEFT JOIN LATERAL (
      SELECT j2.id, j2.case_title
        FROM judgments j2
       WHERE upper(regexp_replace(coalesce(j2.neutral_citation, ''), '[^A-Za-z0-9]', '', 'g'))
             = upper(regexp_replace(c.citation, '[^A-Za-z0-9]', '', 'g'))
          OR EXISTS (
              SELECT 1
                FROM unnest(j2.reporter_citations) AS rc(val)
               WHERE upper(regexp_replace(rc.val, '[^A-Za-z0-9]', '', 'g'))
                     = upper(regexp_replace(c.citation, '[^A-Za-z0-9]', '', 'g'))
          )
       LIMIT 1
  ) j ON TRUE;
$$;


-- -----------------------------------------------------------------------------
-- verify_statute_refs
--
-- The statutory half of the same guardrail. Input is {'IPC 302','BNS 103'};
-- output says whether each one is real. Backed by the immutable statutes table,
-- so an invented section number can never survive into an answer.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_statute_refs(p_refs TEXT[])
RETURNS TABLE (
    ref            TEXT,
    found          BOOLEAN,
    act_code       VARCHAR(20),
    section_number VARCHAR(20),
    section_title  VARCHAR(400)
)
LANGUAGE sql
STABLE
AS $$
SELECT r.ref,
       s.id IS NOT NULL AS found,
       s.act_code,
       s.section_number,
       s.section_title
  FROM unnest(p_refs) AS r(ref)
  LEFT JOIN LATERAL (
      SELECT s2.id, s2.act_code, s2.section_number, s2.section_title
        FROM statutes s2
       -- 'IPC 302' -> act 'IPC', section '302'
       WHERE upper(s2.act_code)       = upper(split_part(trim(r.ref), ' ', 1))
         AND upper(s2.section_number) = upper(split_part(trim(r.ref), ' ', 2))
       LIMIT 1
  ) s ON TRUE;
$$;


-- -----------------------------------------------------------------------------
-- claim_daily_quota
--
-- Durable counterpart to the Redis quota check. Atomically increments today's
-- counter and reports whether the user was within their limit, in one
-- statement - so two messages arriving at the same instant cannot both slip
-- past the last remaining unit.
--
-- p_limit < 0 means unlimited.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_daily_quota(p_user_id UUID, p_limit INTEGER)
RETURNS TABLE (allowed BOOLEAN, used INTEGER, quota INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
    v_used INTEGER;
BEGIN
    INSERT INTO daily_usage (user_id, usage_date, query_count)
         VALUES (p_user_id, CURRENT_DATE, 1)
    ON CONFLICT (user_id, usage_date) DO UPDATE
            SET query_count = daily_usage.query_count + 1,
                updated_at  = NOW()
      RETURNING daily_usage.query_count INTO v_used;

    IF p_limit < 0 THEN
        RETURN QUERY SELECT TRUE, v_used, p_limit;
        RETURN;
    END IF;

    -- Over budget: give the unit back so the counter reflects allowed usage
    -- and the user is not permanently penalised for retrying.
    IF v_used > p_limit THEN
        UPDATE daily_usage
           SET query_count = query_count - 1
         WHERE user_id = p_user_id AND usage_date = CURRENT_DATE;
        RETURN QUERY SELECT FALSE, p_limit, p_limit;
        RETURN;
    END IF;

    RETURN QUERY SELECT TRUE, v_used, p_limit;
END;
$$;

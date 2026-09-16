-- =============================================================================
-- 0017_statute_recodification_lookup.sql
--
-- "It is not able to search BNS or BNSS - still talking about IPC."
--
-- ## Why it could not
--
-- The corpus has no BNS rows. It has IPC rows that each carry their BNS
-- equivalent in `corresponding_act` / `corresponding_section` - IPC 302's row
-- says ('BNS', '103(1)') - which is the right shape for a seed built around the
-- 2023 recodification, and search_statutes never looked at those two columns.
--
-- Every candidate branch filtered on `act_code`, so a lookup for BNS 103 asked
-- for rows whose act_code is BNS, found none, and fell through to the prompt
-- that answers from general knowledge. The mapping was sitting in the same
-- table the query had just searched.
--
-- ## What changes
--
-- One more candidate branch: match the section against the *corresponding*
-- section of a row in the other code. Scored below an exact match, so a real
-- BNS row - once the bare acts are ingested properly - wins over the mapping
-- without this having to be removed first.
--
-- The bracketed sub-clause is ignored on both sides. Advocates write "BNS 103"
-- and the mapping records "103(1)", and refusing to match those two is the same
-- failure with an extra step.
-- =============================================================================

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

    -- 2. The recodified equivalent.
    --
    -- "BNS 103" is not a row in this table; it is the mapping recorded on IPC
    -- 302's row. Scored below EXACT so a genuine BNS row, whenever the bare
    -- acts are ingested, outranks the mapping without changing this function.
    --
    -- split_part drops the sub-clause: the mapping stores "103(1)" and the
    -- advocate types "103".
    SELECT s.*, 'RECODIFIED'::TEXT, 900.0::DOUBLE PRECISION
      FROM statutes s
     WHERE p_section_number IS NOT NULL
       AND p_act_code IS NOT NULL
       AND s.corresponding_act IS NOT NULL
       AND upper(s.corresponding_act) = upper(p_act_code)
       AND split_part(upper(s.corresponding_section), '(', 1)
           = split_part(upper(p_section_number), '(', 1)

    UNION ALL

    -- 3. Full text.
    SELECT s.*, 'FULLTEXT'::TEXT,
           (ts_rank_cd(s.search_vector, q.query) * 10.0)::DOUBLE PRECISION
      FROM statutes s,
           websearch_to_tsquery('english', p_query_text) AS q(query)
     WHERE s.search_vector @@ q.query
       AND (p_act_code IS NULL OR upper(s.act_code) = upper(p_act_code))

    UNION ALL

    -- 4. Fuzzy section number, for typos and odd formatting.
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

COMMENT ON FUNCTION search_statutes IS
    'Statute lookup. Matches a section against act_code, and against the recodification mapping in corresponding_act/corresponding_section so a BNS or BNSS query finds the IPC or CrPC row that records it.';

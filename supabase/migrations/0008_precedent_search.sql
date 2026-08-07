-- =============================================================================
-- 0008_precedent_search.sql
-- Judgment-level precedent search for priority feature #3.
--
-- ## Why this is not just hybrid_search_judgments with a bigger LIMIT
--
-- `hybrid_search_judgments` returns the best *passages*. Three of them can come
-- from the same judgment, which is right for feeding an LLM context window and
-- wrong for showing an advocate a list of precedents - they would see the same
-- case three times and get three fewer authorities.
--
-- This function collapses to one row per judgment, keeping the best-matching
-- passage as the excerpt, and returns judgment-level metadata (bench, headnote,
-- ratio, citations) that the passage-level function has no reason to carry.
--
-- ## Ordering: relevance first, then chronology
--
-- The requirement is "descending chronological order", but sorting the whole
-- corpus by date would return the newest cases regardless of whether they are
-- on point. So this is a two-stage sort:
--
--   1. rank every matching judgment by RRF relevance, keep the top p_max_results
--   2. re-sort that set by judgment_date DESC
--
-- The advocate gets the most relevant authorities, presented newest-first -
-- which is the order you cite them in, because the latest position of the court
-- is what governs. `relevance_rank` is returned alongside so the UI can still
-- show which one the engine thought was strongest.
--
-- ## Degrading without embeddings
--
-- p_query_embedding may be NULL (no embedding provider configured). The dense
-- CTE then yields nothing and RRF collapses to lexical-only, rather than the
-- function returning an empty set. One code path, both modes.
-- =============================================================================

CREATE OR REPLACE FUNCTION search_precedents(
    p_query_embedding vector(3072),
    p_query_text      TEXT,
    p_dense_k         INTEGER DEFAULT 60,
    p_sparse_k        INTEGER DEFAULT 60,
    p_rrf_k           INTEGER DEFAULT 60,
    -- Hard cap on precedents per session. The WhatsApp flow pages through these.
    p_max_results     INTEGER DEFAULT 15,
    p_court_type      TEXT    DEFAULT NULL,
    p_date_from       DATE    DEFAULT NULL,
    p_date_to         DATE    DEFAULT NULL,
    p_sections        TEXT[]  DEFAULT NULL
)
RETURNS TABLE (
    judgment_id        UUID,
    case_title         TEXT,
    neutral_citation   VARCHAR(120),
    reporter_citations TEXT[],
    court_name         VARCHAR(200),
    court_type         VARCHAR(30),
    judgment_date      DATE,
    bench              TEXT[],
    bench_strength     SMALLINT,
    act_sections       TEXT[],
    headnote           TEXT,
    ratio_decidendi    TEXT,
    disposition        VARCHAR(60),
    source_url         TEXT,
    -- Best-matching passage from this judgment, for the synopsis.
    best_excerpt       TEXT,
    para_number        INTEGER,
    score              DOUBLE PRECISION,
    -- 1 = most relevant. Position in the date-sorted output is separate.
    relevance_rank     INTEGER,
    -- Same value on every row: how many judgments matched before the cap.
    total_matches      INTEGER
)
LANGUAGE sql
STABLE
AS $$
WITH
dense AS (
    SELECT c.id,
           c.judgment_id,
           ROW_NUMBER() OVER (
               ORDER BY c.embedding::halfvec(3072) <=> p_query_embedding::halfvec(3072)
           )::INTEGER AS rnk
      FROM judgment_chunks c
     WHERE p_query_embedding IS NOT NULL
       AND c.embedding IS NOT NULL
       AND (p_court_type IS NULL OR c.court_type = p_court_type)
       AND (p_date_from  IS NULL OR c.judgment_date >= p_date_from)
       AND (p_date_to    IS NULL OR c.judgment_date <= p_date_to)
       AND (p_sections   IS NULL OR c.act_sections && p_sections)
     ORDER BY c.embedding::halfvec(3072) <=> p_query_embedding::halfvec(3072)
     LIMIT p_dense_k
),
sparse AS (
    SELECT c.id,
           c.judgment_id,
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
-- Chunk-level RRF, exactly as in hybrid_search_judgments.
fused AS (
    SELECT COALESCE(d.id, s.id)                   AS chunk_id,
           COALESCE(d.judgment_id, s.judgment_id) AS judgment_id,
           COALESCE(1.0 / (p_rrf_k + d.rnk), 0.0)
         + COALESCE(1.0 / (p_rrf_k + s.rnk), 0.0) AS score
      FROM dense d
      FULL OUTER JOIN sparse s ON s.id = d.id
),
-- Collapse to one row per judgment. DISTINCT ON keeps the highest-scoring
-- chunk, which becomes the excerpt shown to the user.
best_per_judgment AS (
    SELECT DISTINCT ON (f.judgment_id)
           f.judgment_id,
           f.chunk_id,
           f.score
      FROM fused f
     ORDER BY f.judgment_id, f.score DESC
),
-- Rank by relevance and cut to the session cap.
ranked AS (
    SELECT b.*,
           ROW_NUMBER() OVER (ORDER BY b.score DESC)::INTEGER AS relevance_rank,
           COUNT(*)    OVER ()::INTEGER                       AS total_matches
      FROM best_per_judgment b
),
capped AS (
    SELECT * FROM ranked WHERE relevance_rank <= p_max_results
)
SELECT j.id,
       j.case_title,
       j.neutral_citation,
       j.reporter_citations,
       c.court_name,
       c.court_type,
       j.judgment_date,
       j.bench,
       j.bench_strength,
       j.act_sections,
       j.headnote,
       j.ratio_decidendi,
       j.disposition,
       j.source_url,
       c.content,
       c.para_number,
       r.score::DOUBLE PRECISION,
       r.relevance_rank,
       r.total_matches
  FROM capped r
  JOIN judgment_chunks c ON c.id = r.chunk_id
  JOIN judgments       j ON j.id = r.judgment_id
 -- Stage two: newest first. NULLS LAST so undated imports sink rather than
 -- heading the list.
 ORDER BY j.judgment_date DESC NULLS LAST, r.score DESC;
$$;


-- -----------------------------------------------------------------------------
-- lookup_judgment_by_citation
--
-- Direct fetch when the advocate already knows the case ("pull up 2024 INSC
-- 452"). Checks the neutral citation and the reporter citation array, both
-- case- and punctuation-insensitively, because nobody types citations the same
-- way twice.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lookup_judgment_by_citation(p_citation TEXT)
RETURNS TABLE (
    judgment_id        UUID,
    case_title         TEXT,
    neutral_citation   VARCHAR(120),
    reporter_citations TEXT[],
    court_name         VARCHAR(200),
    judgment_date      DATE,
    bench              TEXT[],
    headnote           TEXT,
    ratio_decidendi    TEXT,
    disposition        VARCHAR(60),
    source_url         TEXT
)
LANGUAGE sql
STABLE
AS $$
    WITH needle AS (
        SELECT upper(regexp_replace(p_citation, '[^a-zA-Z0-9]', '', 'g')) AS norm
    )
    SELECT j.id,
           j.case_title,
           j.neutral_citation,
           j.reporter_citations,
           j.court_name,
           j.judgment_date,
           j.bench,
           j.headnote,
           j.ratio_decidendi,
           j.disposition,
           j.source_url
      FROM judgments j, needle n
     WHERE upper(regexp_replace(coalesce(j.neutral_citation, ''), '[^a-zA-Z0-9]', '', 'g')) = n.norm
        OR EXISTS (
               SELECT 1
                 FROM unnest(j.reporter_citations) AS rc
                WHERE upper(regexp_replace(rc, '[^a-zA-Z0-9]', '', 'g')) = n.norm
           )
     LIMIT 5;
$$;

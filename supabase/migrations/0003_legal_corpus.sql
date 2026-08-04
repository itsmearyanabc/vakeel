-- =============================================================================
-- 0003_legal_corpus.sql
-- The knowledge base: bare act sections and chunked judgments.
--
-- ## Why the embedding columns look odd
--
-- Embeddings are 3072-dimensional (OpenAI text-embedding-3-large, Google
-- gemini-embedding-001). pgvector's `vector` type stores up to 16000 dims, but
-- its HNSW and IVFFlat *indexes* cap out at 2000 dims - so a plain
-- `USING hnsw (embedding vector_cosine_ops)` on a 3072-dim column fails with:
--
--     ERROR: column cannot have more than 2000 dimensions for hnsw index
--
-- The fix is `halfvec`: 16-bit floats, 4000-dim index limit, ~0 measurable
-- recall loss at this width and half the index size. We keep full float32
-- precision in the stored column and index a halfvec *cast expression*.
--
-- The catch: a cast-expression index is only used when the query expression
-- matches exactly. Every ORDER BY must be written
--     embedding::halfvec(3072) <=> $1::halfvec(3072)
-- and not `embedding <=> $1`, or Postgres silently falls back to a sequential
-- scan. The search functions in 0004 are written correctly - if you hand-write
-- a query, mirror them and check with EXPLAIN.
--
-- ## Changing the dimension
--
-- If you switch to a model with a different width, change EMBEDDING_DIMENSIONS
-- in .env AND every `3072` below, then re-embed the corpus. They must agree or
-- inserts fail with a dimension mismatch.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- statutes
--
-- Bare act sections: IPC, BNS, CrPC, BNSS, Indian Evidence Act, BSA, and any
-- other code you ingest. This table is the *authority* for statutory answers -
-- the guardrail in 0004 checks generated section references against it, so the
-- bot can never invent a section number.
--
-- `corresponding_section` carries the IPC <-> BNS mapping, which is the single
-- most common question since the 2023 recodification ("what is 302 IPC now?").
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS statutes (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    act_code              VARCHAR(20)  NOT NULL,   -- IPC | BNS | CRPC | BNSS | IEA | BSA | ...
    act_name              VARCHAR(200) NOT NULL,
    section_number        VARCHAR(20)  NOT NULL,   -- '302', '498A', '156(3)'
    section_title         VARCHAR(400) NOT NULL,
    section_text          TEXT         NOT NULL,

    -- Classification an advocate actually needs at a glance.
    punishment            TEXT,
    is_cognizable         BOOLEAN,
    is_bailable           BOOLEAN,
    is_compoundable       BOOLEAN,
    triable_by            VARCHAR(160),

    -- e.g. IPC 302 -> BNS 103(1). Free text because the mapping is not 1:1.
    corresponding_act     VARCHAR(20),
    corresponding_section VARCHAR(20),

    chapter               VARCHAR(200),
    language              VARCHAR(10) NOT NULL DEFAULT 'en',
    source_url            TEXT,

    -- Title weighted above body so "murder" ranks s.302 over passing mentions.
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(section_title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(act_code, '')), 'A')      ||
        setweight(to_tsvector('english', coalesce(section_text, '')), 'B')  ||
        setweight(to_tsvector('english', coalesce(punishment, '')), 'C')
    ) STORED,

    embedding             vector(3072),

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_statutes_section UNIQUE (act_code, section_number, language)
);

CREATE INDEX IF NOT EXISTS idx_statutes_fts
    ON statutes USING GIN (search_vector);

-- Fuzzy matching for the many ways people type a section number.
CREATE INDEX IF NOT EXISTS idx_statutes_section_trgm
    ON statutes USING GIN (section_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_statutes_act
    ON statutes (act_code, section_number);

CREATE INDEX IF NOT EXISTS idx_statutes_corresponding
    ON statutes (corresponding_act, corresponding_section)
    WHERE corresponding_section IS NOT NULL;

-- See the header note: the halfvec cast is required above 2000 dimensions.
CREATE INDEX IF NOT EXISTS idx_statutes_embedding_hnsw
    ON statutes USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 100);

DROP TRIGGER IF EXISTS trg_statutes_updated_at ON statutes;
CREATE TRIGGER trg_statutes_updated_at
    BEFORE UPDATE ON statutes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- judgments
--
-- One row per reported judgment. The full text lives here; retrieval happens
-- against `judgment_chunks`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judgments (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    case_title         TEXT         NOT NULL,
    court_name         VARCHAR(200) NOT NULL,   -- 'Supreme Court of India', 'Delhi High Court'
    court_type         VARCHAR(30)  NOT NULL,   -- SUPREME_COURT | HIGH_COURT | TRIBUNAL | DISTRICT

    -- Neutral citation is the stable identifier ('2024 INSC 452').
    neutral_citation   VARCHAR(120),
    -- Reporter citations: {'AIR 2018 SC 1234','(2018) 5 SCC 1'}
    reporter_citations TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    judgment_date      DATE,
    bench              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    bench_strength     SMALLINT,

    -- Statutory provisions the judgment turns on: {'IPC 302','CrPC 439'}.
    act_sections       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    keywords           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Extracted once at ingest so answers can quote the holding directly.
    headnote           TEXT,
    ratio_decidendi    TEXT,
    disposition        VARCHAR(60),   -- ALLOWED | DISMISSED | PARTLY_ALLOWED | ...

    full_text          TEXT,
    source_url         TEXT,
    -- sha256 of full_text: makes re-ingestion idempotent.
    content_hash       VARCHAR(64) UNIQUE,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_judgments_court_date  ON judgments (court_name, judgment_date DESC);
CREATE INDEX IF NOT EXISTS idx_judgments_type_date   ON judgments (court_type, judgment_date DESC);
CREATE INDEX IF NOT EXISTS idx_judgments_sections    ON judgments USING GIN (act_sections);
CREATE INDEX IF NOT EXISTS idx_judgments_keywords    ON judgments USING GIN (keywords);
CREATE INDEX IF NOT EXISTS idx_judgments_citations   ON judgments USING GIN (reporter_citations);
CREATE INDEX IF NOT EXISTS idx_judgments_neutral_cit ON judgments (neutral_citation)
    WHERE neutral_citation IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_judgments_title_trgm  ON judgments USING GIN (case_title gin_trgm_ops);

DROP TRIGGER IF EXISTS trg_judgments_updated_at ON judgments;
CREATE TRIGGER trg_judgments_updated_at
    BEFORE UPDATE ON judgments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- judgment_chunks
--
-- The retrieval unit. Chunked by paragraph with overlap at ingest time so a
-- citation can point at a specific paragraph number, which is what makes the
-- answer checkable by the advocate reading it.
--
-- Denormalised court/date columns let the hybrid search filter before the
-- expensive vector scan without joining back to `judgments`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judgment_chunks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    judgment_id    UUID NOT NULL REFERENCES judgments(id) ON DELETE CASCADE,

    chunk_index    INTEGER NOT NULL,
    content        TEXT    NOT NULL,
    -- Paragraph number as printed in the judgment, when we could parse one.
    para_number    INTEGER,
    token_count    INTEGER NOT NULL DEFAULT 0,

    -- Denormalised from judgments for pre-filtering.
    court_name     VARCHAR(200),
    court_type     VARCHAR(30),
    judgment_date  DATE,
    act_sections   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(content, ''))
    ) STORED,

    embedding      vector(3072),

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_judgment_chunk UNIQUE (judgment_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_fts
    ON judgment_chunks USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_chunks_judgment
    ON judgment_chunks (judgment_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_chunks_court_date
    ON judgment_chunks (court_type, judgment_date DESC);

CREATE INDEX IF NOT EXISTS idx_chunks_sections
    ON judgment_chunks USING GIN (act_sections);

-- The main dense-retrieval index. Build this AFTER bulk ingestion if you are
-- loading a large corpus - building it on an empty table then inserting 10M
-- rows is dramatically slower than the other way round.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
    ON judgment_chunks USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 100);


-- -----------------------------------------------------------------------------
-- Keep the denormalised columns on chunks in sync with their parent judgment.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_chunk_judgment_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE judgment_chunks c
       SET court_name    = NEW.court_name,
           court_type    = NEW.court_type,
           judgment_date = NEW.judgment_date,
           act_sections  = NEW.act_sections
     WHERE c.judgment_id = NEW.id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_chunk_metadata ON judgments;
CREATE TRIGGER trg_sync_chunk_metadata
    AFTER UPDATE OF court_name, court_type, judgment_date, act_sections ON judgments
    FOR EACH ROW EXECUTE FUNCTION sync_chunk_judgment_metadata();

import { Injectable } from '@nestjs/common';
import { getLogger } from '../../common/logger';
import { DatabaseService } from '../database.service';
import { CitationCheck, PrecedentRow, RetrievedChunk, StatuteRefCheck, StatuteRow } from '../types';

export interface PrecedentSearchOptions {
  queryText: string;
  embedding: number[] | null;
  denseK: number;
  sparseK: number;
  rrfK: number;
  /** Hard cap on distinct judgments returned for one research question. */
  maxResults: number;
  courtType?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sections?: string[] | null;
}

export interface HybridSearchOptions {
  queryText: string;
  embedding: number[] | null;
  denseK: number;
  sparseK: number;
  rrfK: number;
  finalK: number;
  courtType?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sections?: string[] | null;
}

/**
 * Access to the legal knowledge base: bare acts and judgment passages.
 *
 * All the interesting work lives in the SQL functions from migration 0004; this
 * class is a thin, typed calling convention over them.
 */
@Injectable()
export class CorpusRepository {
  private readonly logger = getLogger().child({ module: 'corpus-repo' });

  constructor(private readonly db: DatabaseService) {}

  /**
   * Format a JS number array as a pgvector literal: `[0.1,0.2,...]`.
   *
   * pgvector's text input is its own format - not a Postgres array literal and
   * not JSON - so this cannot be replaced by passing the array directly.
   */
  private toVectorLiteral(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }

  /**
   * Hybrid dense + lexical retrieval, fused with RRF inside Postgres.
   *
   * When `embedding` is null (no embedding provider configured, or the provider
   * failed) this degrades to lexical-only rather than returning nothing - a
   * keyword hit is far better than an apology, and the caller cannot tell the
   * difference beyond slightly worse ranking.
   */
  async hybridSearch(opts: HybridSearchOptions): Promise<RetrievedChunk[]> {
    const { sql } = this.db;

    if (!opts.embedding) {
      this.logger.debug('No embedding available; falling back to lexical-only retrieval');
      return this.lexicalOnlySearch(opts);
    }

    const vector = this.toVectorLiteral(opts.embedding);

    return sql<RetrievedChunk[]>`
      SELECT * FROM hybrid_search_judgments(
        ${vector}::vector,
        ${opts.queryText},
        ${opts.denseK},
        ${opts.sparseK},
        ${opts.rrfK},
        ${opts.finalK},
        ${opts.courtType ?? null},
        ${opts.dateFrom ?? null}::date,
        ${opts.dateTo ?? null}::date,
        ${opts.sections ?? null}::text[]
      )
    `;
  }

  /** Lexical half of the hybrid search, used when no embedding is available. */
  private async lexicalOnlySearch(opts: HybridSearchOptions): Promise<RetrievedChunk[]> {
    const { sql } = this.db;

    return sql<RetrievedChunk[]>`
      SELECT c.id            AS chunk_id,
             c.judgment_id,
             c.content,
             c.para_number,
             j.case_title,
             j.neutral_citation,
             j.reporter_citations,
             c.court_name,
             c.judgment_date,
             j.ratio_decidendi,
             NULL::INTEGER   AS dense_rank,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.search_vector, q.query) DESC)::INTEGER AS sparse_rank,
             ts_rank_cd(c.search_vector, q.query)::DOUBLE PRECISION AS score
        FROM judgment_chunks c
        JOIN judgments j ON j.id = c.judgment_id,
             websearch_to_tsquery('english', ${opts.queryText}) AS q(query)
       WHERE c.search_vector @@ q.query
         AND (${opts.courtType ?? null}::text IS NULL OR c.court_type = ${opts.courtType ?? null})
         AND (${opts.sections ?? null}::text[] IS NULL OR c.act_sections && ${opts.sections ?? null}::text[])
       ORDER BY score DESC
       LIMIT ${opts.finalK}
    `;
  }

  /**
   * Precedent list: one row per judgment, newest first.
   *
   * See migration 0008 for why this is not `hybridSearch` with a larger limit -
   * in short, that returns passages, and an advocate asking for precedents
   * wants distinct authorities, not the same case quoted three times.
   *
   * A null embedding is passed through rather than short-circuited: the SQL
   * function degrades to lexical-only on its own, so there is no separate
   * fallback path to keep in sync here.
   */
  async searchPrecedents(opts: PrecedentSearchOptions): Promise<PrecedentRow[]> {
    const { sql } = this.db;
    const vector = opts.embedding ? this.toVectorLiteral(opts.embedding) : null;

    return sql<PrecedentRow[]>`
      SELECT * FROM search_precedents(
        ${vector}::vector,
        ${opts.queryText},
        ${opts.denseK},
        ${opts.sparseK},
        ${opts.rrfK},
        ${opts.maxResults},
        ${opts.courtType ?? null},
        ${opts.dateFrom ?? null}::date,
        ${opts.dateTo ?? null}::date,
        ${opts.sections ?? null}::text[]
      )
    `;
  }

  /** Direct fetch when the advocate already knows the citation. */
  async lookupByCitation(citation: string): Promise<PrecedentRow[]> {
    return this.db.sql<PrecedentRow[]>`
      SELECT * FROM lookup_judgment_by_citation(${citation})
    `;
  }

  /**
   * Look up bare act sections.
   *
   * `sectionNumber` and `actCode` come from the intent classifier's structured
   * extraction; when it could not identify either, the full-text path still
   * handles plain-language questions like "punishment for cheating".
   */
  async searchStatutes(
    queryText: string,
    sectionNumber: string | null,
    actCode: string | null,
    limit = 5,
  ): Promise<StatuteRow[]> {
    return this.db.sql<StatuteRow[]>`
      SELECT * FROM search_statutes(
        ${queryText},
        ${sectionNumber},
        ${actCode},
        ${limit}
      )
    `;
  }

  /**
   * Anti-hallucination check for case citations (spec 9.2).
   *
   * Returns one row per input citation saying whether it exists in the corpus.
   * Anything false is stripped from the answer before it reaches the user.
   */
  async verifyCitations(citations: string[]): Promise<CitationCheck[]> {
    if (citations.length === 0) return [];
    return this.db.sql<CitationCheck[]>`
      SELECT * FROM verify_citations(${citations}::text[])
    `;
  }

  /** Same check for statutory references, e.g. 'IPC 302'. */
  async verifyStatuteRefs(refs: string[]): Promise<StatuteRefCheck[]> {
    if (refs.length === 0) return [];
    return this.db.sql<StatuteRefCheck[]>`
      SELECT * FROM verify_statute_refs(${refs}::text[])
    `;
  }

  async countCorpus(): Promise<{ judgments: number; chunks: number; statutes: number; embedded: number }> {
    const [row] = await this.db.sql<
      { judgments: string; chunks: string; statutes: string; embedded: string }[]
    >`
      SELECT (SELECT COUNT(*) FROM judgments)                                AS judgments,
             (SELECT COUNT(*) FROM judgment_chunks)                          AS chunks,
             (SELECT COUNT(*) FROM statutes)                                 AS statutes,
             (SELECT COUNT(*) FROM judgment_chunks WHERE embedding IS NOT NULL) AS embedded
    `;
    return {
      judgments: Number(row?.judgments ?? 0),
      chunks: Number(row?.chunks ?? 0),
      statutes: Number(row?.statutes ?? 0),
      embedded: Number(row?.embedded ?? 0),
    };
  }
}

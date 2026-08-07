import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { PrecedentRow } from '../database/types';
import { SettingsService } from '../settings/settings.service';
import { EmbeddingService } from './embedding.service';
import { ClassifiedIntent } from './intent.service';
import { expandQuery } from './legal-patterns';

export interface PrecedentSearchResult {
  /** Already sorted newest-first by the SQL function. */
  precedents: PrecedentRow[];
  /** How many matched before the per-session cap. */
  totalMatches: number;
  /** True when retrieval ran keyword-only because no embedding was available. */
  lexicalOnly: boolean;
  latencyMs: number;
}

/**
 * Priority feature 3: case law and precedent search.
 *
 * The requirement is specific and worth restating, because it shapes every
 * decision below: *up to 15 precedents per session, in descending chronological
 * order, with citations where available.*
 *
 * Three consequences follow.
 *
 * 1. **One row per judgment, not per passage.** The general RAG path retrieves
 *    passages to feed a model. Here the passages are not the answer - the list
 *    of authorities is. Collapsing happens in SQL (migration 0008).
 *
 * 2. **Relevance decides membership, chronology decides order.** Sorting the
 *    corpus by date alone returns whatever is newest regardless of subject.
 *    So the engine ranks by relevance, takes the top 15, and then presents
 *    those newest-first - which is also the order you cite them in, since the
 *    court's latest position governs.
 *
 * 3. **No LLM call is required to produce the list.** The synopsis is the
 *    judgment's own headnote or ratio where the corpus has one, falling back to
 *    the best-matching passage. That keeps the feature working - and honest -
 *    when no model provider is configured, and removes any opportunity for a
 *    model to invent a citation, because nothing here is generated.
 */
@Injectable()
export class PrecedentsService {
  private readonly logger = getLogger().child({ module: 'precedents' });

  constructor(
    private readonly corpus: CorpusRepository,
    private readonly embeddings: EmbeddingService,
    private readonly settings: SettingsService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get maxResults(): number {
    return this.settings.getNumber('PRECEDENT_MAX_RESULTS', this.env.PRECEDENT_MAX_RESULTS);
  }

  get pageSize(): number {
    return this.settings.getNumber('PRECEDENT_PAGE_SIZE', this.env.PRECEDENT_PAGE_SIZE);
  }

  async search(intent: ClassifiedIntent): Promise<PrecedentSearchResult> {
    const started = Date.now();

    const expanded = expandQuery(intent.searchQuery);
    const embedding = await this.embeddings.embedQuery(expanded);

    const precedents = await this.corpus.searchPrecedents({
      queryText: expanded,
      embedding,
      denseK: this.settings.getNumber('RAG_DENSE_TOP_K', this.env.RAG_DENSE_TOP_K),
      sparseK: this.settings.getNumber('RAG_SPARSE_TOP_K', this.env.RAG_SPARSE_TOP_K),
      rrfK: this.settings.getNumber('RAG_RRF_K', this.env.RAG_RRF_K),
      maxResults: this.maxResults,
      sections:
        intent.sectionNumber && intent.actCode ? [`${intent.actCode} ${intent.sectionNumber}`] : null,
    });

    this.logger.debug(
      {
        returned: precedents.length,
        totalMatches: precedents[0]?.total_matches ?? 0,
        lexicalOnly: !embedding,
      },
      'Precedent search complete',
    );

    return {
      precedents,
      totalMatches: precedents[0]?.total_matches ?? precedents.length,
      lexicalOnly: !embedding,
      latencyMs: Date.now() - started,
    };
  }

  /** Direct citation fetch: "pull up 2024 INSC 452". */
  async byCitation(citation: string): Promise<PrecedentRow[]> {
    return this.corpus.lookupByCitation(citation);
  }
}

// ---------------------------------------------------------------------------
// Formatting
//
// Kept as free functions rather than methods so they are trivially testable
// without a DI container - see precedents.format.spec.ts.
// ---------------------------------------------------------------------------

/** Best available citation for display, preferring the neutral one. */
export function bestCitation(p: PrecedentRow): string | null {
  if (p.neutral_citation) return p.neutral_citation;
  if (p.reporter_citations?.length) return p.reporter_citations[0];
  return null;
}

function year(date: Date | null): string {
  if (!date) return 'date unknown';
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? 'date unknown' : String(d.getUTCFullYear());
}

function fullDate(date: Date | null): string | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Condense a passage to a readable synopsis.
 *
 * Cuts on a sentence boundary where one is available within range, because a
 * mid-clause truncation of a legal holding can invert its meaning - "the court
 * held that bail could not be granted where…" is a very different sentence from
 * its first eight words.
 */
export function synopsis(p: PrecedentRow, limit = 260): string {
  const source = (p.ratio_decidendi || p.headnote || p.best_excerpt || '').replace(/\s+/g, ' ').trim();
  if (!source) return 'No synopsis available for this judgment.';
  if (source.length <= limit) return source;

  const window = source.slice(0, limit);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '));
  return lastStop > limit * 0.5 ? window.slice(0, lastStop + 1) : `${window.trimEnd()}…`;
}

/**
 * Render one page of precedents as a WhatsApp message.
 *
 * WhatsApp hard-truncates around 4096 characters, so the list is paged rather
 * than sent whole - five judgments with synopses is already close to the limit.
 * `offset` is the index into the (date-sorted) full result set.
 */
export function formatPrecedentPage(
  all: PrecedentRow[],
  offset: number,
  pageSize: number,
  query: string,
  opts: { lexicalOnly?: boolean } = {},
): string {
  if (all.length === 0) {
    return [
      `*No precedents found*`,
      '',
      `I could not find any judgment in the corpus matching _"${query}"_.`,
      '',
      'Try rephrasing with the legal issue rather than the facts — for example ' +
        '_"anticipatory bail in NDPS commercial quantity"_ rather than _"my client was caught with drugs"_.',
    ].join('\n');
  }

  const page = all.slice(offset, offset + pageSize);
  const shownTo = offset + page.length;

  const header = [
    `*Case law — ${all.length} precedent${all.length === 1 ? '' : 's'}*`,
    `_${query}_`,
    '',
    `Showing ${offset + 1}–${shownTo} of ${all.length}, newest first.`,
  ];

  if (opts.lexicalOnly) {
    // Say so rather than quietly returning worse results.
    header.push('_Note: semantic search is off, so these are keyword matches only._');
  }

  const entries = page.map((p, i) => {
    const n = offset + i + 1;
    const citation = bestCitation(p);
    const date = fullDate(p.judgment_date);

    const lines = [
      `*${n}. ${p.case_title}*`,
      `${p.court_name ?? 'Court not recorded'} · ${year(p.judgment_date)}`,
    ];

    if (citation) lines.push(`📑 ${citation}`);

    // Bench strength is what tells an advocate whether a later smaller bench
    // could have departed from it, so it is worth the line.
    if (p.bench_strength && p.bench_strength > 1) {
      lines.push(`⚖️ ${p.bench_strength}-judge bench`);
    }
    if (p.disposition) lines.push(`Result: ${p.disposition.toLowerCase()}`);

    lines.push('', synopsis(p));

    if (p.act_sections?.length) {
      lines.push('', `_Provisions: ${p.act_sections.slice(0, 5).join(', ')}_`);
    }
    if (date) lines.push(`_Decided ${date}_`);

    return lines.join('\n');
  });

  const footer: string[] = [];
  if (shownTo < all.length) {
    footer.push('', `_${all.length - shownTo} more — reply *more* to continue._`);
  } else if (all.length > pageSize) {
    footer.push('', '_End of results._');
  }

  // The corpus is whatever you ingested; saying so prevents "the bot says there
  // is no authority on this" being read as "there is no authority on this".
  footer.push('', '_Results come from the loaded judgment corpus and may not be exhaustive. Always verify before citing._');

  return [...header, '', entries.join('\n\n────────\n\n'), ...footer].join('\n');
}

import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { PrecedentRow } from '../database/types';
import { KanoonNotConfiguredError, KanoonService } from '../kanoon/kanoon.service';
import { SettingsService } from '../settings/settings.service';
// The formatter below emits WhatsApp markup and is only ever rendered into a
// WhatsApp message, so sharing the closing copy is the honest dependency.
import { CAVEAT, RETURN_TO_MENU } from '../whatsapp/replies';
import { EmbeddingService } from './embedding.service';
import { ClassifiedIntent } from './intent.service';
import { expandQuery } from './legal-patterns';
import { buildPrincipleSummaryPrompt } from './prompts';
import { parseJsonLoose } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';

/** Named so the extract builder below reads as prose rather than escapes. */
const NEWLINE = '\n';

export interface PrecedentSearchResult {
  /** Already sorted newest-first, whichever source produced them. */
  precedents: PrecedentRow[];
  /** How many matched before the per-session cap. */
  totalMatches: number;
  /** True when retrieval ran keyword-only because no embedding was available. */
  lexicalOnly: boolean;
  /** Which backend actually answered - shown to the user and logged. */
  source: 'local' | 'kanoon';
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
    private readonly kanoon: KanoonService,
    private readonly settings: SettingsService,
    private readonly registry: ProviderRegistry,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get maxResults(): number {
    return this.settings.getNumber('PRECEDENT_MAX_RESULTS', this.env.PRECEDENT_MAX_RESULTS);
  }

  get pageSize(): number {
    return this.settings.getNumber('PRECEDENT_PAGE_SIZE', this.env.PRECEDENT_PAGE_SIZE);
  }

  /** local | kanoon | auto — resolved per call so the panel can switch it live. */
  private get source(): string {
    return this.settings.get('PRECEDENT_SOURCE') || this.env.PRECEDENT_SOURCE;
  }

  async search(intent: ClassifiedIntent): Promise<PrecedentSearchResult> {
    const started = Date.now();
    const mode = this.source;

    // Indian Kanoon reaches far more case law than any corpus we would ingest,
    // so it is preferred when available. `auto` falls back to local on failure
    // rather than leaving the advocate with nothing.
    const useKanoon = mode === 'kanoon' || (mode === 'auto' && this.kanoon.isConfigured);

    if (useKanoon) {
      try {
        const precedents = await this.kanoon.search(intent.searchQuery, this.maxResults);
        return {
          precedents: await this.withPrinciples(precedents),
          totalMatches: precedents[0]?.total_matches ?? precedents.length,
          // Kanoon runs its own relevance ranking; the local dense/lexical
          // distinction does not apply, so this is never a degraded state.
          lexicalOnly: false,
          source: 'kanoon',
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof KanoonNotConfiguredError) {
          this.logger.warn('PRECEDENT_SOURCE is kanoon but no API key is set - using the local corpus');
        } else if (mode === 'kanoon') {
          // Explicitly pinned to Kanoon: silently serving local results would
          // misrepresent where the authorities came from.
          throw err;
        } else {
          this.logger.error({ err }, 'Indian Kanoon search failed - falling back to the local corpus');
        }
      }
    }

    return this.searchLocal(intent, started);
  }

  /** Hybrid dense + lexical search over the ingested Postgres corpus. */
  private async searchLocal(intent: ClassifiedIntent, started: number): Promise<PrecedentSearchResult> {
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
      precedents: await this.withPrinciples(precedents),
      totalMatches: precedents[0]?.total_matches ?? precedents.length,
      lexicalOnly: !embedding,
      source: 'local',
      latencyMs: Date.now() - started,
    };
  }

  /**
   * Fill in the LEGAL PRINCIPLE line for rows that have no authored one.
   *
   * ## Why this exists
   *
   * The output format requires a principle on every card. Ingested judgments
   * carry a headnote or a ratio and need nothing from a model. Indian Kanoon -
   * which is where most deployments' results actually come from - carries
   * neither, so those cards printed no principle at all, which is the field an
   * advocate scanning ten results reads first.
   *
   * ## Why the whole feature does not depend on it
   *
   * Everything else on the card is assembled from retrieved rows, and that is
   * deliberate: it is what makes a fabricated citation structurally impossible.
   * This step is the one exception, so it is bounded on every side. It runs on
   * the cheap router model, in one call for the whole page. It is skipped
   * entirely when that model is a mock, because a placeholder string printed
   * under LEGAL PRINCIPLE reads as a finding about the case above it. And it
   * never throws: a failure leaves `generated_principle` unset and the card
   * falls back to whatever the row itself states.
   *
   * Rows that already carry a headnote or ratio are not sent at all - there is
   * nothing a model can add to the court's own words, and it would be a chance
   * to contradict them.
   */
  private async withPrinciples(rows: PrecedentRow[]): Promise<PrecedentRow[]> {
    if (rows.length === 0 || this.registry.isRouterMocked) return rows;

    const needed = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !(row.ratio_decidendi || row.headnote || '').trim())
      .filter(({ row }) => (row.best_excerpt || '').trim().length > 0);

    if (needed.length === 0) return rows;

    try {
      const extracts = needed
        .map(({ row }, n) =>
          [
            `${n + 1}. ${row.case_title}`,
            row.court_name ? `Court: ${row.court_name}` : '',
            `Extract: ${(row.best_excerpt || '').replace(/\s+/g, ' ').slice(0, 900)}`,
          ]
            .filter(Boolean)
            .join(NEWLINE),
        )
        .join(NEWLINE + NEWLINE);

      const result = await this.registry.complete({
        task: 'router',
        system: buildPrincipleSummaryPrompt(),
        messages: [{ role: 'user', content: extracts }],
        json: true,
        maxTokens: 900,
      });

      const parsed = parseJsonLoose<{ principles?: { n?: number; principle?: string }[] }>(result.text);
      const byNumber = new Map<number, string>();
      for (const entry of parsed?.principles ?? []) {
        const n = Number(entry?.n);
        const principle = String(entry?.principle ?? '').trim();
        // "NONE" is the model doing the right thing on an extract that states
        // nothing, so it is dropped here rather than printed.
        if (Number.isInteger(n) && principle && principle.toUpperCase() !== 'NONE') {
          byNumber.set(n, principle);
        }
      }

      const filled = [...rows];
      needed.forEach(({ index }, n) => {
        const principle = byNumber.get(n + 1);
        if (principle) filled[index] = { ...filled[index], generated_principle: principle };
      });

      this.logger.debug(
        { asked: needed.length, written: byNumber.size },
        'Legal principles summarised',
      );

      return filled;
    } catch (err) {
      this.logger.warn({ err }, 'Could not summarise legal principles - cards fall back to the row');
      return rows;
    }
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

/** Shown wherever a field genuinely has no value, rather than dropping the line. */
export const NOT_AVAILABLE = 'Not available';

// Re-exported so callers that already import from this module do not need to
// reach into replies.ts as well.
export { CAVEAT, RETURN_TO_MENU };

/** Best available citation for display, preferring the neutral one. */
export function bestCitation(p: PrecedentRow): string | null {
  if (p.neutral_citation) return p.neutral_citation;
  if (p.reporter_citations?.length) return p.reporter_citations[0];
  return null;
}

/**
 * Indian Kanoon truncates long party names in the title, and the ellipsis
 * travels all the way to the advocate's phone: "Tiger Global International Iii
 * ... vs The Authority For Advance Rulings ...". It is noise in every case and
 * actively misleading in some, since it can look like part of the party's name.
 */
export function stripEllipsis(value: string): string {
  return value
    .replace(/\s*(\.{2,}|…)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a judgment title into the two sides.
 *
 * Indian case titles are "<petitioner> vs <respondent>", with the separator
 * written half a dozen ways. Only the *first* separator splits - "State of
 * Bihar vs Ram Kumar vs Anr" is one case with a messy respondent, not three
 * parties, and splitting on every occurrence would silently drop the tail.
 */
export function splitParties(title: string): { petitioner: string | null; respondent: string | null } {
  const cleaned = stripEllipsis(title);
  const match = /^(.*?)\s+(?:vs?\.?|versus|v\/s)\s+(.*)$/i.exec(cleaned);
  if (!match) return { petitioner: cleaned || null, respondent: null };

  const petitioner = match[1].trim();
  const respondent = match[2].trim();
  return { petitioner: petitioner || null, respondent: respondent || null };
}

/**
 * The High Court an advocate practises in, inferred from the state on their
 * profile.
 *
 * Deliberately a lookup rather than string matching on the court name: several
 * High Courts are not named after their state (Bihar is served by Patna, Punjab
 * and Haryana share one, the North-Eastern states share Gauhati), so "does the
 * court name contain the state name" is wrong for exactly the advocates most
 * likely to notice.
 */
const HIGH_COURT_BY_STATE: Record<string, string> = {
  'andhra pradesh': 'andhra pradesh high court',
  'arunachal pradesh': 'gauhati high court',
  assam: 'gauhati high court',
  bihar: 'patna high court',
  chandigarh: 'punjab & haryana high court',
  chhattisgarh: 'chhattisgarh high court',
  delhi: 'delhi high court',
  goa: 'bombay high court',
  gujarat: 'gujarat high court',
  haryana: 'punjab & haryana high court',
  'himachal pradesh': 'himachal pradesh high court',
  'jammu and kashmir': 'jammu & kashmir high court',
  jharkhand: 'jharkhand high court',
  karnataka: 'karnataka high court',
  kerala: 'kerala high court',
  ladakh: 'jammu & kashmir high court',
  'madhya pradesh': 'madhya pradesh high court',
  maharashtra: 'bombay high court',
  manipur: 'manipur high court',
  meghalaya: 'meghalaya high court',
  mizoram: 'gauhati high court',
  nagaland: 'gauhati high court',
  odisha: 'orissa high court',
  orissa: 'orissa high court',
  puducherry: 'madras high court',
  punjab: 'punjab & haryana high court',
  rajasthan: 'rajasthan high court',
  sikkim: 'sikkim high court',
  'tamil nadu': 'madras high court',
  telangana: 'telangana high court',
  tripura: 'tripura high court',
  'uttar pradesh': 'allahabad high court',
  uttarakhand: 'uttarakhand high court',
  'west bengal': 'calcutta high court',
};

export function homeHighCourt(state: string | null | undefined): string | null {
  if (!state) return null;
  return HIGH_COURT_BY_STATE[state.trim().toLowerCase()] ?? null;
}

/**
 * Float up to `max` judgments from the advocate's own High Court to the top.
 *
 * Their home court binds them; everything else is persuasive at best. Sorting
 * purely by date buries the one authority they can actually cite as binding
 * under three from other states.
 *
 * A *stable partition*, not a re-sort: within both groups the existing
 * newest-first order is preserved, and the cap stops a court with many hits
 * from crowding out the genuinely recent authority the advocate also needs.
 */
export function prioritiseHomeCourt(
  rows: PrecedentRow[],
  state: string | null | undefined,
  max = 3,
): PrecedentRow[] {
  const home = homeHighCourt(state);
  if (!home) return rows;

  const promoted: PrecedentRow[] = [];
  const rest: PrecedentRow[] = [];

  for (const row of rows) {
    const court = row.court_name?.toLowerCase() ?? '';
    if (promoted.length < max && court.includes(home)) promoted.push(row);
    else rest.push(row);
  }

  return [...promoted, ...rest];
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
 * The line under LEGAL PRINCIPLE, or nothing at all.
 *
 * ## Why this can return null
 *
 * The corpus supplies a headnote or a ratio for judgments we have ingested, and
 * either is a real statement of what the case decided. Indian Kanoon supplies
 * neither. What it gives is `headline` - a snippet with the query terms
 * highlighted - and for a judgment where those terms appear only in the
 * metadata, that snippet is the document's own header:
 *
 *   "The State Of Bihar vs Imteyaz Alam @ Ansari on 11 September, 2024
 *    Author: Ashutosh Kumar"
 *
 * Printing that after the words LEGAL PRINCIPLE is worse than printing nothing.
 * It is not wrong the way a hallucination is wrong - every word is true - but it
 * claims to be the holding of the case and is actually the title, the date and
 * the judge, all three of which are already on the card immediately above it.
 * An advocate reads it, learns nothing, and concludes the product is broken.
 *
 * So: a real principle, or no line.
 */
export function legalPrinciple(p: PrecedentRow, limit = 200): string | null {
  // Ingested judgments carry the real thing; none of the rescue below applies.
  const authored = (p.ratio_decidendi || p.headnote || '').replace(/\s+/g, ' ').trim();
  if (authored) return stripEllipsis(synopsis({ ...p, best_excerpt: authored }, limit));

  // Written by the model from this row's own extract, and only where the row
  // states no principle of its own - see PrecedentsService.withPrinciples().
  // Ranked below the court's words and above our own salvage attempt.
  const generated = (p.generated_principle || '').replace(/\s+/g, ' ').trim();
  if (generated) return stripEllipsis(synopsis({ ...p, best_excerpt: generated }, limit));

  const excerpt = (p.best_excerpt || '').replace(/\s+/g, ' ').trim();
  if (!excerpt) return null;
  if (isDocumentHeader(excerpt, p.case_title)) return null;

  const trimmed = stripEllipsis(synopsis(p, limit));
  // A handful of words is a fragment, not a principle. The threshold is low on
  // purpose - the aim is to catch residue, not to judge brevity.
  return trimmed.replace(/[^A-Za-z]/g, '').length >= 40 ? trimmed : null;
}

/**
 * Is this snippet just the judgment's own header?
 *
 * Two independent signals, either sufficient, because Kanoon's header format
 * varies with how much of the title it kept:
 *
 *   - the snippet opens with the case title it sits beneath, or
 *   - stripping the "on <date>" and "Author: <name>" furniture leaves almost
 *     nothing behind
 */
function isDocumentHeader(excerpt: string, caseTitle: string): boolean {
  const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');

  const title = norm(stripEllipsis(caseTitle));
  // 24 characters is enough to identify the case and short enough to survive
  // Kanoon truncating long party names.
  if (title.length >= 24 && norm(excerpt).startsWith(title.slice(0, 24))) return true;

  const residue = excerpt
    .replace(/on\s+\d{1,2}\s+\w+,?\s+\d{4}/gi, '')
    .replace(/author\s*:\s*[^.,;]{0,60}/gi, '')
    .replace(/bench\s*:\s*[^.,;]{0,60}/gi, '')
    .replace(/[^A-Za-z]/g, '');

  return residue.length < 40;
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
  opts: { lexicalOnly?: boolean; source?: 'local' | 'kanoon' } = {},
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

  /*
   * Every label, on every card, in the order the output format names them.
   *
   * This dropped empty labels for a while, on the reasoning that Indian Kanoon
   * supplies no citation for most judgments and three dead lines per result push
   * the informative ones off a phone screen. That pressure is real and it lost
   * to the requirement: the format names seven fields and says each precedent
   * must include them, so a card that silently omits three is not a tidier card,
   * it is a different one. An advocate scanning for EQUIVALENT CITATIONS cannot
   * tell "this judgment has none" from "this build stopped printing them".
   *
   * The pressure is answered where it belongs instead. LEGAL PRINCIPLE - the
   * line carrying most of the information on a card - is now written from the
   * judgment's own extract rather than left blank, so the fields that stay
   * empty are the ones that are genuinely empty at the source.
   */
  const line = (label: string, value: string | null | undefined): string =>
    `${label}: ${value && value.trim() ? value.trim() : NOT_AVAILABLE}`;

  const entries = page.map((p, i) => {
    const n = offset + i + 1;
    const { petitioner, respondent } = splitParties(p.case_title);

    const bench =
      p.bench?.length
        ? p.bench.join(', ')
        : p.bench_strength && p.bench_strength > 1
          ? `${p.bench_strength}-judge bench`
          : NOT_AVAILABLE;

    const principle = legalPrinciple(p);

    /*
     * The equivalents are the *other* citations, not the best one.
     *
     * This line used to print bestCitation(), which prefers the neutral
     * citation - the same string CASE NO. had already printed one line above.
     * So a judgment with both kinds showed its neutral citation twice and its
     * reporter citation not at all, which is the one an advocate needs to pull
     * the judgment out of a law report.
     */
    const equivalents = (p.reporter_citations ?? []).filter(
      (citation) => citation && citation !== p.neutral_citation,
    );

    return [
      `*${n}. ${stripEllipsis(p.case_title)}*`,
      line('CASE NO.', p.neutral_citation),
      line('PETITIONER', petitioner),
      line('RESPONDENT', respondent),
      line('DATE OF JUDGMENT', fullDate(p.judgment_date)),
      line('BENCH', bench),
      line('EQUIVALENT CITATIONS', equivalents.join('; ')),
      line('COURT', p.court_name),
      '',
      // "Not available" rather than the document's own header standing in for a
      // holding. Every word of that header is true and it is not what the case
      // decided, which is the one thing this line claims to be.
      line('LEGAL PRINCIPLE', principle),
    ].join(NEWLINE);
  });

  const footer: string[] = [];
  if (shownTo < all.length) {
    footer.push('', `_${all.length - shownTo} more — reply *more* to continue._`);
  } else if (all.length > pageSize) {
    // Naming the ceiling matters: without it, "End of results" reads as "there
    // is no further authority on this", which is a very different claim.
    footer.push('', `_That is all ${all.length} precedents for this search._`);
  }

  footer.push('', CAVEAT, '', RETURN_TO_MENU);

  return [...header, '', entries.join('\n\n────────\n\n'), ...footer].join('\n');
}

import { PrecedentRow } from '../database/types';
import { KanoonSearchDoc } from './kanoon.types';

/**
 * Translation from Indian Kanoon's search results into the bot's PrecedentRow.
 *
 * Kept as pure functions with no I/O so the mapping can be tested against real
 * captured payloads without a network call or a DI container - which matters,
 * because every subtle bug in this integration lives here rather than in the
 * HTTP client.
 *
 * ## The honesty rule
 *
 * Kanoon exposes no citation of any kind. Where the local corpus would carry a
 * neutral citation ("2024 INSC 452"), these rows carry `null`, and the source
 * URL is offered instead. Synthesising a citation-shaped string from the title
 * would produce something that looks quotable in a filing and is not - the one
 * failure mode this whole product is built to avoid.
 */

/**
 * Strip HTML and decode the entities Kanoon actually emits.
 *
 * `headline` arrives with `<b>` around matched terms, and WhatsApp renders
 * those literally. Written as a small scanner rather than a regex chain so
 * that a malformed tag degrades to visible text instead of eating the rest of
 * the snippet.
 */
export function stripHtml(input: string | undefined | null): string {
  if (!input) return '';

  const withoutTags = input
    // Block-ish tags become spaces so words either side do not fuse together.
    .replace(/<\s*(br|p|div|li|tr)\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');

  return withoutTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the total out of Kanoon's `found` string.
 *
 * The field looks like `"1 - 10 of 6142"`. Returns null when it cannot be
 * parsed, so callers fall back to counting the rows they actually received
 * rather than displaying a wrong total.
 */
export function parseFoundCount(found: string | undefined): number | null {
  if (!found) return null;
  const match = /of\s+([\d,]+)/i.exec(found);
  if (match) return Number(match[1].replace(/,/g, ''));

  // Some responses are a bare number.
  const bare = /^\s*([\d,]+)\s*$/.exec(found);
  return bare ? Number(bare[1].replace(/,/g, '')) : null;
}

/**
 * Kanoon titles embed the date: "X vs Y on 3 April, 2014".
 *
 * Removing it keeps the WhatsApp card from printing the date twice, since the
 * formatter renders `judgment_date` on its own line.
 */
export function cleanTitle(title: string | undefined): string {
  if (!title) return 'Untitled judgment';
  return stripHtml(title)
    .replace(/\s+on\s+\d{1,2}\s+\w+,?\s+\d{4}\s*$/i, '')
    .trim();
}

/** `publishdate` is ISO; guard against blanks and malformed values. */
export function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Kanoon's `docsource` mixed with its own quirks, mapped to a court type the
 * rest of the app understands.
 */
export function inferCourtType(docsource: string | undefined): string | null {
  if (!docsource) return null;
  const source = docsource.toLowerCase();
  if (source.includes('supreme court')) return 'SUPREME_COURT';
  if (source.includes('high court')) return 'HIGH_COURT';
  if (source.includes('tribunal') || source.includes('nclat') || source.includes('itat')) return 'TRIBUNAL';
  if (source.includes('district')) return 'DISTRICT';
  return null;
}

export function documentUrl(tid: number): string {
  return `https://indiankanoon.org/doc/${tid}/`;
}

/**
 * Kanoon's `doctypes:` slugs for the courts an advocate is likely to name.
 *
 * Keyed by the words people actually type. Several High Courts are known by a
 * city rather than their state ("Bombay" for Maharashtra, "Madras" for Tamil
 * Nadu), and advocates use both, so both are listed.
 *
 * Deliberately incomplete: a slug that is wrong is worse than one that is
 * missing, because a wrong `doctypes:` returns *nothing* and reads as "there is
 * no authority on this". Anything not listed here falls back to an unfiltered
 * search, which is merely less precise.
 */
const COURT_SLUGS: Record<string, string> = {
  'supreme court': 'supremecourt',
  supremecourt: 'supremecourt',
  sc: 'supremecourt',

  delhi: 'delhi',
  bombay: 'bombay',
  maharashtra: 'bombay',
  calcutta: 'kolkata',
  kolkata: 'kolkata',
  'west bengal': 'kolkata',
  madras: 'chennai',
  chennai: 'chennai',
  'tamil nadu': 'chennai',
  karnataka: 'karnataka',
  bangalore: 'karnataka',
  bengaluru: 'karnataka',
  kerala: 'kerala',
  gujarat: 'gujarat',
  rajasthan: 'rajasthan',
  allahabad: 'allahabad',
  'uttar pradesh': 'allahabad',
  patna: 'patna',
  bihar: 'patna',
  orissa: 'orissa',
  odisha: 'orissa',
  jharkhand: 'jharkhand',
  gauhati: 'gauhati',
  assam: 'gauhati',
};

/**
 * Pull a court restriction out of a natural-language query.
 *
 * "case law from Karnataka High Court" used to be sent to Kanoon verbatim,
 * where it is just relevance text - so the search happily returned Delhi and
 * Bombay judgments and the advocate's one explicit constraint was the only part
 * of the question ignored.
 *
 * Only fires when the query actually names a court: matching a bare state name
 * would restrict "bail under the Karnataka Excise Act" to Karnataka judgments,
 * which is a different question from the one asked.
 */
export function courtFilter(query: string): string | null {
  const lower = query.toLowerCase();

  // The court has to be *named as a court*, not merely mentioned.
  if (!/\b(high\s+court|supreme\s+court|hc\b)/.test(lower)) return null;

  for (const [needle, slug] of Object.entries(COURT_SLUGS)) {
    // Word-boundary matched so "sc" does not fire inside "prescription".
    if (new RegExp(`\\b${needle.replace(/\s+/g, '\\s+')}\\b`).test(lower)) {
      return slug;
    }
  }
  return null;
}

/**
 * Add the court restriction to the query Kanoon receives.
 *
 * The court words are left in the text rather than stripped: they are also
 * useful relevance signal, and removing them reliably from free-form English is
 * more likely to mangle the question than to help it.
 */
export function applyCourtFilter(query: string): string {
  const slug = courtFilter(query);
  return slug ? `${query} doctypes:${slug}` : query;
}

/**
 * One search result -> one PrecedentRow.
 *
 * `relevanceRank` is the position Kanoon returned it in; the caller re-sorts by
 * date afterwards, which is why the original rank has to be carried rather than
 * recomputed.
 */
export function toPrecedentRow(
  doc: KanoonSearchDoc,
  relevanceRank: number,
  totalMatches: number,
): PrecedentRow {
  const excerpt = stripHtml(doc.headline);

  return {
    // Namespaced so a Kanoon result is never mistaken for a local corpus row -
    // these ids are not UUIDs and nothing should try to join on them.
    judgment_id: `kanoon:${doc.tid}`,
    case_title: cleanTitle(doc.title),

    // Kanoon has no citations. Saying so with null is the point.
    neutral_citation: null,
    reporter_citations: [],

    court_name: doc.docsource ?? null,
    court_type: inferCourtType(doc.docsource),
    judgment_date: parseDate(doc.publishdate),

    // `bench` is numeric ids, so it cannot be shown. `author` is a real name,
    // and the id array is still good for counting how many judges sat.
    bench: doc.author ? [doc.author] : [],
    bench_strength: doc.bench?.length ?? null,

    act_sections: [],
    headnote: null,
    ratio_decidendi: null,
    disposition: null,

    source_url: documentUrl(doc.tid),
    best_excerpt: excerpt,
    para_number: null,

    // Kanoon returns no score. Rank is the only ordering signal it gives, so
    // derive a descending pseudo-score from it to keep PrecedentRow's contract
    // (higher = better) meaningful for any downstream sort.
    score: 1 / (relevanceRank + 1),
    relevance_rank: relevanceRank,
    total_matches: totalMatches,
  };
}

/**
 * Map a page of results, de-duplicate by tid, and apply the two-stage sort the
 * precedent feature requires: relevance decides membership, chronology decides
 * presentation order.
 */
export function toPrecedentRows(
  docs: KanoonSearchDoc[],
  totalMatches: number,
  maxResults: number,
): PrecedentRow[] {
  const seen = new Set<number>();
  const unique: KanoonSearchDoc[] = [];

  // Paging can repeat a document across pages; the first occurrence is the
  // more relevant one, so keep that.
  for (const doc of docs) {
    if (!doc || typeof doc.tid !== 'number' || seen.has(doc.tid)) continue;
    seen.add(doc.tid);
    unique.push(doc);
  }

  return unique
    .slice(0, maxResults)
    .map((doc, index) => toPrecedentRow(doc, index + 1, totalMatches))
    .sort((a, b) => {
      // Newest first, undated last, relevance as the tiebreaker.
      const left = a.judgment_date ? a.judgment_date.getTime() : Number.NEGATIVE_INFINITY;
      const right = b.judgment_date ? b.judgment_date.getTime() : Number.NEGATIVE_INFINITY;
      if (left !== right) return right - left;
      return a.relevance_rank - b.relevance_rank;
    });
}

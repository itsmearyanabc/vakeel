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
 * Every citation on a row is one Kanoon printed. A reported judgment arrives
 * with `citation` on the search result, and that is carried; an unreported one
 * arrives without it, and the row says so with an empty list. Nothing is ever
 * assembled from a title - a citation-shaped string built that way looks
 * quotable in a filing and is not, which is the one failure this product exists
 * to prevent.
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
 * A citations string, as a clean list.
 *
 * Kanoon joins a judgment's citations with commas - "AIR 1973 SUPREME COURT
 * 1461, 1973 4 SCC 225". Split, whitespace collapsed, duplicates dropped
 * without regard to case, and anything with no digit in it discarded: every
 * reporter citation has a year or a volume, and a fragment without one is a
 * stray label, not a citation.
 */
export function splitCitations(value: string | null | undefined): string[] {
  if (!value) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const part of stripHtml(value).split(/[,;]/)) {
    const citation = part.replace(/\s+/g, ' ').trim();
    if (!citation || !/\d/.test(citation)) continue;

    const key = citation.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }

  return out;
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
 * Every court and tribunal filter Indian Kanoon documents, and what advocates
 * call them.
 *
 * ## Why this was rewritten from the documentation
 *
 * The table used to hold fifteen High Court names and no tribunals, on the
 * reasoning that "a slug that is wrong is worse than one that is missing" -
 * true, and it had turned into a slug that is missing for most of the country.
 * Punjab and Haryana, Madhya Pradesh, Himachal Pradesh, Andhra Pradesh,
 * Uttarakhand, Chhattisgarh, Jammu and Kashmir, Sikkim and Meghalaya, and
 * every tribunal, got no filter at all - so "judgments from the Punjab and
 * Haryana High Court" searched all of India. That is the "random results"
 * report, for a dozen courts at once.
 *
 * The slugs below are exactly the ones in api.indiankanoon.org/documentation
 * ("The doctypes value for individual courts are ..."), including Kanoon's own
 * spellings: `chattisgarh`, `uttaranchal`, `himachal_pradesh`, `madhyapradesh`.
 *
 * ## Where one High Court is more than one slug
 *
 * The documentation allows comma-separated values ("doctypes:highcourts,cci"),
 * and several courts are split across benches Kanoon indexes separately. An
 * advocate naming the court means all of it:
 *
 *   Allahabad High Court  -> allahabad,lucknow   (Lucknow bench)
 *   Rajasthan High Court  -> rajasthan,jodhpur   (principal seat at Jodhpur)
 *   Calcutta High Court   -> kolkata,kolkata_app (appellate side)
 *   J&K High Court        -> jammu,srinagar
 *
 * ## What is deliberately absent
 *
 * Telangana, Manipur and Tripura High Courts have no documented slug. They are
 * left unfiltered rather than mapped to a neighbour, because a wrong doctypes
 * returns nothing, and nothing reads as "there is no authority on this".
 */
interface CourtEntry {
  /** Lowercase, as they appear in a question. Longer names first where one contains another. */
  names: string[];
  /** A documented doctypes value, or a comma-separated list of them. */
  slug: string;
}

const HIGH_COURTS: CourtEntry[] = [
  { names: ['supreme court of india', 'supreme court', 'apex court'], slug: 'supremecourt' },
  { names: ['delhi'], slug: 'delhi' },
  { names: ['bombay', 'maharashtra', 'mumbai', 'nagpur', 'aurangabad', 'goa'], slug: 'bombay' },
  { names: ['calcutta', 'kolkata', 'west bengal'], slug: 'kolkata,kolkata_app' },
  { names: ['madras', 'chennai', 'tamil nadu', 'madurai'], slug: 'chennai' },
  { names: ['allahabad', 'uttar pradesh'], slug: 'allahabad,lucknow' },
  { names: ['lucknow'], slug: 'lucknow' },
  { names: ['andhra pradesh', 'andhra'], slug: 'andhra' },
  { names: ['chhattisgarh', 'chattisgarh', 'bilaspur'], slug: 'chattisgarh' },
  { names: ['gauhati', 'guwahati', 'assam'], slug: 'gauhati' },
  { names: ['jammu and kashmir', 'jammu & kashmir', 'j&k', 'jammu', 'kashmir', 'ladakh'], slug: 'jammu,srinagar' },
  { names: ['srinagar'], slug: 'srinagar' },
  { names: ['kerala'], slug: 'kerala' },
  { names: ['orissa', 'odisha', 'cuttack'], slug: 'orissa' },
  { names: ['uttarakhand', 'uttaranchal', 'nainital'], slug: 'uttaranchal' },
  { names: ['gujarat'], slug: 'gujarat' },
  { names: ['himachal pradesh', 'himachal', 'shimla'], slug: 'himachal_pradesh' },
  { names: ['jharkhand', 'ranchi'], slug: 'jharkhand' },
  { names: ['karnataka', 'bangalore', 'bengaluru', 'dharwad', 'kalaburagi'], slug: 'karnataka' },
  { names: ['madhya pradesh', 'jabalpur', 'indore', 'gwalior'], slug: 'madhyapradesh' },
  { names: ['patna', 'bihar'], slug: 'patna' },
  { names: ['punjab and haryana', 'punjab & haryana', 'punjab', 'haryana', 'chandigarh'], slug: 'punjab' },
  { names: ['rajasthan', 'jaipur'], slug: 'rajasthan,jodhpur' },
  { names: ['jodhpur'], slug: 'jodhpur' },
  { names: ['sikkim'], slug: 'sikkim' },
  { names: ['meghalaya'], slug: 'meghalaya' },
];

/**
 * Tribunals, which are named without the words "High Court".
 *
 * Their acronyms are distinctive enough to stand alone, which the state names
 * above are not: "the Karnataka Excise Act" must not restrict a search to the
 * Karnataka High Court, but nobody writes "ITAT" meaning anything else. Where
 * an acronym is also an ordinary word - "sat", "cat" - only the full name is
 * accepted.
 */
const TRIBUNALS: CourtEntry[] = [
  { names: ['itat', 'income tax appellate tribunal'], slug: 'itat' },
  { names: ['ngt', 'national green tribunal', 'green tribunal'], slug: 'greentribunal' },
  { names: ['cestat', 'cegat', 'customs excise and service tax appellate tribunal'], slug: 'cegat' },
  { names: ['central administrative tribunal'], slug: 'cat' },
  { names: ['aptel', 'appellate tribunal for electricity'], slug: 'aptel' },
  { names: ['drat', 'debts recovery appellate tribunal'], slug: 'drat' },
  { names: ['securities appellate tribunal'], slug: 'sebisat' },
  { names: ['tdsat'], slug: 'tdsat' },
  { names: ['competition commission of india', 'competition commission'], slug: 'cci' },
  { names: ['central information commission'], slug: 'cic' },
  { names: ['ncdrc', 'consumer commission', 'consumer forum', 'consumer court'], slug: 'consumer' },
  { names: ['cerc', 'central electricity regulatory commission'], slug: 'cerc' },
  { names: ['ipab', 'intellectual property appellate board'], slug: 'ipab' },
  { names: ['company law board'], slug: 'clb' },
  { names: ['copyright board'], slug: 'copyrightboard' },
  { names: ['mrtp commission', 'mrtpc'], slug: 'mrtp' },
];

/** A name as a word-bounded, whitespace-tolerant pattern source. */
function namePattern(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
}

/**
 * The first position at which any of an entry's names occurs, or -1.
 *
 * `(?![a-z])` rather than a closing `\b`, because "j&k" ends in a letter but
 * "punjab & haryana" contains a character `\b` does not treat as a word edge.
 */
function firstIndex(text: string, entry: CourtEntry, suffix = ''): number {
  let best = -1;
  for (const name of entry.names) {
    const match = new RegExp(`(?<![a-z])${namePattern(name)}(?![a-z])${suffix}`).exec(text);
    if (match && (best === -1 || match.index < best)) best = match.index;
  }
  return best;
}

/**
 * The doctypes restriction for the court named in a question, or null.
 *
 * ## The order of preference, and the bug each step closes
 *
 * 1. **A tribunal, by name.** Distinctive without the words "High Court".
 *
 * 2. **All High Courts** - "high courts" in the plural means every one of them,
 *    and Kanoon has an aggregate for exactly that.
 *
 * 3. **The name next to "High Court".** This used to take the first name in the
 *    table that appeared anywhere in the question, so table order decided the
 *    court: "Karnataka High Court on a Delhi company" returned Delhi, because
 *    Delhi is listed first. The name that qualifies the court is the one
 *    directly before "High Court" or "HC", or directly after "High Court of".
 *
 * 4. **Any name, if a court is named at all.** "Judgments of the High Court,
 *    Patna" puts the name after the court.
 *
 * A court still has to be named as a court for a state to count: "bail under
 * the Karnataka Excise Act" restricts nothing.
 *
 * There is no bare "sc" any more. It was in the table and it matched the SC in
 * "SC/ST Act" - the Scheduled Castes and Tribes (Prevention of Atrocities) Act,
 * which is one of the most litigated statutes in the country - so a question
 * about SC/ST Act judgments in the Patna High Court was restricted to the
 * Supreme Court.
 */
export function courtFilter(query: string): string | null {
  const text = query.toLowerCase();

  // 1. Tribunals.
  const tribunal = TRIBUNALS.map((entry) => ({ entry, at: firstIndex(text, entry) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (tribunal) return tribunal.entry.slug;

  // 2. Every High Court.
  if (/\b(?:all\s+(?:the\s+)?)?high\s+courts\b/.test(text)) return 'highcourts';

  const namesCourt = /\b(high\s+court|hc|supreme\s+court|apex\s+court)\b/.test(text);
  if (!namesCourt) return null;

  // 3. The name that qualifies "High Court" - before it, or after "High Court of".
  const adjacent = HIGH_COURTS.map((entry) => {
    const before = firstIndex(text, entry, '\\s+(?:high\\s+court|hc)\\b');
    const after = new RegExp(
      `high\\s+court\\s+(?:of|at|,)\\s+(?:the\\s+state\\s+of\\s+)?(?:${entry.names.map(namePattern).join('|')})(?![a-z])`,
    ).exec(text);
    const at = [before, after ? after.index : -1].filter((i) => i >= 0);
    return { entry, at: at.length ? Math.min(...at) : -1 };
  })
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (adjacent.length > 0) return adjacent[0].entry.slug;

  // The Supreme Court is named by its own words, never by a state.
  if (/\b(supreme|apex)\s+court\b/.test(text)) return 'supremecourt';

  // 4. A court is named and a state appears somewhere near it.
  const anywhere = HIGH_COURTS.map((entry) => ({ entry, at: firstIndex(text, entry) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  return anywhere ? anywhere.entry.slug : null;
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

    /*
     * The citation the search result already carries, when there is one.
     *
     * This was hard-coded empty on the belief that Kanoon exposes no citations,
     * which came from probing an unreported judgment. A reported one sends
     * `citation: "AIR 1973 SUPREME COURT 1461"` on the search result itself - so
     * every reported row gets EQUIVALENT CITATIONS with no document fetch at
     * all, including the rows past the first page that are never enriched.
     */
    neutral_citation: null,
    reporter_citations: splitCitations(doc.citation),

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

import { stripHtml } from './kanoon.mapper';

/**
 * The two fields Indian Kanoon holds but does not expose as fields.
 *
 * ## What the live API actually returns
 *
 * Captured from `/doc/113036187/` on 2026-09-05, because the previous adapter
 * written from documentation - eCourts - was wrong three separate ways and none
 * of it surfaced until a real request was made.
 *
 *   search:   authorid bench catids docsize docsource doctype fragment
 *             headline numcitedby numcites publishdate tid title
 *   document: citetid courtcopy divtype doc docsource numcitedby numcites
 *             publishdate query_alert relatedqs tid title
 *
 * Neither carries a case number and neither carries a citation. `citetid` is
 * not a citation - it is the document's own id repeated.
 *
 * What the *document* has that the search result does not is `doc`: the whole
 * judgment as HTML, roughly 1.1 MB of it, whose header carries both things a
 * card needs:
 *
 *   <h2 class="doc_title">Rajender Kumar & Ors. vs . State Of H.P. …</h2>
 *   <h3 class="doc_bench">Bench: <a …>Tarlok Singh Chauhan</a>, <a …>Virender Singh</a></h3>
 *   <div class="judgments"><p>… CWP No. 2843/2019, a/w CWP No.4189/19, …</p>
 *
 * So the case number is prose in the cause title, and the bench is a real list
 * of names - which is worth having on its own, since the search endpoint gives
 * only `bench: [888, 1990]`, numeric author ids that cannot be shown to anyone.
 *
 * ## What this deliberately does not do
 *
 * It does not invent a citation. There is none to find, at either endpoint, and
 * a citation-shaped string assembled from a title would be the exact failure
 * this product exists to prevent.
 *
 * It also reads only the head of the document. The body is a megabyte of
 * judgment text and every pattern below belongs to the header; scanning the
 * whole thing would find case numbers quoted from other matters.
 */

export interface DocumentHeader {
  /** "CWP No. 2843/2019", or null when the header states none. */
  caseNumber: string | null;
  /** Judge names, in the order the coram lists them. */
  bench: string[];
}

/**
 * How much of the document to look at.
 *
 * The cause title, the coram and the case numbers are all inside the first few
 * thousand characters. Past that the judgment starts citing other matters by
 * number, and the first match stops being this case's own.
 */
const HEADER_CHARS = 4000;

/**
 * A case number as Indian courts write one.
 *
 * The shape is a case-type abbreviation, the word No./Nos., a serial, then a
 * year separated by a slash or by "of". Every part varies:
 *
 *   CWP No. 2843/2019          Himachal, Punjab & Haryana
 *   CWJC No. 1234 of 2004      Patna
 *   Crl.A. No. 123 of 2019     dots inside the type
 *   W.P.(C) 5678/2021          bracketed suffix, and no "No."
 *   SLP (C) No. 1234 of 2020   space before the bracket
 *
 * The type is capped at 12 characters so a sentence cannot drift into it, and
 * the year accepts two digits because "CWP No.4189/19" is written that way in
 * the same breath as "CWP No. 2843/2019".
 */
const CASE_NUMBER =
  /\b([A-Z][A-Za-z.]{0,11}(?:\s*\([A-Za-z.]{1,6}\))?)\s*(?:Nos?\.?\s*)?(\d{1,6})\s*(?:\/|\s+of\s+)\s*((?:19|20)?\d{2})\b/;

/**
 * Case-type abbreviations we accept.
 *
 * Required because the pattern above is otherwise happy to read "Chauhan 16 of
 * 2022" out of a coram. A case number's type is an abbreviation - short, and
 * either all capitals or capitals with dots - so that is what is checked,
 * rather than a list of every registry's naming convention, which differs by
 * court and changes.
 */
function looksLikeCaseType(token: string): boolean {
  const bare = token.replace(/[.\s()]/g, '');
  if (bare.length < 2 || bare.length > 10) return false;

  // Honorifics are short, dotted, and sit next to numbers often enough to
  // matter - "Mr. 16 of 2022" is not a case number.
  if (/^(mr|mrs|ms|dr|sr|jr|hon|smt|shri)$/i.test(bare)) return false;

  /*
   * All capitals, or dotted.
   *
   * "All capitals" alone was the first rule, and it rejected `Crl.A.`,
   * `Crl.M.C.` and `W.P.(Crl.)` - which is most of the criminal side of every
   * registry in the country. The dots are the real signal: an abbreviation has
   * them and a name does not, so "Chauhan 16 of 2022" in a coram is still
   * refused.
   */
  return /^[A-Z]+$/.test(bare) || token.includes('.');
}

/**
 * Pull the case number and the coram out of a judgment's header.
 *
 * Both come back null/empty rather than guessed. A card that says "Not
 * available" is telling the truth about a document we could not read; a card
 * with a plausible wrong case number is worse than either.
 */
export function parseDocumentHeader(html: string | null | undefined): DocumentHeader {
  if (!html) return { caseNumber: null, bench: [] };

  const head = html.slice(0, HEADER_CHARS);

  return { caseNumber: findCaseNumber(head), bench: findBench(head) };
}

/**
 * The coram, from the `doc_bench` heading.
 *
 * Taken from the anchor text rather than from the heading's plain text, because
 * Kanoon links each judge to a bench search and the anchors are exactly the
 * names - no splitting on commas, and no "Bench:" label to strip.
 */
function findBench(head: string): string[] {
  const heading = /<h3[^>]*class="[^"]*doc_bench[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(head);
  if (!heading) return [];

  const names: string[] = [];
  const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchor.exec(heading[1]);

  while (match) {
    const name = stripHtml(match[1]);
    if (name) names.push(name);
    match = anchor.exec(heading[1]);
  }

  // Older documents write the coram without links. The label is dropped and
  // what remains is split on the separators Kanoon uses between names.
  if (names.length === 0) {
    const plain = stripHtml(heading[1]).replace(/^bench\s*:?\s*/i, '');
    return plain
      .split(/\s*(?:,|&amp;|&|\band\b)\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return names;
}

/**
 * The first case number in the header, which is this case's own.
 *
 * "First" is load-bearing. A judgment disposing of connected matters lists
 * dozens - the sample header runs to fifty - and the one the cause title opens
 * with is the lead case. The rest are connected matters, and printing them all
 * would fill the card.
 */
function findCaseNumber(head: string): string | null {
  // Tags become spaces so a number split across them does not fuse with the
  // word before it, which is how "…matters .CWP" would have read.
  const text = stripHtml(head);

  // Skipping the cause title avoids reading a year out of "on 16 August, 2022".
  const afterTitle = text.replace(/^.*?\bon\s+\d{1,2}\s+[A-Za-z]+,?\s*\d{4}/i, '');
  const searchable = afterTitle.trim() || text;

  let offset = 0;
  while (offset < searchable.length) {
    const match = CASE_NUMBER.exec(searchable.slice(offset));
    if (!match) return null;

    const [whole, type, serial, year] = match;
    if (looksLikeCaseType(type)) {
      const fullYear = year.length === 2 ? `20${year}` : year;
      return `${type.trim()} No. ${serial}/${fullYear}`;
    }

    offset += (match.index ?? 0) + whole.length;
  }

  return null;
}

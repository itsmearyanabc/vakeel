/**
 * Wire types for the Indian Kanoon API, captured from live responses on
 * 2026-08-08 rather than transcribed from documentation.
 *
 * Three fields are not what their names suggest, and each has burned someone:
 *
 *  - `found` is a **string** like `"1 - 10 of 6142"`, not a number.
 *  - `bench` is an array of **numeric author IDs**, not judge names. Rendering
 *    it directly shows an advocate "520, 528, 535" as the coram.
 *  - `headline` is a search-result snippet with `<b>` highlight tags around the
 *    query terms - it is not a headnote, and it is not plain text.
 *
 * Citations are there, but only for judgments a reporter carried. This header
 * used to say there was no citation field anywhere in the API, and that was
 * wrong: it was concluded from one unreported 2022 High Court judgment, whose
 * response simply had nothing to put in one. A reported Supreme Court judgment
 * (tid 257876, captured 2026-09-14) carries `citation` on the search result and
 * the full list in the document's `doc_citations` heading. See
 * document.parser.ts.
 */

export interface KanoonSearchDoc {
  /** Kanoon's document id. Stable, and the key to /doc/{tid}/. */
  tid: number;
  /** e.g. "Teru Majhi & Anr vs State Of West Bengal & Ors on 3 April, 2014" */
  title: string;
  /** ISO date, e.g. "2014-04-03". */
  publishdate?: string;
  /** Snippet with <b> tags around matched terms. */
  headline?: string;
  /** e.g. "Calcutta High Court (Appellete Side)" - Kanoon's own spelling. */
  docsource?: string;
  /**
   * The first reporter citation - "AIR 1973 SUPREME COURT 1461".
   *
   * Absent, not null, on a judgment no reporter carried, which is most High
   * Court judgments. Only the first citation: the document's `doc_citations`
   * heading has the rest ("..., 1973 4 SCC 225").
   */
  citation?: string;
  /** Author IDs, NOT names. Length is usable as bench strength. */
  bench?: number[];
  /** The authoring judge's name, e.g. "A K Banerjee". This one IS a name. */
  author?: string;
  authorid?: number;
  authorEncoded?: string;
  /** How many judgments this one cites. */
  numcites?: number;
  /** How many cite it - a rough proxy for how load-bearing it is. */
  numcitedby?: number;
  doctype?: number;
  docsize?: number;
  catids?: number[];
  fragment?: boolean;
}

export interface KanoonSearchResponse {
  docs?: KanoonSearchDoc[];
  /** "1 - 10 of 6142". Parse with parseFoundCount(). */
  found?: string;
  categories?: unknown[];
  encodedformInput?: string;
  /** Present instead of docs when the request is rejected. */
  error?: string;
  errmsg?: string;
}

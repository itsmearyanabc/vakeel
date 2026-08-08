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
 * There is no citation field anywhere in this API. Not in `/search/`, not in
 * `/doc/`. See kanoon.service.ts for how that is handled honestly.
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

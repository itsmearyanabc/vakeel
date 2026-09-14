import reported from './__fixtures__/kanoon-reported-document.json';
import unreported from './__fixtures__/kanoon-document.json';
import { parseDocumentHeader } from './document.parser';
import { splitCitations, toPrecedentRow } from './kanoon.mapper';
import { KanoonService } from './kanoon.service';

/**
 * EQUIVALENT CITATIONS, which were declared impossible and are not.
 *
 * ## How that happened
 *
 * The first probe of the live API fetched one judgment - Rajender Kumar vs
 * State of H.P., an unreported 2022 High Court decision - found no citation in
 * its search result or its document, and concluded that Kanoon exposes no
 * citations at all. That conclusion went into three files' worth of comments
 * and into several replies explaining why the field would always be empty.
 *
 * A second probe, prompted by the advocate pointing at Kanoon's own
 * documentation, fetched a reported Supreme Court judgment instead:
 *
 *   search:   citation: "AIR 1973 SUPREME COURT 1461"
 *   document: <h3 class="doc_citations">Equivalent citations:
 *             AIR 1973 SUPREME COURT 1461, 1973 4 SCC 225</h3>
 *
 * The first judgment had no citations because no reporter ever carried it. The
 * lesson these tests keep is the one in their fixtures: one of each.
 */

describe('a reported judgment', () => {
  const header = parseDocumentHeader(reported.doc);

  it('carries its full citation list in the doc_citations heading', () => {
    expect(header.equivalentCitations).toEqual(['AIR 1973 SUPREME COURT 1461', '1973 4 SCC 225']);
  });

  it('reads the labelled case number as the judgment states it', () => {
    /*
     * "Writ Petition (civil) 135 of 1970" is not an abbreviation, so the case
     * number pattern skipped it; the later "W.P.(C) 135 OF 1970" used a capital
     * OF the pattern did not accept. The labelled block states it outright.
     */
    expect(header.caseNumber).toBe('Writ Petition (civil) 135 of 1970');
  });

  it('reads all twelve judges of the bench', () => {
    expect(header.bench).toHaveLength(12);
    expect(header.bench[0]).toBe('S.M. Sikri');
    expect(header.bench).toContain('Y.V.Chandrachud');
  });

  it('has no neutral citation, because the scheme began fifty years later', () => {
    expect(header.neutralCitation).toBeNull();
  });
});

describe('an unreported judgment', () => {
  it('has no equivalent citations, and that is the truth rather than a failure', () => {
    // This is the judgment the "impossible" conclusion was drawn from. It is
    // kept as a fixture precisely so both halves stay tested.
    expect(parseDocumentHeader(unreported.doc).equivalentCitations).toEqual([]);
  });
});

describe('the citation on the search result itself', () => {
  it('reaches the card with no document fetch at all', () => {
    // Every reported row gets a citation this way - including rows past the
    // first page, which are never enriched with their document.
    const row = toPrecedentRow(reported.search as never, 1, 214);

    expect(row.reporter_citations).toEqual(['AIR 1973 SUPREME COURT 1461']);
  });

  it('is an empty list, not an error, when the field is absent', () => {
    const row = toPrecedentRow({ tid: 1, title: 'X vs Y on 1 January, 2022' } as never, 1, 1);

    expect(row.reporter_citations).toEqual([]);
  });
});

describe('splitCitations', () => {
  it('splits on commas, collapses whitespace and drops duplicates without regard to case', () => {
    expect(splitCitations(' AIR 1973 SC 1461,  1973 4 SCC 225 , air 1973 sc 1461')).toEqual([
      'AIR 1973 SC 1461',
      '1973 4 SCC 225',
    ]);
  });

  it('discards a fragment with no digit, which is a stray label and not a citation', () => {
    expect(splitCitations('AIR 1973 SC 1461, Supreme Court')).toEqual(['AIR 1973 SC 1461']);
  });

  it('returns nothing for nothing', () => {
    expect(splitCitations(undefined)).toEqual([]);
    expect(splitCitations('')).toEqual([]);
  });
});

describe('the summary does not read the labelled header as reasoning', () => {
  /*
   * Synthetic, not captured: the reporting system's labelled block wrapped in a
   * paragraph, followed by an opening that states the question. The block is
   * long enough and low enough in digits to pass every other furniture test, so
   * without its own rule the case summary would describe a list of parties.
   */
  const html =
    '<h2 class="doc_title">A vs B on 1 January, 1990</h2>' +
    '<p>CASE NO.: Civil Appeal 12 of 1989 PETITIONER: Ram Prasad RESPONDENT: Shyam Lal DATE OF JUDGMENT: 01/01/1990 BENCH: X and Y</p>' +
    '<p>The appellant challenges the judgment of the High Court dismissing his suit for specific performance, and the only question is whether a concluded agreement ever came into existence.</p>';

  it('skips the block and reaches the question', () => {
    const extract = parseDocumentHeader(html).extract;

    expect(extract).not.toContain('CASE NO');
    expect(extract).not.toContain('PETITIONER');
    expect(extract).toContain('specific performance');
  });
});

describe('a header cached before this field existed', () => {
  /*
   * Headers are cached in Postgres for a day. One stored by the previous build
   * has no equivalentCitations at all, and reading `.length` off it rejected
   * the whole Promise.all in withHeaders - every card lost, not just the one.
   */
  function service(stored: unknown) {
    const cache = {
      get: jest.fn().mockResolvedValue(stored),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const settings = {
      get: (key: string) => (key === 'KANOON_API_KEY' ? 'test-key' : ''),
      getNumber: (_key: string, fallback: number) => fallback,
    };
    const env = {
      KANOON_API_KEY: '',
      KANOON_BASE_URL: 'https://api.indiankanoon.org',
      KANOON_TIMEOUT_MS: 1000,
      KANOON_CACHE_TTL_SECONDS: 60,
      KANOON_BREAKER_THRESHOLD: 5,
      KANOON_BREAKER_RESET_MS: 1000,
    };
    return { instance: new KanoonService(cache as never, env as never, settings as never), cache };
  }

  it('fills the missing fields with empties instead of undefined', async () => {
    const { instance } = service({ caseNumber: 'CWP No. 1/2020', bench: ['A'] });

    const header = await instance.documentHeader(113036187);

    expect(header.caseNumber).toBe('CWP No. 1/2020');
    expect(header.equivalentCitations).toEqual([]);
    expect(header.neutralCitation).toBeNull();
    expect(header.extract).toBe('');
  });

  it('reads under a new key, so old citation-less entries are not served at all', async () => {
    const { instance, cache } = service({ caseNumber: null, bench: [] });

    await instance.documentHeader(257876);

    expect(cache.get).toHaveBeenCalledWith('kanoon:doc:v2:257876');
  });
});

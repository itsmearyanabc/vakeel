import fixture from './__fixtures__/kanoon-document.json';
import { parseDocumentHeader } from './document.parser';

/**
 * Asserted against a payload captured from the live API, not from docs.
 *
 * The last adapter built the other way was eCourts, and it was wrong in three
 * separate ways - nesting, arrays, and where the dates lived - none of which
 * surfaced until somebody made a real request.
 */
describe('reading a judgment header', () => {
  const header = parseDocumentHeader(fixture.doc);

  it('finds the case number Kanoon exposes as no field at all', () => {
    // Neither endpoint has a case-number field. It is prose, in the cause
    // title, and this is the only place it exists.
    expect(header.caseNumber).toBe('CWP No. 2843/2019');
  });

  it('takes the lead case, not the fifty connected matters after it', () => {
    // This judgment disposes of connected matters and its header lists dozens.
    // The first is the lead case; printing the rest would fill the card.
    expect(header.caseNumber).not.toContain('4189');
    expect(header.caseNumber).not.toContain('COPC');
  });

  it('reads the coram as names', () => {
    // The search endpoint gives `bench: [888, 1990]` - author ids, which cannot
    // be shown to anybody. The document links each judge by name.
    expect(header.bench).toEqual(['Tarlok Singh Chauhan', 'Virender Singh']);
  });
});

describe('the shapes different registries use', () => {
  const withHeader = (body: string): string =>
    `<h2 class="doc_title">X vs Y on 1 January, 2020</h2><div>${body}</div>`;

  it.each([
    ['CWJC No. 1234 of 2004', 'CWJC No. 1234/2004'],
    ['Crl.A. No. 123 of 2019', 'Crl.A. No. 123/2019'],
    ['CWP No.4189/19', 'CWP No. 4189/2019'],
    ['SLP (C) No. 1234 of 2020', 'SLP (C) No. 1234/2020'],
  ])('reads %p', (written, expected) => {
    expect(parseDocumentHeader(withHeader(written)).caseNumber).toBe(expected);
  });

  it('does not read a case number out of a judge name and a year', () => {
    // The pattern is loose enough to match "Chauhan 16 of 2022" out of a coram,
    // so the type has to look like a registry abbreviation - short, capitals.
    const out = parseDocumentHeader(
      withHeader('Present: Mr Sanjeev Bhushan, Senior Advocate. Heard 16 of 2022 arguments.'),
    );
    expect(out.caseNumber).toBeNull();
  });

  it('says nothing rather than guessing when the header has no number', () => {
    expect(parseDocumentHeader(withHeader('Present: counsel for the parties.')).caseNumber).toBeNull();
  });

  it('survives an empty or missing document', () => {
    const empty = { caseNumber: null, neutralCitation: null, bench: [], extract: '' };
    expect(parseDocumentHeader('')).toEqual(empty);
    expect(parseDocumentHeader(null)).toEqual(empty);
  });

  it('reads an unlinked coram, which older documents have', () => {
    const out = parseDocumentHeader(
      '<h3 class="doc_bench">Bench: A K Sikri, Ashok Bhushan</h3><div>CWP No. 1/2019</div>',
    );
    expect(out.bench).toEqual(['A K Sikri', 'Ashok Bhushan']);
  });
});

describe('the criminal side, where the abbreviations are not all capitals', () => {
  const withHeader = (body: string): string =>
    `<h2 class="doc_title">X vs Y on 1 January, 2020</h2><div>${body}</div>`;

  it.each([
    ['Crl.M.C. No. 456 of 2021', 'Crl.M.C. No. 456/2021'],
    ['Crl.O.P. No. 789/2022', 'Crl.O.P. No. 789/2022'],
    ['W.P.(Crl.) No. 45 of 2023', 'W.P.(Crl.) No. 45/2023'],
  ])('reads %p', (written, expected) => {
    // "All capitals" was the first discriminator and it rejected every one of
    // these - which is most of the criminal side of every registry in India.
    expect(parseDocumentHeader(withHeader(written)).caseNumber).toBe(expected);
  });

  it('still refuses an honorific standing next to a number', () => {
    // Honorifics are short and dotted, which is exactly what the dot rule now
    // accepts, so they are named and excluded.
    expect(parseDocumentHeader(withHeader('Present: Mr. 16 of 2022')).caseNumber).toBeNull();
  });
});

describe('reading what the judgment is actually about', () => {
  /*
   * LEGAL PRINCIPLE read "Not available" on every card, and the reason was the
   * input rather than the summariser. It was being given Kanoon's `headline`,
   * which for a title match is the cause title echoed back with the query words
   * emboldened. Asked to find a principle in a cause title, the model correctly
   * answered that there was none.
   *
   * The document has been fetched for the case number by then, so the court's
   * own words are already in hand.
   */
  const opening = parseDocumentHeader(fixture.doc).extract;

  it('skips the cause title, the coram and the case-number list', () => {
    // The sample's header runs to fifty case numbers in one paragraph, and the
    // paragraph after it is a page of counsel names.
    expect(opening).not.toContain('CWPOA');
    expect(opening).not.toContain('6943');
    expect(opening).not.toMatch(/^Present:/);
  });

  it('skips the appearances, which are names and nothing else', () => {
    expect(opening).not.toContain('Sanjeev Bhushan');
  });

  it('is bounded, because the judgment is a megabyte', () => {
    expect(opening.length).toBeLessThanOrEqual(2000);
  });
});

describe('the extract is the question the court had to decide', () => {
  const opening = parseDocumentHeader(fixture.doc).extract;

  it('reaches the reasoning', () => {
    // What an advocate scanning ten results wants is not the outcome - "the
    // petition is allowed" - but what the case was about.
    expect(opening).toContain('daily-waged');
    expect(opening).toContain('regularisation');
  });

  it('returns nothing rather than furniture when there is no reasoning', () => {
    /*
     * The first version fell back to the plain body when no paragraph passed
     * the filter. What that returns is the cause title, fifty case numbers and
     * a page of counsel names - and this string is what LEGAL PRINCIPLE prints.
     * "Not available" is true; a list of case numbers presented as the holding
     * is not.
     */
    const headerOnly =
      '<h2 class="doc_title">X vs Y on 1 January, 2020</h2>' +
      '<div><p>CWP No. 1/2020, CWP No. 2/2020, CWP No. 3/2020, CWP No. 4/2020, CWP No. 5/2020</p>' +
      '<p>Present: Mr. A. K. Gupta, Advocate, for the petitioner and Ms. B. Sharma for the State.</p></div>';

    expect(parseDocumentHeader(headerOnly).extract).toBe('');
  });
});

describe('the one citation nobody sells', () => {
  const withHeader = (body: string): string =>
    `<h2 class="doc_title">X vs Y on 1 January, 2024</h2><div>${body}</div>`;

  /*
   * EQUIVALENT CITATIONS has been empty on every card, and for AIR, SCC and
   * PLJR it always will be: those are the products those reporters license and
   * Kanoon exposes none of them at either endpoint.
   *
   * Neutral citations are different. The courts assign them and print them in
   * the judgment, so where one exists it is free to read.
   */
  it.each([
    ['Neutral Citation No. 2024:PHHC:012345', '2024:PHHC:012345'],
    ['2023:DHC:1234-DB', '2023:DHC:1234-DB'],
    ['Reportable 2023 INSC 456', '2023 INSC 456'],
    ['2024 : ORHC : 9876', '2024:ORHC:9876'],
  ])('reads %p', (written, expected) => {
    expect(parseDocumentHeader(withHeader(written)).neutralCitation).toBe(expected);
  });

  it('finds none on a judgment older than the scheme', () => {
    // The Supreme Court began in 2023 and the High Courts came in over 2023-24.
    // A 2005 judgment has no neutral citation and never will, so "Not
    // available" on that card is the truth rather than a gap.
    expect(parseDocumentHeader(fixture.doc).neutralCitation).toBeNull();
  });

  it('does not read a case number as a citation', () => {
    expect(parseDocumentHeader(withHeader('CWP No. 2843/2019')).neutralCitation).toBeNull();
  });
});

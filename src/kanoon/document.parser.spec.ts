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
    expect(parseDocumentHeader('')).toEqual({ caseNumber: null, bench: [] });
    expect(parseDocumentHeader(null)).toEqual({ caseNumber: null, bench: [] });
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

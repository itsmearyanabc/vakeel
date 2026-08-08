import {
  cleanTitle,
  documentUrl,
  inferCourtType,
  parseDate,
  parseFoundCount,
  stripHtml,
  toPrecedentRow,
  toPrecedentRows,
} from './kanoon.mapper';
import { KanoonSearchDoc } from './kanoon.types';

/**
 * A real document from api.indiankanoon.org, captured 2026-08-08.
 *
 * Kept verbatim - including Kanoon's own "Appellete" typo - because the point
 * of this fixture is that it is what the API actually sends, not what the docs
 * say it sends.
 */
const REAL_DOC: KanoonSearchDoc = {
  tid: 174268577,
  catids: [41, 4, 13, 239],
  doctype: 1006,
  publishdate: '2014-04-03',
  authorid: 520,
  bench: [520, 528, 535],
  title: 'Teru Majhi & Anr vs State Of West Bengal & Ors on 3 April, 2014',
  numcites: 105,
  numcitedby: 6,
  headline:
    'grant of <b>bail</b>. The right of an accused, to apply for <b>anticipatory</b> <b>bail</b>,\n\nin a proceeding under the  <b>Narcotic</b> Drugs Act',
  docsize: 121087,
  fragment: true,
  docsource: 'Calcutta High Court (Appellete Side)',
  author: 'A K Banerjee',
  authorEncoded: 'a-k-banerjee',
};

describe('stripHtml', () => {
  it('removes the <b> highlight tags Kanoon wraps around query terms', () => {
    // WhatsApp renders these literally, so an unstripped snippet shows the user
    // raw markup.
    expect(stripHtml('grant of <b>bail</b> here')).toBe('grant of bail here');
  });

  it('collapses the newlines and runs of whitespace in real headlines', () => {
    expect(stripHtml(REAL_DOC.headline)).toBe(
      'grant of bail. The right of an accused, to apply for anticipatory bail, in a proceeding under the Narcotic Drugs Act',
    );
  });

  it('turns block tags into spaces so words do not fuse', () => {
    expect(stripHtml('first<br>second')).toBe('first second');
    expect(stripHtml('<p>one</p><p>two</p>')).toBe('one two');
  });

  it('decodes the entities that appear in case titles', () => {
    expect(stripHtml('State &amp; Anr')).toBe('State & Anr');
    expect(stripHtml('&lt;tag&gt; &quot;quoted&quot; &#39;apos&#39;')).toBe('<tag> "quoted" \'apos\'');
  });

  it('handles empty input without throwing', () => {
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml(null)).toBe('');
    expect(stripHtml('')).toBe('');
  });
});

describe('parseFoundCount', () => {
  it('parses the real "1 - 10 of 6142" shape', () => {
    // The field is a STRING, not a number. Treating it as a count yields NaN.
    expect(parseFoundCount('1 - 10 of 6142')).toBe(6142);
  });

  it('handles thousands separators', () => {
    expect(parseFoundCount('1 - 10 of 1,234,567')).toBe(1_234_567);
  });

  it('accepts a bare number', () => {
    expect(parseFoundCount('42')).toBe(42);
  });

  it('returns null rather than a wrong total when unparseable', () => {
    expect(parseFoundCount(undefined)).toBeNull();
    expect(parseFoundCount('lots')).toBeNull();
  });
});

describe('cleanTitle', () => {
  it('strips the trailing date Kanoon embeds in titles', () => {
    // Otherwise the card prints the date twice.
    expect(cleanTitle(REAL_DOC.title)).toBe('Teru Majhi & Anr vs State Of West Bengal & Ors');
  });

  it('leaves a title with no trailing date alone', () => {
    expect(cleanTitle('Kesavananda Bharati vs State Of Kerala')).toBe('Kesavananda Bharati vs State Of Kerala');
  });

  it('falls back rather than returning an empty card', () => {
    expect(cleanTitle(undefined)).toBe('Untitled judgment');
  });
});

describe('inferCourtType', () => {
  it.each([
    ['Supreme Court of India', 'SUPREME_COURT'],
    ['Calcutta High Court (Appellete Side)', 'HIGH_COURT'],
    ['Income Tax Appellate Tribunal', 'TRIBUNAL'],
    ['District Court, Pune', 'DISTRICT'],
  ])('maps %s', (source, expected) => {
    expect(inferCourtType(source)).toBe(expected);
  });

  it('returns null for anything unrecognised', () => {
    expect(inferCourtType('Some Other Body')).toBeNull();
    expect(inferCourtType(undefined)).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses the ISO publishdate', () => {
    expect(parseDate('2014-04-03')?.getUTCFullYear()).toBe(2014);
  });

  it('returns null for missing or malformed dates', () => {
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('not-a-date')).toBeNull();
  });
});

describe('toPrecedentRow', () => {
  const row = toPrecedentRow(REAL_DOC, 1, 6142);

  it('never invents a citation', () => {
    // Kanoon exposes none, anywhere. A citation-shaped string here would look
    // quotable in a filing and not be real - the exact failure this product
    // exists to prevent.
    expect(row.neutral_citation).toBeNull();
    expect(row.reporter_citations).toEqual([]);
  });

  it('offers the document URL as the reference instead', () => {
    expect(row.source_url).toBe('https://indiankanoon.org/doc/174268577/');
    expect(documentUrl(1)).toBe('https://indiankanoon.org/doc/1/');
  });

  it('does NOT put the numeric bench ids in the bench field', () => {
    // `bench` is [520, 528, 535] - author IDs. Rendering them would show an
    // advocate "520, 528, 535" as the coram.
    expect(row.bench).toEqual(['A K Banerjee']);
    expect(row.bench.join()).not.toMatch(/\d{3}/);
  });

  it('uses the bench array only for its length', () => {
    expect(row.bench_strength).toBe(3);
  });

  it('namespaces the id so it cannot be confused with a local corpus row', () => {
    expect(row.judgment_id).toBe('kanoon:174268577');
  });

  it('carries a stripped excerpt and the real court and date', () => {
    expect(row.best_excerpt).not.toContain('<b>');
    expect(row.court_name).toBe('Calcutta High Court (Appellete Side)');
    expect(row.court_type).toBe('HIGH_COURT');
    expect(row.judgment_date?.getUTCFullYear()).toBe(2014);
  });

  it('leaves fields Kanoon cannot supply as null rather than guessing', () => {
    expect(row.headnote).toBeNull();
    expect(row.ratio_decidendi).toBeNull();
    expect(row.disposition).toBeNull();
    expect(row.act_sections).toEqual([]);
  });

  it('derives a descending score from rank so ordering stays meaningful', () => {
    expect(toPrecedentRow(REAL_DOC, 1, 10).score).toBeGreaterThan(toPrecedentRow(REAL_DOC, 5, 10).score);
  });
});

describe('toPrecedentRows', () => {
  const doc = (tid: number, date: string | undefined): KanoonSearchDoc => ({
    ...REAL_DOC,
    tid,
    publishdate: date,
    title: `Case ${tid} on 1 January, 2020`,
  });

  it('sorts newest first while keeping relevance as the membership test', () => {
    const rows = toPrecedentRows(
      [doc(1, '2010-01-01'), doc(2, '2024-01-01'), doc(3, '2018-01-01')],
      3,
      15,
    );
    expect(rows.map((r) => r.judgment_id)).toEqual(['kanoon:2', 'kanoon:3', 'kanoon:1']);
    // Relevance rank is preserved, so the UI can still show which Kanoon
    // considered strongest.
    expect(rows.find((r) => r.judgment_id === 'kanoon:1')?.relevance_rank).toBe(1);
  });

  it('de-duplicates documents repeated across pages', () => {
    const rows = toPrecedentRows([doc(1, '2020-01-01'), doc(1, '2020-01-01'), doc(2, '2021-01-01')], 3, 15);
    expect(rows).toHaveLength(2);
  });

  it('caps at maxResults', () => {
    const many = Array.from({ length: 30 }, (_, i) => doc(i + 1, '2020-01-0' + ((i % 9) + 1)));
    expect(toPrecedentRows(many, 30, 15)).toHaveLength(15);
  });

  it('sinks undated judgments to the bottom rather than the top', () => {
    const rows = toPrecedentRows([doc(1, undefined), doc(2, '2024-01-01')], 2, 15);
    expect(rows[0].judgment_id).toBe('kanoon:2');
    expect(rows[rows.length - 1].judgment_id).toBe('kanoon:1');
  });

  it('propagates the real total to every row', () => {
    const rows = toPrecedentRows([doc(1, '2020-01-01')], 6142, 15);
    expect(rows[0].total_matches).toBe(6142);
  });

  it('skips malformed entries instead of throwing', () => {
    const rows = toPrecedentRows(
      [null as unknown as KanoonSearchDoc, { title: 'no tid' } as KanoonSearchDoc, doc(9, '2020-01-01')],
      3,
      15,
    );
    expect(rows).toHaveLength(1);
  });
});

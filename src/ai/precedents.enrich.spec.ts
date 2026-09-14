import { PrecedentRow } from '../database/types';
import { PrecedentsService } from './precedents.service';

/**
 * Filling CASE NO. and BENCH from the judgment, at a cost worth controlling.
 *
 * Indian Kanoon's search response was captured live and carries neither. There
 * is no case-number field, and `bench` is `[888, 1990]` - author ids, not
 * names. Both are inside the judgment's own header, which means one extra
 * billed call per row, against documents that ran to 1.1 MB in the sample.
 *
 * So what is asserted here is mostly about restraint: which rows are fetched,
 * how many, and what happens when the fetch fails.
 */

function kanoonRow(over: Partial<PrecedentRow> = {}): PrecedentRow {
  return {
    judgment_id: 'kanoon:113036187',
    case_title: 'Rajender Kumar & Ors vs State Of H.P.',
    neutral_citation: null,
    reporter_citations: [],
    court_name: 'Himachal Pradesh High Court',
    court_type: 'HIGH_COURT',
    judgment_date: new Date('2022-08-16'),
    bench: [],
    bench_strength: null,
    act_sections: [],
    headnote: null,
    ratio_decidendi: null,
    disposition: null,
    source_url: 'https://indiankanoon.org/doc/113036187/',
    best_excerpt: '',
    para_number: null,
    score: 0.5,
    relevance_rank: 1,
    total_matches: 1,
    ...over,
  } as PrecedentRow;
}

function build(over: { rows?: PrecedentRow[]; enrichMax?: number; header?: unknown } = {}) {
  const rows = over.rows ?? [kanoonRow()];

  const kanoon = {
    isConfigured: true,
    isDegraded: false,
    search: jest.fn().mockResolvedValue(rows),
    documentHeader: jest.fn().mockResolvedValue(
      over.header ?? {
        caseNumber: 'CWP No. 2843/2019',
        neutralCitation: null,
        equivalentCitations: [],
        bench: ['Tarlok Singh Chauhan', 'Virender Singh'],
        extract: '',
      },
    ),
  };

  const service = new PrecedentsService(
    {} as never,
    {} as never,
    kanoon as never,
    { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
    { isRouterMocked: true } as never,
    {
      KANOON_ENRICH_MAX: over.enrichMax ?? 5,
      PRECEDENT_MAX_RESULTS: 15,
      PRECEDENT_PAGE_SIZE: 5,
    } as never,
  );

  return { service, kanoon };
}

function intent(text = 'judgments on service law') {
  return {
    intent: 'PRECEDENT_SEARCH' as const,
    language: 'en',
    cnrNumber: null,
    sectionNumber: null,
    actCode: null,
    searchQuery: text,
    rawText: text,
    confidence: 0.9,
  };
}

describe('filling the two fields Kanoon has no field for', () => {
  it('puts the registry number under CASE NO. and the real coram under BENCH', async () => {
    const { service } = build();

    const result = await service.search(intent() as never);

    expect(result.precedents[0].neutral_citation).toBe('CWP No. 2843/2019');
    expect(result.precedents[0].bench).toEqual(['Tarlok Singh Chauhan', 'Virender Singh']);
    expect(result.precedents[0].bench_strength).toBe(2);
  });

  it('stops at the page the advocate will actually see', async () => {
    // Fifteen results, five shown. Enriching the other ten is paid for and
    // thrown away - the sample document was 1.1 MB and each is a billed call.
    const rows = Array.from({ length: 15 }, (_, i) => kanoonRow({ judgment_id: `kanoon:${i + 1}` }));
    const { service, kanoon } = build({ rows, enrichMax: 5 });

    await service.search(intent() as never);

    expect(kanoon.documentHeader).toHaveBeenCalledTimes(5);
  });

  it('fetches nothing at all when the cap is zero', async () => {
    const { service, kanoon } = build({ enrichMax: 0 });

    await service.search(intent() as never);

    expect(kanoon.documentHeader).not.toHaveBeenCalled();
  });

  it('leaves corpus judgments alone', async () => {
    // An ingested row has a UUID, a real bench and a neutral citation already,
    // and no Kanoon document to fetch.
    const { service, kanoon } = build({
      rows: [kanoonRow({ judgment_id: '8f1c2d34-0000-4000-8000-000000000001' })],
    });

    await service.search(intent() as never);

    expect(kanoon.documentHeader).not.toHaveBeenCalled();
  });

  it('does not overwrite a citation the row already carries', async () => {
    const { service } = build({ rows: [kanoonRow({ neutral_citation: '2022 INSC 900' })] });

    const result = await service.search(intent() as never);

    expect(result.precedents[0].neutral_citation).toBe('2022 INSC 900');
  });

  it('still returns the search when a header cannot be read', async () => {
    // A judgment whose header states no case number still has a title, a date
    // and a court. Losing the card over the missing field would be a poor trade.
    const { service } = build({ header: { caseNumber: null, bench: [] } });

    const result = await service.search(intent() as never);

    expect(result.precedents).toHaveLength(1);
    expect(result.precedents[0].case_title).toContain('Rajender Kumar');
  });
});

describe('EQUIVALENT CITATIONS, from the judgment Kanoon printed them in', () => {
  /*
   * Empty on every card for months and explained as impossible. It was
   * concluded from probing one unreported judgment. A reported one carries its
   * citations on the search result and, in full, in the document's
   * doc_citations heading.
   */
  const reported = {
    caseNumber: 'Writ Petition (civil) 135 of 1970',
    neutralCitation: null,
    equivalentCitations: ['AIR 1973 SUPREME COURT 1461', '1973 4 SCC 225'],
    bench: ['S.M. Sikri'],
    extract: '',
  };

  it('fills the field from the document', async () => {
    const { service } = build({ header: reported });

    const result = await service.search(intent() as never);

    expect(result.precedents[0].reporter_citations).toEqual([
      'AIR 1973 SUPREME COURT 1461',
      '1973 4 SCC 225',
    ]);
  });

  it('does not print the citation twice when the search result carried it too', async () => {
    // The search result sends the first citation and the document sends all of
    // them, so the first one arrives from both.
    const { service } = build({
      rows: [kanoonRow({ reporter_citations: ['AIR 1973 SUPREME COURT 1461'] })],
      header: reported,
    });

    const result = await service.search(intent() as never);

    expect(result.precedents[0].reporter_citations).toEqual([
      'AIR 1973 SUPREME COURT 1461',
      '1973 4 SCC 225',
    ]);
  });

  it('lists a reporter citation ahead of a neutral one', async () => {
    const { service } = build({
      header: {
        caseNumber: null,
        neutralCitation: '2024:PHHC:012345',
        equivalentCitations: ['2024 SCC OnLine P&H 99'],
        bench: [],
        extract: '',
      },
    });

    const result = await service.search(intent() as never);

    expect(result.precedents[0].reporter_citations).toEqual([
      '2024 SCC OnLine P&H 99',
      '2024:PHHC:012345',
    ]);
  });

  it('still enriches a row whose only new information is a citation', async () => {
    // The early return used to require a case number, a bench or an extract,
    // so a header carrying nothing but citations was discarded.
    const { service } = build({
      header: { caseNumber: null, neutralCitation: null, equivalentCitations: ['AIR 1990 SC 1'], bench: [], extract: '' },
    });

    const result = await service.search(intent() as never);

    expect(result.precedents[0].reporter_citations).toEqual(['AIR 1990 SC 1']);
  });
});

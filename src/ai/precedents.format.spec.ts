import { PrecedentRow } from '../database/types';
import { bestCitation, formatPrecedentPage, synopsis } from './precedents.service';

function row(over: Partial<PrecedentRow> = {}): PrecedentRow {
  return {
    judgment_id: 'j1',
    case_title: 'State of Maharashtra v. ABC',
    neutral_citation: '2024 INSC 452',
    reporter_citations: ['AIR 2024 SC 100'],
    court_name: 'Supreme Court of India',
    court_type: 'SUPREME_COURT',
    judgment_date: new Date('2024-03-15'),
    bench: ['Justice A', 'Justice B'],
    bench_strength: 2,
    act_sections: ['IPC 302'],
    headnote: null,
    ratio_decidendi: 'Bail may be granted where the accused has no antecedents.',
    disposition: 'ALLOWED',
    source_url: null,
    best_excerpt: 'The court considered the question of bail at length.',
    para_number: 12,
    score: 0.5,
    relevance_rank: 1,
    total_matches: 1,
    ...over,
  };
}

describe('precedent formatting', () => {
  describe('bestCitation', () => {
    it('prefers the neutral citation', () => {
      expect(bestCitation(row())).toBe('2024 INSC 452');
    });

    it('falls back to the first reporter citation', () => {
      expect(bestCitation(row({ neutral_citation: null }))).toBe('AIR 2024 SC 100');
    });

    it('returns null when the judgment carries no citation at all', () => {
      expect(bestCitation(row({ neutral_citation: null, reporter_citations: [] }))).toBeNull();
    });
  });

  describe('synopsis', () => {
    it('prefers the ratio over the raw excerpt', () => {
      expect(synopsis(row())).toContain('no antecedents');
    });

    it('falls back to the excerpt when there is no ratio or headnote', () => {
      expect(synopsis(row({ ratio_decidendi: null, headnote: null }))).toContain('question of bail');
    });

    it('cuts on a sentence boundary when one falls in the back half', () => {
      // Truncating a legal holding mid-clause can invert its meaning, so when a
      // sentence break is available late enough to still be informative, cut
      // there rather than ellipsising.
      const long =
        'The court held that bail is the rule and jail the exception in such matters. ' +
        'A further paragraph that will be cut off entirely goes here and continues. '.repeat(4);
      const out = synopsis(row({ ratio_decidendi: long }), 120);
      expect(out.endsWith('.')).toBe(true);
      expect(out.endsWith('…')).toBe(false);
      expect(out).toContain('jail the exception');
    });

    it('ellipsises rather than returning a stub when the only break is very early', () => {
      // A 26-character synopsis out of a 120-character budget tells the reader
      // nothing, so an ellipsised longer cut is the better trade.
      const out = synopsis(row({ ratio_decidendi: 'Short. ' + 'x'.repeat(400) }), 120);
      expect(out.endsWith('…')).toBe(true);
      expect(out.length).toBeGreaterThan(100);
    });

    it('ellipsises when there is no sentence break at all', () => {
      const out = synopsis(row({ ratio_decidendi: 'y'.repeat(400) }), 100);
      expect(out.endsWith('…')).toBe(true);
      expect(out.length).toBeLessThanOrEqual(101);
    });

    it('does not crash on a judgment with no text at all', () => {
      const out = synopsis(row({ ratio_decidendi: null, headnote: null, best_excerpt: '' }));
      expect(out).toMatch(/No synopsis/i);
    });
  });

  describe('formatPrecedentPage', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row({
        judgment_id: 'j' + i,
        case_title: 'Case ' + i,
        neutral_citation: '202' + (i % 10) + ' INSC ' + i,
        judgment_date: new Date(2024 - i, 0, 1),
        total_matches: 12,
      }),
    );

    it('reports the full count, not the page size', () => {
      const out = formatPrecedentPage(many, 0, 5, 'bail in NDPS');
      expect(out).toContain('12 precedents');
      expect(out).toContain('Showing 1–5 of 12');
    });

    it('numbers entries by absolute position across pages', () => {
      const page2 = formatPrecedentPage(many, 5, 5, 'bail in NDPS');
      expect(page2).toContain('Showing 6–10 of 12');
      expect(page2).toContain('*6. Case 5*');
      expect(page2).not.toContain('*1. Case 0*');
    });

    it('offers "more" only while results remain', () => {
      expect(formatPrecedentPage(many, 0, 5, 'q')).toContain('reply *more*');
      // "End of results" read as "no further authority exists"; the closing
      // line now names the count instead.
      expect(formatPrecedentPage(many, 10, 5, 'q')).toContain('That is all 12 precedents');
      expect(formatPrecedentPage(many, 10, 5, 'q')).not.toContain('reply *more*');
    });

    it('handles a final short page without over-running', () => {
      const out = formatPrecedentPage(many, 10, 5, 'q');
      expect(out).toContain('Showing 11–12 of 12');
    });

    it('says so when retrieval was keyword-only', () => {
      // Silently returning worse results would be the wrong call - the operator
      // needs to know dense search is off.
      const out = formatPrecedentPage(many, 0, 5, 'q', { lexicalOnly: true });
      expect(out).toMatch(/keyword matches only/i);
    });

    it('always carries the caveat and the way back to the menu', () => {
      const out = formatPrecedentPage(many, 0, 5, 'q');
      expect(out).toMatch(/research aid.*Not legal advice/i);
      expect(out).toContain('Type *0*');
    });

    it('never leaks an Indian Kanoon URL', () => {
      // The advocate asked for judgments, not for links to a third-party site.
      const out = formatPrecedentPage([row({ source_url: 'https://indiankanoon.org/doc/70495810/' })], 0, 5, 'q');
      expect(out).not.toMatch(/indiankanoon|https?:\/\//i);
    });

    it('strips the ellipses Kanoon leaves in truncated titles', () => {
      const out = formatPrecedentPage(
        [row({ case_title: 'Tiger Global International Iii ... vs The Authority For Advance Rulings ...' })],
        0,
        5,
        'q',
      );
      expect(out).not.toContain('...');
      expect(out).not.toContain('…');
    });

    it('splits the title into petitioner and respondent', () => {
      const out = formatPrecedentPage([row({ case_title: 'State of Bihar vs Ram Kumar' })], 0, 5, 'q');
      expect(out).toContain('PETITIONER: State of Bihar');
      expect(out).toContain('RESPONDENT: Ram Kumar');
    });

    it('prints "Not available" rather than dropping a field', () => {
      // A card whose shape changes with the data is harder to read down a phone
      // screen, and a missing label reads as an omission rather than an absence.
      const out = formatPrecedentPage(
        [row({ neutral_citation: null, reporter_citations: [], judgment_date: null, bench: [], bench_strength: null })],
        0,
        5,
        'q',
      );
      for (const label of ['CASE NO.', 'DATE OF JUDGMENT', 'BENCH', 'EQUIVALENT CITATIONS']) {
        expect(out).toContain(`${label}: Not available`);
      }
    });

    it('gives a useful empty state instead of a bare "nothing found"', () => {
      const out = formatPrecedentPage([], 0, 5, 'my client was caught with drugs');
      expect(out).toContain('No precedents found');
      expect(out).toMatch(/rephrasing/i);
    });

    it('includes the citation, bench and court for each entry', () => {
      const out = formatPrecedentPage([row()], 0, 5, 'q');
      expect(out).toContain('EQUIVALENT CITATIONS: 2024 INSC 452');
      expect(out).toContain('COURT: Supreme Court of India');
      expect(out).toMatch(/BENCH: .+/);
    });

    it('names the judges when Kanoon supplied them', () => {
      const out = formatPrecedentPage([row({ bench: ['R. Gavai', 'K.V. Viswanathan'] })], 0, 5, 'q');
      expect(out).toContain('BENCH: R. Gavai, K.V. Viswanathan');
    });

    it('falls back to bench strength when no names are available', () => {
      const out = formatPrecedentPage([row({ bench: [], bench_strength: 3 })], 0, 5, 'q');
      expect(out).toContain('BENCH: 3-judge bench');
    });

    it('survives a judgment with no date', () => {
      const out = formatPrecedentPage([row({ judgment_date: null })], 0, 5, 'q');
      expect(out).toContain('DATE OF JUDGMENT: Not available');
    });
  });
});

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

    it('never sends the advocate to another website', () => {
      /*
       * This has now been decided twice, and the second time is the one that
       * stands: no link out, ever.
       *
       * The argument for one was that Indian Kanoon publishes no case number
       * and no citations through its API, so three of the seven fields read
       * "Not available" and the card proves a judgment exists without offering
       * a way to read it. A READ: line was added on that basis.
       *
       * The instruction is explicit and it overrides that: this product never
       * points an advocate at another service. A link out is an admission that
       * the answer is somewhere else, printed on every card, next to a
       * competitor's name. Empty fields are a reason to go and fill them.
       *
       * The same rule is in VAKEEL_PERSONA, because the model was doing it in
       * prose - "you might want to check a legal database or citation tool" -
       * which is worse than a link.
       */
      const out = formatPrecedentPage(
        [row({ source_url: 'https://indiankanoon.org/doc/70495810/' })],
        0,
        5,
        'q',
      );

      expect(out).not.toMatch(/indiankanoon|https?:\/\//i);
      expect(out).not.toContain('READ:');
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

    it('prints every required label even when the source has nothing for it', () => {
      // Dropping empty labels was tried, to stop Kanoon's missing citations
      // costing three dead lines per result. The output format names seven
      // fields and requires all seven, and an absent label cannot be told apart
      // from a build that stopped printing it - so the shape is fixed and the
      // gap is stated.
      const out = formatPrecedentPage(
        [row({ neutral_citation: null, reporter_citations: [], judgment_date: null, bench: [], bench_strength: null })],
        0,
        5,
        'q',
      );
      for (const label of [
        'CASE NO.',
        'PETITIONER',
        'RESPONDENT',
        'DATE OF JUDGMENT',
        'BENCH',
        'EQUIVALENT CITATIONS',
        'LEGAL PRINCIPLE',
      ]) {
        expect(out).toContain(`${label}:`);
      }
      expect(out).toContain('Not available');
      // The title still anchors the card, so a result is never a blank block.
      expect(out).toContain('1. ');
    });

    it('gives a useful empty state instead of a bare "nothing found"', () => {
      const out = formatPrecedentPage([], 0, 5, 'my client was caught with drugs');
      expect(out).toContain('No precedents found');
      expect(out).toMatch(/rephrasing/i);
    });

    it('includes the citation, bench and court for each entry', () => {
      const out = formatPrecedentPage([row()], 0, 5, 'q');
      expect(out).toContain('CASE NO.: 2024 INSC 452');
      expect(out).toContain('COURT: Supreme Court of India');
      expect(out).toMatch(/BENCH: .+/);
    });

    it('prints the reporter citations as the equivalents, not the neutral one again', () => {
      // EQUIVALENT CITATIONS used to render bestCitation(), which prefers the
      // neutral citation - the string CASE NO. has already printed. The card
      // showed one citation twice and dropped the reporter citation entirely.
      const out = formatPrecedentPage([row()], 0, 5, 'q');
      expect(out).toContain('EQUIVALENT CITATIONS: AIR 2024 SC 100');
      expect(out.match(/2024 INSC 452/g)).toHaveLength(1);
    });

    it('promotes the reporter citation when there is no neutral citation', () => {
      const out = formatPrecedentPage([row({ neutral_citation: null })], 0, 5, 'q');
      expect(out).toContain('CASE NO.: Not available');
      expect(out).toContain('EQUIVALENT CITATIONS: AIR 2024 SC 100');
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
      // Still a usable card - the absence of one field must not blank the rest.
      expect(out).toContain('COURT:');
    });

    it('prints the model-written principle when the row states none', () => {
      // Kanoon supplies no headnote and no ratio, so without this the field an
      // advocate reads first was empty on every result it returned.
      const out = formatPrecedentPage(
        [
          row({
            ratio_decidendi: null,
            headnote: null,
            best_excerpt: '',
            generated_principle:
              'Bail cannot be refused solely because the offence carries a long sentence.',
          }),
        ],
        0,
        5,
        'q',
      );
      expect(out).toContain('LEGAL PRINCIPLE: Bail cannot be refused solely because');
    });

    it("prefers the court's own words over anything written for it", () => {
      const out = formatPrecedentPage(
        [row({ generated_principle: 'A summary that must not win.' })],
        0,
        5,
        'q',
      );
      expect(out).toContain('LEGAL PRINCIPLE: Bail may be granted where the accused has no antecedents.');
      expect(out).not.toContain('must not win');
    });

    it('says so plainly when no principle can be stated at all', () => {
      const out = formatPrecedentPage(
        [row({ ratio_decidendi: null, headnote: null, best_excerpt: '' })],
        0,
        5,
        'q',
      );
      expect(out).toContain('LEGAL PRINCIPLE: Not available');
    });

    it('closes the page with the caveat, in italics', () => {
      const out = formatPrecedentPage([row()], 0, 5, 'q');
      expect(out).toContain(
        '_This is a research aid. Verify from original sources before court use. Not legal advice._',
      );
    });
  });
});

describe('a judgment asked for by name and not found', () => {
  /*
   * The heading is the defect. "Case law - 10 precedents" over ten judgments
   * that are not the one asked for tells the advocate nothing is wrong, so the
   * first result reads as the answer - and the first result was *Sunil Bharti
   * Mittal vs The State Of Bihar* for a question about Rajesh Kumar Mittal.
   */
  const rows = [
    row({ judgment_id: 'k1', case_title: 'Sunil Bharti Mittal vs The State Of Bihar' }),
    row({ judgment_id: 'k2', case_title: 'Baliram Prasad Singh & Ors vs The State Of Bihar & Ors' }),
  ];

  it('says so instead of calling them precedents', () => {
    const page = formatPrecedentPage(rows, 0, 5, 'Rajesh Kumar Mittal vs State of Bihar', {
      namedCase: { name: 'Rajesh Kumar Mittal vs State of Bihar', found: false },
    });

    expect(page).toContain('No judgment found named "Rajesh Kumar Mittal vs State of Bihar"');
    expect(page).not.toContain('Case law —');
  });

  it('offers the near misses as near misses', () => {
    // Still worth showing: cause titles get misremembered, and the right case
    // is often two words away. Just not presented as what was asked for.
    const page = formatPrecedentPage(rows, 0, 5, 'q', { namedCase: { name: 'A vs B', found: false } });

    expect(page).toContain('Closest matches by name');
    expect(page).toContain('Sunil Bharti Mittal');
  });

  it('does not claim the case does not exist', () => {
    // Absence from the searchable record is not absence from the law reports,
    // and an advocate cannot check a claim like that.
    const page = formatPrecedentPage(rows, 0, 5, 'q', { namedCase: { name: 'A vs B', found: false } });

    expect(page).toMatch(/could not find that case/i);
    expect(page).not.toMatch(/does not exist|no such case/i);
  });

  it('keeps the caveat on the second page too', () => {
    // Without the flag carried through the session, page two reverted to the
    // confident heading and read like a search that had worked.
    const page = formatPrecedentPage(rows, 1, 5, 'q', { namedCase: { name: 'A vs B', found: false } });

    expect(page).toContain('No judgment found named');
  });

  it('is absent from an ordinary topic search', () => {
    const page = formatPrecedentPage(rows, 0, 5, 'anticipatory bail');

    expect(page).toContain('Case law —');
    expect(page).not.toContain('No judgment found named');
  });
});

describe('a judgment asked for by name and found', () => {
  /*
   * "Rajesh Kumar Mittal vs State Of Bihar on 18 January, 2005" returned the
   * right judgment at number one - and then nine more under the heading "Case
   * law - 10 precedents", among them *State Of Himachal Pradesh vs Chander
   * Sharma*, which shares neither a party nor a court nor a subject with the
   * question. They were there because Kanoon returns ten results, not because
   * anything connected them.
   *
   * Padding an exact answer with near misses makes the answer look like a
   * guess. The matches are the reply now; the rest are dropped, not demoted.
   */
  const hit = row({ case_title: 'Rajesh Kumar Mittal vs State Of Bihar' });
  const found = { name: 'Rajesh Kumar Mittal vs State of Bihar', found: true };

  it('leads with the name, not a precedent count', () => {
    const page = formatPrecedentPage([hit], 0, 5, 'q', { namedCase: found });

    expect(page).toContain('*Rajesh Kumar Mittal vs State of Bihar*');
    expect(page).toContain('One judgment matches that name.');
    expect(page).not.toContain('Case law —');
    expect(page).not.toContain('newest first');
  });

  it('counts them when a name genuinely matches more than one', () => {
    // Same parties litigating twice is ordinary. Both are the answer.
    const page = formatPrecedentPage([hit, hit], 0, 5, 'q', { namedCase: found });

    expect(page).toContain('2 judgments match that name');
  });

  it('still reads as a topic search when no name was given', () => {
    const page = formatPrecedentPage([hit], 0, 5, 'anticipatory bail');

    expect(page).toContain('Case law —');
    expect(page).not.toContain('matches that name');
  });
});

describe('when the summariser says the extract states no principle', () => {
  /*
   * Live output, and the fallback was backwards:
   *
   *   LEGAL PRINCIPLE: Rule 3 of Order 32 of the CPC , 1908. Sub Rule (5) of
   *   Rule 3 of Order 32 of the CPC , 1908 lays Rule (1) of Rule 3 of Order 32
   *   of the CPC , 1908. 18.
   *
   * That is Kanoon's raw snippet — the spaces before the commas are what is
   * left after its <b> tags are stripped. It reached the card because the model
   * had answered NONE for that row, NONE was discarded, and the row fell
   * through to the last resort, which prints the extract.
   *
   * So the advocate was shown the exact text a reader had just rejected as
   * stating nothing, under a heading claiming it was the holding. The model's
   * refusal is the most reliable signal available on that card and it was the
   * one thing being thrown away.
   */
  it('says nothing rather than printing the extract it just rejected', () => {
    const out = formatPrecedentPage(
      [
        row({
          ratio_decidendi: null,
          headnote: null,
          generated_principle: null,
          principle_declined: true,
          best_excerpt:
            'Rule 3 of Order 32 of the CPC , 1908. Sub Rule (5) of Rule 3 of Order 32 of the CPC , 1908 lays Rule (1) of Rule 3 of Order 32 of the CPC , 1908. 18.',
        }),
      ],
      0,
      5,
      'q',
    );

    expect(out).toContain('LEGAL PRINCIPLE: Not available');
    expect(out).not.toContain('Sub Rule (5)');
  });

  it('still salvages an extract the summariser never looked at', () => {
    // A failed model call, or no model at all, leaves principle_declined unset.
    // The extract is then the best thing available and is still worth printing.
    const out = formatPrecedentPage(
      [
        row({
          ratio_decidendi: null,
          headnote: null,
          generated_principle: null,
          best_excerpt:
            'A minor must sue through a next friend, and a decree passed against a minor not so represented is a nullity.',
        }),
      ],
      0,
      5,
      'q',
    );

    expect(out).toContain('next friend');
  });

  it('prefers what the model wrote over the raw extract', () => {
    const out = formatPrecedentPage(
      [
        row({
          ratio_decidendi: null,
          headnote: null,
          generated_principle: 'A decree against an unrepresented minor is a nullity.',
          best_excerpt: 'Rule 3 of Order 32 of the CPC , 1908. Sub Rule (5) of Rule 3.',
        }),
      ],
      0,
      5,
      'q',
    );

    expect(out).toContain('A decree against an unrepresented minor is a nullity.');
    expect(out).not.toContain('Sub Rule (5)');
  });
});

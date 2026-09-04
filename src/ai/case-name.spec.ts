import { CASE_NAME_MATCH, caseNameScore, extractCaseName } from './case-name';
import { ClassifiedIntent } from './intent.service';
import { kanoonQuery } from './precedents.service';

/**
 * Reported from a live session, with the screenshot.
 *
 * The advocate asked for "case of Rajesh Kumar Mittal vs State of Bihar . Patna
 * High court". The reply was headed "Case law - 10 precedents" and the first
 * result was *Sunil Bharti Mittal vs The State Of Bihar*. Nothing in it was
 * marked uncertain - ten unrelated judgments, in the confident format used for
 * a topic search that worked.
 *
 * Relevance ranking was doing its job. Given free text, "Mittal" and "State of
 * Bihar" are the best lexical match available once the named case is not in the
 * result set. The mistake is one level up: a request for one named judgment and
 * a request for authority on a question are different questions, and both were
 * getting the second answer.
 */

const ASKED = 'case of Rajesh Kumar Mittal vs State of Bihar . Patna High court';

describe('spotting that a judgment was named', () => {
  it.each([
    ['case of Rajesh Kumar Mittal vs State of Bihar', 'Rajesh Kumar Mittal', 'State of Bihar'],
    ['Rajesh Kumar Mittal vs State of Bihar', 'Rajesh Kumar Mittal', 'State of Bihar'],
    ['Kesavananda Bharati v. State of Kerala', 'Kesavananda Bharati', 'State of Kerala'],
    ['Maneka Gandhi versus Union of India', 'Maneka Gandhi', 'Union of India'],
    ['judgment of Vishaka vs State of Rajasthan', 'Vishaka', 'State of Rajasthan'],
    ['M/s Tata Steel Ltd vs Union of India', 'M/s Tata Steel Ltd', 'Union of India'],
  ])('reads %p', (text, petitioner, respondent) => {
    expect(extractCaseName(text)).toEqual({ petitioner, respondent });
  });

  it('survives the router rewriting the question before it gets here', () => {
    /*
     * The bug this test exists for, and it was my own.
     *
     * The detection was reading intent.searchQuery - the router model's rewrite
     * aimed at retrieval - rather than what the advocate typed. The same
     * question came back rewritten as "case law for Rajesh Kumar Mittal vs
     * State of Bihar in Patna High Court", and the parties read out of that as
     * "law for Rajesh Kumar Mittal" and "State of Bihar in Patna High Court".
     *
     * Wrong twice: the junk was quoted back in the heading, and the extra
     * tokens diluted the score enough that the real judgment would have been
     * rejected as well.
     *
     * The fix is that the intent now carries rawText and this reads that. These
     * cases stay because the rewrite is not the only source of stray words -
     * advocates type "case law for X vs Y in the Patna High Court" themselves.
     */
    for (const phrasing of [
      'case law for Rajesh Kumar Mittal vs State of Bihar in Patna High Court',
      'case of Rajesh Kumar Mittal vs State of Bihar in Patna High Court',
      'Rajesh Kumar Mittal vs State of Bihar Patna High Court',
      'case law on Rajesh Kumar Mittal vs State of Bihar',
    ]) {
      expect(extractCaseName(phrasing)).toMatchObject({
        petitioner: 'Rajesh Kumar Mittal',
        respondent: 'State of Bihar',
      });
    }
  });

  it('scores the real judgment above the bar from any of those phrasings', () => {
    // The dilution mattered more than the display. "law for Rajesh Kumar
    // Mittal" against the genuine title scored 0.5 - the same as the decoy -
    // so the fix would have reported "not found" for a case that was there.
    const name = extractCaseName(
      'case law for Rajesh Kumar Mittal vs State of Bihar in Patna High Court',
    )!;

    expect(caseNameScore(name, 'Rajesh Kumar Mittal vs The State Of Bihar')).toBe(1);
    expect(caseNameScore(name, 'Sunil Bharti Mittal vs The State Of Bihar')).toBeLessThan(
      CASE_NAME_MATCH,
    );
  });

  it('gives up rather than guess when the respondent is itself a court', () => {
    // A writ against the High Court's administrative side loses its respondent
    // to the court-stripping. Returning null is the right failure: the query
    // falls back to a topic search, which still finds the case.
    expect(extractCaseName('X vs Delhi High Court')).toBeNull();
  });

  it('takes the court and year out of the parties, and keeps the court', () => {
    /*
     * "Patna High court" is not part of the cause title - leaving it on made the
     * respondent "State of Bihar . Patna High court".
     *
     * It is returned rather than discarded because it is the one word in the
     * surrounding text that still narrows the search: Kanoon derives its
     * doctypes: restriction from it. Throwing it away would fix the parties and
     * quietly widen a Patna High Court lookup to every court in India.
     */
    expect(extractCaseName(ASKED)).toEqual({
      petitioner: 'Rajesh Kumar Mittal',
      respondent: 'State of Bihar',
      court: 'Patna High court',
    });
    expect(extractCaseName('Vishaka vs State of Rajasthan (1997)')).toEqual({
      petitioner: 'Vishaka',
      respondent: 'State of Rajasthan',
    });
  });

  it.each([
    'is anticipatory bail maintainable after a chargesheet is filed',
    'what is IPC 420',
    'order 32 CPC',
    'precedents on cheque bounce',
    'bail',
    '',
  ])('does not read %p as a case name', (text) => {
    // Null is the common answer and the right one. A topic search must go on
    // being a topic search.
    expect(extractCaseName(text)).toBeNull();
  });

  it('does not read a sentence containing "vs" as a cause title', () => {
    // The separator appears in ordinary prose. A whole clause either side of it
    // is a question, and answering it with a name lookup is worse than
    // answering it as a topic.
    expect(
      extractCaseName(
        'when is bail granted if the accused and the complainant vs each other have settled the entire dispute amicably',
      ),
    ).toBeNull();
  });
});

describe('scoring a title against the name that was asked for', () => {
  const name = extractCaseName(ASKED)!;

  it('matches the case that was actually asked for', () => {
    expect(caseNameScore(name, 'Rajesh Kumar Mittal vs The State Of Bihar')).toBe(1);
    expect(caseNameScore(name, 'Rajesh Kumar Mittal vs State Of Bihar & Ors')).toBe(1);
  });

  it('rejects the one that was returned instead', () => {
    /*
     * The whole point. *Sunil Bharti Mittal vs The State Of Bihar* shares one
     * surname and the universal respondent, and it came first.
     *
     * 1 of 3 distinctive petitioner tokens x 0.75, plus a respondent that
     * matches completely and is worth 0.25 - because "vs State of Bihar" is
     * shared by tens of thousands of judgments and must never carry a result on
     * its own.
     */
    const score = caseNameScore(name, 'Sunil Bharti Mittal vs The State Of Bihar');

    expect(score).toBeCloseTo(0.5, 5);
    expect(score).toBeLessThan(CASE_NAME_MATCH);
  });

  it('rejects a title agreeing only on the respondent', () => {
    expect(caseNameScore(name, 'Baliram Prasad Singh & Ors vs The State Of Bihar & Ors')).toBeLessThan(
      CASE_NAME_MATCH,
    );
  });

  it('still finds the case when the title is quoted from memory', () => {
    // Advocates type "Mittal vs State of Bihar" far more often than the full
    // cause title, and that has to keep working - which is why the bar is 0.7
    // and not higher.
    const short = extractCaseName('Rajesh Mittal vs State of Bihar')!;

    expect(caseNameScore(short, 'Rajesh Kumar Mittal vs The State Of Bihar')).toBeGreaterThanOrEqual(
      CASE_NAME_MATCH,
    );
  });

  it('is unmoved by punctuation, case and the honorifics in a cause title', () => {
    const parties = extractCaseName('M/s Tata Steel Ltd vs Union of India')!;

    expect(
      caseNameScore(parties, 'M/S. TATA STEEL LIMITED vs UNION OF INDIA & ORS'),
    ).toBeGreaterThanOrEqual(CASE_NAME_MATCH);
  });

  it('claims nothing when the request has no distinctive party at all', () => {
    // "State vs State" is every criminal appeal ever reported. Matching on it
    // would put an arbitrary judgment at the top and call it the one asked for.
    const vague = extractCaseName('State vs State')!;

    expect(caseNameScore(vague, 'Anything vs Anything Else')).toBe(0);
  });
});

/** A ClassifiedIntent with only the fields kanoonQuery reads. */
function intent(over: Partial<ClassifiedIntent> & { rawText: string }): ClassifiedIntent {
  return {
    intent: 'PRECEDENT_SEARCH',
    language: 'en',
    cnrNumber: null,
    sectionNumber: null,
    actCode: null,
    searchQuery: over.rawText,
    confidence: 0.9,
    ...over,
  };
}

describe('what actually gets sent to Indian Kanoon', () => {
  /*
   * The second half of the same report: the bot said "no judgment found" for a
   * case the advocate could see on Kanoon's own site.
   *
   * Kanoon ranks by relevance across every word it is given, and it was being
   * given the router's rewrite - "case law for Rajesh Kumar Mittal vs State of
   * Bihar in Patna High Court". Five of those words identify the judgment and
   * the rest are scaffolding, so the signal is a third of the string. Once a
   * cause title has been recognised, the parties are the query.
   */
  it('searches for the parties, not the sentence around them', () => {
    expect(
      kanoonQuery(
        intent({ rawText: 'case law for Rajesh Kumar Mittal vs State of Bihar', searchQuery: 'rewritten' }),
      ),
    ).toBe('Rajesh Kumar Mittal State of Bihar');
  });

  it('keeps the court, because that is what narrows the search', () => {
    // Kanoon's doctypes: restriction is derived from phrases like "Patna High
    // Court". Dropping them turns a High Court lookup into a search of
    // everything, which is how a precise question gets a vague answer.
    expect(
      kanoonQuery(
        intent({
          rawText: 'case of Rajesh Kumar Mittal vs State of Bihar . Patna High court',
          searchQuery: 'x',
        }),
      ),
    ).toBe('Rajesh Kumar Mittal State of Bihar Patna High court');
    expect(extractCaseName('Vishaka vs State of Rajasthan')?.court).toBeUndefined();
  });

  it('leaves an ordinary question with the rewrite, which is what it is for', () => {
    // "anticipatory bail after chargesheet" is better searched in the model's
    // legal vocabulary than in the advocate's phrasing.
    expect(
      kanoonQuery(
        intent({
          rawText: 'is anticipatory bail maintainable',
          searchQuery: 'anticipatory bail after chargesheet',
        }),
      ),
    ).toBe('anticipatory bail after chargesheet');
  });
});

describe('searching for a provision', () => {
  /*
   * "list of judgements for order 32 cpc" came back as *Royal Sundaram General
   * Insurance vs Commissioner Of GST* and *Bss Mines & Minerals vs Commissioner
   * Of Central Excise* — customs and excise tribunal decisions with no
   * connection to civil procedure.
   *
   * The router had rewritten the question to "list of judgments related to
   * Order 32 of the Civil Procedure Code" and Kanoon scored every word of it.
   * "order", "code" and "32" are among the commonest tokens in Indian tax and
   * excise judgments — Order-in-Original, Order No. 32, the Customs Act — so
   * the documents matching hardest were the ones using those words most.
   */
  it('sends the provision as a phrase, with the Act as courts write it', () => {
    expect(
      kanoonQuery(
        intent({
          rawText: 'list of judgements for order 32 cpc',
          searchQuery: 'list of judgments related to Order 32 of the Civil Procedure Code',
          sectionNumber: 'Order 32',
          actCode: 'CPC',
        }),
      ),
    ).toBe('"Order 32" "Civil Procedure"');
  });

  it('names a bare number as a section, or the phrase is just a number', () => {
    expect(
      kanoonQuery(intent({ rawText: 'judgments on 302 IPC', sectionNumber: '302', actCode: 'IPC' })),
    ).toBe('"Section 302" "Indian Penal Code"');
  });

  it('handles an Article of the Constitution the same way', () => {
    expect(
      kanoonQuery(
        intent({ rawText: 'case law on article 226', sectionNumber: 'Article 226', actCode: 'COI' }),
      ),
    ).toBe('"Article 226" "Constitution of India"');
  });

  it('quotes the provision alone when no Act was identified', () => {
    expect(
      kanoonQuery(intent({ rawText: 'judgments on section 138', sectionNumber: '138' })),
    ).toBe('"Section 138"');
  });

  it('leaves a question naming no provision with the rewrite', () => {
    expect(
      kanoonQuery(
        intent({ rawText: 'precedents on cheque bounce', searchQuery: 'dishonour of cheque' }),
      ),
    ).toBe('dishonour of cheque');
  });

  it('prefers the cause title when the advocate named both', () => {
    // A named case is more specific than the provision it turns on.
    expect(
      kanoonQuery(
        intent({
          rawText: 'Rajesh Kumar Mittal vs State of Bihar',
          sectionNumber: 'Order 32',
          actCode: 'CPC',
        }),
      ),
    ).toBe('Rajesh Kumar Mittal State of Bihar');
  });
});

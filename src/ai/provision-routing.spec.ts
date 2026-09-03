import {
  extractArticleReference,
  extractOrderReference,
  extractSectionReference,
  normaliseActCode,
} from './legal-patterns';
import { IntentService } from './intent.service';

/**
 * Civil procedure, which the bot could not recognise at all.
 *
 * Reported from a live session: "order 32 CPC" came back as ten unrelated Patna
 * judgments under the heading "Case law - 10 precedents". Three separate faults
 * stacked up, and each on its own is enough to produce that:
 *
 *   1. CPC was not in KNOWN_ACTS. The list was assembled from the criminal side
 *      of practice - IPC, BNS, CrPC, BNSS, Evidence - and civil litigation is
 *      most of the work.
 *   2. Nothing understood an *Order*. The CPC's procedure lives in the First
 *      Schedule as Orders and Rules, not sections, so the section matcher found
 *      nothing and the whole question read as free text.
 *   3. With no provision extracted, the router model decided - and it reads the
 *      word "order" as "judgment", so a procedural question went to case-law
 *      search.
 */

describe('recognising a CPC Order', () => {
  it.each([
    ['order 32 CPC', 'Order 32'],
    ['Order 34 CPC', 'Order 34'],
    ['Order 36 CPC', 'Order 36'],
    ['order 37 rule 3 cpc', 'Order 37 Rule 3'],
    ['O.32 R.1 CPC', 'Order 32 Rule 1'],
    ['O 39 R 1 and 2', 'Order 39 Rule 1'],
    ['what does order 33 of the code of civil procedure say', 'Order 33'],
  ])('reads %p as %p', (text, expected) => {
    expect(extractOrderReference(text)).toBe(expected);
  });

  it('normalises a Roman numeral, which the older reports use', () => {
    expect(extractOrderReference('Order XXXII CPC')).toBe('Order 32');
    expect(extractOrderReference('Order XXXVII Rule 2')).toBe('Order 37 Rule 2');
  });

  it.each([
    'interim order in a bail matter',
    'the order sheet says nothing',
    'order of the court dated 3 April',
    'I need the order passed last week',
  ])('does not read %p as a provision', (text) => {
    // "order" is an ordinary English word. Reading the "i" of "in" as Roman one
    // answered a bail question with Order 1 of the CPC.
    expect(extractOrderReference(text)).toBeNull();
  });

  it('rejects an Order number the CPC does not have', () => {
    // The First Schedule ends at Order 51. A three-digit "order 302" is a
    // section number with the wrong word in front of it.
    expect(extractOrderReference('order 302')).toBeNull();
  });
});

describe('recognising the CPC itself', () => {
  it.each(['cpc', 'CPC', 'Code of Civil Procedure', 'civil procedure code'])(
    'resolves %p',
    (text) => {
      expect(normaliseActCode(text)).toBe('CPC');
    },
  );

  it('never reads CrPC as CPC', () => {
    // Two different codes, three characters apart, and answering a criminal
    // question with civil procedure is the kind of wrong that wastes an hour.
    expect(normaliseActCode('crpc')).toBe('CRPC');
    expect(extractSectionReference('CrPC 438').act).toBe('CRPC');
    expect(extractSectionReference('u/s 438 of the Code of Criminal Procedure').act).toBe('CRPC');
  });

  it('picks CPC out of a sentence naming it', () => {
    expect(extractSectionReference('order 32 CPC').act).toBe('CPC');
    expect(extractSectionReference('what does order 33 of the code of civil procedure say').act).toBe(
      'CPC',
    );
  });
});

describe('routing a provision question', () => {
  /** The router model is never reached on these; the regex decides. */
  function service(modelIntent = 'PRECEDENT_SEARCH') {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({
          intent: modelIntent,
          language: 'en',
          search_query: 'What does Order 32 of the Code of Civil Procedure say?',
        }),
        model: 'mock',
        inputTokens: 0,
        outputTokens: 0,
      }),
    };
    return { service: new IntentService(registry as never), registry };
  }

  it.each(['order 32 CPC', 'Order 34 CPC', 'Order 36 CPC', 'O.37 R.3 CPC'])(
    'sends %p to a provision lookup, not a case-law search',
    async (text) => {
      const { service: s } = service();
      const intent = await s.classify(text);

      expect(intent.intent).toBe('SECTION_LOOKUP');
      expect(intent.actCode).toBe('CPC');
      expect(intent.sectionNumber).toMatch(/^Order \d+/);
    },
  );

  it('does not spend a router call on a bare Order reference', async () => {
    // Short and unambiguous. Paying a round trip to be told the wrong answer is
    // the worst of both.
    const { service: s, registry } = service();
    await s.classify('order 32 CPC');

    expect(registry.complete).not.toHaveBeenCalled();
  });

  it('still lets a research question about an Order reach the model', async () => {
    // "What did the court hold about Order 39 injunctions" is genuinely case
    // law. The fast path is length-capped so this is not swallowed.
    const { service: s, registry } = service('PRECEDENT_SEARCH');
    const intent = await s.classify(
      'what did the Supreme Court hold about Order 39 injunctions in trademark matters',
    );

    expect(registry.complete).toHaveBeenCalled();
    expect(intent.intent).toBe('SECTION_LOOKUP');
  });

  it('overrides the model when it calls a provision question case law', async () => {
    // The model reads "order" as "judgment". The regex is certain, so it wins -
    // the same override the CNR path has always used.
    const { service: s } = service('PRECEDENT_SEARCH');
    const intent = await s.classify(
      'please tell me in detail what order 32 of the CPC provides for',
    );

    expect(intent.intent).toBe('SECTION_LOOKUP');
  });

  it('leaves a drafting request as drafting', async () => {
    // "Draft an application under Order 39" names a provision and is still a
    // drafting job.
    const { service: s } = service('DRAFTING_HELP');
    const intent = await s.classify('draft an application for injunction under Order 39 Rule 1 CPC');

    expect(intent.intent).toBe('DRAFTING_HELP');
  });
});

describe('recognising a constitutional Article', () => {
  /*
   * The same hole as the CPC's Orders, in the other direction.
   *
   * Constitutional provisions are Articles, and nothing recognised one - so
   * "Article 226" reached the classifier as free text and came back a case-law
   * search. Article 226 and Article 32 are two of the most-asked provisions in
   * Indian practice, and both were answered with a list of judgments instead of
   * an explanation of the provision.
   */
  it.each([
    ['article 226', 'Article 226'],
    ['Article 32', 'Article 32'],
    ['art. 21', 'Article 21'],
    ['Art 14', 'Article 14'],
    ['article 21A right to education', 'Article 21A'],
    ['article 300A', 'Article 300A'],
    ['article 243ZG', 'Article 243ZG'],
  ])('reads %p as %p', (text, expected) => {
    expect(extractArticleReference(text)).toBe(expected);
  });

  it('does not let the next English word become an amendment suffix', () => {
    // The pattern is case-insensitive, so a gap before the suffix let "in"
    // attach itself: "article 226 in a writ petition" read as Article 226IN.
    expect(extractArticleReference('article 226 in a writ petition')).toBe('Article 226');
    expect(extractArticleReference('article 32 before the Supreme Court')).toBe('Article 32');
  });

  it.each([
    'the articles of association',
    'this article was published in AIR',
    'part 3 of the agreement',
  ])('does not read %p as a provision', (text) => {
    expect(extractArticleReference(text)).toBeNull();
  });

  it('rejects a number the Constitution does not reach', () => {
    // The text ends at Article 395. A four-digit "article 1234" is something
    // else with the wrong word in front of it.
    expect(extractArticleReference('article 999')).toBeNull();
  });

  it('resolves the Constitution as an act in its own right', () => {
    expect(normaliseActCode('Constitution of India')).toBe('COI');
    expect(normaliseActCode('constitution')).toBe('COI');
    expect(extractSectionReference('article 226 of the Constitution').act).toBe('COI');
  });

  it('sends an Article to a provision lookup and names the Constitution', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'PRECEDENT_SEARCH', language: 'en', search_query: 'q' }),
        model: 'mock',
        inputTokens: 0,
        outputTokens: 0,
      }),
    };
    const intent = await new IntentService(registry as never).classify('article 226');

    expect(intent.intent).toBe('SECTION_LOOKUP');
    expect(intent.sectionNumber).toBe('Article 226');
    expect(intent.actCode).toBe('COI');
  });

  it('overrides the model when it calls an Article question case law', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'PRECEDENT_SEARCH', language: 'en', search_query: 'q' }),
        model: 'mock',
        inputTokens: 0,
        outputTokens: 0,
      }),
    };
    const intent = await new IntentService(registry as never).classify(
      'please explain in detail the scope of article 226 of the Constitution',
    );

    expect(intent.intent).toBe('SECTION_LOOKUP');
    expect(intent.actCode).toBe('COI');
  });
});

describe('asking for judgments about a provision', () => {
  /*
   * The other side of the Order override, and it was a regression I introduced
   * fixing the first side.
   *
   * "order 32 CPC" is a provision lookup, and the router model gets it wrong -
   * it sees "order" and thinks judgment - so the regex overrides it. That
   * override was unconditional, and it caught the opposite case too. "list of
   * judgements for order 32 cpc" was forced to SECTION_LOOKUP, found no CPC
   * text in the corpus, and answered "I don't have a specific list of judgments
   * for Order 32 CPC. You might need to look into legal databases" - from a bot
   * whose third feature is a judgment database.
   *
   * The provision is the *subject* of that question, not the request. When the
   * advocate names what they want, the model does not need to guess and the
   * override must stand down.
   */
  function service(modelIntent = 'PRECEDENT_SEARCH') {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: modelIntent, language: 'en', search_query: 'q' }),
        model: 'mock',
        inputTokens: 0,
        outputTokens: 0,
      }),
    };
    return new IntentService(registry as never);
  }

  it.each([
    'list of judgements for order 32 cpc',
    'judgments on order 39 rule 1 CPC',
    'case law for article 226',
    'precedents under Order 37 CPC',
    'rulings on Order 7 Rule 11',
  ])('leaves %p as a precedent search', async (text) => {
    const intent = await service().classify(text);

    expect(intent.intent).toBe('PRECEDENT_SEARCH');
  });

  it('still carries the provision so retrieval can use it', async () => {
    // Standing down from the override must not also throw away what was
    // extracted - the section filter is what keeps the results on topic.
    const intent = await service().classify('list of judgements for order 32 cpc');

    expect(intent.sectionNumber).toBe('Order 32');
    expect(intent.actCode).toBe('CPC');
  });

  it.each([
    'order 32 CPC',
    'what does order 32 cpc provide',
    'explain Order 37 Rule 3',
    'article 226',
  ])('still overrides %p, which asks for no judgments', async (text) => {
    // The narrowness is the point. If these stopped being overridden, the
    // original bug is back.
    const intent = await service().classify(text);

    expect(intent.intent).toBe('SECTION_LOOKUP');
  });
});

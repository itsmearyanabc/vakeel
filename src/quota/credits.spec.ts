import { CREDIT_COST, isSameSearchContext } from './quota.service';

/**
 * What an advocate is billed for.
 *
 * These rules are a promise to the person paying, so the tests are written from
 * their side: "I asked the same thing twice and was charged twice" is a
 * complaint, not a bug report, and it has to be impossible rather than
 * unlikely.
 */
describe('credit costs', () => {
  it('never charges for a case status lookup', () => {
    // A court-record lookup with no model call behind it, done standing
    // outside a courtroom. Charging for it would ration the cheapest feature.
    expect(CREDIT_COST.CASE_STATUS).toBe(0);
  });

  it('charges two for research', () => {
    expect(CREDIT_COST.SECTION_LOOKUP).toBe(2);
    expect(CREDIT_COST.PRECEDENT_SEARCH).toBe(2);
  });
});

describe('isSameSearchContext', () => {
  it('treats an identical question as already paid for', () => {
    expect(isSameSearchContext('what is IPC 420', 'what is IPC 420')).toBe(true);
  });

  it.each([
    ['casing', 'What Is IPC 420', 'what is ipc 420'],
    ['punctuation', 'what is IPC 420?', 'what is IPC 420'],
    ['word order', 'IPC 420 what is', 'what is IPC 420'],
    ['extra whitespace', 'what   is  IPC 420', 'what is IPC 420'],
  ])('ignores %s', (_label, previous, next) => {
    expect(isSameSearchContext(previous, next)).toBe(true);
  });

  it('charges again for a genuinely different section', () => {
    // The example that decided the rule: IPC 420 -> section 53 is new work.
    expect(isSameSearchContext('what is IPC 420', 'what is section 53')).toBe(false);
  });

  it('charges for the first search of a session', () => {
    expect(isSameSearchContext(null, 'what is IPC 420')).toBe(false);
    expect(isSameSearchContext('', 'what is IPC 420')).toBe(false);
  });

  it('does not treat a longer follow-up as the same question', () => {
    // Deliberate. A similarity threshold would charge for one rephrasing and
    // not another, which is impossible to explain to whoever is paying.
    // Paging with "more" is handled by the caller and never reaches here.
    expect(isSameSearchContext('IPC 420', 'IPC 420 punishment and bail')).toBe(false);
  });
});

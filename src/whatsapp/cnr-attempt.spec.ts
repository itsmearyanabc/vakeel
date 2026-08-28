import { isStale, looksLikeCnrAttempt } from './conversation.service';

/**
 * Regression tests for the CNR state trap.
 *
 * Every string in the "changes the subject" block is one a real advocate
 * actually sent to the live bot and got "I could not find a case with that CNR
 * number" in reply - twice, because the first fix was also wrong. They are kept
 * verbatim rather than tidied up.
 */
describe('looksLikeCnrAttempt', () => {
  describe('changes the subject - must release the CNR state', () => {
    it.each([
      // These three came from the production transcript.
      ['what is ipc 420'],
      ['Okay let me'],
      ['Hindi please'],
      // Natural follow-ups that must not be swallowed either.
      ['can you search case law on bail'],
      ['thanks'],
      ['what can you do'],
      ['punishment for cheating'],
      ['302 ka punishment kya hai'],
      ['menu'],
      ['actually never mind'],
      ['show me precedents on anticipatory bail'],
    ])('%s', (text) => {
      expect(looksLikeCnrAttempt(text)).toBe(false);
    });

    it('specifically rejects the string that broke production', () => {
      // Stripping whitespace made this "whatisipc420" - 12 alphanumerics - and
      // the old rule read it as a botched CNR.
      expect('what is ipc 420'.replace(/\s/g, '')).toHaveLength(12);
      expect(looksLikeCnrAttempt('what is ipc 420')).toBe(false);
    });
  });

  describe('is a CNR attempt - must show the corrective message', () => {
    it.each([
      // Valid shape but wrong, e.g. a typo - the user needs the hint.
      ['DLCT010001232024'],
      ['BRMG030000191989'],
      ['dlct01000123202'],
      ['DLCT-0100-0123-2024'],
      // Typed in groups, which people do with long reference numbers.
      ['DLCT01 000123 2024'],
      ['DLCT01 0001232024'],
    ])('%s', (text) => {
      expect(looksLikeCnrAttempt(text)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty and whitespace-only input', () => {
      expect(looksLikeCnrAttempt('')).toBe(false);
      expect(looksLikeCnrAttempt('   ')).toBe(false);
    });

    it('does not treat a long ordinary sentence as a CNR', () => {
      expect(
        looksLikeCnrAttempt('I need to know the current status of my client matter please'),
      ).toBe(false);
    });

    it('treats a bare long number as an attempt', () => {
      // Probably a case number rather than a CNR, but the corrective message is
      // the right response either way.
      expect(looksLikeCnrAttempt('12345678901234')).toBe(true);
    });
  });
});

/**
 * Replay protection.
 *
 * Two independent things re-deliver an old message, and both were observed in
 * production on the same afternoon: Meta held a webhook backlog while the
 * callback URL pointed at a dead host and flushed it at the new one, and the
 * queue's stalled-job sweep re-ran jobs stranded by a deploy. Either way an
 * advocate gets an answer to something they asked yesterday, and once the
 * 24-hour service window has closed the send is refused with error 131047
 * *after* the credit has been spent.
 */
describe('isStale', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('accepts a message that just arrived', () => {
    expect(isStale(now())).toBe(false);
  });

  it('accepts a message from an hour ago', () => {
    expect(isStale(now() - 3600)).toBe(false);
  });

  it('accepts one at twenty-two hours, still inside the window', () => {
    expect(isStale(now() - 22 * 3600)).toBe(false);
  });

  it('drops one at twenty-four hours, where the reply would be refused', () => {
    expect(isStale(now() - 24 * 3600)).toBe(true);
  });

  it('drops a day-old backlog message', () => {
    expect(isStale(now() - 48 * 3600)).toBe(true);
  });

  it('treats a missing or nonsensical timestamp as fresh', () => {
    // Guessing "old" on bad data would silently drop live messages, which is
    // the worse of the two mistakes: a duplicate reply annoys, a dropped one
    // looks like the bot is broken.
    expect(isStale(0)).toBe(false);
    expect(isStale(NaN)).toBe(false);
    expect(isStale(-1)).toBe(false);
  });

  it('does not drop a message dated slightly in the future', () => {
    // Clock skew between Meta and this host must never eat a real message.
    expect(isStale(now() + 120)).toBe(false);
  });
});

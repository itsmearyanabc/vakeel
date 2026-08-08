import { looksLikeCnrAttempt } from './conversation.service';

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

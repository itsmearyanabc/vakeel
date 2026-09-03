import { isValidCnr, normaliseCnr, parseProfile } from './onboarding';
import { matchLanguage } from './replies';

/**
 * Onboarding is the very first interaction an advocate has with the bot, so
 * the failure that matters is not "accepted something odd" - it is "rejected
 * something reasonable and made the product look broken at first contact".
 * The permissive cases below are the point of these tests.
 */
describe('parseProfile', () => {
  const expected = {
    fullName: 'Ramesh Kumar',
    barCouncilId: 'D/1234/2015',
    city: 'Patna',
    state: 'Bihar',
  };

  it('parses the format we ask for', () => {
    expect(parseProfile('Ramesh Kumar, D/1234/2015, Patna, Bihar')).toEqual(expected);
  });

  it.each([
    ['newlines instead of commas', 'Ramesh Kumar\nD/1234/2015\nPatna\nBihar'],
    ['extra whitespace', '  Ramesh   Kumar ,  D/1234/2015 ,  Patna ,  Bihar  '],
    ['a trailing full stop', 'Ramesh Kumar, D/1234/2015, Patna, Bihar.'],
    ['semicolons', 'Ramesh Kumar; D/1234/2015; Patna; Bihar'],
    ['numbered lines', '1. Ramesh Kumar\n2. D/1234/2015\n3. Patna\n4. Bihar'],
    ['labels', 'Name: Ramesh Kumar, Bar Council ID: D/1234/2015, City: Patna, State: Bihar'],
  ])('accepts %s', (_label, input) => {
    expect(parseProfile(input)).toEqual(expected);
  });

  it('normalises casing for display', () => {
    // Echoed back in "Welcome back ..." on every future session.
    expect(parseProfile('RAMESH KUMAR, d/1234/2015, patna, BIHAR')).toEqual(expected);
  });

  it('leaves a deliberately mixed-case name alone', () => {
    expect(parseProfile("Ronald McDonald, D/1234/2015, Patna, Bihar")?.fullName).toBe('Ronald McDonald');
  });

  it('keeps a name that contains a comma', () => {
    // Positional parsing would truncate this to "Ramesh Kumar"; splitting
    // around the Bar Council ID does not.
    expect(parseProfile('Ramesh Kumar, Jr, D/1234/2015, Patna, Bihar')?.fullName).toBe('Ramesh Kumar Jr');
  });

  it('strips spaces inside the bar council id', () => {
    expect(parseProfile('Ramesh Kumar, KAR 567 2019, Mysuru, Karnataka')?.barCouncilId).toBe('KAR5672019');
  });

  describe('refuses to guess', () => {
    it.each([
      ['no bar council id at all', 'Ramesh Kumar, Patna, Bihar'],
      ['city and state missing', 'Ramesh Kumar, D/1234/2015'],
      ['state missing', 'Ramesh Kumar, D/1234/2015, Patna'],
      ['name missing', 'D/1234/2015, Patna, Bihar'],
      ['an ordinary question', 'what is section 420 IPC'],
      ['empty', ''],
    ])('returns null for %s', (_label, input) => {
      // A half-filled profile is worse than asking again: the advocate never
      // finds out a field is blank and nothing ever prompts for it.
      expect(parseProfile(input)).toBeNull();
    });

    it('does not mistake a phone number for an enrolment year', () => {
      expect(parseProfile('Ramesh Kumar, 9876543210, Patna, Bihar')).toBeNull();
    });
  });
});

describe('isValidCnr', () => {
  it.each(['BRMG030000191989', 'brmg030000191989', 'BRMG 0300 0019 1989', 'BRMG-030000191989'])(
    'accepts %s',
    (input) => {
      expect(isValidCnr(input)).toBe(true);
    },
  );

  it.each([
    ['too short', 'BRMG0300001919'],
    ['too long', 'BRMG0300001919891'],
    ['digits where letters belong', '1RMG030000191989'],
    ['letters where digits belong', 'BRMG03000019198X'],
    ['an implausible year', 'BRMG030000191089'],
    ['plain text', 'what is ipc 420'],
  ])('rejects %s', (_label, input) => {
    expect(isValidCnr(input)).toBe(false);
  });

  it('normalises separators', () => {
    expect(normaliseCnr('brmg-0300 0019 1989')).toBe('BRMG030000191989');
  });
});

describe('matchLanguage', () => {
  it.each([
    ['1', 'en'],
    ['2', 'hi'],
    ['3', 'kn'],
    ['english', 'en'],
    ['English', 'en'],
    ['hindi', 'hi'],
    ['हिंदी', 'hi'],
    ['kannada', 'kn'],
    ['ಕನ್ನಡ', 'kn'],
    ['2.', 'hi'],
  ])('resolves %s to %s', (input, code) => {
    // Number, English name and native name are all things people actually
    // send; rejecting two of the three makes the menu feel broken.
    expect(matchLanguage(input)?.code).toBe(code);
  });

  it.each(['4', '0', 'french', '', 'yes'])('returns null for %s', (input) => {
    expect(matchLanguage(input)).toBeNull();
  });

  it('does not read "hi" as a request for Hindi', () => {
    /*
     * It did, by matching the ISO code. So the most common way anybody opens a
     * chat, sent at the language prompt by somebody who had not read it,
     * silently switched an English-speaking advocate's replies to Hindi and
     * dropped them at the menu with no explanation and no obvious way back.
     *
     * "hindi" and "2" still work, which is what people who mean Hindi type.
     */
    expect(matchLanguage('hi')).toBeNull();
    expect(matchLanguage('Hi')).toBeNull();
    expect(matchLanguage('hindi')?.code).toBe('hi');
    expect(matchLanguage('2')?.code).toBe('hi');
  });

  it('still resolves the two codes somebody might type on purpose', () => {
    // Nobody types "hi" meaning Hindi, and somebody might type "en". The two
    // safe ones are aliases now rather than a blanket match on the code.
    expect(matchLanguage('en')?.code).toBe('en');
    expect(matchLanguage('kn')?.code).toBe('kn');
  });
});

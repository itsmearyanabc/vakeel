import { DUMMY_HASH } from './auth.service';
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from './password';

/**
 * Password hashing.
 *
 * Slow by design - each derivation is 32 MiB of scrypt - so these are kept few
 * and aimed at the properties that would be silently wrong rather than at
 * coverage. A bug here does not throw; it produces a login form that accepts
 * the wrong password, or one that rejects the right one after a config change.
 */
describe('hashPassword / verifyPassword', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('a-perfectly-ordinary-password');

    await expect(verifyPassword('a-perfectly-ordinary-password', hash)).resolves.toBe(true);
    await expect(verifyPassword('a-perfectly-ordinary-passwore', hash)).resolves.toBe(false);
  });

  it('produces a different hash every time for the same password', async () => {
    // The salt is what guarantees this. Without it, two advocates who chose the
    // same password would be visibly identical in a database dump, and one
    // rainbow table would cover the whole column.
    const [a, b] = await Promise.all([hashPassword('same-password-twice'), hashPassword('same-password-twice')]);

    expect(a).not.toEqual(b);
    await expect(verifyPassword('same-password-twice', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password-twice', b)).resolves.toBe(true);
  });

  it('records its parameters in the encoded hash', async () => {
    // This is what makes raising the work factor a change rather than a flag
    // day: an old hash keeps verifying against the cost it was made with.
    const hash = await hashPassword('parameters-are-recorded');
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('normalises unicode, so the same typed password verifies', async () => {
    // é can be one code point or two. A password typed on a Mac and later on
    // Windows can differ byte-for-byte while being the same password to the
    // person typing it.
    const composed = 'contraseñabuena';
    const decomposed = composed.normalize('NFD');

    expect(composed).not.toEqual(decomposed);

    const hash = await hashPassword(composed);
    await expect(verifyPassword(decomposed, hash)).resolves.toBe(true);
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['not scrypt', 'bcrypt$10$abc$def$ghi$jkl'],
    ['too few fields', 'scrypt$32768$8$1$onlysalt'],
    ['a zero cost', 'scrypt$0$8$1$AAAA$AAAA'],
    ['nonsense', 'not-a-hash-at-all'],
  ])('denies rather than throwing on a %s hash', async (_label, stored) => {
    // A corrupted row must fail the sign-in, not 500 the endpoint. The second
    // turns one bad record into an outage and tells an attacker they have
    // found something worth poking at.
    await expect(verifyPassword('anything', stored)).resolves.toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with the current cost', async () => {
    expect(needsRehash(await hashPassword('current-cost-password'))).toBe(false);
  });

  it('is true for a weaker cost', () => {
    // A hash written before the work factor was raised. Sign-in is the only
    // moment the plaintext exists, so it is the only moment this can be fixed.
    expect(needsRehash('scrypt$16384$8$1$AAAA$AAAA')).toBe(true);
  });

  it('is true for anything unparseable, so a bad row is replaced', () => {
    expect(needsRehash(null)).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});

/**
 * The dummy hash exists so that signing in with an unregistered address costs
 * the same time as signing in with a registered one. If its parameters drift
 * from the real ones, the two paths diverge measurably and the account
 * enumeration channel that the generic error message closes is reopened through
 * a stopwatch. See AuthService.signIn.
 */
describe('the timing-equalisation dummy hash', () => {
  it('parses, and no password matches it', async () => {
    await expect(verifyPassword('', DUMMY_HASH)).resolves.toBe(false);
    await expect(verifyPassword('hunter2', DUMMY_HASH)).resolves.toBe(false);
  });

  it('dummyHashMatchesCurrentCost', async () => {
    // The real assertion: it carries the same cost as a freshly made hash, so
    // deriving against it takes the same work. needsRehash() is exactly the
    // "are these parameters current" question, so it answers this one too.
    expect(needsRehash(DUMMY_HASH)).toBe(false);
  });
});

describe('passwordProblem', () => {
  it('rejects anything under the configured minimum', () => {
    expect(passwordProblem('short', 10)).toMatch(/at least 10/);
    expect(passwordProblem('exactly-10', 10)).toBeNull();
  });

  it('rejects an absurdly long password', () => {
    // Not a strength rule. scrypt will hash any length, so an unbounded field
    // is a cheap way to make every login attempt expensive for the server.
    expect(passwordProblem('x'.repeat(201), 10)).toMatch(/200 characters/);
  });

  it('imposes no composition rules', () => {
    // Deliberate. Requiring a symbol and a digit measurably pushes people
    // towards Password1!, which is why NIST stopped recommending it.
    expect(passwordProblem('all lowercase words no digits', 10)).toBeNull();
  });
});

import { clearCookie, readCookie, serializeCookie } from './cookies';

/**
 * Cookie handling.
 *
 * Worth testing despite being small, because every failure mode here presents
 * identically to the user - "I signed in and it did nothing" - and none of them
 * produces an error anywhere in the logs.
 */
describe('readCookie', () => {
  it('finds a cookie among others', () => {
    expect(readCookie('a=1; vs_session=abc123; b=2', 'vs_session')).toBe('abc123');
  });

  it('does not match a cookie whose name merely ends with the one asked for', () => {
    // `vs_oauth_state` and `vs_session` coexist, and a substring match would
    // return whichever came first.
    expect(readCookie('other_vs_session=wrong; vs_session=right', 'vs_session')).toBe('right');
  });

  it('decodes percent-encoded values', () => {
    expect(readCookie('vs_session=a%2Bb%3Dc', 'vs_session')).toBe('a+b=c');
  });

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['a header without the cookie', 'other=1; another=2'],
    ['a malformed pair', 'vs_sessionabc123'],
  ])('returns undefined for %s', (_label, header) => {
    expect(readCookie(header, 'vs_session')).toBeUndefined();
  });

  it('returns undefined rather than throwing on a broken encoding', () => {
    // The Cookie header is attacker-controlled on every single request. A stray
    // `%` makes decodeURIComponent throw, and an unhandled throw here would be
    // a 500 on every page load for anyone who could plant one.
    expect(readCookie('vs_session=%E0%A4', 'vs_session')).toBeUndefined();
  });
});

describe('serializeCookie', () => {
  it('is HttpOnly and SameSite=Lax by default', () => {
    const header = serializeCookie('vs_session', 'token', { secure: true });

    // HttpOnly is why an XSS bug cannot steal the session; it is the single
    // most valuable attribute here.
    expect(header).toContain('HttpOnly');
    // Lax rather than Strict: Strict withholds the cookie on top-level
    // navigation into the app, so an advocate following an email link or
    // returning from Google would arrive signed out.
    expect(header).toContain('SameSite=Lax');
  });

  it('omits Secure when the deployment is not on https', () => {
    // Setting Secure on plain http makes the browser silently discard the
    // cookie: sign-in appears to succeed and the next request is anonymous,
    // with nothing in any log to explain it. Local development runs on http.
    expect(serializeCookie('vs_session', 'token', { secure: false })).not.toContain('Secure');
    expect(serializeCookie('vs_session', 'token', { secure: true })).toContain('Secure');
  });

  it('writes both Max-Age and Expires', () => {
    const header = serializeCookie('vs_session', 'token', { secure: true, maxAgeSeconds: 3600 });
    expect(header).toContain('Max-Age=3600');
    expect(header).toMatch(/Expires=\w{3}, \d{2} \w{3} \d{4}/);
  });

  it('encodes the value', () => {
    const header = serializeCookie('vs_session', 'a+b=c', { secure: true });
    expect(header).toContain('vs_session=a%2Bb%3Dc');
    // Round-trips through the reader.
    expect(readCookie(header.split(';')[0], 'vs_session')).toBe('a+b=c');
  });
});

describe('clearCookie', () => {
  it('expires immediately and keeps the same path', () => {
    // A clear with a different path leaves the original cookie in place, and
    // the user stays signed in after pressing Sign out.
    const header = clearCookie('vs_session', true);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Path=/');
    expect(header).toContain('vs_session=');
  });
});

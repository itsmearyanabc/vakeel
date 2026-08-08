import { createHmac } from 'node:crypto';
import { ADMIN_UI_HTML } from './admin-ui.html';
import { JwtPayload, parseDuration, signJwt, verifyJwt } from './jwt';

const SECRET = 'test-secret-value-at-least-16-chars';

describe('parseDuration', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['12h', 43_200],
    ['7d', 604_800],
    ['900', 900],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('falls back rather than throwing on nonsense', () => {
    // A malformed JWT_EXPIRES_IN must not stop the service booting.
    expect(parseDuration('not-a-duration')).toBe(43_200);
    expect(parseDuration('', 60)).toBe(60);
  });
});

describe('signJwt / verifyJwt', () => {
  it('round-trips a payload', () => {
    const token = signJwt({ sub: 'admin@example.com', role: 'SUPER_ADMIN' }, SECRET, 3600);
    const payload = verifyJwt(token, SECRET);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('admin@example.com');
    expect(payload!.role).toBe('SUPER_ADMIN');
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signJwt({ sub: 'a@b.com', role: 'SUPER_ADMIN' }, 'other-secret', 3600);
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    // The attack the signature exists to stop: keep the signature, swap the
    // claims. Without verification this would be a free privilege escalation.
    const token = signJwt({ sub: 'user@example.com', role: 'SUPER_ADMIN' }, SECRET, 3600);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'attacker@evil.com', role: 'SUPER_ADMIN', iat: 1, exp: 9_999_999_999 })).toString('base64url');

    expect(verifyJwt(`${header}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signJwt({ sub: 'a@b.com', role: 'SUPER_ADMIN' }, SECRET, -1);
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it('rejects the alg=none confusion attack', () => {
    // The classic JWT vulnerability: an attacker declares there is no signature
    // and hopes the verifier believes the token's own header. The verifier must
    // decide the algorithm itself.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'attacker@evil.com', role: 'SUPER_ADMIN', iat: 1, exp: 9_999_999_999 } satisfies JwtPayload),
    ).toString('base64url');

    expect(verifyJwt(`${header}.${body}.`, SECRET)).toBeNull();
    expect(verifyJwt(`${header}.${body}.anything`, SECRET)).toBeNull();
  });

  it('rejects a signature computed over only the body', () => {
    // A verifier that signs the wrong span would accept this.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'x@y.com', role: 'SUPER_ADMIN', iat: 1, exp: 9_999_999_999 })).toString('base64url');
    const wrongSpan = createHmac('sha256', SECRET).update(body).digest('base64url');

    expect(verifyJwt(`${header}.${body}.${wrongSpan}`, SECRET)).toBeNull();
  });

  it.each([['garbage'], ['a.b'], ['a.b.c.d'], ['']])('returns null, never throws, for %p', (bad) => {
    expect(() => verifyJwt(bad, SECRET)).not.toThrow();
    expect(verifyJwt(bad, SECRET)).toBeNull();
  });
});

/**
 * The admin panel is one large String.raw template literal. A stray backtick
 * anywhere inside it silently terminates the literal, producing a truncated
 * page that still compiles. These assertions catch that.
 */
describe('admin UI document integrity', () => {
  it('is a complete HTML document', () => {
    expect(ADMIN_UI_HTML.trimStart().startsWith('<!doctype html>')).toBe(true);
    expect(ADMIN_UI_HTML.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('contains no backticks', () => {
    expect(ADMIN_UI_HTML.includes('`')).toBe(false);
  });

  it('has balanced script and style tags', () => {
    const count = (needle: string) => ADMIN_UI_HTML.split(needle).length - 1;
    expect(count('<script>')).toBe(count('</script>'));
    expect(count('<style>')).toBe(count('</style>'));
    expect(count('<style>')).toBeGreaterThan(0);
  });

  it('ships the login form and the olive palette', () => {
    expect(ADMIN_UI_HTML).toContain('id="email"');
    expect(ADMIN_UI_HTML).toContain('id="password"');
    expect(ADMIN_UI_HTML).toContain('--olive:#6B8E23');
    expect(ADMIN_UI_HTML).toContain('--red:#C1121F');
  });

  it('loads no external resources', () => {
    // A strict no-CDN rule: the panel must render with no third-party
    // JavaScript in front of an interface that displays advocates' data.
    expect(ADMIN_UI_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(ADMIN_UI_HTML).not.toMatch(/<link[^>]+stylesheet/i);
    expect(ADMIN_UI_HTML).not.toMatch(/https?:\/\/(?!platform\.claude|graph\.facebook)/i);
  });
});

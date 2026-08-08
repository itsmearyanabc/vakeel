import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT sign/verify.
 *
 * ## Why not the `jsonwebtoken` package
 *
 * We need exactly two operations on one algorithm, and Node ships HMAC-SHA256 in
 * its standard library. The library would add a dependency (and its transitive
 * tree) to a service whose whole auth surface is one admin login form. The parts
 * that are genuinely easy to get wrong here are the ones handled below:
 * constant-time signature comparison, and rejecting the `alg` header rather than
 * trusting it.
 *
 * ## The `alg` confusion attack
 *
 * The classic JWT vulnerability is trusting the token's own `alg` header. An
 * attacker sends `{"alg":"none"}` with no signature, or swaps HS256 for RS256 to
 * get the public key treated as an HMAC secret. {@link verifyJwt} ignores the
 * header's claim entirely and only ever validates as HS256 - the algorithm is a
 * property of our verifier, never of the untrusted input.
 */

export interface JwtPayload {
  /** Subject - the admin's email. */
  sub: string;
  role: 'SUPER_ADMIN';
  /** Issued at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Parse a duration like `12h`, `30m`, `7d`, `900s` into seconds.
 *
 * A bare number is treated as seconds. Anything unparseable falls back to 12
 * hours rather than throwing - a malformed JWT_EXPIRES_IN should not stop the
 * service booting, and a sane default is safer than an infinite session.
 */
export function parseDuration(value: string, fallbackSeconds = 43_200): number {
  const match = /^(\d+)\s*([smhd]?)$/i.exec(value.trim());
  if (!match) return fallbackSeconds;

  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[match[2].toLowerCase() || 's'] ?? 1;
  return amount * multiplier;
}

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresInSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(
    JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds } satisfies JwtPayload),
  );
  const data = `${header}.${body}`;
  return `${data}.${sign(data, secret)}`;
}

/**
 * Verify a token and return its payload, or null if it is not valid.
 *
 * Never throws: every failure path is a null return, so callers cannot
 * accidentally treat a thrown parse error as anything other than "denied".
 */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;

  // Recompute rather than reading `alg` from the token - see the class comment.
  const expected = sign(`${header}.${body}`, secret);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

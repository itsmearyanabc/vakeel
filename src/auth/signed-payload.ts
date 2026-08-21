import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A short-lived, tamper-evident payload carried in a cookie.
 *
 * ## What this replaced
 *
 * Redis held the in-flight OAuth state — the PKCE verifier and the post-sign-in
 * destination — under a random key for ten minutes. That is a server-side store
 * for something only one browser will ever present, which is exactly the shape
 * a signed cookie handles without a store at all.
 *
 * ## Signed, not encrypted, and why that is enough
 *
 * The contents are not secret. A PKCE verifier is protection against an
 * intercepted *authorization code*, and the browser holding it is the same
 * browser that will present the code — there is nothing to hide from it. What
 * matters is that the value cannot be *changed*, because a forged `returnTo`
 * would be an open redirect and a forged verifier would break the exchange.
 * An HMAC gives exactly that.
 *
 * If a future payload here does hold a secret, this needs to become encryption
 * rather than signing. That would be a change of kind, not a tweak, which is
 * why it is stated rather than assumed.
 *
 * ## Why the expiry is inside the signature
 *
 * A cookie's own `Max-Age` is a request to the browser, not a guarantee — a
 * client that ignores it can present a year-old value. The `exp` below is
 * covered by the HMAC and checked on the server, so the lifetime is enforced by
 * whoever validates rather than by whoever stores.
 */

interface Envelope<T> {
  d: T;
  /** Expiry, epoch seconds. Covered by the signature. */
  exp: number;
}

/** Sign a payload for at most `ttlSeconds`. */
export function signPayload<T>(payload: T, secret: string, ttlSeconds: number): string {
  const envelope: Envelope<T> = {
    d: payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const body = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify and unwrap. Returns null for anything that is not a valid, live
 * payload — never throws, so a caller cannot mistake a parse failure for a
 * success.
 */
export function verifyPayload<T>(token: string | undefined, secret: string): T | null {
  if (!token) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expected = sign(body, secret);

  // Constant time. A plain === on a signature leaks it a byte at a time to
  // anyone able to measure the response.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Envelope<T>;
  } catch {
    return null;
  }

  if (typeof envelope.exp !== 'number' || envelope.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return envelope.d;
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

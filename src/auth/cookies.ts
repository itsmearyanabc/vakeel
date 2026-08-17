/**
 * Cookie reading and writing, without `@fastify/cookie`.
 *
 * The plugin exists and is perfectly good. It is not worth a dependency here:
 * this application sets exactly two cookies, neither is signed, and the parsing
 * a session cookie needs is a split on `;`. What the plugin would genuinely add
 * - signing - is not wanted, because the session token is already a 256-bit
 * random value validated against a database row. Signing it would authenticate
 * a value whose authenticity is established by the lookup that follows.
 */

export interface CookieOptions {
  maxAgeSeconds?: number;
  /** Set for HTTPS deployments; must NOT be set on plain http - see below. */
  secure: boolean;
  path?: string;
  sameSite?: 'Strict' | 'Lax' | 'None';
  httpOnly?: boolean;
}

/**
 * Read one cookie from a raw `Cookie` header.
 *
 * Returns undefined rather than throwing on anything malformed. The header is
 * attacker-controlled on every request, and a parse error must be a missing
 * session, not a 500.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    if (part.slice(0, index).trim() !== name) continue;

    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A stray `%` makes decodeURIComponent throw. The value is not one we
      // wrote, so it cannot be a valid session either way.
      return undefined;
    }
  }

  return undefined;
}

/**
 * Build a `Set-Cookie` value.
 *
 * The attribute choices, and why each one:
 *
 *   **HttpOnly** - page JavaScript cannot read the session token, so an XSS bug
 *   anywhere in the app cannot exfiltrate it. This is the single most valuable
 *   attribute here and it is why the token lives in a cookie rather than in
 *   localStorage, which is readable by any script that runs.
 *
 *   **SameSite=Lax** - the cookie is not sent on cross-site POSTs, which
 *   removes the whole class of CSRF that needs one. Lax rather than Strict
 *   because Strict also withholds it on ordinary top-level navigation *into*
 *   the app: an advocate following the link in their verification email would
 *   arrive signed out, which reads as a broken product. Lax sends it on
 *   top-level GETs and withholds it on cross-site form posts, which is exactly
 *   the line wanted.
 *
 *   **Secure** - derived from the public URL, never configured by hand. Setting
 *   Secure on a plain-http origin makes the browser silently discard the
 *   cookie: sign-in appears to succeed and the next request is anonymous, with
 *   nothing in any log to explain it. Local http development therefore gets a
 *   non-Secure cookie automatically.
 *
 *   **Path=/** - the app, the API and the OAuth callback are on different
 *   prefixes and all need it.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? '/'}`);
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);

  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');

  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
    // Max-Age alone is ignored by some older clients; Expires covers them. When
    // both are present every current browser prefers Max-Age.
    parts.push(`Expires=${new Date(Date.now() + options.maxAgeSeconds * 1000).toUTCString()}`);
  }

  return parts.join('; ');
}

/**
 * A cookie that deletes the one already there.
 *
 * The attributes must match the ones it was set with - a browser treats a
 * cookie as a different cookie if the path or domain differs, so a clear with
 * the wrong path leaves the original in place and the user stays signed in
 * after clicking Sign out.
 */
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', { secure, maxAgeSeconds: 0 });
}

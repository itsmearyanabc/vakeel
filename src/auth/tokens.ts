import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Secret generation and storage for sessions, email links and phone codes.
 *
 * ## The rule this file exists to enforce
 *
 * Every secret here is handed out once and stored only as a SHA-256 digest.
 * A database leak then yields nothing usable: the digests cannot be presented
 * as credentials, and reversing them is the same problem as reversing a hash of
 * 256 random bits, which is to say it is not a problem anyone solves.
 *
 * ## Why plain SHA-256 and not scrypt, when passwords get scrypt
 *
 * Password hashing is slow *on purpose*, because a password has perhaps 40 bits
 * of entropy and an attacker's only limit is how many guesses per second they
 * can make. These tokens carry 256 bits from a CSPRNG. There is nothing to
 * guess, so there is nothing for a work factor to slow down - it would only
 * make every authenticated request more expensive. Fast hashing is the correct
 * choice for high-entropy secrets and the wrong one for passwords, and the
 * difference is the entropy, not the sensitivity.
 */

/** 32 bytes. base64url so it survives a cookie, a URL and a copy-paste. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What actually goes in the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A six-digit code for linking a phone number over WhatsApp.
 *
 * Short because a human retypes it into a chat, which is also why it is the one
 * secret here with genuinely little entropy - a million possibilities is
 * nothing against an automated guesser. Its safety comes from the constraints
 * around it rather than from its length: a short expiry, a hard attempt cap
 * enforced on the row, and a binding to the specific number it was issued for.
 * Lengthening it would not fix a missing attempt cap, and the attempt cap makes
 * the length sufficient.
 *
 * `randomInt` and not `Math.random()`: the latter is seeded predictably and is
 * not a source anyone should authenticate against.
 */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, '0');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Used where a digest is compared in application code rather than by an index
 * lookup. A plain `===` on secret-derived material leaks it a byte at a time to
 * anyone able to measure the response.
 */
export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

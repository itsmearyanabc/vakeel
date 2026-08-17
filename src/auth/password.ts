import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * `promisify(scrypt)` resolves to the three-argument overload, which cannot
 * carry the cost parameters, so the wrapper is written out instead of inferred.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
}

/**
 * Password hashing with scrypt.
 *
 * ## Why scrypt and not bcrypt or argon2
 *
 * Node ships scrypt in `node:crypto`. bcrypt and argon2 are native addons: they
 * need a compiler in the Docker build, they break on Node major upgrades, and
 * they are a third-party dependency sitting on the credential path. scrypt is
 * memory-hard, which is the property that matters against GPU cracking, and it
 * is already here.
 *
 * argon2id is the better algorithm on paper. It is not enough better to justify
 * a native build step for a service whose whole auth surface is a login form -
 * and the encoding below means switching to it later is a migration rather than
 * a rewrite.
 *
 * ## Why the parameters are stored in the hash
 *
 * The encoded form is `scrypt$N$r$p$salt$hash`, so every hash carries the cost
 * it was created with. Raising the work factor is then a one-line change that
 * applies to new passwords immediately, while every existing hash keeps
 * verifying against the parameters it was made with. Hard-coding the cost at
 * the verify site is what makes a work-factor increase a flag day where nobody
 * can sign in.
 *
 * `needsRehash` completes that: on a successful sign-in the caller can notice
 * an old hash and quietly upgrade it, using the one moment the plaintext is
 * legitimately available.
 */

/**
 * CPU/memory cost. 2^15 with r=8 is 32 MiB per hash.
 *
 * The trade is real and worth stating: this is per concurrent login, so a burst
 * of sign-ins is a memory spike on a small container. Halving it would double
 * an attacker's throughput against a stolen database. 32 MiB is the point where
 * the defence is meaningful and a starter instance still copes; raise it (and
 * MAX_MEM with it) when the service has room.
 */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Node's default scrypt maxmem is 32 MiB, which N=2^15,r=8 sits exactly on and
 * then exceeds by the algorithm's own overhead - producing a confusing
 * `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` rather than anything about memory. Set
 * explicitly, with headroom.
 */
const MAX_MEM = 96 * 1024 * 1024;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * Hash a password for storage.
 *
 * The salt is per password and random, which is what stops one rainbow table
 * from covering the whole table and stops two users with the same password
 * having the same hash.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(plaintext.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });

  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Check a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed or unknown-algorithm hash.
 * A corrupted row should deny the sign-in, not 500 the endpoint - the second
 * turns a bad record into an outage and tells an attacker they found something
 * interesting.
 */
export async function verifyPassword(plaintext: string, encoded: string | null): Promise<boolean> {
  if (!encoded) return false;

  const parsed = parseHash(encoded);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(plaintext.normalize('NFKC'), parsed.salt, parsed.hash.length, {
      N: parsed.params.N,
      r: parsed.params.r,
      p: parsed.params.p,
      maxmem: MAX_MEM,
    });
  } catch {
    // Parameters outside what this Node build will accept - a hash written by
    // a future version with a higher cost, most plausibly.
    return false;
  }

  // Lengths are equal by construction (the derivation was asked for exactly
  // parsed.hash.length bytes), but timingSafeEqual throws on a mismatch and
  // this is not the place to find out.
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Should this hash be recomputed at the next successful sign-in?
 *
 * True when it was made with a weaker cost than the current one. Sign-in is the
 * only moment the plaintext exists, so it is the only moment an upgrade is
 * possible - which is why this is worth doing there rather than in a batch job
 * that cannot.
 */
export function needsRehash(encoded: string | null): boolean {
  const parsed = parseHash(encoded ?? '');
  if (!parsed) return true;
  return parsed.params.N < N || parsed.params.r < R || parsed.params.p < P;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6) return null;

  const [algorithm, rawN, rawR, rawP, salt, hash] = parts;
  if (algorithm !== 'scrypt') return null;

  const params = { N: Number(rawN), r: Number(rawR), p: Number(rawP) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return null;
  }
  // A zero or negative cost would be accepted by Number.isInteger and is
  // exactly what a tampered row would carry.
  if (params.N < 2 || params.r < 1 || params.p < 1) return null;

  try {
    return { params, salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
  } catch {
    return null;
  }
}

/**
 * Is this password acceptable?
 *
 * Length is the only rule. Composition requirements - an uppercase, a digit, a
 * symbol - measurably push people towards `Password1!` and its cousins, which
 * is why NIST stopped recommending them; a longer minimum buys more than a more
 * elaborate one.
 *
 * The upper bound is not a strength rule. scrypt hashes arbitrarily long input,
 * so an unbounded field is a cheap way to make every login attempt expensive
 * for the server.
 */
export function passwordProblem(plaintext: string, minLength: number): string | null {
  if (plaintext.length < minLength) {
    return `Password must be at least ${minLength} characters.`;
  }
  if (plaintext.length > 200) {
    return 'Password must be 200 characters or fewer.';
  }
  return null;
}

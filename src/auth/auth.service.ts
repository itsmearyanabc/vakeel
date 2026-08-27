import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { RateLimiter } from '../common/rate-limiter';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CreditsService } from '../credits/credits.service';
import { AuthRepository } from '../database/repositories/auth.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { UserRow, WebSessionRow } from '../database/types';
import { EmailService } from './email.service';
import { GoogleProfile } from './google-oauth.service';
import { normalisePhone } from './phone-link.service';
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from './password';
import { generateToken, hashToken } from './tokens';

export type AuthFailure =
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_TAKEN'
  | 'WEAK_PASSWORD'
  | 'INVALID_EMAIL'
  | 'TOO_MANY_ATTEMPTS'
  | 'ACCOUNT_BLOCKED'
  | 'NO_PASSWORD_SET'
  | 'INVALID_TOKEN'
  | 'INVALID_PHONE'
  | 'PHONE_TAKEN';

export class AuthError extends Error {
  constructor(
    readonly code: AuthFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface SignedInSession {
  user: UserRow;
  /** The raw cookie value. Never stored; only its digest is. */
  token: string;
  expiresAt: Date;
}

/**
 * Deliberately loose. The strict grammar for an address is famously
 * unimplementable in a regex, and every attempt rejects real addresses -
 * `+` tags and long TLDs being the usual casualties. Anything that survives
 * this and is wrong will fail at the point that actually matters, which is
 * sending mail to it.
 */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Failed sign-ins from one IP before it is locked out. */
const MAX_IP_ATTEMPTS = 20;
/** Failed sign-ins against one account, across every IP. */
const MAX_ACCOUNT_ATTEMPTS = 10;
const LOCKOUT_SECONDS = 900;

/**
 * In-process since migration 0013, having been in Redis.
 *
 * One counter per process rather than one shared. Only the web process serves
 * sign-ins, so in practice there is one, and Cloudflare rate-limits
 * `/api/auth/*` at the edge as the outer bound. See rate-limiter.ts for the
 * condition under which this needs to become shared again.
 */
const failures = new RateLimiter(LOCKOUT_SECONDS);

const EMAIL_VERIFY_TTL_SECONDS = 86_400;
const PASSWORD_RESET_TTL_SECONDS = 3600;

/**
 * End-user authentication.
 *
 * ## What tells an attacker whether an account exists, and what does not
 *
 * Three endpoints touch this, and they are treated differently on purpose
 * rather than uniformly:
 *
 *   - **Sign in** is generic. A wrong email and a wrong password return the
 *     identical message, because distinguishing them turns the form into an
 *     oracle that confirms which addresses have accounts.
 *   - **Password reset** is generic, always reporting success. The same
 *     reasoning, and here it costs nothing: the user's next step is to check
 *     their inbox either way.
 *   - **Sign up** is explicit: "an account already exists for this email". This
 *     one leaks, and it is the right trade. The enumeration-safe alternative is
 *     to accept the signup silently and email the existing address instead - it
 *     requires working mail, which this deployment may not have, and it strands
 *     every honest user who simply forgot they had registered, staring at a
 *     screen that claims success while nothing happens. Every large consumer
 *     service makes the same call at signup for the same reason.
 *
 * ## Two rate limits, because they stop different attacks
 *
 * The per-IP counter is generous and the per-account one is tight. An attacker
 * with a pool of addresses defeats a per-IP limit entirely; a legitimate office
 * behind one NAT would be locked out by a tight one. The per-account counter is
 * what actually limits guessing at a specific password, and it is scoped to the
 * account so a stranger cannot use it to lock out someone else's IP.
 */
@Injectable()
export class AuthService {
  private readonly logger = getLogger().child({ module: 'auth' });

  constructor(
    private readonly auth: AuthRepository,
    private readonly users: UserRepository,
    private readonly credits: CreditsService,
    private readonly email: EmailService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  // ---------------------------------------------------------------------------
  // Email + password
  // ---------------------------------------------------------------------------

  async signUp(input: {
    email: string;
    password: string;
    phoneNumber: string;
    fullName: string | null;
    userAgent: string | null;
    ip: string | null;
  }): Promise<SignedInSession> {
    const email = normaliseEmail(input.email);

    if (!EMAIL_PATTERN.test(email)) {
      throw new AuthError('INVALID_EMAIL', 'Enter a valid email address.');
    }

    /*
     * The number is validated here and deliberately not stored.
     *
     * `users.phone_number` is UNIQUE, so writing an unproven number would let
     * anyone reserve a handset they do not own simply by typing it into the
     * signup form - and the real owner would then be unable to register at all.
     * The claim lives in the verification token's `subject` until a code proves
     * it, and PhoneVerificationService writes it to the row at that point.
     */
    const phoneNumber = normalisePhone(input.phoneNumber);
    if (phoneNumber.length < 10 || phoneNumber.length > 15) {
      throw new AuthError('INVALID_PHONE', 'Enter your WhatsApp number in international format, e.g. 919876543210.');
    }

    // Refused up front rather than at verification, so the person is told
    // before they wait for a code that can never succeed. The check is repeated
    // after the code is proven, because these two moments are minutes apart.
    const numberOwner = await this.users.findByPhone(phoneNumber);
    if (numberOwner && (numberOwner.password_hash || numberOwner.email)) {
      throw new AuthError(
        'PHONE_TAKEN',
        'An account already exists for this WhatsApp number. Try signing in instead.',
      );
    }

    const weak = passwordProblem(input.password, this.env.PASSWORD_MIN_LENGTH);
    if (weak) throw new AuthError('WEAK_PASSWORD', weak);

    const existing = await this.auth.findByEmail(email);
    if (existing) {
      throw new AuthError('EMAIL_TAKEN', 'An account already exists for this email. Try signing in.');
    }

    const passwordHash = await hashPassword(input.password);

    const user = await this.auth.createWebUser({
      email,
      passwordHash,
      fullName: input.fullName?.trim() || null,
      avatarUrl: null,
      source: 'WEB_PASSWORD',
      // Not verified. Access is not gated on it - an advocate can ask a
      // question immediately, which is the zero-friction onboarding the product
      // is built around - but a password reset is, because resetting to an
      // address nobody has proven they own is an account takeover.
      emailVerified: false,
    });

    // The unique index caught a signup that raced this one between the check
    // above and the insert. Same outcome as finding it in the check.
    if (!user) {
      throw new AuthError('EMAIL_TAKEN', 'An account already exists for this email. Try signing in.');
    }

    await this.credits.grantSignupBonus(user.id);
    void this.sendVerificationEmail(user).catch((err) =>
      this.logger.warn({ err, userId: user.id }, 'Could not send the verification email'),
    );

    this.logger.info({ userId: user.id }, 'Web account created');

    return this.startSession(user, input.userAgent, input.ip);
  }

  async signIn(input: {
    email: string;
    password: string;
    userAgent: string | null;
    ip: string | null;
  }): Promise<SignedInSession> {
    const email = normaliseEmail(input.email);
    const ipKey = `auth:fail:ip:${input.ip ?? 'unknown'}`;
    const accountKey = `auth:fail:account:${email}`;

    if (
      failures.count(ipKey) >= MAX_IP_ATTEMPTS ||
      failures.count(accountKey) >= MAX_ACCOUNT_ATTEMPTS
    ) {
      throw new AuthError(
        'TOO_MANY_ATTEMPTS',
        'Too many failed sign-in attempts. Try again in 15 minutes.',
      );
    }

    const user = await this.auth.findByEmail(email);

    // The hash is verified even when no account was found, against a dummy
    // value. Returning early on a missing account makes the response
    // measurably faster for unknown addresses than for known ones, which is
    // the same enumeration oracle the generic error message exists to close -
    // reintroduced through a stopwatch instead of a string.
    const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);

    if (!user || !ok) {
      failures.record(ipKey);
      failures.record(accountKey);
      throw new AuthError('INVALID_CREDENTIALS', 'Incorrect email or password.');
    }

    if (user.is_blocked) {
      throw new AuthError('ACCOUNT_BLOCKED', 'This account has been suspended. Contact support.');
    }

    failures.clear(ipKey, accountKey);

    // Sign-in is the only moment the plaintext exists, so it is the only moment
    // an outdated work factor can be upgraded. See needsRehash() in password.ts.
    if (needsRehash(user.password_hash)) {
      void hashPassword(input.password)
        .then((hash) => this.auth.setPasswordHash(user.id, hash))
        .catch((err) => this.logger.warn({ err, userId: user.id }, 'Could not upgrade password hash'));
    }

    return this.startSession(user, input.userAgent, input.ip);
  }

  // ---------------------------------------------------------------------------
  // Google
  // ---------------------------------------------------------------------------

  /**
   * Sign in or sign up from a verified Google profile.
   *
   * ## Account linking, and the one case where it is refused
   *
   * Three outcomes, in order:
   *
   *   1. The `sub` is already linked - sign that account in. This is the
   *      returning user and by far the common path.
   *   2. No link, but the email matches an existing account - adopt it, so that
   *      an advocate who signed up with a password and later clicks "continue
   *      with Google" lands on their own account rather than a duplicate.
   *   3. Neither - create an account.
   *
   * Case 2 is the dangerous one and is gated on `email_verified`. Without that
   * check, anyone who can obtain a Google token asserting an unverified address
   * takes over the account registered to it. Some Google Workspace
   * configurations do return unverified addresses, so this is not theoretical;
   * such a profile falls through to case 3 and gets its own account.
   */
  async signInWithGoogle(input: {
    profile: GoogleProfile;
    userAgent: string | null;
    ip: string | null;
  }): Promise<SignedInSession> {
    const { profile } = input;

    let user = await this.auth.findByProviderAccount('google', profile.providerAccountId);

    if (!user && profile.emailVerified) {
      const byEmail = await this.auth.findByEmail(profile.email);
      if (byEmail) {
        user = byEmail;
        this.logger.info({ userId: user.id }, 'Linked Google identity to an existing account by email');
      }
    }

    let created = false;
    if (!user) {
      user = await this.auth.createWebUser({
        email: profile.email,
        // No password. The account is reachable through Google only, until the
        // advocate sets one - which is what the "set a password" flow on the
        // account screen is for.
        passwordHash: null,
        fullName: profile.name,
        avatarUrl: profile.picture,
        source: 'WEB_GOOGLE',
        emailVerified: profile.emailVerified,
      });

      // Lost a race with a concurrent sign-in for the same new address.
      if (!user) {
        user = await this.auth.findByEmail(profile.email);
      } else {
        created = true;
      }

      if (!user) {
        throw new AuthError('INVALID_CREDENTIALS', 'Could not complete the Google sign-in.');
      }
    }

    if (user.is_blocked) {
      throw new AuthError('ACCOUNT_BLOCKED', 'This account has been suspended. Contact support.');
    }

    await this.auth.linkIdentity({
      userId: user.id,
      provider: 'google',
      providerAccountId: profile.providerAccountId,
      email: profile.email,
      displayName: profile.name,
      avatarUrl: profile.picture,
    });

    if (created) {
      await this.credits.grantSignupBonus(user.id);
      this.logger.info({ userId: user.id }, 'Web account created through Google');
    }

    // Google has already proven the address, so there is nothing to verify.
    if (profile.emailVerified && !user.email_verified_at) {
      await this.auth.setEmailVerified(user.id);
      user.email_verified_at = new Date();
    }

    return this.startSession(user, input.userAgent, input.ip);
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Mint a session.
   *
   * The raw token is returned to the caller and immediately forgotten; only its
   * SHA-256 goes to the database. A leaked backup therefore contains no usable
   * credential - the same reasoning as password hashing, applied to the thing
   * that actually authenticates every request.
   */
  private async startSession(
    user: UserRow,
    userAgent: string | null,
    ip: string | null,
  ): Promise<SignedInSession> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.env.sessionTtlSeconds * 1000);

    await this.auth.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      // Truncated: enough to recognise a device in the session list, not enough
      // to be a fingerprinting record.
      userAgent: userAgent?.slice(0, 300) ?? null,
      ipAddress: ip,
      expiresAt,
    });

    await this.auth.touchWebLogin(user.id);

    return { user, token, expiresAt };
  }

  /** Resolve a cookie to its account, or null. */
  async resolveSession(token: string): Promise<{ session: WebSessionRow; user: UserRow } | null> {
    const found = await this.auth.findSessionUser(hashToken(token));
    if (!found) return null;

    // Fire-and-forget: the request must not wait on a bookkeeping write, and a
    // failed one costs nothing but a stale timestamp.
    void this.auth.touchSession(found.session.id).catch(() => undefined);

    return found;
  }

  async signOut(token: string): Promise<void> {
    await this.auth.revokeSession(hashToken(token));
  }

  async signOutEverywhere(userId: string, keepToken?: string): Promise<number> {
    return this.auth.revokeAllSessions(userId, keepToken ? hashToken(keepToken) : undefined);
  }

  // ---------------------------------------------------------------------------
  // Email verification and password reset
  // ---------------------------------------------------------------------------

  async sendVerificationEmail(user: UserRow): Promise<{ sent: boolean }> {
    if (!user.email || user.email_verified_at) return { sent: false };

    const token = generateToken();
    await this.auth.issueToken({
      userId: user.id,
      purpose: 'EMAIL_VERIFY',
      tokenHash: hashToken(token),
      subject: user.email,
      expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_SECONDS * 1000),
    });

    const link = `${this.publicBase()}/app/verify-email?token=${encodeURIComponent(token)}`;
    const result = await this.email.sendVerification(user.email, link);
    return { sent: result.sent };
  }

  async verifyEmail(token: string): Promise<boolean> {
    const row = await this.auth.consumeToken(hashToken(token), 'EMAIL_VERIFY');
    if (!row) return false;

    await this.auth.setEmailVerified(row.user_id);
    this.logger.info({ userId: row.user_id }, 'Email verified');
    return true;
  }

  /**
   * Begin a password reset.
   *
   * Always resolves, whatever the address. See the class comment on which
   * endpoints leak account existence and why this one must not.
   *
   * Gated on a verified address: sending a reset link to an unproven address
   * would let anyone register someone else's email, never confirm it, and then
   * use the reset flow to seize the account if the real owner ever signs up.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.auth.findByEmail(normaliseEmail(email));

    if (!user?.email || !user.email_verified_at) {
      this.logger.info(
        { known: Boolean(user), verified: Boolean(user?.email_verified_at) },
        'Password reset requested for an address that cannot receive one',
      );
      return;
    }

    const token = generateToken();
    await this.auth.issueToken({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      tokenHash: hashToken(token),
      subject: user.email,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000),
    });

    const link = `${this.publicBase()}/app/reset-password?token=${encodeURIComponent(token)}`;
    await this.email.sendPasswordReset(user.email, link);
  }

  /**
   * Finish a password reset.
   *
   * Every other session is revoked on success. A reset is the standard response
   * to a suspected compromise, and leaving the attacker's existing session live
   * makes it useless - the legitimate owner changes the lock while the intruder
   * is still inside.
   */
  async completePasswordReset(token: string, password: string): Promise<boolean> {
    const weak = passwordProblem(password, this.env.PASSWORD_MIN_LENGTH);
    if (weak) throw new AuthError('WEAK_PASSWORD', weak);

    const row = await this.auth.consumeToken(hashToken(token), 'PASSWORD_RESET');
    if (!row) return false;

    await this.auth.setPasswordHash(row.user_id, await hashPassword(password));
    await this.auth.revokeAllSessions(row.user_id);

    this.logger.info({ userId: row.user_id }, 'Password reset completed; all sessions revoked');
    return true;
  }

  /**
   * Set a password after identity was proven by a one-time code.
   *
   * No current password is asked for, because there is none to ask about - the
   * whole point of the flow is that it was forgotten. What stands in its place
   * is the code, which PhoneVerificationService has already consumed by the
   * time this runs; this method must therefore never be reachable from a route
   * that has not done that.
   *
   * Sessions are revoked for the same reason the emailed flow revokes them: if
   * the reset happened because somebody else had the account, leaving their
   * session alive hands it straight back.
   */
  async setPasswordAfterProof(user: UserRow, password: string): Promise<void> {
    const weak = passwordProblem(password, this.env.PASSWORD_MIN_LENGTH);
    if (weak) throw new AuthError('WEAK_PASSWORD', weak);

    await this.auth.setPasswordHash(user.id, await hashPassword(password));
    await this.auth.revokeAllSessions(user.id);

    this.logger.info({ userId: user.id }, 'Password set from a phone code; all sessions revoked');
  }

  /**
   * Change a password from inside the account.
   *
   * Requires the current one, even though the request already carries a valid
   * session. The session proves the browser was signed in at some point; it
   * does not prove the person at the keyboard is the owner, and an unattended
   * laptop is the exact case this guards.
   *
   * Accounts created through Google have no password to confirm, so for them
   * this sets the first one - which is the "add a password" path, not a bypass:
   * they still had to sign in with Google to get here.
   */
  async changePassword(user: UserRow, currentPassword: string, newPassword: string): Promise<void> {
    const weak = passwordProblem(newPassword, this.env.PASSWORD_MIN_LENGTH);
    if (weak) throw new AuthError('WEAK_PASSWORD', weak);

    if (user.password_hash) {
      const ok = await verifyPassword(currentPassword, user.password_hash);
      if (!ok) throw new AuthError('INVALID_CREDENTIALS', 'Your current password is not correct.');
    }

    await this.auth.setPasswordHash(user.id, await hashPassword(newPassword));
    this.logger.info({ userId: user.id }, 'Password changed');
  }

  private publicBase(): string {
    return this.env.APP_PUBLIC_URL.replace(/\/+$/, '');
  }
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A well-formed hash that no password matches, verified against when no account
 * exists so a failed sign-in takes the same time either way.
 *
 * It does not need to be the hash of anything: what equalises the timing is the
 * scrypt derivation running at all, and its cost comes entirely from the
 * parameters encoded here. The bytes it compares against are never going to
 * match, which is the point.
 *
 * The parameters are written out rather than imported so that this stays a
 * constant, but that means they must be kept in step with password.ts - a
 * mismatch would make an unknown address measurably faster or slower than a
 * known one, quietly reopening the enumeration channel this exists to close.
 * `dummyHashMatchesCurrentCost` in password.spec.ts fails if they drift.
 */
export const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88);

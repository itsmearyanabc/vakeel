import { Injectable } from '@nestjs/common';
import { getLogger, maskPhone } from '../common/logger';
import { AuthRepository } from '../database/repositories/auth.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { AuthTokenPurpose, UserRow } from '../database/types';
import { SettingsService } from '../settings/settings.service';
import { WhatsAppApiService } from '../whatsapp/whatsapp-api.service';
import { normalisePhone, PhoneLinkService } from './phone-link.service';
import { generateNumericCode, hashToken } from './tokens';

/** How long a code stays usable. */
const CODE_TTL_SECONDS = 600;

/**
 * Guesses allowed before the code is burnt.
 *
 * Six digits is a million possibilities, which is only safe because of this
 * ceiling: five guesses in ten minutes is five in a million, while unlimited
 * guessing walks the whole space in minutes. See generateNumericCode().
 */
const MAX_ATTEMPTS = 5;

/**
 * Minimum gap between sends to one number.
 *
 * Each send costs money and lands on somebody's handset. Without this, the
 * resend button is a free way to make a stranger's phone buzz indefinitely.
 */
const RESEND_COOLDOWN_SECONDS = 60;

export type StartOutcome =
  | { status: 'SENT'; phoneNumber: string; expiresAt: Date }
  | { status: 'INVALID_PHONE' }
  | { status: 'CHANNEL_UNAVAILABLE' }
  | { status: 'ALREADY_REGISTERED' }
  | { status: 'COOLDOWN'; retryAfterSeconds: number }
  | { status: 'DELIVERY_FAILED'; detail?: string; hint?: string };

export type VerifyOutcome =
  | { status: 'VERIFIED'; user: UserRow; merged: boolean }
  | { status: 'NO_PENDING_CODE' }
  | { status: 'TOO_MANY_ATTEMPTS' }
  | { status: 'ALREADY_REGISTERED' }
  | { status: 'WRONG_CODE'; remaining: number };

/**
 * Proving a phone number by sending a code to it.
 *
 * ## Why this is the opposite direction from PhoneLinkService
 *
 * That service shows a code in the browser and has the advocate send it to the
 * bot, and its class comment explains at length why that is the better proof:
 * sending from a number demonstrates more than receiving at one, and it dodges
 * the 24-hour window that blocks free-form messages to strangers.
 *
 * Both of those reasons still hold. What changed is the requirement. Linking is
 * something an advocate opts into from inside a working session, so it can
 * afford to ask them to switch apps. Sign-up verification stands between a
 * stranger and their first use of the product, and "open WhatsApp, find our
 * bot, type this code" loses people who would otherwise have become users.
 *
 * The 24-hour window is defeated with an approved authentication template
 * rather than by pretending it does not apply - see sendAuthCode(). The weaker
 * proof is accepted deliberately: possession of the handset is what a sign-up
 * needs to establish, and the stronger from-the-handset proof remains available
 * through PhoneLinkService for advocates linking an existing bot account.
 *
 * ## Why a failed send is an error and not a shrug
 *
 * WhatsAppApiService.send() returns success when credentials are absent, so a
 * deployment with no WhatsApp configuration logs the message and carries on.
 * That is right for a chat reply and wrong here: the person would be told a
 * code was sent, would never receive one, and - because verification gates
 * access - could never finish signing up. Every path that cannot actually
 * deliver returns a distinct status instead.
 */
@Injectable()
export class PhoneVerificationService {
  private readonly logger = getLogger().child({ module: 'auth:phone-verify' });

  constructor(
    private readonly auth: AuthRepository,
    private readonly users: UserRepository,
    private readonly links: PhoneLinkService,
    private readonly whatsapp: WhatsAppApiService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Issue a code and send it to the handset.
   *
   * `purpose` separates sign-up verification from password reset so that a code
   * obtained for one cannot be redeemed for the other. They are otherwise the
   * same object with the same lifetime.
   */
  async start(
    user: UserRow,
    rawPhone: string,
    purpose: Extract<AuthTokenPurpose, 'PHONE_VERIFY' | 'PHONE_RESET'> = 'PHONE_VERIFY',
  ): Promise<StartOutcome> {
    const phoneNumber = normalisePhone(rawPhone);

    // 10 is the shortest national number that reaches an Indian handset; 15 is
    // E.164's ceiling. Anything outside cannot be a phone number, and sending
    // to it would be a paid message into the void.
    if (phoneNumber.length < 10 || phoneNumber.length > 15) {
      return { status: 'INVALID_PHONE' };
    }

    if (!this.settings.whatsappConfigured) {
      this.logger.error(
        { userId: user.id },
        'Phone verification requested but WhatsApp is not configured - no code can be delivered',
      );
      return { status: 'CHANNEL_UNAVAILABLE' };
    }

    const blocker = await this.registeredElsewhere(user.id, phoneNumber);
    if (blocker) return { status: 'ALREADY_REGISTERED' };

    // Checked before issuing, because issueToken() invalidates the previous
    // code for this purpose - a rejected resend would otherwise still have
    // destroyed the code the person is currently reading off their phone.
    const live = await this.auth.findLiveToken(user.id, purpose);
    if (live) {
      const age = (Date.now() - new Date(live.created_at).getTime()) / 1000;
      if (age < RESEND_COOLDOWN_SECONDS) {
        return { status: 'COOLDOWN', retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - age) };
      }
    }

    const code = generateNumericCode(6);
    const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);

    await this.auth.issueToken({
      userId: user.id,
      purpose,
      tokenHash: hashToken(code),
      // Bound to the number, so a code issued for one handset cannot be used to
      // claim a different one if the form is edited between the two requests.
      subject: phoneNumber,
      expiresAt,
    });

    const sent = await this.whatsapp.sendAuthCode(phoneNumber, code);

    if (!sent.ok) {
      this.logger.error(
        { userId: user.id, phone: maskPhone(phoneNumber), error: sent.error, code: sent.code },
        'Could not deliver the verification code',
      );
      return { status: 'DELIVERY_FAILED', detail: sent.error, hint: sent.hint };
    }

    this.logger.info(
      { userId: user.id, phone: maskPhone(phoneNumber), purpose },
      'Verification code sent',
    );

    return { status: 'SENT', phoneNumber, expiresAt };
  }

  /**
   * Redeem a code typed into the browser.
   *
   * The attempt is counted before the comparison, so a wrong guess costs an
   * attempt whether or not the code exists. Counting only on failure to match
   * would let an attacker distinguish "no code outstanding" from "wrong code"
   * by timing alone.
   */
  async verify(user: UserRow, code: string): Promise<VerifyOutcome> {
    const pending = await this.auth.findLiveToken(user.id, 'PHONE_VERIFY');
    if (!pending?.subject) return { status: 'NO_PENDING_CODE' };

    const attempts = await this.auth.recordTokenAttempt(user.id, 'PHONE_VERIFY');
    if (attempts > MAX_ATTEMPTS) {
      this.logger.warn({ userId: user.id, attempts }, 'Verification code exceeded its attempt limit');
      return { status: 'TOO_MANY_ATTEMPTS' };
    }

    /*
     * Scoped to this account, in the UPDATE itself.
     *
     * The call used to match on the digest and the purpose alone. A six-digit
     * code that collided with any *other* account's live code therefore
     * verified this one - the guesser's claimed number was attached - and burnt
     * the stranger's code on the way past. With N codes outstanding that is N
     * chances per guess rather than one, and a denial of service on N-1 people
     * who see a code stop working for no reason.
     *
     * Rejecting the row after the fact would close the first hole and not the
     * second, because the UPDATE has already consumed it. The predicate belongs
     * in the statement.
     */
    const consumed = await this.auth.consumeToken(hashToken(code.trim()), 'PHONE_VERIFY', user.id);
    if (!consumed) {
      return { status: 'WRONG_CODE', remaining: Math.max(0, MAX_ATTEMPTS - attempts) };
    }

    // Re-checked after the code is proven, not only at start(). The two calls
    // are minutes apart and the number could have been claimed in between; the
    // consequence of skipping this is an account takeover, so it is worth the
    // second query.
    if (await this.registeredElsewhere(user.id, pending.subject)) {
      this.logger.warn(
        { userId: user.id, phone: maskPhone(pending.subject) },
        'Verified number now belongs to a credentialled account - refusing to merge',
      );
      return { status: 'ALREADY_REGISTERED' };
    }

    const outcome = await this.links.attachOrMerge(user.id, pending.subject);

    if (outcome.status !== 'LINKED') {
      this.logger.error({ userId: user.id, outcome: outcome.status }, 'Attach failed after a valid code');
      return { status: 'NO_PENDING_CODE' };
    }

    this.logger.info(
      { userId: outcome.user.id, merged: outcome.merged, phone: maskPhone(pending.subject) },
      'Phone number verified',
    );

    return { status: 'VERIFIED', user: outcome.user, merged: outcome.merged };
  }

  /**
   * Redeem a reset code, identified by the number rather than by a session.
   *
   * Password reset runs signed out, so there is no principal to look the token
   * up against - the number is the only handle the caller has. That makes this
   * the one path where an attacker chooses the account being attacked, so the
   * attempt ceiling is doing more work here than anywhere else.
   *
   * Returns the user rather than setting the password: what a proven code
   * establishes is identity, and what to do with that belongs to AuthService,
   * which already owns hashing and session revocation.
   */
  async redeemReset(rawPhone: string, code: string): Promise<UserRow | null> {
    const phoneNumber = normalisePhone(rawPhone);
    const owner = await this.users.findByPhone(phoneNumber);
    if (!owner) return null;

    const pending = await this.auth.findLiveToken(owner.id, 'PHONE_RESET');
    // Bound to the number the code was issued for, so a code cannot be carried
    // from one account to another by editing the form.
    if (!pending || pending.subject !== phoneNumber) return null;

    const attempts = await this.auth.recordTokenAttempt(owner.id, 'PHONE_RESET');
    if (attempts > MAX_ATTEMPTS) {
      this.logger.warn({ userId: owner.id, attempts }, 'Reset code exceeded its attempt limit');
      return null;
    }

    const consumed = await this.auth.consumeToken(hashToken(code.trim()), 'PHONE_RESET', owner.id);
    if (!consumed) return null;

    this.logger.info({ userId: owner.id, phone: maskPhone(phoneNumber) }, 'Reset code accepted');
    return owner;
  }

  /** The outstanding request for this account, if there is one. */
  async pendingFor(userId: string): Promise<{ phoneNumber: string; expiresAt: Date } | null> {
    const row = await this.auth.findLiveToken(userId, 'PHONE_VERIFY');
    if (!row?.subject) return null;
    return { phoneNumber: row.subject, expiresAt: row.expires_at };
  }

  /**
   * Does this number already belong to an account that can sign in on its own?
   *
   * The distinction that matters is credentials, not existence. A WhatsApp-only
   * row has no password and no email - it is the same person arriving by a
   * second door, and merging it is the entire point of attachOrMerge(). A row
   * with a password hash is somebody's account, and handing it to whoever
   * verifies the number would be a takeover dressed up as a merge.
   */
  private async registeredElsewhere(userId: string, phoneNumber: string): Promise<boolean> {
    const owner = await this.users.findByPhone(phoneNumber);
    if (!owner || owner.id === userId) return false;
    return Boolean(owner.password_hash) || Boolean(owner.email);
  }
}

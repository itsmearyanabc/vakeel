import { Injectable } from '@nestjs/common';
import { getLogger, maskPhone } from '../common/logger';
import { AuthRepository } from '../database/repositories/auth.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { UserRow } from '../database/types';
import { generateNumericCode, hashToken } from './tokens';

/** How long a code stays usable. Long enough to switch apps, short enough to matter. */
const CODE_TTL_SECONDS = 900;

/**
 * Guesses allowed against one code before it is burnt.
 *
 * Six digits is a million possibilities, which sounds ample and is not: an
 * automated guesser gets through that in minutes given unlimited attempts. Five
 * is what makes the short code safe - it caps the attacker at five in a million
 * per issued code, and a code only exists for fifteen minutes.
 */
const MAX_ATTEMPTS = 5;

export type LinkOutcome =
  | { status: 'LINKED'; user: UserRow; merged: boolean }
  | { status: 'NO_PENDING_CODE' }
  | { status: 'TOO_MANY_ATTEMPTS' };

/**
 * Connecting a web account to a WhatsApp number.
 *
 * ## Why the code travels outward, not inward
 *
 * The advocate is shown a code in the browser and sends it to the bot from
 * their handset. The obvious alternative - texting them a code to type into the
 * browser - is worse here in two independent ways.
 *
 * The first is that it would not work. WhatsApp refuses free-form messages to
 * anyone who has not messaged the business in the last 24 hours, so a link code
 * could only be delivered to advocates who had recently been chatting anyway,
 * which is close to the opposite of the people who need to link. Delivering it
 * as a template message means a Meta-approved template and a per-message fee.
 *
 * The second is that it proves more. A received code proves someone can read
 * messages sent to that number; a sent code proves they can send *from* it,
 * which is what "this is my WhatsApp account" actually means. SIM-swap and
 * notification-preview attacks defeat the first and not the second.
 *
 * ## What linking does to two existing accounts
 *
 * The common case is that the number already has an account, because the
 * advocate used the bot before they used the site. Both rows are real, so
 * neither can simply be deleted: the WhatsApp row usually holds the
 * verification status and the search history, and the web row holds the
 * credentials and any credits bought there.
 *
 * The WhatsApp account survives and absorbs the web one - see
 * AuthRepository.mergeWebAccountInto, which moves the threads, the ledger and
 * the orders before the delete so that a cascade cannot quietly take an
 * advocate's research history with it.
 */
@Injectable()
export class PhoneLinkService {
  private readonly logger = getLogger().child({ module: 'auth:phone-link' });

  constructor(
    private readonly auth: AuthRepository,
    private readonly users: UserRepository,
  ) {}

  /**
   * Issue a code for a number.
   *
   * Returns the code, because it is displayed to the person who asked for it -
   * they already hold a valid session for the account being linked, so showing
   * it to them reveals nothing they could not otherwise do. It is stored only
   * as a digest, so a database leak does not hand over live codes.
   */
  async requestCode(user: UserRow, rawPhone: string): Promise<{ code: string; phoneNumber: string }> {
    const phoneNumber = normalisePhone(rawPhone);

    if (phoneNumber.length < 10 || phoneNumber.length > 15) {
      throw new Error('INVALID_PHONE');
    }

    const code = generateNumericCode(6);

    await this.auth.issueToken({
      userId: user.id,
      purpose: 'PHONE_LINK',
      tokenHash: hashToken(code),
      // Bound to the number it was issued for, so a code cannot be replayed
      // from a different handset to claim a different number.
      subject: phoneNumber,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    });

    this.logger.info(
      { userId: user.id, phone: maskPhone(phoneNumber) },
      'Phone link code issued',
    );

    return { code, phoneNumber };
  }

  /**
   * Redeem a code that arrived over WhatsApp.
   *
   * Called from the conversation flow, where the only thing known about the
   * sender is the number the message came from. That is precisely what makes
   * the check meaningful: the code is looked up by digest *and* by the sending
   * number, so both have to match the pair that was issued.
   */
  async redeemCode(fromPhone: string, code: string): Promise<LinkOutcome> {
    const phoneNumber = normalisePhone(fromPhone);
    const pending = await this.auth.findPhoneLinkByCode(hashToken(code), phoneNumber);

    if (!pending) return { status: 'NO_PENDING_CODE' };

    const attempts = await this.auth.recordTokenAttempt(pending.user_id, 'PHONE_LINK');
    if (attempts > MAX_ATTEMPTS) {
      this.logger.warn(
        { userId: pending.user_id, attempts },
        'Phone link code exceeded its attempt limit',
      );
      return { status: 'TOO_MANY_ATTEMPTS' };
    }

    // Consumed before the merge. If the merge then fails, the advocate requests
    // a new code and tries again - which is a far better failure than a code
    // that stays live after it has been used once.
    const consumed = await this.auth.consumeToken(hashToken(code), 'PHONE_LINK');
    if (!consumed) return { status: 'NO_PENDING_CODE' };

    return this.link(pending.user_id, phoneNumber);
  }

  /**
   * Attach the number, merging accounts when the number already has one.
   *
   * The self-link case - the number already belongs to the very account being
   * linked - is checked first and is not a no-op: it marks the number verified,
   * which is the thing the code proved and which may not have been true before.
   */
  private async link(webUserId: string, phoneNumber: string): Promise<LinkOutcome> {
    const owner = await this.users.findByPhone(phoneNumber);

    if (owner && owner.id !== webUserId) {
      const merged = await this.auth.mergeWebAccountInto(owner.id, webUserId);
      if (!merged) return { status: 'NO_PENDING_CODE' };

      this.logger.info(
        { survivingUser: owner.id, absorbed: webUserId, phone: maskPhone(phoneNumber) },
        'Web account merged into the existing WhatsApp account',
      );

      return { status: 'LINKED', user: merged, merged: true };
    }

    const attached = await this.auth.attachPhone(webUserId, phoneNumber);
    if (!attached) {
      // Someone else took the number between the lookup and the write.
      return { status: 'NO_PENDING_CODE' };
    }

    this.logger.info(
      { userId: webUserId, phone: maskPhone(phoneNumber) },
      'Phone number linked to web account',
    );

    return { status: 'LINKED', user: attached, merged: false };
  }

  /** Is there an outstanding request, and for which number? */
  async pendingFor(userId: string): Promise<{ phoneNumber: string; expiresAt: Date } | null> {
    const row = await this.auth.findLiveToken(userId, 'PHONE_LINK');
    if (!row?.subject) return null;
    return { phoneNumber: row.subject, expiresAt: row.expires_at };
  }
}

/**
 * Reduce a number to digits, matching how Meta delivers them.
 *
 * Meta sends E.164 without the leading `+` (919876543210), and `users`
 * .phone_number stores exactly that. A number typed into the web form with
 * spaces, a `+` or brackets has to end up as the same string or the lookup
 * silently fails to find an account that is right there.
 */
function normalisePhone(value: string): string {
  return value.replace(/\D/g, '');
}

import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { maskPhone } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { UserRepository } from '../database/repositories/user.repository';
import { UserRow, WhatsAppUserRow } from '../database/types';
import { CryptoService } from '../security/crypto.service';

export interface BarCouncilSubmission {
  accepted: boolean;
  reason?: 'INVALID_FORMAT' | 'ALREADY_REGISTERED';
}

/** What a completed onboarding form yields. */
export interface ProfileSubmission {
  fullName: string;
  barCouncilId: string;
  city: string;
  state: string;
}

export interface ProfileResult {
  accepted: boolean;
  reason?: 'INVALID_BAR_ID';
  /**
   * The account the advocate actually owns. Differs from the row the message
   * arrived on when the Bar Council ID matched an existing account - see
   * {@link UsersService.completeProfile}.
   */
  user?: UserRow;
  /** True when this number was folded into an account that already existed. */
  merged?: boolean;
}

/**
 * Bar council enrolment numbers look like `D/1234/2015` or `MAH/12345/2010`:
 * a state code, a serial number, and a year of enrolment. Separators vary
 * (slash, hyphen, space) so the check is deliberately loose on those and strict
 * on the shape.
 */
const BAR_COUNCIL_PATTERN = /^[A-Z]{1,5}[\s/-]?\d{1,6}[\s/-]?(19|20)\d{2}$/i;

@Injectable()
export class UsersService {
  private readonly logger = getLogger().child({ module: 'users' });

  constructor(
    private readonly users: UserRepository,
    private readonly crypto: CryptoService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /**
   * Resolve the user for an inbound message, creating them on first contact.
   *
   * There is no signup step by design - the spec calls for zero-friction
   * onboarding, so the first message creates the account and the advocate can
   * ask a question immediately under guest quotas.
   */
  async resolveFromPhone(phoneNumber: string, profileName?: string): Promise<WhatsAppUserRow> {
    const normalised = phoneNumber.replace(/\D/g, '');
    const isAdmin = this.env.adminPhoneNumbers.includes(normalised);

    const user = await this.users.findOrCreate(normalised, isAdmin ? 'SUPER_ADMIN' : 'GUEST_LAWYER');

    // Promote a number that was added to ADMIN_PHONE_NUMBERS after it first
    // messaged, so the env var alone is enough to grant admin.
    if (isAdmin && user.role !== 'SUPER_ADMIN') {
      await this.users.setRole(user.id, 'SUPER_ADMIN');
      user.role = 'SUPER_ADMIN';
    }

    if (profileName && !user.full_name) {
      await this.users.setFullName(user.id, profileName);
      user.full_name = profileName;
    }

    // findOrCreate looked this row up *by* the number, so it has one - the
    // column is only nullable to allow web-only accounts. See WhatsAppUserRow.
    return { ...user, phone_number: normalised };
  }

  /**
   * Record a bar council registration number.
   *
   * Stored twice: AES-GCM ciphertext for retrieval, and an HMAC blind index for
   * the uniqueness check. The duplicate check runs against the HMAC, so we can
   * tell that a number is already registered without decrypting anything.
   */
  async submitBarCouncilId(
    userId: string,
    rawId: string,
    state: string | null = null,
  ): Promise<BarCouncilSubmission> {
    const cleaned = rawId.trim().toUpperCase();

    if (!BAR_COUNCIL_PATTERN.test(cleaned)) {
      return { accepted: false, reason: 'INVALID_FORMAT' };
    }

    const hash = this.crypto.blindIndex(cleaned);

    const existing = await this.users.findByBarCouncilHash(hash);
    if (existing && existing.id !== userId) {
      this.logger.warn(
        { userId, existingUser: existing.id },
        'Bar council number is already registered to another account',
      );
      return { accepted: false, reason: 'ALREADY_REGISTERED' };
    }

    await this.users.setBarCouncilDetails(userId, this.crypto.encrypt(cleaned), hash, state);
    this.logger.info({ userId }, 'Bar council details submitted for verification');

    return { accepted: true };
  }

  /**
   * Complete onboarding, treating the Bar Council ID as the identity.
   *
   * ## The case this exists for
   *
   * An inbound message is resolved by phone number, before anyone knows who
   * sent it - so an advocate messaging from a second handset arrives as a brand
   * new account with a brand new daily allowance. That is the loophole the
   * credit limit exists to close.
   *
   * When the submitted Bar Council ID already belongs to an account, this
   * returns *that* account and moves the new number onto it. Credits,
   * verification status and history stay where they were, and the throwaway row
   * is discarded. From the advocate's side switching handsets simply works;
   * from the product's side a second number buys nothing.
   *
   * The name, city and state are written to whichever account wins, because an
   * advocate correcting a typo by re-onboarding should see the correction take.
   */
  async completeProfile(userId: string, input: ProfileSubmission): Promise<ProfileResult> {
    const cleanedId = input.barCouncilId.trim().toUpperCase();
    if (!BAR_COUNCIL_PATTERN.test(cleanedId)) {
      return { accepted: false, reason: 'INVALID_BAR_ID' };
    }

    const hash = this.crypto.blindIndex(cleanedId);
    const existing = await this.users.findByBarCouncilHash(hash);

    // Same advocate, different handset. Fold this number into the real account.
    if (existing && existing.id !== userId) {
      const current = await this.users.findById(userId);
      // A phone-less row here means onboarding was completed from the web
      // rather than WhatsApp. There is no handset to move, so the duplicate is
      // simply discarded and the two accounts are merged on the Bar Council ID
      // alone - which is the identity anyway. See migration 0009.
      if (current?.phone_number) {
        await this.users.adoptPhone(existing.id, userId, current.phone_number);
      } else if (current) {
        await this.users.discard(current.id);
      }

      await this.users.setProfile(existing.id, input.fullName, input.city, input.state);

      this.logger.info(
        { adoptedInto: existing.id, discarded: userId },
        'Bar council ID matched an existing account; number moved and duplicate discarded',
      );

      const merged = await this.users.findById(existing.id);
      return { accepted: true, user: merged ?? existing, merged: true };
    }

    await this.users.setProfile(userId, input.fullName, input.city, input.state);
    if (!existing) {
      await this.users.setBarCouncilDetails(userId, this.crypto.encrypt(cleanedId), hash, input.state);
    }

    const user = await this.users.findById(userId);
    this.logger.info({ userId }, 'Onboarding profile completed');

    return { accepted: true, user: user ?? undefined, merged: false };
  }

  /**
   * Read back a stored registration number.
   *
   * Only for the admin verification screen. Returns null rather than throwing
   * on a decryption failure, which is what happens if ENCRYPTION_KEY was
   * rotated without re-encrypting - a loud log line and a blank field beats a
   * 500 on the admin page.
   */
  async revealBarCouncilId(user: UserRow): Promise<string | null> {
    if (!user.bar_council_id_enc) return null;
    try {
      return this.crypto.decrypt(user.bar_council_id_enc);
    } catch (err) {
      this.logger.error(
        { err, userId: user.id },
        'Could not decrypt bar council id - has ENCRYPTION_KEY changed?',
      );
      return null;
    }
  }

  async approve(userId: string, notes: string | null = null): Promise<UserRow | null> {
    const user = await this.users.setVerification(userId, 'VERIFIED', notes);
    this.logger.info({ userId, phone: maskPhone(user?.phone_number) }, 'Advocate verified');
    return user;
  }

  async reject(userId: string, notes: string): Promise<UserRow | null> {
    return this.users.setVerification(userId, 'REJECTED', notes);
  }

  async setLanguage(userId: string, language: string): Promise<void> {
    await this.users.setLanguage(userId, language);
  }

  async listPending(limit = 50): Promise<UserRow[]> {
    return this.users.listPendingVerifications(limit);
  }
}

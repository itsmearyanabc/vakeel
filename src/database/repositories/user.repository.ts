import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { UserRole, UserRow, VerificationStatus } from '../types';

@Injectable()
export class UserRepository {
  constructor(private readonly db: DatabaseService) {}

  async findByPhone(phoneNumber: string): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      SELECT * FROM users WHERE phone_number = ${phoneNumber} LIMIT 1
    `;
    return row ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      SELECT * FROM users WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  /**
   * Get the user for a phone number, creating them on first contact.
   *
   * Written as a single upsert rather than select-then-insert because two
   * messages from the same new number can arrive concurrently on different
   * worker replicas, and the loser of that race would otherwise hit the unique
   * constraint. `DO UPDATE` on a no-op column is what makes RETURNING fire on
   * the conflict path too.
   */
  async findOrCreate(phoneNumber: string, role: UserRole = 'GUEST_LAWYER'): Promise<UserRow> {
    const [row] = await this.db.sql<UserRow[]>`
      INSERT INTO users (phone_number, role)
           VALUES (${phoneNumber}, ${role}::user_role)
      ON CONFLICT (phone_number) DO UPDATE
              SET last_active_at = NOW()
        RETURNING *
    `;
    return row;
  }

  async touchLastActive(userId: string): Promise<void> {
    await this.db.sql`UPDATE users SET last_active_at = NOW() WHERE id = ${userId}`;
  }

  async setLanguage(userId: string, language: string): Promise<void> {
    await this.db.sql`UPDATE users SET preferred_language = ${language} WHERE id = ${userId}`;
  }

  async setFullName(userId: string, fullName: string): Promise<void> {
    await this.db.sql`UPDATE users SET full_name = ${fullName} WHERE id = ${userId}`;
  }

  /**
   * Store bar council details.
   *
   * The registration number is written as ciphertext plus a deterministic HMAC.
   * The HMAC is what the unique index and lookups use, so we can detect a
   * duplicate registration without ever holding plaintext in an index.
   */
  async setBarCouncilDetails(
    userId: string,
    encrypted: string,
    hash: string,
    state: string | null,
  ): Promise<void> {
    await this.db.sql`
      UPDATE users
         SET bar_council_id_enc  = ${encrypted},
             bar_council_id_hash = ${hash},
             bar_council_state   = ${state},
             verification_status = 'SUBMITTED'::verification_status
       WHERE id = ${userId}
    `;
  }

  async findByBarCouncilHash(hash: string): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      SELECT * FROM users WHERE bar_council_id_hash = ${hash} LIMIT 1
    `;
    return row ?? null;
  }

  /** Profile fields captured during onboarding. */
  async setProfile(
    userId: string,
    fullName: string,
    city: string | null,
    state: string | null,
  ): Promise<void> {
    await this.db.sql`
      UPDATE users
         SET full_name         = ${fullName},
             city              = ${city},
             bar_council_state = ${state}
       WHERE id = ${userId}
    `;
  }

  /**
   * Move a phone number onto the account its Bar Council ID already names, and
   * discard the throwaway row that number created.
   *
   * ## Why this exists
   *
   * An inbound message is resolved by phone number before we know who is
   * behind it, so an advocate messaging from a second handset gets a fresh row
   * with fresh credits. That is precisely the loophole the daily limit exists
   * to close. Once onboarding reveals a Bar Council ID that already belongs to
   * an account, this collapses the two: the number moves to the real account
   * and everything else - credits, verification, history - stays where it was.
   *
   * ## Why it is a transaction, and why the order matters
   *
   * `phone_number` is UNIQUE. The duplicate has to be deleted before the number
   * can be attached to the canonical row, or the UPDATE violates the
   * constraint against a row we are about to remove anyway. Both statements
   * therefore have to succeed or neither may: a crash between them would leave
   * the advocate's number attached to nothing, and their next message would
   * create yet another empty account.
   *
   * The duplicate is minutes old and holds nothing but a half-finished
   * onboarding state, so `ON DELETE CASCADE` taking its conversation row with
   * it is the desired outcome, not collateral damage.
   */
  async adoptPhone(canonicalUserId: string, duplicateUserId: string, phoneNumber: string): Promise<void> {
    await this.db.sql.begin(async (sql) => {
      await sql`DELETE FROM users WHERE id = ${duplicateUserId}`;
      await sql`
        UPDATE users
           SET phone_number   = ${phoneNumber},
               last_active_at = NOW()
         WHERE id = ${canonicalUserId}
      `;
    });
  }

  async setIdCardPath(userId: string, storagePath: string): Promise<void> {
    await this.db.sql`UPDATE users SET id_card_storage_path = ${storagePath} WHERE id = ${userId}`;
  }

  /**
   * Approve or reject a verification. Approval also promotes the role, unless
   * the user already holds a higher one (an auditor or admin stays put).
   */
  async setVerification(
    userId: string,
    status: VerificationStatus,
    notes: string | null = null,
  ): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      UPDATE users
         SET verification_status = ${status}::verification_status,
             verification_notes  = ${notes},
             verified_at         = ${status === 'VERIFIED' ? this.db.sql`NOW()` : null},
             role = CASE
                      WHEN ${status} = 'VERIFIED' AND role = 'GUEST_LAWYER'
                        THEN 'VERIFIED_ADVOCATE'::user_role
                      ELSE role
                    END
       WHERE id = ${userId}
   RETURNING *
    `;
    return row ?? null;
  }

  async setRole(userId: string, role: UserRole): Promise<void> {
    await this.db.sql`UPDATE users SET role = ${role}::user_role WHERE id = ${userId}`;
  }

  async setBlocked(userId: string, blocked: boolean): Promise<void> {
    await this.db.sql`
      UPDATE users
         SET is_blocked  = ${blocked},
             opted_out_at = ${blocked ? this.db.sql`NOW()` : null}
       WHERE id = ${userId}
    `;
  }

  async listPendingVerifications(limit = 50): Promise<UserRow[]> {
    return this.db.sql<UserRow[]>`
      SELECT * FROM users
       WHERE verification_status = 'SUBMITTED'::verification_status
       ORDER BY updated_at ASC
       LIMIT ${limit}
    `;
  }
}

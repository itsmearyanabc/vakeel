import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import {
  AccountSource,
  AuthTokenPurpose,
  AuthTokenRow,
  UserIdentityRow,
  UserRow,
  WebSessionRow,
} from '../types';

/**
 * Accounts, sessions and single-use tokens for the web app.
 *
 * Split from UserRepository rather than added to it because the two answer
 * different questions: that one is about the advocate (profile, verification,
 * role), this one is about the credential (can this request prove it is them).
 * They share a table and nothing else.
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly db: DatabaseService) {}

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  /**
   * Look up by email, case-insensitively.
   *
   * `lower(email)` matches the unique index from migration 0010, so this is an
   * index scan rather than a sequential one. Comparing the raw column instead
   * would both miss the index and disagree with the constraint, which is the
   * combination that lets two accounts exist for one address.
   */
  async findByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      SELECT * FROM users WHERE lower(email) = lower(${email}) LIMIT 1
    `;
    return row ?? null;
  }

  /**
   * Create an account from a web signup.
   *
   * `ON CONFLICT DO NOTHING` on the email index, returning nothing when the
   * address is taken. The caller distinguishes that from a database failure by
   * the null return - it must not present as an error, because "this email is
   * already registered" is the response an attacker uses to enumerate accounts
   * and is handled deliberately in the controller.
   */
  async createWebUser(input: {
    email: string;
    passwordHash: string | null;
    fullName: string | null;
    avatarUrl: string | null;
    source: AccountSource;
    emailVerified: boolean;
  }): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      INSERT INTO users (email, password_hash, full_name, avatar_url, signup_source, email_verified_at, last_web_login_at)
           VALUES (${input.email}, ${input.passwordHash}, ${input.fullName}, ${input.avatarUrl},
                   ${input.source}::account_source,
                   ${input.emailVerified ? this.db.sql`NOW()` : null},
                   NOW())
      ON CONFLICT DO NOTHING
        RETURNING *
    `;
    return row ?? null;
  }

  async setPasswordHash(userId: string, hash: string): Promise<void> {
    await this.db.sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
  }

  async setEmailVerified(userId: string): Promise<void> {
    await this.db.sql`UPDATE users SET email_verified_at = NOW() WHERE id = ${userId}`;
  }

  async touchWebLogin(userId: string): Promise<void> {
    await this.db.sql`
      UPDATE users SET last_web_login_at = NOW(), last_active_at = NOW() WHERE id = ${userId}
    `;
  }

  /**
   * Attach an email address to an account that did not have one.
   *
   * The path for an advocate who has been using WhatsApp and now signs up on the
   * web with the same identity. Returns null when the address was taken between
   * the check and the write, which the caller must treat as a conflict rather
   * than a failure.
   */
  async attachEmail(userId: string, email: string, verified: boolean): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      UPDATE users
         SET email             = ${email},
             email_verified_at = ${verified ? this.db.sql`NOW()` : null}
       WHERE id = ${userId}
         AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(${email}) AND id <> ${userId})
   RETURNING *
    `;
    return row ?? null;
  }

  /**
   * Attach a verified phone number to a web account.
   *
   * Returns null when the number already belongs to someone else - which is the
   * common case, not an error: an advocate who used WhatsApp first *has* an
   * account on that number, and linking means merging into it rather than
   * moving the number. The caller handles that; this method only refuses to
   * silently steal a number from another row.
   */
  async attachPhone(userId: string, phoneNumber: string): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      UPDATE users
         SET phone_number      = ${phoneNumber},
             phone_verified_at = NOW()
       WHERE id = ${userId}
         AND NOT EXISTS (SELECT 1 FROM users WHERE phone_number = ${phoneNumber} AND id <> ${userId})
   RETURNING *
    `;
    return row ?? null;
  }

  /**
   * Merge a web-only account into the WhatsApp account that owns the number.
   *
   * ## Why this is a transaction and why the order is what it is
   *
   * Both rows are real accounts with real history, so unlike the Bar Council
   * merge in UserRepository.adoptPhone this cannot simply delete one. The
   * surviving row is the WhatsApp account - it holds the verification status,
   * the search history and, usually, the credits - and it gains the web
   * credentials from the row being retired.
   *
   * Chat threads and the credit ledger are re-pointed before the delete,
   * because `ON DELETE CASCADE` would otherwise take them with it. That is the
   * whole risk in this method: a cascade that fires on a row whose children
   * have not been moved destroys an advocate's research history, and it does so
   * quietly.
   */
  async mergeWebAccountInto(canonicalUserId: string, webUserId: string): Promise<UserRow | null> {
    return this.db.sql.begin(async (sql) => {
      const [web] = await sql<UserRow[]>`SELECT * FROM users WHERE id = ${webUserId}`;
      if (!web) return null;

      // Move everything the web account owns onto the surviving row first.
      await sql`UPDATE chat_threads    SET user_id = ${canonicalUserId} WHERE user_id = ${webUserId}`;
      await sql`UPDATE chat_messages   SET user_id = ${canonicalUserId} WHERE user_id = ${webUserId}`;
      await sql`UPDATE credit_ledger   SET user_id = ${canonicalUserId} WHERE user_id = ${webUserId}`;
      await sql`UPDATE credit_orders   SET user_id = ${canonicalUserId} WHERE user_id = ${webUserId}`;
      await sql`UPDATE user_identities SET user_id = ${canonicalUserId} WHERE user_id = ${webUserId}`;
      await sql`UPDATE search_history  SET user_id = ${canonicalUserId} WHERE user_id = ${webUserId}`;

      // Credits move with the rows, so the balances have to move too or the
      // ledger and the cached columns stop agreeing.
      await sql`
        UPDATE users
           SET paid_credits = paid_credits + ${web.paid_credits}
         WHERE id = ${canonicalUserId}
      `;

      // Carry over the login credentials, but never overwrite one that exists:
      // an advocate who already had an email on the WhatsApp account keeps it.
      const [merged] = await sql<UserRow[]>`
        UPDATE users
           SET email             = COALESCE(email, ${web.email}),
               password_hash     = COALESCE(password_hash, ${web.password_hash}),
               email_verified_at = COALESCE(email_verified_at, ${web.email_verified_at}),
               avatar_url        = COALESCE(avatar_url, ${web.avatar_url}),
               full_name         = COALESCE(full_name, ${web.full_name}),
               phone_verified_at = NOW(),
               last_web_login_at = NOW()
         WHERE id = ${canonicalUserId}
     RETURNING *
      `;

      // Sessions are deliberately NOT moved. The web account's cookies are
      // invalidated by this delete, so the browser is signed out and signs back
      // in against the surviving account - which is the correct outcome, because
      // a session is a claim about an account that no longer exists.
      await sql`DELETE FROM users WHERE id = ${webUserId}`;

      return merged ?? null;
    });
  }

  // ---------------------------------------------------------------------------
  // Federated identities
  // ---------------------------------------------------------------------------

  /**
   * Find the account behind a Google `sub`.
   *
   * Matched on the provider's stable subject id, never on the email. A Google
   * account's address can change; its `sub` cannot. Matching on email would
   * detach the identity the day someone changes theirs, and - worse - would
   * hand an account to anyone who acquired a recycled address.
   */
  async findByProviderAccount(provider: string, providerAccountId: string): Promise<UserRow | null> {
    const [row] = await this.db.sql<UserRow[]>`
      SELECT u.*
        FROM user_identities i
        JOIN users u ON u.id = i.user_id
       WHERE i.provider = ${provider} AND i.provider_account_id = ${providerAccountId}
       LIMIT 1
    `;
    return row ?? null;
  }

  async linkIdentity(input: {
    userId: string;
    provider: string;
    providerAccountId: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  }): Promise<UserIdentityRow> {
    const [row] = await this.db.sql<UserIdentityRow[]>`
      INSERT INTO user_identities
             (user_id, provider, provider_account_id, email, display_name, avatar_url, last_login_at)
      VALUES (${input.userId}, ${input.provider}, ${input.providerAccountId},
              ${input.email}, ${input.displayName}, ${input.avatarUrl}, NOW())
      ON CONFLICT (provider, provider_account_id) DO UPDATE
              SET last_login_at = NOW(),
                  email         = EXCLUDED.email,
                  display_name  = EXCLUDED.display_name,
                  avatar_url    = EXCLUDED.avatar_url
        RETURNING *
    `;
    return row;
  }

  async listIdentities(userId: string): Promise<UserIdentityRow[]> {
    return this.db.sql<UserIdentityRow[]>`
      SELECT * FROM user_identities WHERE user_id = ${userId} ORDER BY created_at
    `;
  }

  async unlinkIdentity(userId: string, provider: string): Promise<void> {
    await this.db.sql`
      DELETE FROM user_identities WHERE user_id = ${userId} AND provider = ${provider}
    `;
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async createSession(input: {
    userId: string;
    tokenHash: string;
    userAgent: string | null;
    ipAddress: string | null;
    expiresAt: Date;
  }): Promise<WebSessionRow> {
    const [row] = await this.db.sql<WebSessionRow[]>`
      INSERT INTO web_sessions (user_id, token_hash, user_agent, ip_address, expires_at)
           VALUES (${input.userId}, ${input.tokenHash}, ${input.userAgent},
                   ${input.ipAddress}::inet, ${input.expiresAt})
        RETURNING *
    `;
    return row;
  }

  /**
   * Resolve a session cookie to its account, in one query.
   *
   * The expiry and revocation checks are in the WHERE clause rather than done
   * in application code, so an expired session cannot be resurrected by a
   * caller that forgets to check - the row simply does not come back.
   */
  async findSessionUser(tokenHash: string): Promise<{ session: WebSessionRow; user: UserRow } | null> {
    const [row] = await this.db.sql<(WebSessionRow & { user: UserRow })[]>`
      SELECT s.*, to_jsonb(u.*) AS user
        FROM web_sessions s
        JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ${tokenHash}
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1
    `;
    if (!row) return null;

    const { user, ...session } = row;
    return { session: session as WebSessionRow, user };
  }

  /**
   * Record that a session was used.
   *
   * Deliberately coarse: only written when the stored value is more than an
   * hour old. Updating on every request turns a read-mostly table into one
   * write per API call, which on a chat interface is a great many writes to
   * maintain a timestamp nobody reads to the minute.
   */
  async touchSession(sessionId: string): Promise<void> {
    await this.db.sql`
      UPDATE web_sessions
         SET last_used_at = NOW()
       WHERE id = ${sessionId} AND last_used_at < NOW() - INTERVAL '1 hour'
    `;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.db.sql`
      UPDATE web_sessions SET revoked_at = NOW()
       WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    `;
  }

  async revokeSessionById(userId: string, sessionId: string): Promise<void> {
    await this.db.sql`
      UPDATE web_sessions SET revoked_at = NOW()
       WHERE id = ${sessionId} AND user_id = ${userId} AND revoked_at IS NULL
    `;
  }

  /** Sign out everywhere. `exceptTokenHash` keeps the current device signed in. */
  async revokeAllSessions(userId: string, exceptTokenHash?: string): Promise<number> {
    const rows = await this.db.sql<{ id: string }[]>`
      UPDATE web_sessions SET revoked_at = NOW()
       WHERE user_id = ${userId}
         AND revoked_at IS NULL
         AND ${exceptTokenHash ? this.db.sql`token_hash <> ${exceptTokenHash}` : this.db.sql`TRUE`}
   RETURNING id
    `;
    return rows.length;
  }

  async listSessions(userId: string): Promise<WebSessionRow[]> {
    return this.db.sql<WebSessionRow[]>`
      SELECT * FROM web_sessions
       WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY last_used_at DESC
    `;
  }

  /** Housekeeping: drop sessions that expired or were revoked long ago. */
  async purgeDeadSessions(): Promise<number> {
    const rows = await this.db.sql<{ id: string }[]>`
      DELETE FROM web_sessions
       WHERE expires_at < NOW() - INTERVAL '7 days'
          OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
   RETURNING id
    `;
    return rows.length;
  }

  // ---------------------------------------------------------------------------
  // Single-use tokens
  // ---------------------------------------------------------------------------

  /**
   * Issue a token, retiring any outstanding one for the same purpose.
   *
   * The retirement matters: without it, requesting a second password reset
   * leaves the first link live, so an email forwarded or leaked an hour ago
   * still works. One outstanding token per purpose is the behaviour users
   * already expect from every other service.
   */
  async issueToken(input: {
    userId: string;
    purpose: AuthTokenPurpose;
    tokenHash: string;
    subject: string | null;
    expiresAt: Date;
  }): Promise<AuthTokenRow> {
    return this.db.sql.begin(async (sql) => {
      await sql`
        UPDATE auth_tokens SET consumed_at = NOW()
         WHERE user_id = ${input.userId}
           AND purpose = ${input.purpose}
           AND consumed_at IS NULL
      `;

      const [row] = await sql<AuthTokenRow[]>`
        INSERT INTO auth_tokens (user_id, purpose, token_hash, subject, expires_at)
             VALUES (${input.userId}, ${input.purpose}, ${input.tokenHash},
                     ${input.subject}, ${input.expiresAt})
          RETURNING *
      `;
      return row;
    });
  }

  /**
   * Redeem a token, atomically.
   *
   * The `consumed_at IS NULL` predicate is inside the UPDATE, so two concurrent
   * redemptions of the same reset link cannot both succeed - the second matches
   * no rows. Checking first and updating after would let both through, which on
   * a password reset means two people setting the password.
   */
  async consumeToken(tokenHash: string, purpose: AuthTokenPurpose): Promise<AuthTokenRow | null> {
    const [row] = await this.db.sql<AuthTokenRow[]>`
      UPDATE auth_tokens
         SET consumed_at = NOW()
       WHERE token_hash  = ${tokenHash}
         AND purpose     = ${purpose}
         AND consumed_at IS NULL
         AND expires_at  > NOW()
   RETURNING *
    `;
    return row ?? null;
  }

  /**
   * Find a live phone-link code for a user, and count the attempt.
   *
   * Phone codes are six digits, so they are the one secret here that can be
   * guessed. `attempts` is incremented on every check and the caller refuses
   * past a small ceiling, which is what makes six digits sufficient - see
   * generateNumericCode() in tokens.ts.
   */
  async recordTokenAttempt(userId: string, purpose: AuthTokenPurpose): Promise<number> {
    const [row] = await this.db.sql<{ attempts: number }[]>`
      UPDATE auth_tokens
         SET attempts = attempts + 1
       WHERE user_id = ${userId}
         AND purpose = ${purpose}
         AND consumed_at IS NULL
         AND expires_at > NOW()
   RETURNING attempts
    `;
    return row?.attempts ?? 0;
  }

  /** A live token for a purpose, without consuming it. */
  async findLiveToken(userId: string, purpose: AuthTokenPurpose): Promise<AuthTokenRow | null> {
    const [row] = await this.db.sql<AuthTokenRow[]>`
      SELECT * FROM auth_tokens
       WHERE user_id = ${userId} AND purpose = ${purpose}
         AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1
    `;
    return row ?? null;
  }

  /**
   * Match a phone-link code against every outstanding request for that number.
   *
   * Looked up by the code and the number together, because the code arrives
   * over WhatsApp with no session attached - all we know is which handset sent
   * it. Binding to `subject` is what stops a code issued for one number being
   * replayed to claim a different one.
   */
  async findPhoneLinkByCode(tokenHash: string, phoneNumber: string): Promise<AuthTokenRow | null> {
    const [row] = await this.db.sql<AuthTokenRow[]>`
      SELECT * FROM auth_tokens
       WHERE token_hash = ${tokenHash}
         AND purpose    = 'PHONE_LINK'
         AND subject    = ${phoneNumber}
         AND consumed_at IS NULL
         AND expires_at  > NOW()
       LIMIT 1
    `;
    return row ?? null;
  }

  async purgeDeadTokens(): Promise<number> {
    const rows = await this.db.sql<{ id: string }[]>`
      DELETE FROM auth_tokens
       WHERE expires_at < NOW() - INTERVAL '2 days'
          OR (consumed_at IS NOT NULL AND consumed_at < NOW() - INTERVAL '2 days')
   RETURNING id
    `;
    return rows.length;
  }
}

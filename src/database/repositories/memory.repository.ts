import { Injectable } from '@nestjs/common';
import type { JSONValue } from 'postgres';
import { getLogger } from '../../common/logger';
import { DatabaseService } from '../database.service';

export interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Conversation memory for the WhatsApp side.
 *
 * ## Why this is in Postgres now
 *
 * It was in Redis, which made it the one part of an advocate's conversation
 * that a restart erased. The web side never had that problem — its history is
 * `chat_messages`, a real table — and the asymmetry showed: the same advocate
 * asking a follow-up got context on the web and a blank slate on WhatsApp,
 * depending on whether anything had been deployed in between.
 *
 * ## Why it is one row rather than a row per turn
 *
 * The only read is "the last N turns for this user", and the only write
 * replaces that whole list after trimming. A row per turn would mean an insert
 * plus a delete plus an ordered read, to model something the application always
 * handles as one object.
 *
 * ## Retention
 *
 * `expires_at` is data minimisation under the DPDP Act as much as housekeeping.
 * Nothing keeps an advocate's questions longer than the conversation they
 * belong to, and the nightly sweep enforces it.
 *
 * ## Failure policy
 *
 * Reads return empty and writes are swallowed. Memory improves an answer; it is
 * never worth failing a message over, and losing it degrades the reply rather
 * than breaking it.
 */
@Injectable()
export class MemoryRepository {
  private readonly logger = getLogger().child({ module: 'memory' });

  constructor(private readonly db: DatabaseService) {}

  async load(userId: string): Promise<MemoryTurn[]> {
    try {
      const [row] = await this.db.sql<{ turns: MemoryTurn[] }[]>`
        SELECT turns FROM whatsapp_memory
         WHERE user_id = ${userId} AND expires_at > NOW()
      `;
      return row?.turns ?? [];
    } catch (err) {
      this.logger.warn({ err, userId }, 'Could not load chat memory; answering without history');
      return [];
    }
  }

  /** Replace the stored turns, already trimmed by the caller. */
  async save(userId: string, turns: MemoryTurn[], ttlSeconds: number): Promise<void> {
    try {
      await this.db.sql`
        INSERT INTO whatsapp_memory (user_id, turns, expires_at)
             VALUES (${userId}, ${this.db.sql.json(turns as unknown as JSONValue)},
                     NOW() + (${ttlSeconds}::int * INTERVAL '1 second'))
        ON CONFLICT (user_id) DO UPDATE
                SET turns      = EXCLUDED.turns,
                    expires_at = EXCLUDED.expires_at,
                    updated_at = NOW()
      `;
    } catch (err) {
      this.logger.warn({ err, userId }, 'Could not persist chat memory');
    }
  }

  async clear(userId: string): Promise<void> {
    try {
      await this.db.sql`DELETE FROM whatsapp_memory WHERE user_id = ${userId}`;
    } catch (err) {
      this.logger.warn({ err, userId }, 'Could not clear chat memory');
    }
  }

  async purgeExpired(): Promise<number> {
    try {
      const rows = await this.db.sql<{ user_id: string }[]>`
        DELETE FROM whatsapp_memory WHERE expires_at < NOW() RETURNING user_id
      `;
      return rows.length;
    } catch (err) {
      this.logger.warn({ err }, 'Memory purge failed');
      return 0;
    }
  }
}

import { Injectable } from '@nestjs/common';
import type { JSONValue } from 'postgres';
import { DatabaseService } from '../database.service';
import { ConversationStateRow } from '../types';

@Injectable()
export class ConversationRepository {
  constructor(private readonly db: DatabaseService) {}

  async get(userId: string): Promise<ConversationStateRow | null> {
    const [row] = await this.db.sql<ConversationStateRow[]>`
      SELECT * FROM conversation_states
       WHERE user_id = ${userId}
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1
    `;
    return row ?? null;
  }

  /**
   * Write the conversation state.
   *
   * `ttlSeconds` guards against a user who starts onboarding, wanders off, and
   * comes back next week expecting a fresh menu rather than "please send your
   * bar council number" with no memory of why.
   */
  async set(
    userId: string,
    state: string,
    context: Record<string, unknown> = {},
    ttlSeconds = 3600,
  ): Promise<void> {
    await this.db.sql`
      INSERT INTO conversation_states (user_id, state, context, expires_at)
           VALUES (
             ${userId},
             ${state},
             ${this.db.sql.json(context as unknown as JSONValue)},
             NOW() + make_interval(secs => ${ttlSeconds})
           )
      ON CONFLICT (user_id) DO UPDATE
              SET state      = EXCLUDED.state,
                  context    = EXCLUDED.context,
                  expires_at = EXCLUDED.expires_at,
                  updated_at = NOW()
    `;
  }

  async clear(userId: string): Promise<void> {
    await this.db.sql`DELETE FROM conversation_states WHERE user_id = ${userId}`;
  }
}

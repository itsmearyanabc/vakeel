import { Injectable } from '@nestjs/common';
import type { JSONValue } from 'postgres';
import { DatabaseService } from '../database.service';
import { ChatMessageRow, ChatRole, ChatThreadRow, QueryIntent } from '../types';

/**
 * Threads and messages for the web chat.
 *
 * Every read is scoped by `user_id` in the WHERE clause rather than checked
 * after the fact. That is the whole authorisation model for this table and it
 * is deliberately not delegated upwards: a thread id is a UUID in a URL, and
 * the difference between "SELECT by id, then compare the owner" and "SELECT by
 * id AND owner" is one forgotten comparison between private and public. Making
 * the ownership part of the query means the wrong user gets no row at all.
 */
@Injectable()
export class ChatRepository {
  constructor(private readonly db: DatabaseService) {}

  // ---------------------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------------------

  async createThread(userId: string, title = 'New chat'): Promise<ChatThreadRow> {
    const [row] = await this.db.sql<ChatThreadRow[]>`
      INSERT INTO chat_threads (user_id, title) VALUES (${userId}, ${title})
        RETURNING *
    `;
    return row;
  }

  /** The sidebar. Archived threads are excluded; nothing is hard-deleted here. */
  async listThreads(userId: string, limit = 100, offset = 0): Promise<ChatThreadRow[]> {
    return this.db.sql<ChatThreadRow[]>`
      SELECT * FROM chat_threads
       WHERE user_id = ${userId} AND archived_at IS NULL
       ORDER BY last_message_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  async findThread(userId: string, threadId: string): Promise<ChatThreadRow | null> {
    const [row] = await this.db.sql<ChatThreadRow[]>`
      SELECT * FROM chat_threads WHERE id = ${threadId} AND user_id = ${userId} LIMIT 1
    `;
    return row ?? null;
  }

  async renameThread(userId: string, threadId: string, title: string): Promise<ChatThreadRow | null> {
    const [row] = await this.db.sql<ChatThreadRow[]>`
      UPDATE chat_threads SET title = ${title.slice(0, 200)}
       WHERE id = ${threadId} AND user_id = ${userId}
   RETURNING *
    `;
    return row ?? null;
  }

  /**
   * Archive rather than delete, by default.
   *
   * The thread leaves the sidebar and stops being reachable, which is what the
   * user asked for, and the content survives long enough for "I deleted the
   * wrong one" to be recoverable. Genuine erasure is a separate, explicit
   * operation - see {@link purgeThread} - because the two requests are
   * different and conflating them means one of them is always wrong.
   */
  async archiveThread(userId: string, threadId: string): Promise<boolean> {
    const rows = await this.db.sql<{ id: string }[]>`
      UPDATE chat_threads SET archived_at = NOW()
       WHERE id = ${threadId} AND user_id = ${userId} AND archived_at IS NULL
   RETURNING id
    `;
    return rows.length > 0;
  }

  /** Irreversible. Messages go with it through ON DELETE CASCADE. */
  async purgeThread(userId: string, threadId: string): Promise<boolean> {
    const rows = await this.db.sql<{ id: string }[]>`
      DELETE FROM chat_threads WHERE id = ${threadId} AND user_id = ${userId}
   RETURNING id
    `;
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async listMessages(userId: string, threadId: string, limit = 200): Promise<ChatMessageRow[]> {
    return this.db.sql<ChatMessageRow[]>`
      SELECT m.* FROM chat_messages m
        JOIN chat_threads t ON t.id = m.thread_id
       WHERE m.thread_id = ${threadId} AND t.user_id = ${userId}
       ORDER BY m.created_at
       LIMIT ${limit}
    `;
  }

  /**
   * Append a message and move the thread's summary forward, atomically.
   *
   * `structured` goes through `sql.json()`, not `JSON.stringify(...)::jsonb`.
   * The second looks equivalent and is not: postgres.js treats the resulting JS
   * string as a jsonb *string value*, so the column ends up holding a quoted
   * blob of JSON rather than an object, and it reads back as a string. Nothing
   * errors - the client simply finds `structured.kind` undefined and every
   * precedent list and case-status card silently falls back to plain text.
   *
   * The counter and `last_message_at` are denormalised so the sidebar sorts
   * without touching this table; writing them in the same transaction as the
   * insert is what keeps them from drifting. A thread whose timestamp says it
   * is empty while it holds twenty messages sorts to the bottom of the sidebar
   * and looks lost.
   */
  async appendMessage(input: {
    threadId: string;
    userId: string;
    role: ChatRole;
    content: string;
    intent?: QueryIntent | null;
    citations?: string[];
    structured?: Record<string, unknown> | null;
    modelUsed?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    creditsCharged?: number;
    guardrailFlagged?: boolean;
    guardrailReason?: string | null;
    errorDetail?: string | null;
  }): Promise<ChatMessageRow> {
    return this.db.sql.begin(async (sql) => {
      const [row] = await sql<ChatMessageRow[]>`
        INSERT INTO chat_messages (
          thread_id, user_id, role, content, intent, citations, structured,
          model_used, input_tokens, output_tokens, latency_ms, credits_charged,
          guardrail_flagged, guardrail_reason, error_detail
        ) VALUES (
          ${input.threadId}, ${input.userId}, ${input.role}, ${input.content},
          ${input.intent ?? null}::query_intent,
          ${input.citations ?? []}::text[],
          ${input.structured ? this.db.sql.json(input.structured as unknown as JSONValue) : null},
          ${input.modelUsed ?? null},
          ${input.inputTokens ?? 0}, ${input.outputTokens ?? 0}, ${input.latencyMs ?? 0},
          ${input.creditsCharged ?? 0},
          ${input.guardrailFlagged ?? false}, ${input.guardrailReason ?? null},
          ${input.errorDetail ?? null}
        )
        RETURNING *
      `;

      await sql`
        UPDATE chat_threads
           SET last_message_at = NOW(),
               message_count   = message_count + 1
         WHERE id = ${input.threadId}
      `;

      return row;
    });
  }

  /**
   * Name a thread from its first question, unless the user has already named it.
   *
   * The `title = 'New chat'` guard is what makes this safe to call on every
   * first message: a thread the advocate has renamed keeps its name, and one
   * they have not gets something better than "New chat" in the sidebar.
   */
  async autoTitle(threadId: string, question: string): Promise<void> {
    const title = question.replace(/\s+/g, ' ').trim().slice(0, 70) || 'New chat';
    await this.db.sql`
      UPDATE chat_threads SET title = ${title}
       WHERE id = ${threadId} AND title = 'New chat'
    `;
  }

  /**
   * The last few turns of a thread, oldest first, for model context.
   *
   * Read from Postgres rather than from the Redis chat memory the WhatsApp side
   * uses. On WhatsApp the conversation has no durable home, so Redis is the
   * only record; here the thread *is* the record, and reading history from a
   * cache that can expire would mean a thread the advocate can see on screen
   * while the model has forgotten it.
   */
  async recentTurns(threadId: string, limit = 10): Promise<{ role: ChatRole; content: string }[]> {
    const rows = await this.db.sql<{ role: ChatRole; content: string }[]>`
      SELECT role, content FROM (
        SELECT role, content, created_at
          FROM chat_messages
         WHERE thread_id = ${threadId} AND error_detail IS NULL
         ORDER BY created_at DESC
         LIMIT ${limit}
      ) recent
      ORDER BY created_at
    `;
    return rows;
  }

  /** Admin: recent web conversations across all users. */
  async recentThreadsForAdmin(limit = 50, offset = 0) {
    return this.db.sql<
      (ChatThreadRow & { full_name: string | null; email: string | null })[]
    >`
      SELECT t.*, u.full_name, u.email
        FROM chat_threads t
        JOIN users u ON u.id = t.user_id
       ORDER BY t.last_message_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /** Admin: read a thread without the owner check, for support and audit. */
  async messagesForAdmin(threadId: string, limit = 200): Promise<ChatMessageRow[]> {
    return this.db.sql<ChatMessageRow[]>`
      SELECT * FROM chat_messages WHERE thread_id = ${threadId}
       ORDER BY created_at LIMIT ${limit}
    `;
  }
}

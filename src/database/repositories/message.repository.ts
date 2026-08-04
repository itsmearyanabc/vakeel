import { Injectable } from '@nestjs/common';
import type { JSONValue } from 'postgres';
import { DatabaseService } from '../database.service';
import { MessageDirection, MessageStatus } from '../types';

export interface RecordMessageInput {
  waMessageId?: string | null;
  userId?: string | null;
  phoneNumber: string;
  direction: MessageDirection;
  messageType: string;
  body?: string | null;
  payload?: Record<string, unknown>;
  status?: MessageStatus;
}

@Injectable()
export class MessageRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Append to the message log.
   *
   * Returns null when the message id already exists, which is the signal that
   * Meta re-delivered a webhook we have already handled. Callers use that
   * return value to skip processing - it is the durable backstop behind the
   * Redis dedupe key, and the one that still works after a Redis flush.
   */
  async record(input: RecordMessageInput): Promise<{ id: string } | null> {
    const rows = await this.db.sql<{ id: string }[]>`
      INSERT INTO whatsapp_messages (
        wa_message_id, user_id, phone_number, direction, message_type, body, payload, status
      ) VALUES (
        ${input.waMessageId ?? null},
        ${input.userId ?? null},
        ${input.phoneNumber},
        ${input.direction}::message_direction,
        ${input.messageType},
        ${input.body ?? null},
        ${this.db.sql.json((input.payload ?? {}) as unknown as JSONValue)},
        ${input.status ?? 'RECEIVED'}::message_status
      )
      ON CONFLICT (wa_message_id) DO NOTHING
      RETURNING id
    `;
    return rows[0] ?? null;
  }

  async updateStatus(waMessageId: string, status: MessageStatus, errorDetail?: string): Promise<void> {
    await this.db.sql`
      UPDATE whatsapp_messages
         SET status = ${status}::message_status,
             error_detail = ${errorDetail ?? null}
       WHERE wa_message_id = ${waMessageId}
    `;
  }

  /**
   * Claim a webhook event key.
   *
   * Returns true only for the caller that inserted the row, so concurrent
   * deliveries of the same event resolve to exactly one winner. Status
   * callbacks have no message row of their own, which is why this exists
   * separately from `record`.
   */
  async claimWebhookEvent(eventKey: string): Promise<boolean> {
    const rows = await this.db.sql<{ event_key: string }[]>`
      INSERT INTO processed_webhooks (event_key)
           VALUES (${eventKey})
      ON CONFLICT (event_key) DO NOTHING
        RETURNING event_key
    `;
    return rows.length > 0;
  }

  async recentForUser(userId: string, limit = 20) {
    return this.db.sql`
      SELECT id, direction, message_type, body, status, created_at
        FROM whatsapp_messages
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
  }
}

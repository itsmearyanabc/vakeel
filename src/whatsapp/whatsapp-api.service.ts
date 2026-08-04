import { Injectable } from '@nestjs/common';
import { getLogger, maskPhone } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { MessageRepository } from '../database/repositories/message.repository';
import { splitForWhatsApp, textMessage, toWhatsAppMarkup } from './message-builder';
import { OutboundMessage } from './whatsapp.types';

export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
}

/**
 * Outbound client for the WhatsApp Cloud API.
 *
 * When credentials are absent the client logs what it would have sent and
 * reports success. That is what makes the whole pipeline runnable locally
 * without a Meta account - and it is gated on `whatsappConfigured`, so a
 * production deploy missing its token fails loudly at boot instead of silently
 * swallowing every reply.
 */
@Injectable()
export class WhatsAppApiService {
  private readonly logger = getLogger().child({ module: 'whatsapp:api' });

  constructor(
    @InjectEnv() private readonly env: AppEnv,
    private readonly messages: MessageRepository,
  ) {}

  private get headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`,
      'content-type': 'application/json',
    };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.env.whatsappConfigured) {
      this.logger.info(
        { to: maskPhone(message.to), type: message.type, preview: this.preview(message) },
        'WhatsApp credentials not configured - message logged instead of sent',
      );
      await this.logOutbound(message, 'SENT', null);
      return { ok: true };
    }

    try {
      const response = await fetch(`${this.env.whatsappApiBase}/messages`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(15000),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        messages?: { id?: string }[];
        error?: { message?: string; code?: number; error_data?: { details?: string } };
      };

      if (!response.ok) {
        const detail = payload.error?.error_data?.details ?? payload.error?.message ?? 'unknown error';
        this.logger.error(
          { status: response.status, to: maskPhone(message.to), detail, code: payload.error?.code },
          'WhatsApp send failed',
        );
        await this.logOutbound(message, 'FAILED', detail);
        return { ok: false, error: detail };
      }

      const waMessageId = payload.messages?.[0]?.id;
      await this.logOutbound(message, 'SENT', null, waMessageId);
      this.logger.debug({ to: maskPhone(message.to), waMessageId }, 'Message sent');

      return { ok: true, waMessageId };
    } catch (err) {
      this.logger.error({ err, to: maskPhone(message.to) }, 'WhatsApp send threw');
      await this.logOutbound(message, 'FAILED', err instanceof Error ? err.message : String(err));
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send a text answer, splitting it across messages if needed.
   *
   * Markdown is converted first, because the LLM emits `**bold**` no matter how
   * the prompt is worded and WhatsApp would render the asterisks literally.
   */
  async sendText(to: string, body: string): Promise<SendResult> {
    const formatted = toWhatsAppMarkup(body);
    const parts = splitForWhatsApp(formatted);

    let last: SendResult = { ok: true };
    for (const [index, part] of parts.entries()) {
      // Multi-part answers are numbered so the reader knows more is coming and
      // can tell if a part went missing.
      const suffix = parts.length > 1 ? `\n\n_(${index + 1}/${parts.length})_` : '';
      last = await this.send(textMessage(to, part + suffix));
      if (!last.ok) break;
    }
    return last;
  }

  /**
   * Mark an inbound message as read (the blue ticks).
   *
   * Best-effort: a failure here is cosmetic and must never fail the job.
   */
  async markAsRead(waMessageId: string): Promise<void> {
    if (!this.env.whatsappConfigured) return;

    try {
      await fetch(`${this.env.whatsappApiBase}/messages`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      this.logger.debug({ err, waMessageId }, 'Could not mark message as read');
    }
  }

  /**
   * Download inbound media (voice notes, ID card images).
   *
   * Two hops: resolve the media id to a short-lived URL, then fetch it. The URL
   * requires the same bearer token, which is a common thing to miss.
   */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!this.env.whatsappConfigured) return null;

    try {
      const metaResponse = await fetch(
        `${this.env.WHATSAPP_GRAPH_BASE_URL}/${this.env.WHATSAPP_API_VERSION}/${mediaId}`,
        { method: 'GET', headers: this.headers, signal: AbortSignal.timeout(10000) },
      );

      if (!metaResponse.ok) {
        this.logger.warn({ mediaId, status: metaResponse.status }, 'Could not resolve media URL');
        return null;
      }

      const meta = (await metaResponse.json()) as { url?: string; mime_type?: string };
      if (!meta.url) return null;

      // The media URL is on a different host but still requires the same
      // bearer token - fetching it unauthenticated returns a 401.
      const fileResponse = await fetch(meta.url, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(20000),
      });

      if (!fileResponse.ok) return null;

      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      return { buffer, mimeType: meta.mime_type ?? 'application/octet-stream' };
    } catch (err) {
      this.logger.error({ err, mediaId }, 'Media download failed');
      return null;
    }
  }

  private preview(message: OutboundMessage): string {
    if (message.type === 'text') return message.text.body.slice(0, 300);
    return `[interactive:${message.interactive.type}] ${message.interactive.body.text.slice(0, 200)}`;
  }

  private async logOutbound(
    message: OutboundMessage,
    status: 'SENT' | 'FAILED',
    error: string | null,
    waMessageId?: string,
  ): Promise<void> {
    try {
      await this.messages.record({
        waMessageId: waMessageId ?? null,
        phoneNumber: message.to,
        direction: 'OUTBOUND',
        messageType: message.type,
        body: message.type === 'text' ? message.text.body : message.interactive.body.text,
        payload: message as unknown as Record<string, unknown>,
        status,
      });
      if (error && waMessageId) await this.messages.updateStatus(waMessageId, 'FAILED', error);
    } catch (err) {
      // The message log is an audit trail, not part of delivery. Never let a
      // logging failure stop a reply going out.
      this.logger.warn({ err }, 'Failed to record outbound message');
    }
  }
}

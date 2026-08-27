import { Injectable } from '@nestjs/common';
import { getLogger, maskPhone } from '../common/logger';
import { MessageRepository } from '../database/repositories/message.repository';
import { SettingsService } from '../settings/settings.service';
import { splitForWhatsApp, textMessage, toWhatsAppMarkup } from './message-builder';
import { OutboundMessage } from './whatsapp.types';

export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
  /** Meta's numeric error code, when the failure came from the Graph API. */
  code?: number;
  /** What to actually do about it, for codes we recognise. */
  hint?: string;
}

/**
 * Meta error codes worth translating.
 *
 * Their messages describe the API's state, not the operator's mistake. "Recipient
 * phone number not in allowed list" is accurate and still leaves you guessing
 * that the app is in test mode - so these failures read as bot bugs and get
 * debugged in the wrong place. The mapping is deliberately small: only codes
 * that have a specific, checkable action attached.
 *
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const META_ERROR_HINTS: Record<number, string> = {
  131030:
    'This number is not on the app\'s allowed recipient list. A WhatsApp app in test mode can only message numbers added under API Setup -> "To". Add it there, or complete Business Verification and take the app Live to message anyone.',
  131047:
    'More than 24 hours have passed since this number last messaged the bot, so free-form replies are blocked. Only an approved message template can reopen the conversation.',
  131026:
    'The number cannot receive WhatsApp messages - it is not on WhatsApp, or it is a landline.',
  190: 'The access token has expired or been revoked. Generate a permanent System User token in Business Settings and update WHATSAPP_ACCESS_TOKEN.',
  100: 'A parameter was rejected. Usually WHATSAPP_PHONE_NUMBER_ID belongs to a different WhatsApp Business Account than the access token.',
  133010: 'The phone number is not registered with the Cloud API. Register it under API Setup before sending.',
  368: 'The number is temporarily blocked by Meta for policy reasons. Check Quality Rating in the WhatsApp Manager.',
};

/**
 * Outbound client for the WhatsApp Cloud API.
 *
 * When credentials are absent the client logs what it would have sent and
 * reports success. That is what makes the whole pipeline runnable locally
 * without a Meta account.
 *
 * Every credential is read from SettingsService on each call rather than
 * captured in the constructor. That is what lets an admin paste in a different
 * number's credentials and have the very next message go out on the new number,
 * with no redeploy and no restart.
 */
@Injectable()
export class WhatsAppApiService {
  private readonly logger = getLogger().child({ module: 'whatsapp:api' });

  constructor(
    private readonly settings: SettingsService,
    private readonly messages: MessageRepository,
  ) {}

  private get headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.settings.whatsappAccessToken}`,
      'content-type': 'application/json',
    };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.settings.whatsappConfigured) {
      this.logger.info(
        { to: maskPhone(message.to), type: message.type, preview: this.preview(message) },
        'WhatsApp credentials not configured - message logged instead of sent',
      );
      await this.logOutbound(message, 'SENT', null);
      return { ok: true };
    }

    try {
      const response = await fetch(`${this.settings.whatsappApiBase}/messages`, {
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
        const code = payload.error?.code;
        const hint = code === undefined ? undefined : META_ERROR_HINTS[code];

        this.logger.error(
          { status: response.status, to: maskPhone(message.to), detail, code, hint },
          'WhatsApp send failed',
        );
        // The hint goes into the message log too, so the Messages view in the
        // panel explains the failure without anyone reading the server logs.
        await this.logOutbound(message, 'FAILED', hint ? `${detail} - ${hint}` : detail);
        return { ok: false, error: detail, code, hint };
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
   * Send a one-time code as an authentication template.
   *
   * ## Why this exists rather than `sendText`
   *
   * A person signing up has never messaged the bot, so the 24-hour customer
   * service window is closed for them and a free-form message is refused by
   * Meta with error 131047. An approved authentication template is the only
   * category exempt from that window, which makes it the only way an account
   * verification code can reach a handset at all.
   *
   * ## Why the code is repeated
   *
   * Meta requires the code in the body parameter *and* in the copy-code button
   * parameter. Supplying only the body is accepted by the API and delivers a
   * message whose button copies an empty string - a failure that looks like a
   * working send in every log and only shows up on the handset.
   *
   * Deliberately not routed through `sendText`'s splitting: a code is never
   * long enough to split, and a split code would be two useless messages.
   */
  async sendAuthCode(to: string, code: string): Promise<SendResult> {
    const name = this.settings.get('WHATSAPP_OTP_TEMPLATE_NAME') || 'otp_verify';
    const language = this.settings.get('WHATSAPP_OTP_TEMPLATE_LANG') || 'en';

    return this.send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          {
            type: 'button',
            sub_type: 'copy_code',
            index: '0',
            parameters: [{ type: 'coupon_code', coupon_code: code }],
          },
        ],
      },
    });
  }

  /**
   * Mark an inbound message as read (the blue ticks).
   *
   * Best-effort: a failure here is cosmetic and must never fail the job.
   */
  async markAsRead(waMessageId: string): Promise<void> {
    if (!this.settings.whatsappConfigured) return;

    try {
      await fetch(`${this.settings.whatsappApiBase}/messages`, {
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
    if (!this.settings.whatsappConfigured) return null;

    try {
      const metaResponse = await fetch(`${this.settings.whatsappGraphRoot}/${mediaId}`, {
        method: 'GET',
        headers: this.headers,
        signal: AbortSignal.timeout(10000),
      });

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
        headers: { authorization: `Bearer ${this.settings.whatsappAccessToken}` },
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
    // Never the parameters: for an authentication template those are the
    // one-time code, and this string is written to the log line that runs when
    // credentials are absent. The template name is enough to identify it.
    if (message.type === 'template') return `[template:${message.template.name}]`;
    return `[interactive:${message.interactive.type}] ${message.interactive.body.text.slice(0, 200)}`;
  }

  /**
   * What of this message is safe to keep in the message log.
   *
   * The log is an audit trail an admin can read in the panel, and it is kept
   * for the retention window. A one-time code in there outlives its usefulness
   * by weeks and turns the log into a credential store, so a template records
   * that it was sent and not what it said.
   */
  private loggableBody(message: OutboundMessage): string {
    if (message.type === 'text') return message.text.body;
    if (message.type === 'template') return `[template:${message.template.name}]`;
    return message.interactive.body.text;
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
        body: this.loggableBody(message),
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

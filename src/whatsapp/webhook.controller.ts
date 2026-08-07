import { Controller, ForbiddenException, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RawResponse } from '../common/api-response';
import { getLogger, maskPhone } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { MessageRepository } from '../database/repositories/message.repository';
import { InboundMessageJob } from '../redis/queue.constants';
import { QueueService } from '../redis/queue.service';
import { RedisService } from '../redis/redis.service';
import { SignatureService } from '../security/signature.service';
import { SettingsService } from '../settings/settings.service';
import { WebhookMessage, WebhookStatus, WhatsAppWebhookPayload } from './whatsapp.types';

/** Fastify request carrying the raw body captured by the parser in main.ts. */
type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Meta's webhook endpoint (spec section 13).
 *
 * ## The one hard constraint
 *
 * Meta expects a 200 within seconds and retries anything slower. Sustained slow
 * or failing responses get the phone number rate-limited, and eventually the
 * webhook subscription is disabled - at which point the bot is off the air
 * until someone notices and re-subscribes in the Meta dashboard.
 *
 * So this controller does the minimum: verify the signature, drop duplicates,
 * push to the queue, return 200. Retrieval, LLM calls and eCourts lookups all
 * happen in the worker process. Nothing here awaits anything slow.
 *
 * It also returns 200 on malformed payloads. A 4xx would make Meta retry a
 * payload that will never parse, forever.
 */
@Controller('webhooks/whatsapp')
export class WebhookController {
  private readonly logger = getLogger().child({ module: 'whatsapp:webhook' });

  constructor(
    private readonly signature: SignatureService,
    private readonly queue: QueueService,
    private readonly redis: RedisService,
    private readonly messages: MessageRepository,
    private readonly settings: SettingsService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /**
   * Subscription handshake.
   *
   * Meta GETs this once when you save the callback URL. It must echo
   * `hub.challenge` as a bare body - wrapped in the JSON envelope, verification
   * fails with an unhelpful error in the dashboard.
   */
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): RawResponse<string> {
    if (!this.signature.verifySubscription(mode, token, this.settings.whatsappVerifyToken)) {
      this.logger.warn(
        { mode },
        'Webhook verification failed - the verify token Meta sent does not match the configured one',
      );
      throw new ForbiddenException({ code: 'VERIFICATION_FAILED', message: 'Invalid verify token.' });
    }

    this.logger.info('Webhook verified by Meta');
    return new RawResponse(challenge);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: RawBodyRequest): Promise<{ received: true }> {
    // Signature is computed over the raw bytes; see signature.service.ts.
    const valid = this.signature.verifyWhatsAppSignature(
      req.rawBody,
      req.headers['x-hub-signature-256'] as string | undefined,
      this.settings.whatsappAppSecret,
    );

    if (!valid) {
      this.logger.warn({ ip: req.ip }, 'Rejected webhook with invalid signature');
      throw new ForbiddenException({ code: 'INVALID_SIGNATURE', message: 'Signature verification failed.' });
    }

    const payload = req.body as WhatsAppWebhookPayload;

    // Deliberately not awaited: Meta gets its 200 immediately and the fan-out
    // continues in the background. Errors are caught inside.
    void this.dispatch(payload).catch((err) => this.logger.error({ err }, 'Webhook dispatch failed'));

    return { received: true };
  }

  private async dispatch(payload: WhatsAppWebhookPayload): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const phoneNumberId = value.metadata?.phone_number_id ?? this.settings.whatsappPhoneNumberId;

        for (const message of value.messages ?? []) {
          await this.handleMessage(message, value.contacts?.[0]?.profile?.name, phoneNumberId);
        }

        for (const status of value.statuses ?? []) {
          await this.handleStatus(status);
        }

        for (const error of value.errors ?? []) {
          this.logger.error({ error }, 'Meta reported an account-level error');
        }
      }
    }
  }

  private async handleMessage(
    message: WebhookMessage,
    profileName: string | undefined,
    phoneNumberId: string,
  ): Promise<void> {
    if (!message.id || !message.from) {
      this.logger.warn({ message }, 'Skipping message without id or sender');
      return;
    }

    // First of three dedupe layers (Redis here, unique index in the message
    // log, deterministic BullMQ job id). Meta redelivers aggressively, and each
    // duplicate would otherwise cost an LLM call.
    const fresh = await this.redis.claimOnce(
      `wa:seen:${message.id}`,
      this.env.WHATSAPP_DEDUPE_TTL_SECONDS,
    );
    if (!fresh) {
      this.logger.debug({ waMessageId: message.id }, 'Duplicate webhook delivery ignored');
      return;
    }

    const job = this.toJob(message, profileName, phoneNumberId);

    await this.messages.record({
      waMessageId: message.id,
      phoneNumber: message.from,
      direction: 'INBOUND',
      messageType: job.type,
      body: job.text ?? null,
      payload: message as unknown as Record<string, unknown>,
      status: 'QUEUED',
    });

    await this.queue.enqueueInbound(job);

    this.logger.info(
      { from: maskPhone(message.from), type: job.type, waMessageId: message.id },
      'Inbound message accepted',
    );
  }

  /** Normalise Meta's per-type message shapes into one job payload. */
  private toJob(
    message: WebhookMessage,
    profileName: string | undefined,
    phoneNumberId: string,
  ): InboundMessageJob {
    const base = {
      waMessageId: message.id!,
      from: message.from!,
      phoneNumberId,
      timestamp: Number(message.timestamp ?? Math.floor(Date.now() / 1000)),
      profileName,
    };

    switch (message.type) {
      case 'text':
        return { ...base, type: 'text', text: message.text?.body ?? '' };

      case 'interactive': {
        // The id is ours - we encoded it into the button or row - so it is what
        // routing keys off. The title is only for the message log.
        const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
        return {
          ...base,
          type: 'interactive',
          interactiveId: reply?.id,
          text: reply?.title ?? '',
        };
      }

      case 'button':
        // Legacy template button. `payload` is what we set; `text` is the label.
        return { ...base, type: 'button', interactiveId: message.button?.payload, text: message.button?.text ?? '' };

      case 'audio':
        return {
          ...base,
          type: 'audio',
          mediaId: message.audio?.id,
          mediaMimeType: message.audio?.mime_type,
        };

      case 'image':
        return {
          ...base,
          type: 'image',
          mediaId: message.image?.id,
          mediaMimeType: message.image?.mime_type,
          text: message.image?.caption ?? '',
        };

      case 'document':
        return {
          ...base,
          type: 'document',
          mediaId: message.document?.id,
          mediaMimeType: message.document?.mime_type,
          text: message.document?.caption ?? message.document?.filename ?? '',
        };

      default:
        // Stickers, locations, contacts, reactions and whatever Meta ships
        // next. The worker replies with a polite "not supported".
        return { ...base, type: 'unsupported', text: message.type ?? 'unknown' };
    }
  }

  private async handleStatus(status: WebhookStatus): Promise<void> {
    if (!status.id || !status.status) return;

    // Status callbacks have no message row of their own, so they get their own
    // idempotency key rather than reusing the message dedupe.
    const claimed = await this.messages.claimWebhookEvent(`status:${status.id}:${status.status}`);
    if (!claimed) return;

    const mapped = {
      sent: 'SENT',
      delivered: 'DELIVERED',
      read: 'READ',
      failed: 'FAILED',
    } as const;

    await this.messages.updateStatus(
      status.id,
      mapped[status.status],
      status.errors?.[0]?.message ?? status.errors?.[0]?.title,
    );

    if (status.status === 'failed') {
      this.logger.warn(
        { waMessageId: status.id, recipient: maskPhone(status.recipient_id), errors: status.errors },
        'Message delivery failed',
      );
    }
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UserAuthGuard, WebRequest } from '../auth/user-auth.guard';
import { getLogger } from '../common/logger';
import { CreditsService } from '../credits/credits.service';
import { PaymentsService, UnknownPackError } from './payments.service';
import { GatewayNotConfiguredError, RazorpayService } from './razorpay.service';

/** Fastify request carrying the raw body captured by the parser in main.ts. */
type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Buying credits, from the advocate's side.
 *
 * Every route is guarded and scoped to the session holder. There is no route
 * here that takes a user id, and no route that takes a price - see
 * PaymentsService on why the pack code is the only thing trusted from a client.
 */
@Controller('api/payments')
@UseGuards(UserAuthGuard)
export class PaymentsController {
  private readonly logger = getLogger().child({ module: 'payments:http' });

  constructor(
    private readonly payments: PaymentsService,
    private readonly credits: CreditsService,
  ) {}

  /**
   * The price list.
   *
   * `gatewayConfigured` travels with it so the interface can say plainly that
   * checkout is unavailable, rather than rendering a Buy button that fails on
   * click - which is indistinguishable from a broken payment page, and the only
   * way a user finds out is by trying to pay.
   */
  @Get('packs')
  async packs() {
    const packs = await this.payments.listPacks();

    return {
      gatewayConfigured: this.payments.gatewayConfigured,
      packs: packs.map((pack) => ({
        code: pack.code,
        name: pack.name,
        description: pack.description,
        credits: pack.credits,
        pricePaise: pack.price_paise,
        currency: pack.currency,
        billingPeriod: pack.billing_period,
        featured: pack.is_featured,
      })),
    };
  }

  @Post('order')
  @HttpCode(HttpStatus.OK)
  async createOrder(@Body() body: { packCode?: string }, @Req() req: WebRequest) {
    const packCode = (body?.packCode ?? '').trim();
    if (!packCode) {
      throw new BadRequestException({ code: 'NO_PACK', message: 'Choose a credit pack first.' });
    }

    try {
      return await this.payments.startCheckout(req.principal!.user, packCode);
    } catch (err) {
      if (err instanceof GatewayNotConfiguredError) {
        throw new ServiceUnavailableException({
          code: 'GATEWAY_UNAVAILABLE',
          message: 'Card payments are not switched on for this deployment yet.',
        });
      }
      if (err instanceof UnknownPackError) {
        throw new BadRequestException({
          code: 'UNKNOWN_PACK',
          message: 'That pack is no longer on sale. Refresh and choose another.',
        });
      }
      throw err;
    }
  }

  /**
   * Settle the result the checkout script handed back.
   *
   * Returns the balance, so the interface can show the new figure without a
   * second round trip - the advocate has just paid and the number is the thing
   * they are looking at.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Body()
    body: { razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string },
    @Req() req: WebRequest,
  ) {
    const user = req.principal!.user;

    const gatewayOrderId = (body?.razorpay_order_id ?? '').trim();
    const paymentId = (body?.razorpay_payment_id ?? '').trim();
    const signature = (body?.razorpay_signature ?? '').trim();

    if (!gatewayOrderId || !paymentId || !signature) {
      throw new BadRequestException({
        code: 'INCOMPLETE_RESULT',
        message: 'The payment result was incomplete.',
      });
    }

    const result = await this.payments.confirmCheckout(user, {
      gatewayOrderId,
      paymentId,
      signature,
    });

    return {
      ...result,
      balance: await this.credits.peek(user.id, user.role),
    };
  }
}

/**
 * Razorpay's webhook.
 *
 * ## Why this is a separate, unguarded controller
 *
 * It is called by Razorpay, which carries no session cookie. Its authentication
 * is the signature over the raw body, checked below, and nothing else - so it
 * sits outside `UserAuthGuard` deliberately and must never be given a route
 * that trusts anything in the body before that check passes.
 *
 * ## Why it always returns 200 once the signature verifies
 *
 * Razorpay retries until it receives a 2xx. A payload we cannot act on will
 * never become actionable by being redelivered, so a non-2xx there buys an
 * indefinite retry loop and nothing else. A *signature* failure is different
 * and returns 403: that is either a misconfigured secret or somebody forging
 * deliveries, and both need to be loud.
 */
@Controller('webhooks/razorpay')
export class RazorpayWebhookController {
  private readonly logger = getLogger().child({ module: 'payments:webhook' });

  constructor(
    private readonly razorpay: RazorpayService,
    private readonly payments: PaymentsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: RawBodyRequest): Promise<{ received: true }> {
    const valid = this.razorpay.verifyWebhook(
      req.rawBody,
      req.headers['x-razorpay-signature'] as string | undefined,
    );

    if (!valid) {
      this.logger.warn({ ip: req.ip }, 'Rejected a Razorpay webhook with an invalid signature');
      throw new ForbiddenException({
        code: 'INVALID_SIGNATURE',
        message: 'Signature verification failed.',
      });
    }

    const body = req.body as {
      event?: string;
      payload?: Record<string, unknown>;
    };

    // Razorpay's own delivery id. Falling back to the payment id keeps the
    // dedupe working if the header is ever absent, which is better than
    // crediting twice; a random value here would defeat the whole table.
    const eventId =
      (req.headers['x-razorpay-event-id'] as string | undefined) ??
      `${body?.event ?? 'unknown'}:${JSON.stringify(body?.payload ?? {}).length}`;

    if (!body?.event) {
      this.logger.warn('Razorpay webhook carried no event type');
      return { received: true };
    }

    try {
      const outcome = await this.payments.handleWebhookEvent({
        eventId,
        event: body.event,
        payload: body.payload ?? {},
      });

      this.logger.info({ event: body.event, eventId, handled: outcome.handled }, 'Payment webhook processed');
    } catch (err) {
      // Logged and swallowed. See the class comment: a retry cannot fix a
      // payload we failed on, and the failure is already recorded against the
      // payment_events row for the uncredited report to pair with.
      this.logger.error({ err, event: body.event, eventId }, 'Payment webhook handling failed');
    }

    return { received: true };
  }
}

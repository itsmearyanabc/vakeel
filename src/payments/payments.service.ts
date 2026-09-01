import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { getLogger } from '../common/logger';
import { CreditsService } from '../credits/credits.service';
import { CreditRepository } from '../database/repositories/credit.repository';
import { PackRepository } from '../database/repositories/pack.repository';
import { CreditPackRow, UserRow } from '../database/types';
import { SettingsService } from '../settings/settings.service';
import { GatewayNotConfiguredError, RazorpayService } from './razorpay.service';

/** Raised when a checkout names a pack that is not on sale. */
export class UnknownPackError extends Error {
  constructor(code: string) {
    super(`No pack on sale with code ${code}`);
    this.name = 'UnknownPackError';
  }
}

export interface StartedCheckout {
  /** Razorpay's order id, which the browser hands to their checkout script. */
  gatewayOrderId: string;
  /** The publishable key. The secret never leaves the server. */
  keyId: string;
  amountPaise: number;
  currency: string;
  credits: number;
  packName: string;
  receipt: string;
}

/**
 * Buying credits.
 *
 * ## The order of operations, and why it is that way
 *
 * Our row is written *before* the gateway is contacted. The receipt is
 * generated here and is unique, so a request that times out mid-flight leaves a
 * CREATED order with no gateway id - which is a visible, retryable state -
 * rather than money taken against an order we have no record of. The reverse
 * order has one failure mode and it is the unrecoverable one.
 *
 * ## What is trusted from the client, and what is not
 *
 * The pack code, and nothing else. Price and credit count are read from the
 * database at order time, never from the request: a client that could name its
 * own price would name zero. They are then copied onto the order row, so a
 * later price change cannot alter what an already-paid order was worth.
 *
 * ## Two ways in, one grant
 *
 * A successful payment arrives twice - the browser's signed checkout result and
 * Razorpay's webhook. Both are honoured, because either can be the only one that
 * shows up: the browser closes on a flaky connection, webhooks lag. Both credit
 * through `purchase:{paymentId}`, so the second collides on the ledger's unique
 * index and moves nothing.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = getLogger().child({ module: 'payments' });

  constructor(
    private readonly packs: PackRepository,
    private readonly orders: CreditRepository,
    private readonly credits: CreditsService,
    private readonly razorpay: RazorpayService,
    private readonly settings: SettingsService,
  ) {}

  /** The price list, as the pricing screen shows it. */
  async listPacks(): Promise<CreditPackRow[]> {
    return this.packs.listActive();
  }

  get gatewayConfigured(): boolean {
    return this.razorpay.isConfigured;
  }

  /**
   * Create an order and hand the browser what it needs to open checkout.
   *
   * The GST split is computed here rather than stored on the pack, because the
   * rate can change between a pack being listed and an order being placed and
   * the invoice has to carry the rate actually charged - see migration 0015.
   */
  async startCheckout(user: UserRow, packCode: string): Promise<StartedCheckout> {
    if (!this.razorpay.isConfigured) throw new GatewayNotConfiguredError();

    const pack = await this.packs.findActiveByCode(packCode);
    if (!pack) throw new UnknownPackError(packCode);

    const taxRateBps = this.settings.gstRateBps;
    const { basePaise, taxPaise } = splitTax(pack.price_paise, taxRateBps);

    // Ours, unique, and generated before the gateway is contacted. Short enough
    // for Razorpay's 40-character receipt limit.
    const receipt = `vs_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;

    const order = await this.orders.createOrder({
      userId: user.id,
      receipt,
      credits: pack.credits,
      packCode: pack.code,
      amountPaise: pack.price_paise,
      basePaise,
      taxPaise,
      taxRateBps,
    });

    const gatewayOrder = await this.razorpay.createOrder({
      amountPaise: pack.price_paise,
      currency: pack.currency,
      receipt,
      // Carried back on the webhook, which is how a delivery that arrives
      // before our own row is committed can still be attributed.
      notes: { userId: user.id, packCode: pack.code, orderId: order.id },
    });

    await this.orders.attachGatewayOrder(receipt, gatewayOrder.id);

    this.logger.info(
      { userId: user.id, receipt, pack: pack.code, amountPaise: pack.price_paise },
      'Checkout started',
    );

    return {
      gatewayOrderId: gatewayOrder.id,
      keyId: this.razorpay.publicKeyId,
      amountPaise: pack.price_paise,
      currency: pack.currency,
      credits: pack.credits,
      packName: pack.name,
      receipt,
    };
  }

  /**
   * Settle what the browser handed back after checkout.
   *
   * The signature proves the browser was given a genuine payment id for a
   * genuine order; it does not prove the money settled, which is the webhook's
   * job. Crediting here anyway is deliberate: the advocate sees their balance
   * move immediately instead of waiting on delivery, and the webhook's later
   * arrival is a no-op on the same idempotency key.
   *
   * The order is re-read by *gateway* id and its `user_id` checked against the
   * caller, so a signed result cannot be replayed against someone else's order.
   */
  async confirmCheckout(
    user: UserRow,
    input: { gatewayOrderId: string; paymentId: string; signature: string },
  ): Promise<{ credited: boolean; credits: number }> {
    if (!this.razorpay.verifyCheckout({
      orderId: input.gatewayOrderId,
      paymentId: input.paymentId,
      signature: input.signature,
    })) {
      this.logger.warn(
        { userId: user.id, gatewayOrderId: input.gatewayOrderId },
        'Checkout signature did not verify - refusing to credit',
      );
      throw new Error('The payment could not be verified.');
    }

    const order = await this.orders.findOrderByRazorpayId(input.gatewayOrderId);
    if (!order || order.user_id !== user.id) {
      this.logger.error(
        { userId: user.id, gatewayOrderId: input.gatewayOrderId, found: Boolean(order) },
        'Verified checkout for an order this account does not own',
      );
      throw new Error('The payment could not be matched to your account.');
    }

    await this.orders.markOrderPaid({
      razorpayOrderId: input.gatewayOrderId,
      paymentId: input.paymentId,
      signature: input.signature,
      method: null,
    });

    return this.credit(order.id, order.user_id, order.credits, input.paymentId, order.pack_code);
  }

  /**
   * Handle a verified webhook body.
   *
   * The signature is checked by the controller against the raw bytes before
   * this is reached. Everything here is about deciding whether the event is one
   * we act on, and doing it exactly once.
   */
  async handleWebhookEvent(input: {
    eventId: string;
    event: string;
    payload: Record<string, unknown>;
  }): Promise<{ handled: boolean }> {
    const entity = paymentEntity(input.payload);
    const gatewayOrderId = entity?.order_id ?? null;

    const order = gatewayOrderId ? await this.orders.findOrderByRazorpayId(gatewayOrderId) : null;

    // Claimed before anything is acted on. Razorpay redelivers until it gets a
    // 2xx, so a second delivery must find the key taken and stop.
    const fresh = await this.orders.claimPaymentEvent({
      eventId: input.eventId,
      eventType: input.event,
      orderId: order?.id ?? null,
      payload: input.payload,
    });

    if (!fresh) {
      this.logger.debug({ eventId: input.eventId, event: input.event }, 'Duplicate payment event ignored');
      return { handled: false };
    }

    try {
      if (input.event === 'payment.failed') {
        if (gatewayOrderId) {
          await this.orders.markOrderFailed(
            gatewayOrderId,
            String(entity?.error_description ?? 'The payment failed at the gateway'),
          );
        }
        await this.orders.settlePaymentEvent(input.eventId, true);
        return { handled: true };
      }

      if (input.event !== 'payment.captured' && input.event !== 'order.paid') {
        // Verified, real, and not something this product acts on. Recorded as
        // received-but-unhandled rather than dropped, so the audit trail shows
        // the delivery arrived.
        await this.orders.settlePaymentEvent(input.eventId, false);
        return { handled: false };
      }

      if (!order || !entity?.id) {
        await this.orders.settlePaymentEvent(
          input.eventId,
          false,
          'No matching order for this payment',
        );
        this.logger.error(
          { eventId: input.eventId, gatewayOrderId },
          'Captured payment with no matching order row',
        );
        return { handled: false };
      }

      await this.orders.markOrderPaid({
        razorpayOrderId: order.razorpay_order_id!,
        paymentId: entity.id,
        signature: null,
        method: entity.method ?? null,
      });

      await this.credit(order.id, order.user_id, order.credits, entity.id, order.pack_code);
      await this.orders.settlePaymentEvent(input.eventId, true);

      return { handled: true };
    } catch (err) {
      // Recorded against the event rather than swallowed. An event claimed and
      // then failed is exactly the row the uncredited report exists to pair with.
      await this.orders
        .settlePaymentEvent(input.eventId, false, err instanceof Error ? err.message : 'unknown')
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Write the credits and stamp the order.
   *
   * `credited_at` is set only after the ledger row exists, which is what makes
   * "paid but not credited" findable. Setting it alongside PAID would make the
   * uncredited report structurally incapable of returning anything.
   */
  private async credit(
    orderId: string,
    userId: string,
    credits: number,
    paymentId: string,
    packCode: string | null,
  ): Promise<{ credited: boolean; credits: number }> {
    const result = await this.credits.grantPurchase({
      userId,
      amount: credits,
      paymentId,
      orderId,
      reason: packCode ? `Purchased ${packCode}` : 'Purchased credits',
    });

    await this.orders.markOrderCredited(orderId);

    return { credited: result.applied, credits };
  }
}

/**
 * Split a gross price into base and tax.
 *
 * The price an advocate is quoted is what they pay, so the tax is computed
 * *out* of it rather than added on top - a quoted ₹499 that charges ₹588 at
 * checkout is the complaint this avoids.
 *
 * Integer arithmetic throughout, and the base is derived by subtraction so the
 * two always add to the total. Computing both independently and rounding each
 * is how an invoice ends up a paisa short of itself, which the
 * `credit_orders_amount_adds_up` constraint would then reject.
 */
export function splitTax(
  grossPaise: number,
  taxRateBps: number,
): { basePaise: number; taxPaise: number } {
  if (taxRateBps <= 0) return { basePaise: grossPaise, taxPaise: 0 };

  const base = Math.round((grossPaise * 10_000) / (10_000 + taxRateBps));
  return { basePaise: base, taxPaise: grossPaise - base };
}

/** Razorpay nests the entity under `payload.<type>.entity`. */
function paymentEntity(
  payload: Record<string, unknown>,
): { id?: string; order_id?: string; method?: string; error_description?: string } | null {
  const container = payload.payment ?? payload.order;
  if (!container || typeof container !== 'object') return null;

  const entity = (container as { entity?: unknown }).entity;
  return entity && typeof entity === 'object' ? (entity as Record<string, never>) : null;
}

import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../common/logger';
import { SettingsService } from '../settings/settings.service';

/** Raised when a payment route is reached on a deployment with no keys. */
export class GatewayNotConfiguredError extends Error {
  constructor() {
    super('Razorpay is not configured on this deployment.');
    this.name = 'GatewayNotConfiguredError';
  }
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

/**
 * The Razorpay client.
 *
 * ## Why this is hand-rolled rather than the `razorpay` npm package
 *
 * Three calls are needed: create an order, verify a checkout signature, verify a
 * webhook signature. Two of the three are an HMAC comparison against a secret
 * this process already holds, and the third is one authenticated POST. The
 * official SDK brings a dependency tree into a service whose entire payment
 * surface is that, and wraps the two signature checks in helpers that are four
 * lines each.
 *
 * ## The two signatures are different, and confusing them is the bug
 *
 * They use different secrets over different payloads, and both "work" in the
 * sense of producing a digest, so a mix-up fails as *every payment rejected*
 * rather than as an error:
 *
 *   - **Checkout** (the browser handing back a result): HMAC-SHA256 of
 *     `"{razorpay_order_id}|{razorpay_payment_id}"` with the **API key secret**.
 *   - **Webhook** (Razorpay calling us): HMAC-SHA256 of the **raw request body**
 *     with the **webhook secret**, which is a separate value set in the
 *     Razorpay dashboard and is not the API secret.
 *
 * ## Why the checkout signature is not enough on its own
 *
 * It proves the browser was handed a genuine payment id for a genuine order. It
 * does not prove the money settled - a client can simply never come back, and
 * on a flaky mobile connection frequently does not. The webhook is what
 * actually credits; the checkout verification exists so the advocate sees their
 * balance move immediately rather than waiting on Razorpay's delivery. Both
 * paths credit through the same idempotency key, so whichever arrives first
 * wins and the other is a no-op.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = getLogger().child({ module: 'payments:razorpay' });

  constructor(private readonly settings: SettingsService) {}

  /** Read per call, so a key pasted into the environment takes effect on redeploy. */
  private get keyId(): string {
    return this.settings.get('RAZORPAY_KEY_ID');
  }

  private get keySecret(): string {
    return this.settings.get('RAZORPAY_KEY_SECRET');
  }

  private get webhookSecret(): string {
    return this.settings.get('RAZORPAY_WEBHOOK_SECRET');
  }

  get isConfigured(): boolean {
    return this.settings.razorpayConfigured;
  }

  /** The publishable half. Safe in browser code; the secret never leaves here. */
  get publicKeyId(): string {
    return this.keyId;
  }

  /**
   * Create an order at the gateway.
   *
   * `receipt` is ours and is generated before this is called, so a request that
   * times out mid-flight can be retried without risking a second order - see
   * the column comment in migration 0010.
   */
  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder> {
    if (!this.isConfigured) throw new GatewayNotConfiguredError();

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
        // Capture automatically. The alternative is authorise-then-capture,
        // which buys nothing here - there is no fulfilment step between paying
        // and receiving credits that could fail and warrant holding the money.
        payment_capture: 1,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      id?: string;
      amount?: number;
      currency?: string;
      receipt?: string;
      status?: string;
      error?: { description?: string; code?: string };
    };

    if (!response.ok || !payload.id) {
      const detail = payload.error?.description ?? `HTTP ${response.status}`;
      this.logger.error(
        { status: response.status, receipt: input.receipt, detail, code: payload.error?.code },
        'Razorpay order creation failed',
      );
      throw new Error(`Could not create the payment order: ${detail}`);
    }

    return {
      id: payload.id,
      amount: payload.amount ?? input.amountPaise,
      currency: payload.currency ?? input.currency,
      receipt: payload.receipt ?? input.receipt,
      status: payload.status ?? 'created',
    };
  }

  /**
   * Verify what the browser handed back after checkout.
   *
   * Signed with the **API key secret** over `orderId|paymentId`. See the class
   * comment on why this is not the same as the webhook signature.
   */
  verifyCheckout(input: { orderId: string; paymentId: string; signature: string }): boolean {
    if (!this.keySecret) return false;
    if (!input.orderId || !input.paymentId || !input.signature) return false;

    const expected = createHmac('sha256', this.keySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest('hex');

    return safeEqualHex(input.signature, expected);
  }

  /**
   * Verify a webhook delivery.
   *
   * Signed with the **webhook secret** over the raw bytes. Re-serialising the
   * parsed body produces different bytes and never matches - the same trap as
   * Meta's signature, and the reason main.ts keeps the raw buffer.
   *
   * Refuses outright when no webhook secret is set. Unlike the WhatsApp
   * verifier, there is no development-mode pass: an unsigned request accepted
   * here grants credits, so "no secret configured" has to mean "no webhook",
   * not "trust everything".
   */
  verifyWebhook(rawBody: Buffer | string | undefined, header: string | undefined): boolean {
    const secret = this.webhookSecret;

    if (!secret) {
      this.logger.error('No Razorpay webhook secret configured; rejecting the delivery');
      return false;
    }
    if (!rawBody || !header) return false;

    const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const expected = createHmac('sha256', secret).update(body).digest('hex');

    return safeEqualHex(header, expected);
  }
}

/**
 * Constant-time hex comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which on a
 * malformed header would be an unhandled exception on a public endpoint - so
 * the length is checked first and reported as a plain mismatch.
 */
function safeEqualHex(received: string, expected: string): boolean {
  const a = Buffer.from(received.trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

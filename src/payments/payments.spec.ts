import { createHmac } from 'node:crypto';
import { splitTax } from './payments.service';
import { RazorpayService } from './razorpay.service';

/**
 * The parts of a payment flow where a silent bug costs somebody real money.
 *
 * Two signatures, two secrets, two payloads - and both produce a digest either
 * way, so confusing them does not throw. It fails as *every payment rejected*,
 * or, far worse in the other direction, as every forged delivery accepted.
 */

const KEY_SECRET = 'rzp_secret_value';
const WEBHOOK_SECRET = 'a_different_webhook_secret';

function build(over: { keySecret?: string; webhookSecret?: string } = {}) {
  const settings = {
    get: (key: string) => {
      if (key === 'RAZORPAY_KEY_ID') return 'rzp_test_key';
      if (key === 'RAZORPAY_KEY_SECRET') return over.keySecret ?? KEY_SECRET;
      if (key === 'RAZORPAY_WEBHOOK_SECRET') return over.webhookSecret ?? WEBHOOK_SECRET;
      return '';
    },
    razorpayConfigured: true,
    gstRateBps: 1800,
  };

  return new RazorpayService(settings as never);
}

describe('checkout signature', () => {
  const orderId = 'order_ABC123';
  const paymentId = 'pay_XYZ789';

  /** What Razorpay's checkout hands back: HMAC of "order|payment" with the API secret. */
  const genuine = createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  it('accepts a genuine result', () => {
    expect(build().verifyCheckout({ orderId, paymentId, signature: genuine })).toBe(true);
  });

  it('rejects a signature for a different payment', () => {
    // The exact replay this defends against: a real signature from one payment
    // presented against another order.
    expect(
      build().verifyCheckout({ orderId, paymentId: 'pay_SOMEONE_ELSE', signature: genuine }),
    ).toBe(false);
  });

  it('rejects one signed with the webhook secret', () => {
    // The two secrets are different values for different purposes, and using
    // the wrong one produces a perfectly well-formed digest that must not pass.
    const wrongSecret = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    expect(build().verifyCheckout({ orderId, paymentId, signature: wrongSecret })).toBe(false);
  });

  it.each([['', 'empty'], ['deadbeef', 'short'], ['z'.repeat(64), 'non-hex']])(
    'rejects a %s signature without throwing',
    (signature) => {
      // timingSafeEqual throws on a length mismatch, which on a public endpoint
      // would be a 500 rather than a refusal.
      expect(() => build().verifyCheckout({ orderId, paymentId, signature })).not.toThrow();
      expect(build().verifyCheckout({ orderId, paymentId, signature })).toBe(false);
    },
  );

  it('refuses everything when no API secret is set', () => {
    expect(
      build({ keySecret: '' }).verifyCheckout({ orderId, paymentId, signature: genuine }),
    ).toBe(false);
  });
});

describe('webhook signature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} }));
  const genuine = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

  it('accepts a genuine delivery', () => {
    expect(build().verifyWebhook(body, genuine)).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const tampered = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { x: 1 } }));
    expect(build().verifyWebhook(tampered, genuine)).toBe(false);
  });

  it('rejects one signed with the API secret', () => {
    const wrongSecret = createHmac('sha256', KEY_SECRET).update(body).digest('hex');
    expect(build().verifyWebhook(body, wrongSecret)).toBe(false);
  });

  it('refuses every delivery when no webhook secret is configured', () => {
    // Deliberately unlike the WhatsApp verifier, which passes in development.
    // An unsigned request accepted here grants credits, so "no secret" has to
    // mean "no webhook" rather than "trust everything".
    expect(build({ webhookSecret: '' }).verifyWebhook(body, genuine)).toBe(false);
  });

  it('rejects a delivery with no signature header at all', () => {
    expect(build().verifyWebhook(body, undefined)).toBe(false);
  });
});

describe('GST split', () => {
  it('takes the tax out of the quoted price rather than adding it on top', () => {
    // The advocate is quoted ₹499 and pays ₹499. Adding 18% at checkout is the
    // complaint this avoids.
    const { basePaise, taxPaise } = splitTax(49900, 1800);
    expect(basePaise + taxPaise).toBe(49900);
    expect(basePaise).toBe(42288);
  });

  it.each([1, 99, 49900, 129900, 399900, 1_000_001])(
    'always adds back to the gross, for %d paise',
    (gross) => {
      // credit_orders enforces base + tax = amount. A split that rounds each
      // half independently is a paisa out often enough to reject real orders.
      const { basePaise, taxPaise } = splitTax(gross, 1800);
      expect(basePaise + taxPaise).toBe(gross);
      expect(taxPaise).toBeGreaterThanOrEqual(0);
    },
  );

  it('leaves the whole amount as base when no tax applies', () => {
    expect(splitTax(49900, 0)).toEqual({ basePaise: 49900, taxPaise: 0 });
  });
});

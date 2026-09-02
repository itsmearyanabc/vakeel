import { CreditPlanRow, CreditOrderRow, UserRow } from '../database/types';
import { PaymentsService, UnknownPackError } from './payments.service';
import { GatewayNotConfiguredError } from './razorpay.service';

/**
 * The orchestration, where the money actually moves.
 *
 * The signature tests next door prove we can tell a genuine payment from a
 * forged one. These prove what happens afterwards - and every case here is one
 * that costs somebody real money when it is wrong: crediting twice, crediting
 * the wrong account, charging a price the client chose, or marking an order
 * settled that never produced credits.
 */

function plan(over: Partial<CreditPlanRow> = {}): CreditPlanRow {
  return {
    id: 'plan-1',
    code: 'practice',
    name: 'Practice',
    description: '300 questions.',
    credits: 300,
    base_paise: 211864,
    tax_rate_bps: 1800,
    tax_paise: 38136,
    price_paise: 250000,
    currency: 'INR',
    badge: 'Most popular',
    sort_order: 20,
    is_active: true,
    archived_at: null,
    billing_period: 'MONTHLY',
    razorpay_plan_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...(over as object),
  } as CreditPlanRow;
}

function order(over: Partial<CreditOrderRow> = {}): CreditOrderRow {
  return {
    id: 'order-1',
    user_id: 'user-1',
    receipt: 'vs_abc_123',
    credits: 300,
    pack_code: 'practice',
    amount_paise: 250000,
    base_paise: 211864,
    tax_paise: 38136,
    tax_rate_bps: 1800,
    currency: 'INR',
    status: 'ATTEMPTED',
    razorpay_order_id: 'order_RZP1',
    razorpay_payment_id: null,
    razorpay_signature: null,
    payment_method: null,
    failure_reason: null,
    credited_at: null,
    refunded_at: null,
    notes: {},
    plan_id: 'plan-1',
    created_at: new Date(),
    updated_at: new Date(),
    ...(over as object),
  } as CreditOrderRow;
}

const USER = { id: 'user-1', role: 'GUEST_LAWYER' } as UserRow;

function build(
  over: {
    found?: CreditPlanRow | null;
    existingOrder?: CreditOrderRow | null;
    checkoutValid?: boolean;
    configured?: boolean;
    freshEvent?: boolean;
  } = {},
) {
  const plans = {
    listActive: jest.fn().mockResolvedValue([plan()]),
    findByCode: jest.fn().mockResolvedValue(over.found === undefined ? plan() : over.found),
  };

  const orders = {
    createOrder: jest.fn().mockResolvedValue(order({ razorpay_order_id: null })),
    attachGatewayOrder: jest.fn().mockResolvedValue(undefined),
    findOrderByRazorpayId: jest
      .fn()
      .mockResolvedValue(over.existingOrder === undefined ? order() : over.existingOrder),
    markOrderPaid: jest.fn().mockResolvedValue(order({ status: 'PAID' })),
    markOrderCredited: jest.fn().mockResolvedValue(undefined),
    markOrderFailed: jest.fn().mockResolvedValue(undefined),
    claimPaymentEvent: jest.fn().mockResolvedValue(over.freshEvent !== false),
    settlePaymentEvent: jest.fn().mockResolvedValue(undefined),
  };

  const credits = {
    grantPurchase: jest.fn().mockResolvedValue({ applied: true, free: 0, paid: 300 }),
  };

  const razorpay = {
    isConfigured: over.configured !== false,
    publicKeyId: 'rzp_test_key',
    createOrder: jest.fn().mockResolvedValue({
      id: 'order_RZP1',
      amount: 250000,
      currency: 'INR',
      receipt: 'vs_abc_123',
      status: 'created',
    }),
    verifyCheckout: jest.fn().mockReturnValue(over.checkoutValid !== false),
  };

  const settings = { gstRateBps: 1800 };

  const service = new PaymentsService(
    plans as never,
    orders as never,
    credits as never,
    razorpay as never,
    settings as never,
  );

  return { service, plans, orders, credits, razorpay };
}

describe('starting a checkout', () => {
  it('reads the price from the database, never from the caller', async () => {
    // A client that could name its own price would name zero. Only the plan
    // code crosses the wire.
    const { service, orders, razorpay } = build();

    const started = await service.startCheckout(USER, 'practice');

    expect(started.amountPaise).toBe(250000);
    expect(started.credits).toBe(300);
    expect(razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 250000 }),
    );
    expect(orders.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 300, amountPaise: 250000, planId: 'plan-1' }),
    );
  });

  it('writes our order before contacting the gateway', async () => {
    // The reverse order has one failure mode and it is the unrecoverable one:
    // money taken against an order we have no record of.
    const { service, orders, razorpay } = build();

    await service.startCheckout(USER, 'practice');

    expect(orders.createOrder.mock.invocationCallOrder[0]).toBeLessThan(
      razorpay.createOrder.mock.invocationCallOrder[0],
    );
  });

  it('splits the tax so it always adds back to the price', async () => {
    // credit_orders enforces base + tax = amount; a split that rounds each half
    // independently rejects real orders.
    const { service, orders } = build();

    await service.startCheckout(USER, 'practice');

    const written = orders.createOrder.mock.calls[0][0];
    expect(written.basePaise + written.taxPaise).toBe(written.amountPaise);
    expect(written.taxRateBps).toBe(1800);
  });

  it('never leaks the API secret to the browser', async () => {
    const { service } = build();
    const started = await service.startCheckout(USER, 'practice');

    expect(started.keyId).toBe('rzp_test_key');
    expect(JSON.stringify(started)).not.toContain('secret');
  });

  it.each([
    ['an unknown code', null],
    ['a paused plan', plan({ is_active: false })],
    ['an archived plan', plan({ archived_at: new Date() })],
  ])('refuses %s rather than charging for it', async (_label, found) => {
    const { service, orders } = build({ found });

    await expect(service.startCheckout(USER, 'practice')).rejects.toBeInstanceOf(UnknownPackError);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it('refuses when the gateway is not configured', async () => {
    const { service, orders } = build({ configured: false });

    await expect(service.startCheckout(USER, 'practice')).rejects.toBeInstanceOf(
      GatewayNotConfiguredError,
    );
    expect(orders.createOrder).not.toHaveBeenCalled();
  });
});

describe('confirming a checkout', () => {
  const result = {
    gatewayOrderId: 'order_RZP1',
    paymentId: 'pay_XYZ',
    signature: 'sig',
  };

  it('credits the account on a verified result', async () => {
    const { service, credits, orders } = build();

    const outcome = await service.confirmCheckout(USER, result);

    expect(outcome).toEqual({ credited: true, credits: 300 });
    expect(credits.grantPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', amount: 300, paymentId: 'pay_XYZ' }),
    );
    expect(orders.markOrderCredited).toHaveBeenCalledWith('order-1');
  });

  it('keys the grant on the payment id, so the webhook cannot credit twice', async () => {
    const { service, credits } = build();

    await service.confirmCheckout(USER, result);

    // Both paths use this key; the second collides on the ledger's unique index.
    expect(credits.grantPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay_XYZ' }),
    );
  });

  it('credits nothing when the signature does not verify', async () => {
    const { service, credits, orders } = build({ checkoutValid: false });

    await expect(service.confirmCheckout(USER, result)).rejects.toThrow(/could not be verified/i);
    expect(credits.grantPurchase).not.toHaveBeenCalled();
    expect(orders.markOrderPaid).not.toHaveBeenCalled();
  });

  it('refuses a genuine result replayed against another account', async () => {
    // The signature is real; the order belongs to somebody else. Without this
    // check a signed result is a transferable claim on anyone's order.
    const { service, credits } = build({ existingOrder: order({ user_id: 'someone-else' }) });

    await expect(service.confirmCheckout(USER, result)).rejects.toThrow(/could not be matched/i);
    expect(credits.grantPurchase).not.toHaveBeenCalled();
  });

  it('refuses when no order matches the gateway id', async () => {
    const { service, credits } = build({ existingOrder: null });

    await expect(service.confirmCheckout(USER, result)).rejects.toThrow(/could not be matched/i);
    expect(credits.grantPurchase).not.toHaveBeenCalled();
  });
});

describe('handling a webhook', () => {
  const captured = {
    eventId: 'evt_1',
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_XYZ', order_id: 'order_RZP1', method: 'upi' } } },
  };

  it('credits a captured payment', async () => {
    const { service, credits, orders } = build();

    const outcome = await service.handleWebhookEvent(captured);

    expect(outcome.handled).toBe(true);
    expect(credits.grantPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 300, paymentId: 'pay_XYZ' }),
    );
    expect(orders.settlePaymentEvent).toHaveBeenCalledWith('evt_1', true);
  });

  it('ignores a redelivery without crediting again', async () => {
    // Razorpay retries until it gets a 2xx, so the same capture arriving three
    // times is normal operation and crediting three times is not.
    const { service, credits } = build({ freshEvent: false });

    const outcome = await service.handleWebhookEvent(captured);

    expect(outcome.handled).toBe(false);
    expect(credits.grantPurchase).not.toHaveBeenCalled();
  });

  it('claims the event before acting on it', async () => {
    const { service, orders, credits } = build();

    await service.handleWebhookEvent(captured);

    expect(orders.claimPaymentEvent.mock.invocationCallOrder[0]).toBeLessThan(
      credits.grantPurchase.mock.invocationCallOrder[0],
    );
  });

  it('marks a failed payment without crediting', async () => {
    const { service, credits, orders } = build();

    const outcome = await service.handleWebhookEvent({
      eventId: 'evt_2',
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_F', order_id: 'order_RZP1', error_description: 'Card declined' },
        },
      },
    });

    expect(outcome.handled).toBe(true);
    expect(orders.markOrderFailed).toHaveBeenCalledWith('order_RZP1', 'Card declined');
    expect(credits.grantPurchase).not.toHaveBeenCalled();
  });

  it('records an event it does not act on rather than dropping it', async () => {
    // Verified, real, and not ours to handle. The audit trail should still show
    // the delivery arrived.
    const { service, orders, credits } = build();

    const outcome = await service.handleWebhookEvent({
      eventId: 'evt_3',
      event: 'refund.created',
      payload: { payment: { entity: { id: 'pay_R', order_id: 'order_RZP1' } } },
    });

    expect(outcome.handled).toBe(false);
    expect(credits.grantPurchase).not.toHaveBeenCalled();
    expect(orders.settlePaymentEvent).toHaveBeenCalledWith('evt_3', false);
  });

  it('does not credit a capture with no matching order', async () => {
    const { service, credits, orders } = build({ existingOrder: null });

    const outcome = await service.handleWebhookEvent(captured);

    expect(outcome.handled).toBe(false);
    expect(credits.grantPurchase).not.toHaveBeenCalled();
    expect(orders.settlePaymentEvent).toHaveBeenCalledWith(
      'evt_1',
      false,
      expect.stringContaining('No matching order'),
    );
  });

  it('records the failure against the event when crediting throws', async () => {
    // The event is already claimed, so it will not be retried into a second
    // attempt. What is left is a row the uncredited report can be paired with.
    const { service, orders, credits } = build();
    credits.grantPurchase.mockRejectedValue(new Error('ledger unavailable'));

    await expect(service.handleWebhookEvent(captured)).rejects.toThrow('ledger unavailable');
    expect(orders.settlePaymentEvent).toHaveBeenCalledWith(
      'evt_1',
      false,
      'ledger unavailable',
    );
  });

  it('stamps credited_at only after the ledger row exists', async () => {
    // Setting it alongside PAID would make the "paid but not credited" report
    // structurally incapable of ever returning a row.
    const { service, orders, credits } = build();

    await service.handleWebhookEvent(captured);

    expect(credits.grantPurchase.mock.invocationCallOrder[0]).toBeLessThan(
      orders.markOrderCredited.mock.invocationCallOrder[0],
    );
  });
});

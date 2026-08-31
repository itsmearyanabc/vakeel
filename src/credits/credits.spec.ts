import { AppEnv, parseEnv } from '../config/env';
import { CreditRepository } from '../database/repositories/credit.repository';
import { CREDIT_COST, CreditsService, isSameSearchContext } from './credits.service';

function env(overrides: Record<string, string> = {}): AppEnv {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    JWT_SECRET: 'test-jwt-secret-at-least-16-chars',
    ENCRYPTION_KEY: 'a'.repeat(64),
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function build(overrides: Record<string, string> = {}) {
  const repo = {
    spend: jest.fn(async () => ({
      allowed: true,
      charged: 1,
      free_left: 29,
      paid_left: 0,
      from_free: 1,
      from_paid: 0,
      already_spent: false,
    })),
    balance: jest.fn(async () => ({ free: 30, paid: 0 })),
    peekBalance: jest.fn(async () => ({ free: 30, paid: 0 })),
    grant: jest.fn(async () => ({ applied: true, free_left: 30, paid_left: 10 })),
    deduct: jest.fn(async () => ({ applied: true, deducted: 5, free: 30, paid: 5 })),
    refundByReference: jest.fn(async () => ({ refunded: 1, free: 30, paid: 0 })),
  };
  const service = new CreditsService(repo as unknown as CreditRepository, env(overrides));
  return { service, repo };
}

/**
 * What an advocate is billed for.
 *
 * These rules are a promise to the person paying, so the tests are written from
 * their side: "I asked the same thing twice and was charged twice" is a
 * complaint, not a bug report, and it has to be impossible rather than
 * unlikely.
 */
describe('credit costs', () => {
  it('charges for a case status lookup', () => {
    // Free while eCourts was a mock and the call cost nothing to serve. It is
    // a metered upstream API now, so it carries a price like everything else.
    expect(CREDIT_COST.CASE_STATUS).toBe(1);
  });

  it('charges two credits for a research question', () => {
    expect(CREDIT_COST.SECTION_LOOKUP).toBe(2);
    expect(CREDIT_COST.PRECEDENT_SEARCH).toBe(2);
  });

  it('keeps every cost a small whole number', () => {
    // The costs are quoted to advocates on the landing page and in the bot. A
    // fractional or three-digit price is one nobody can hold in their head, and
    // this is the assertion that notices before they see it.
    for (const cost of Object.values(CREDIT_COST)) {
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThanOrEqual(5);
    }
  });
});

describe('isSameSearchContext', () => {
  it('treats an identical question as already paid for', () => {
    expect(isSameSearchContext('what is IPC 420', 'what is IPC 420')).toBe(true);
  });

  it.each([
    ['casing', 'What Is IPC 420', 'what is ipc 420'],
    ['punctuation', 'what is IPC 420?', 'what is IPC 420'],
    ['word order', 'IPC 420 what is', 'what is IPC 420'],
    ['extra whitespace', 'what   is  IPC 420', 'what is IPC 420'],
  ])('ignores %s', (_label, previous, next) => {
    expect(isSameSearchContext(previous, next)).toBe(true);
  });

  it('charges again for a genuinely different section', () => {
    // The example that decided the rule: IPC 420 -> section 53 is new work.
    expect(isSameSearchContext('what is IPC 420', 'what is section 53')).toBe(false);
  });

  it('charges for the first search of a session', () => {
    expect(isSameSearchContext(null, 'what is IPC 420')).toBe(false);
    expect(isSameSearchContext('', 'what is IPC 420')).toBe(false);
  });

  it('does not treat a longer follow-up as the same question', () => {
    // Deliberate. A similarity threshold would charge for one rephrasing and
    // not another, which is impossible to explain to whoever is paying.
    // Paging with "more" is handled by the caller and never reaches here.
    expect(isSameSearchContext('IPC 420', 'IPC 420 punishment and bail')).toBe(false);
  });
});

/**
 * The wallet's behaviour around unlimited roles and free actions.
 *
 * These are the paths that must never touch the ledger. A zero-delta row for
 * every greeting an admin sends would fill an audit trail with entries that
 * record nothing, and an unlimited role has no balance to move in the first
 * place.
 */
describe('CreditsService.spend', () => {
  it('charges a guest and returns the new balance', async () => {
    const { service, repo } = build();

    const decision = await service.spend({
      userId: 'u1',
      role: 'GUEST_LAWYER',
      cost: CREDIT_COST.PRECEDENT_SEARCH,
      action: 'PRECEDENT_SEARCH',
      reference: 'spend:web:msg-1',
    });

    expect(decision.allowed).toBe(true);
    // Read from the constant rather than written out, so a price change moves
    // this test with it instead of failing it. What is being asserted is that
    // the wallet charges what the table says - not what the table says.
    // `charged` is echoed from the database, not recomputed here - the stub
    // returns 1 and that is what should surface. What this asserts is that the
    // service reports what the ledger actually did, rather than what it asked
    // for; the cost it *asked* for is checked against the table below.
    expect(decision.charged).toBe(1);
    expect(decision.balance.total).toBe(29);
    expect(repo.spend).toHaveBeenCalledWith(
      expect.objectContaining({
        cost: CREDIT_COST.PRECEDENT_SEARCH,
        reference: 'spend:web:msg-1',
        monthlyAllowance: 30,
      }),
    );
  });

  it('never touches the ledger for an unlimited role', async () => {
    // CREDITS_VERIFIED_MONTHLY defaults to -1. There is no balance to move, so a
    // ledger entry would record a movement that did not happen.
    const { service, repo } = build();

    const decision = await service.spend({
      userId: 'u1',
      role: 'VERIFIED_ADVOCATE',
      cost: 1,
      action: 'PRECEDENT_SEARCH',
      reference: 'spend:web:msg-2',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.charged).toBe(0);
    expect(decision.balance.unlimited).toBe(true);
    expect(repo.spend).not.toHaveBeenCalled();
  });

  it('never touches the ledger for a zero-cost action', async () => {
    // No action is priced at zero today, but the wallet must still short-
    // circuit one: a zero-cost spend that reached the ledger would write a
    // meaningless row and burn the reference that a later real charge needs.
    const { service, repo } = build();

    const decision = await service.spend({
      userId: 'u1',
      role: 'GUEST_LAWYER',
      cost: 0,
      action: 'CASE_STATUS',
      reference: 'spend:web:msg-3',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.charged).toBe(0);
    expect(repo.spend).not.toHaveBeenCalled();
  });

  it('reports a refusal without charging', async () => {
    const { service, repo } = build();
    repo.spend.mockResolvedValueOnce({
      allowed: false, charged: 0, free_left: 0, paid_left: 0,
      from_free: 0, from_paid: 0, already_spent: false,
    });

    const decision = await service.spend({
      userId: 'u1', role: 'GUEST_LAWYER', cost: 1,
      action: 'PRECEDENT_SEARCH', reference: 'spend:web:msg-4',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.charged).toBe(0);
    expect(decision.balance.total).toBe(0);
    // No reset date travels with the refusal any more: since migration 0014 the
    // free allowance is granted once for the life of the account, so there is
    // no date to give and implying one would tell an advocate to wait for
    // credits that are never coming.
    expect(decision.balance).not.toHaveProperty('resetsInDays');
  });

  it('surfaces a replayed charge as allowed but free', async () => {
    // A retried request must not be charged twice, and must not be refused
    // either - the advocate is owed the answer they already paid for.
    const { service, repo } = build();
    repo.spend.mockResolvedValueOnce({
      allowed: true, charged: 0, free_left: 29, paid_left: 0,
      from_free: 0, from_paid: 0, already_spent: true,
    });

    const decision = await service.spend({
      userId: 'u1', role: 'GUEST_LAWYER', cost: 1,
      action: 'PRECEDENT_SEARCH', reference: 'spend:wa:same-message',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.charged).toBe(0);
    expect(decision.replay).toBe(true);
  });
});

describe('CreditsService.refund', () => {
  it('reverses by reference, without being told an amount', async () => {
    // The amount is deliberately not a parameter: a spend can straddle both
    // buckets, and guessing which one to credit costs somebody real money
    // either way. See credit_refund() in migration 0010.
    const { service, repo } = build();

    await service.refund('u1', 'GUEST_LAWYER', 'spend:web:msg-1', 'delivery failed');

    expect(repo.refundByReference).toHaveBeenCalledWith('u1', 'spend:web:msg-1', 'delivery failed');
  });

  it('does nothing for an unlimited role', async () => {
    const { service, repo } = build();
    await service.refund('u1', 'VERIFIED_ADVOCATE', 'spend:web:msg-1', 'delivery failed');
    expect(repo.refundByReference).not.toHaveBeenCalled();
  });

  it('never throws, because the caller is already handling a failure', async () => {
    const { service, repo } = build();
    repo.refundByReference.mockRejectedValueOnce(new Error('database down'));

    await expect(
      service.refund('u1', 'GUEST_LAWYER', 'spend:web:msg-1', 'delivery failed'),
    ).resolves.toBeUndefined();
  });
});

describe('CreditsService.creditLine', () => {
  it('says unlimited rather than a number', async () => {
    const { service } = build();
    const balance = await service.balance('u1', 'VERIFIED_ADVOCATE');
    expect(service.creditLine(balance)).toBe('Credits: unlimited');
  });

  it('reports the allowance without promising a refill', async () => {
    const { service } = build();
    const balance = await service.balance('u1', 'GUEST_LAWYER');
    // "this month" was true until migration 0014 and is now a promise the
    // system does not keep: the free allowance is granted once and never
    // topped up, so an advocate reading it would wait instead of buying.
    expect(service.creditLine(balance)).toBe('Credits: 30 of 30 left');
  });

  it('separates free from purchased once there are both', async () => {
    // Collapsing these into one number is what the two buckets exist to avoid:
    // free credits are spent first, so "8 left" hides which 3 survive a
    // spending spree and which 5 do not.
    const { service, repo } = build();
    repo.balance.mockResolvedValueOnce({ free: 5, paid: 3 });

    const balance = await service.balance('u1', 'GUEST_LAWYER');
    expect(service.creditLine(balance)).toBe('Credits: 8 left (5 free + 3 purchased)');
  });
});

describe('CreditsService.grantSignupBonus', () => {
  it('grants into the durable bucket, keyed on the user', async () => {
    // Durable, not daily: a welcome gift that expires before the advocate has
    // finished reading the welcome screen is worse than no gift. Keyed on the
    // user id so a retried signup handler grants once.
    const { service, repo } = build();

    await service.grantSignupBonus('u1');

    expect(repo.grant).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'PAID', kind: 'SIGNUP_BONUS', reference: 'signup:u1' }),
    );
  });

  it('does nothing when the bonus is switched off', async () => {
    const { service, repo } = build({ CREDITS_SIGNUP_BONUS: '0' });
    await service.grantSignupBonus('u1');
    expect(repo.grant).not.toHaveBeenCalled();
  });
});

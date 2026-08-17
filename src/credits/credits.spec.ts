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
      charged: 2,
      free_left: 3,
      paid_left: 0,
      from_free: 2,
      from_paid: 0,
      already_spent: false,
    })),
    balance: jest.fn(async () => ({ free: 5, paid: 0 })),
    peekBalance: jest.fn(async () => ({ free: 5, paid: 0 })),
    grant: jest.fn(async () => ({ applied: true, free_left: 5, paid_left: 10 })),
    refundByReference: jest.fn(async () => ({ refunded: 2, free: 5, paid: 0 })),
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
  it('never charges for a case status lookup', () => {
    // A court-record lookup with no model call behind it, done standing
    // outside a courtroom. Charging for it would ration the cheapest feature.
    expect(CREDIT_COST.CASE_STATUS).toBe(0);
  });

  it('charges two for research', () => {
    expect(CREDIT_COST.SECTION_LOOKUP).toBe(2);
    expect(CREDIT_COST.PRECEDENT_SEARCH).toBe(2);
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
    expect(decision.charged).toBe(2);
    expect(decision.balance.total).toBe(3);
    expect(repo.spend).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 2, reference: 'spend:web:msg-1', dailyAllowance: 5 }),
    );
  });

  it('never touches the ledger for an unlimited role', async () => {
    // QUOTA_VERIFIED_DAILY defaults to -1. There is no balance to move, so a
    // ledger entry would record a movement that did not happen.
    const { service, repo } = build();

    const decision = await service.spend({
      userId: 'u1',
      role: 'VERIFIED_ADVOCATE',
      cost: 2,
      action: 'PRECEDENT_SEARCH',
      reference: 'spend:web:msg-2',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.charged).toBe(0);
    expect(decision.balance.unlimited).toBe(true);
    expect(repo.spend).not.toHaveBeenCalled();
  });

  it('never touches the ledger for a free action', async () => {
    // Case status costs nothing - see CREDIT_COST for why.
    const { service, repo } = build();

    const decision = await service.spend({
      userId: 'u1',
      role: 'GUEST_LAWYER',
      cost: CREDIT_COST.CASE_STATUS,
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
      allowed: false, charged: 0, free_left: 1, paid_left: 0,
      from_free: 0, from_paid: 0, already_spent: false,
    });

    const decision = await service.spend({
      userId: 'u1', role: 'GUEST_LAWYER', cost: 2,
      action: 'PRECEDENT_SEARCH', reference: 'spend:web:msg-4',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.charged).toBe(0);
    // The remaining credit is reported, because "you have 1 and this costs 2"
    // is the message, not "you are out".
    expect(decision.balance.total).toBe(1);
  });

  it('surfaces a replayed charge as allowed but free', async () => {
    // A retried request must not be charged twice, and must not be refused
    // either - the advocate is owed the answer they already paid for.
    const { service, repo } = build();
    repo.spend.mockResolvedValueOnce({
      allowed: true, charged: 0, free_left: 3, paid_left: 0,
      from_free: 0, from_paid: 0, already_spent: true,
    });

    const decision = await service.spend({
      userId: 'u1', role: 'GUEST_LAWYER', cost: 2,
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

  it('reports the daily allowance when nothing has been purchased', async () => {
    const { service } = build();
    const balance = await service.balance('u1', 'GUEST_LAWYER');
    expect(service.creditLine(balance)).toBe('Credits: 5 of 5 left today');
  });

  it('separates free from purchased once there are both', async () => {
    // Collapsing these into one number is what the two buckets exist to avoid:
    // "8 left" hides that 5 of them vanish at midnight and 3 do not.
    const { service, repo } = build();
    repo.balance.mockResolvedValueOnce({ free: 5, paid: 3 });

    const balance = await service.balance('u1', 'GUEST_LAWYER');
    expect(service.creditLine(balance)).toBe('Credits: 8 left (5 free today + 3 purchased)');
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

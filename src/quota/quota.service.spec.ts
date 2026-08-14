import { AppEnv, parseEnv } from '../config/env';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { RedisService } from '../redis/redis.service';
import { QuotaService } from './quota.service';

/**
 * Refunds, mostly.
 *
 * Quota has to be claimed *before* the model runs - that is the only moment it
 * can stop the spend - which means every claim is a promise to deliver an
 * answer. WhatsApp can refuse the send afterwards (error 131030 is the common
 * one), and a guest with five queries a day should not lose one to a message
 * they never received.
 */

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
  const redis = { refundQuota: jest.fn(async () => 0), claimQuota: jest.fn(async () => ({ allowed: true, used: 1 })) };
  const analytics = { refundQuota: jest.fn(async () => undefined), claimQuota: jest.fn() };
  const service = new QuotaService(
    redis as unknown as RedisService,
    analytics as unknown as AnalyticsRepository,
    env(overrides),
  );
  return { service, redis, analytics };
}

describe('QuotaService.refund', () => {
  it('gives the credits back in both stores', async () => {
    const { service, redis, analytics } = build();

    await service.refund('user-1', 'GUEST_LAWYER', 2);

    expect(redis.refundQuota).toHaveBeenCalledWith('user-1', 2);
    expect(analytics.refundQuota).toHaveBeenCalledWith('user-1');
  });

  it('does nothing for a free action', async () => {
    // Case status costs nothing, so a failed delivery has nothing to return.
    const { service, redis, analytics } = build();

    await service.refund('user-1', 'GUEST_LAWYER', 0);

    expect(redis.refundQuota).not.toHaveBeenCalled();
    expect(analytics.refundQuota).not.toHaveBeenCalled();
  });

  it('does nothing for roles with no limit', async () => {
    // QUOTA_VERIFIED_DAILY defaults to -1. There was never a unit to return,
    // and decrementing would push the usage ledger below the real figure.
    const { service, redis, analytics } = build();

    await service.refund('user-1', 'VERIFIED_ADVOCATE');

    expect(redis.refundQuota).not.toHaveBeenCalled();
    expect(analytics.refundQuota).not.toHaveBeenCalled();
  });

  it('still refunds the database when Redis is down', async () => {
    const { service, redis, analytics } = build();
    redis.refundQuota.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.refund('user-1', 'GUEST_LAWYER')).resolves.toBeUndefined();
    expect(analytics.refundQuota).toHaveBeenCalledWith('user-1');
  });

  it('never throws, because the caller is already handling a delivery failure', async () => {
    const { service, redis, analytics } = build();
    redis.refundQuota.mockRejectedValueOnce(new Error('redis down'));
    analytics.refundQuota.mockRejectedValueOnce(new Error('database down'));

    await expect(service.refund('user-1', 'GUEST_LAWYER')).resolves.toBeUndefined();
  });
});

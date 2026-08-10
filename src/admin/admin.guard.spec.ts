import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AppEnv, parseEnv } from '../config/env';
import { CryptoService } from '../security/crypto.service';
import { AdminGuard } from './admin.guard';
import { signJwt } from './jwt';

/**
 * Who AdminGuard lets in.
 *
 * The interesting cases are all about the *service token*, because which string
 * that is now depends on configuration - see `adminServiceToken` in env.ts. A
 * mistake here is not a broken feature, it is an unauthenticated SUPER_ADMIN.
 */

const JWT_SECRET = 'test-jwt-secret-at-least-16-chars';

function env(overrides: Record<string, string> = {}): AppEnv {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    JWT_SECRET,
    ENCRYPTION_KEY: 'a'.repeat(64),
    ...overrides,
  } as NodeJS.ProcessEnv);
}

const EMAIL_LOGIN = { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'a-long-enough-password' };

function contextFor(authorization?: string): { context: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = { headers: authorization ? { authorization } : {} };
  return {
    request,
    context: { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext,
  };
}

function guardFor(appEnv: AppEnv): AdminGuard {
  return new AdminGuard(appEnv, new CryptoService(appEnv));
}

describe('AdminGuard', () => {
  describe('session tokens', () => {
    it('accepts a JWT signed with JWT_SECRET', () => {
      const token = signJwt({ sub: 'admin@example.com', role: 'SUPER_ADMIN' }, JWT_SECRET, 3600);
      const { context, request } = contextFor(`Bearer ${token}`);

      expect(guardFor(env(EMAIL_LOGIN)).canActivate(context)).toBe(true);
      expect(request.admin).toEqual({ email: 'admin@example.com', role: 'SUPER_ADMIN', via: 'session' });
    });

    it('rejects an expired JWT', () => {
      const token = signJwt({ sub: 'admin@example.com', role: 'SUPER_ADMIN' }, JWT_SECRET, -1);
      const { context } = contextFor(`Bearer ${token}`);

      expect(() => guardFor(env(EMAIL_LOGIN)).canActivate(context)).toThrow(UnauthorizedException);
    });
  });

  describe('service token', () => {
    it('accepts ADMIN_SERVICE_TOKEN when one is set', () => {
      const serviceToken = 'service-token-of-sufficient-length';
      const { context, request } = contextFor(`Bearer ${serviceToken}`);

      expect(guardFor(env({ ...EMAIL_LOGIN, ADMIN_SERVICE_TOKEN: serviceToken })).canActivate(context)).toBe(true);
      expect(request.admin).toMatchObject({ via: 'service' });
    });

    it('falls back to JWT_SECRET while email login is unconfigured', () => {
      // A fresh deployment has no ADMIN_EMAIL yet. Refusing here would leave no
      // way to reach the panel at all.
      const { context } = contextFor(`Bearer ${JWT_SECRET}`);

      expect(guardFor(env()).canActivate(context)).toBe(true);
    });

    it('stops accepting JWT_SECRET once email login is configured', () => {
      // The whole point of the split: the signing key must not double as a
      // credential, because holding it means being able to mint sessions.
      const { context } = contextFor(`Bearer ${JWT_SECRET}`);

      expect(() => guardFor(env(EMAIL_LOGIN)).canActivate(context)).toThrow(UnauthorizedException);
    });

    it('rejects an empty bearer when no service token is configured', () => {
      // safeEqual('', '') is true, so an unguarded comparison against an empty
      // adminServiceToken would authenticate `Authorization: Bearer ` as admin.
      const { context } = contextFor('Bearer ');

      expect(() => guardFor(env(EMAIL_LOGIN)).canActivate(context)).toThrow(UnauthorizedException);
    });
  });

  describe('malformed credentials', () => {
    it.each([
      ['no header', undefined],
      ['not a bearer scheme', 'Basic abc123'],
      ['a wrong token', 'Bearer nonsense'],
      ['an alg:none forgery', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIiwiZXhwIjo5OTk5OTk5OTk5fQ.'],
    ])('rejects %s', (_label, header) => {
      const { context } = contextFor(header);
      expect(() => guardFor(env(EMAIL_LOGIN)).canActivate(context)).toThrow(UnauthorizedException);
    });
  });
});

import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getLogger } from '../common/logger';
import { RateLimiter } from '../common/rate-limiter';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CryptoService } from '../security/crypto.service';
import { parseDuration, signJwt } from './jwt';

/** Failed attempts from one IP before it is locked out. */
const MAX_ATTEMPTS = 8;
/**
 * Failed attempts against the account itself, across every IP.
 *
 * The per-IP counter alone is the wrong shape for both threats it faces. An
 * attacker with a pool of addresses gets 8 guesses per address and is never
 * slowed; a legitimate admin behind a corporate NAT shares one address with
 * everyone else in the building. This counter is what actually rate-limits
 * guessing, so it is deliberately more generous than the IP one - it can be
 * tripped by strangers, and must not become a way to lock the real admin out
 * cheaply.
 */
const MAX_ACCOUNT_ATTEMPTS = 25;
/** How long the lockout lasts. */
const LOCKOUT_SECONDS = 900;

/**
 * In-process since migration 0013.
 *
 * These counters were in Redis and deliberately failed open when it was
 * unreachable, so that a datastore outage could never lock the operator out of
 * the panel they needed to diagnose it. A plain map cannot be unreachable, so
 * that whole failure mode is gone rather than handled.
 */
const failures = new RateLimiter(LOCKOUT_SECONDS);

interface LoginBody {
  email?: string;
  password?: string;
}

/**
 * Admin sign-in.
 *
 * Deliberately NOT behind AdminGuard - this is the endpoint that mints the
 * credential the guard checks for.
 *
 * ## Credentials live in the environment, not the database
 *
 * `ADMIN_EMAIL` / `ADMIN_PASSWORD` are read from the environment (Render service
 * variables). They are intentionally *not* in the `app_settings` table, for the
 * same reason DATABASE_URL is not: an operator who locks themselves out by
 * saving a bad value would have no way back in through the very form they broke.
 * Environment variables can always be fixed from the hosting dashboard.
 *
 * ## Why the responses are deliberately vague
 *
 * A wrong email and a wrong password return the identical message. Distinguishing
 * them turns the form into an account-enumeration oracle - an attacker learns
 * which address is the admin one, which is half the credential.
 */
@Controller('admin')
export class AdminAuthController {
  private readonly logger = getLogger().child({ module: 'admin:auth' });

  constructor(
    @InjectEnv() private readonly env: AppEnv,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Tells the login page which mode it is in, so it can render the right form.
   * Returns no secrets - only whether email/password sign-in is available.
   */
  @Post('auth/mode')
  @HttpCode(HttpStatus.OK)
  mode() {
    return {
      emailLogin: this.env.adminLoginConfigured,
      // When false the page falls back to asking for the raw service token.
      hint: this.env.adminLoginConfigured
        ? 'Sign in with your admin email and password.'
        : 'ADMIN_EMAIL and ADMIN_PASSWORD are not set on this service, so the panel is still using token sign-in. Set both and redeploy to enable the login form.',
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginBody, @Req() req: FastifyRequest) {
    if (!this.env.adminLoginConfigured) {
      throw new UnauthorizedException({
        code: 'LOGIN_NOT_CONFIGURED',
        message: 'Email sign-in is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD on the service.',
      });
    }

    const ip = req.ip || 'unknown';
    const ipKey = `admin:login:fail:${ip}`;
    const accountKey = 'admin:login:fail:account';

    if (
      failures.count(ipKey) >= MAX_ATTEMPTS ||
      failures.count(accountKey) >= MAX_ACCOUNT_ATTEMPTS
    ) {
      this.logger.warn({ ip }, 'Admin login locked out after repeated failures');
      // Nest has no TooManyRequestsException, so 429 is raised directly.
      throw new HttpException(
        { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed sign-in attempts. Try again in 15 minutes.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const email = (body?.email ?? '').trim().toLowerCase();
    const password = body?.password ?? '';

    // Both compared in constant time, and both compared even when the first
    // fails, so response timing does not reveal which one was wrong.
    const emailOk = this.crypto.safeEqual(email, this.env.ADMIN_EMAIL);
    const passwordOk = this.crypto.safeEqual(password, this.env.ADMIN_PASSWORD);

    if (!emailOk || !passwordOk) {
      const count = failures.record(ipKey);
      failures.record(accountKey);

      this.logger.warn({ ip, attempt: count }, 'Failed admin login');
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Incorrect email or password.',
      });
    }

    failures.clear(ipKey, accountKey);

    const expiresIn = parseDuration(this.env.JWT_EXPIRES_IN);
    const token = signJwt({ sub: email, role: 'SUPER_ADMIN' }, this.env.JWT_SECRET, expiresIn);

    this.logger.info({ ip, email }, 'Admin signed in');

    return { token, expiresIn, email };
  }

}

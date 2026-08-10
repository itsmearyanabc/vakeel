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
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { RedisService } from '../redis/redis.service';
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
    private readonly redis: RedisService,
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
      (await this.failureCount(ipKey)) >= MAX_ATTEMPTS ||
      (await this.failureCount(accountKey)) >= MAX_ACCOUNT_ATTEMPTS
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
      const count = await this.recordFailure(ipKey);
      await this.recordFailure(accountKey);

      this.logger.warn({ ip, attempt: count }, 'Failed admin login');
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Incorrect email or password.',
      });
    }

    await this.clearFailures(ipKey, accountKey);

    const expiresIn = parseDuration(this.env.JWT_EXPIRES_IN);
    const token = signJwt({ sub: email, role: 'SUPER_ADMIN' }, this.env.JWT_SECRET, expiresIn);

    this.logger.info({ ip, email }, 'Admin signed in');

    return { token, expiresIn, email };
  }

  /**
   * Read a failure counter, treating an unreachable Redis as zero.
   *
   * ## Why this fails open
   *
   * The credentials live in the environment precisely so that a broken
   * datastore can never lock the operator out - that is the reasoning in the
   * class comment above. Letting the *brute-force counter* throw put the
   * dependency straight back: with Redis down this endpoint returned 500 before
   * it ever compared a password, so the panel was unreachable exactly when
   * someone most needed it to diagnose the outage.
   *
   * The cost is that brute-force protection is absent while Redis is down. That
   * is the better failure: the password is still required and still compared in
   * constant time, the window is as long as an outage, and the alternative
   * trades a rate limit for a guaranteed lockout.
   */
  private async failureCount(key: string): Promise<number> {
    try {
      return Number((await this.redis.client.get(key)) ?? 0);
    } catch (err) {
      this.logger.error({ err, key }, 'Could not read login attempt counter; allowing the attempt');
      return 0;
    }
  }

  /** Record a failed attempt. Returns the new count, or 0 if it could not be stored. */
  private async recordFailure(key: string): Promise<number> {
    try {
      const count = await this.redis.client.incr(key);
      // Only the first failure sets the TTL, so the window is fixed from the
      // first bad attempt rather than sliding forward with each new one -
      // otherwise a slow trickle of guesses extends the lockout indefinitely.
      if (count === 1) await this.redis.client.expire(key, LOCKOUT_SECONDS);
      return count;
    } catch (err) {
      this.logger.error({ err, key }, 'Could not record failed login attempt');
      return 0;
    }
  }

  private async clearFailures(...keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.redis.del(key);
      } catch (err) {
        this.logger.warn({ err, key }, 'Could not clear login attempt counter');
      }
    }
  }
}

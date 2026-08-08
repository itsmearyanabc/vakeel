import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CryptoService } from '../security/crypto.service';
import { verifyJwt } from './jwt';

/** The authenticated admin, attached to the request for handlers to read. */
export interface AdminPrincipal {
  email: string;
  role: 'SUPER_ADMIN';
  /** 'session' = signed in through the login form; 'service' = raw token. */
  via: 'session' | 'service';
}

export type AuthenticatedRequest = FastifyRequest & { admin?: AdminPrincipal };

/**
 * Authentication for the admin API.
 *
 * Accepts a bearer token in either of two forms:
 *
 *  1. **A signed session JWT** issued by `POST /admin/login` after an
 *     email/password check. This is what the panel uses, and it expires
 *     (`JWT_EXPIRES_IN`), so a token copied out of a browser is not valid
 *     forever.
 *
 *  2. **The raw `JWT_SECRET`**, as a service token. This predates the login
 *     form and is kept for curl and automation - the README's examples use it,
 *     and CI has no way to complete a login form.
 *
 * ## The tradeoff in keeping (2)
 *
 * A non-expiring shared secret is weaker than a session. It is retained because
 * removing it would break existing automation and because it is the only way in
 * when `ADMIN_EMAIL`/`ADMIN_PASSWORD` are unset - which is the state every
 * deployment starts in.
 *
 * If you want to close it off once the login form is configured, delete the
 * `serviceToken` branch below; the panel will keep working, and only scripted
 * callers need updating.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @InjectEnv() private readonly env: AppEnv,
    private readonly crypto: CryptoService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Missing bearer token.' });
    }

    const token = header.slice('Bearer '.length);

    // Session JWT first - it is the normal path once login is configured.
    const payload = verifyJwt(token, this.env.JWT_SECRET);
    if (payload) {
      request.admin = { email: payload.sub, role: payload.role, via: 'session' };
      return true;
    }

    // Constant-time: a plain === here leaks the secret a byte at a time.
    if (this.crypto.safeEqual(token, this.env.JWT_SECRET)) {
      request.admin = { email: 'service-token', role: 'SUPER_ADMIN', via: 'service' };
      return true;
    }

    throw new UnauthorizedException({
      code: 'UNAUTHORIZED',
      // Deliberately does not say whether the token was malformed, expired or
      // simply wrong - that distinction only helps someone guessing.
      message: 'Invalid or expired credentials.',
    });
  }
}

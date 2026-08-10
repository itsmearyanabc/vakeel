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
 *  2. **A service token**, for curl and automation, which has no way to
 *     complete a login form. Which string that is - and whether one exists at
 *     all - is decided by `env.adminServiceToken`; read the comment there,
 *     because the answer changed and the reasoning is the important part.
 *
 * ## The tradeoff in keeping (2)
 *
 * A non-expiring shared secret is weaker than a session, and this one is not
 * scoped: it is full SUPER_ADMIN. It is retained because it is the only way in
 * before `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set - the state every deployment
 * starts in - and because automation needs a credential that does not expire
 * mid-run. It is now at least a credential of its own, so it can be rotated
 * without signing every admin out, and a deployment that wants sessions only
 * gets that by simply not setting `ADMIN_SERVICE_TOKEN`.
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

    // The empty-string guard matters: safeEqual('', '') is true, so without it
    // a deployment that deliberately has no service token would accept an
    // empty bearer as full SUPER_ADMIN.
    const serviceToken = this.env.adminServiceToken;
    // Constant-time: a plain === here leaks the secret a byte at a time.
    if (serviceToken !== '' && this.crypto.safeEqual(token, serviceToken)) {
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

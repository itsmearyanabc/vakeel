import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CryptoService } from '../security/crypto.service';

/**
 * Service-to-service auth for the admin endpoints.
 *
 * A shared bearer token (JWT_SECRET) rather than per-user JWTs. That is
 * deliberate for this stage: there is no admin portal yet, so there are no
 * interactive admin sessions to issue tokens for, and inventing a user auth
 * system that nothing consumes would be speculative work.
 *
 * When the Next.js governance portal is built, replace this with proper JWT
 * verification and role checks against the `user_role` enum - the roles already
 * exist in the schema.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @InjectEnv() private readonly env: AppEnv,
    private readonly crypto: CryptoService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Missing bearer token.' });
    }

    // Constant-time: a plain === here leaks the token a byte at a time.
    if (!this.crypto.safeEqual(header.slice('Bearer '.length), this.env.JWT_SECRET)) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid token.' });
    }

    return true;
  }
}

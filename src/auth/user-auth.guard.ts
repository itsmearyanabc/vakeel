import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { UserRow, WebSessionRow } from '../database/types';
import { AuthService } from './auth.service';
import { readCookie } from './cookies';

/** The signed-in advocate, attached to the request for handlers to read. */
export interface WebPrincipal {
  user: UserRow;
  session: WebSessionRow;
  /** The raw cookie value, needed to keep this device signed in on "sign out everywhere". */
  token: string;
}

export type WebRequest = FastifyRequest & { principal?: WebPrincipal };

/**
 * Authentication for the end-user API.
 *
 * ## Why a cookie and not a bearer token
 *
 * The client is a browser and nothing else - there is no mobile app and no
 * third-party integration on this surface. A cookie can be HttpOnly, which
 * takes the credential out of reach of page JavaScript entirely; a bearer token
 * has to be stored somewhere a script can read it, which turns any XSS anywhere
 * in the application into a stolen session. The admin API keeps bearer tokens
 * because it has automation callers that cannot hold cookies; this one has
 * none.
 *
 * The cost of cookies is CSRF, which is handled by SameSite=Lax plus the fact
 * that every mutating endpoint here is a JSON POST - see cookies.ts.
 *
 * ## Why blocked accounts are rejected here
 *
 * A user who opts out or is suspended keeps their row, and their session cookie
 * stays cryptographically valid until it expires. Checking the flag at the
 * guard is what makes suspension take effect on the next request rather than
 * whenever the cookie happens to lapse.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebRequest>();

    const token = readCookie(request.headers.cookie, this.env.SESSION_COOKIE_NAME);
    if (!token) {
      throw new UnauthorizedException({ code: 'NOT_SIGNED_IN', message: 'Sign in to continue.' });
    }

    const resolved = await this.auth.resolveSession(token);
    if (!resolved) {
      // Expired, revoked or simply wrong - all indistinguishable to the caller
      // on purpose. The client's response to every one of them is the same:
      // show the sign-in screen.
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Your session has expired. Please sign in again.',
      });
    }

    if (resolved.user.is_blocked) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_BLOCKED',
        message: 'This account has been suspended.',
      });
    }

    request.principal = { user: resolved.user, session: resolved.session, token };
    return true;
  }
}

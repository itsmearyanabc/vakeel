import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CreditsService } from '../credits/credits.service';
import { AuthRepository } from '../database/repositories/auth.repository';
import { UserRow } from '../database/types';
import { AuthError, AuthService, SignedInSession } from './auth.service';
import { clearCookie, readCookie, serializeCookie } from './cookies';
import { GoogleOAuthService, OAuthError } from './google-oauth.service';
import { PhoneLinkService } from './phone-link.service';
import { UserAuthGuard, WebRequest } from './user-auth.guard';

/** Short-lived cookie holding the OAuth `state`, for CSRF. See google-oauth.service.ts. */
const OAUTH_STATE_COOKIE = 'vs_oauth_state';
const OAUTH_STATE_TTL_SECONDS = 600;

interface SignUpBody {
  email?: string;
  password?: string;
  fullName?: string;
}

/**
 * Sign-up, sign-in and account management for advocates using the web app.
 *
 * Separate from AdminAuthController, which authenticates operators against
 * environment credentials and mints a JWT. The two have almost nothing in
 * common beyond the word "login": different credential store, different token
 * shape, different revocation story, different threat model. Merging them would
 * mean one code path deciding between them on every request.
 */
@Controller()
export class AuthController {
  private readonly logger = getLogger().child({ module: 'auth:http' });

  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleOAuthService,
    private readonly credits: CreditsService,
    private readonly repo: AuthRepository,
    private readonly phoneLink: PhoneLinkService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  // ---------------------------------------------------------------------------
  // Public configuration
  // ---------------------------------------------------------------------------

  /**
   * What this deployment can actually do.
   *
   * The sign-in screen renders from this rather than from hard-coded markup, so
   * a Google button only appears where Google is configured and the "forgot
   * password" link only appears where mail can be delivered. A control that
   * cannot work should not be on screen - it is indistinguishable from a broken
   * one, and the user's only way to find out is to try it.
   */
  @Get('api/auth/config')
  config() {
    return {
      google: this.google.isConfigured,
      emailRecovery: this.env.emailConfigured,
      passwordMinLength: this.env.PASSWORD_MIN_LENGTH,
      payments: this.env.razorpayConfigured,
    };
  }

  // ---------------------------------------------------------------------------
  // Email + password
  // ---------------------------------------------------------------------------

  @Post('api/auth/signup')
  @HttpCode(HttpStatus.OK)
  async signUp(@Body() body: SignUpBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.run(() =>
      this.auth.signUp({
        email: body?.email ?? '',
        password: body?.password ?? '',
        fullName: body?.fullName ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip ?? null,
      }),
    );

    return this.completeSignIn(session, reply);
  }

  @Post('api/auth/login')
  @HttpCode(HttpStatus.OK)
  async signIn(
    @Body() body: { email?: string; password?: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.run(() =>
      this.auth.signIn({
        email: body?.email ?? '',
        password: body?.password ?? '',
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip ?? null,
      }),
    );

    return this.completeSignIn(session, reply);
  }

  @Post('api/auth/logout')
  @HttpCode(HttpStatus.OK)
  async signOut(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = readCookie(req.headers.cookie, this.env.SESSION_COOKIE_NAME);
    if (token) await this.auth.signOut(token);

    // Cleared whether or not a session was found. A cookie that could not be
    // resolved is still a cookie the browser will keep sending.
    reply.header('set-cookie', clearCookie(this.env.SESSION_COOKIE_NAME, this.env.cookieSecure));
    return { signedOut: true };
  }

  // ---------------------------------------------------------------------------
  // Google
  // ---------------------------------------------------------------------------

  /**
   * Start the Google flow.
   *
   * A redirect rather than a JSON URL for the client to follow, because the
   * `state` cookie has to be set on the same response that sends the browser to
   * Google. Handing back a URL would mean two round trips and a window where
   * the cookie exists but the flow does not.
   */
  @Get('auth/google')
  async googleStart(@Query('returnTo') returnTo: string | undefined, @Res() reply: FastifyReply) {
    if (!this.google.isConfigured) {
      reply.redirect('/app?error=google_not_configured', HttpStatus.FOUND);
      return;
    }

    const { url, state } = await this.google.beginFlow(safeReturnTo(returnTo));

    reply.header(
      'set-cookie',
      serializeCookie(OAUTH_STATE_COOKIE, state, {
        secure: this.env.cookieSecure,
        maxAgeSeconds: OAUTH_STATE_TTL_SECONDS,
        // Lax, not Strict: Google's redirect back to us is a cross-site
        // top-level navigation, and Strict would withhold the cookie on
        // exactly the request that needs it - making every sign-in fail with
        // a state mismatch.
        sameSite: 'Lax',
      }),
    );

    reply.redirect(url, HttpStatus.FOUND);
  }

  /**
   * Google's redirect back.
   *
   * Always ends in a redirect, never a JSON body: the browser arrived here by
   * navigation, so an error has to be a page the advocate can read, not a 401
   * document. Failures carry a short code in the query string that the sign-in
   * screen turns into a sentence.
   */
  @Get('auth/google/callback')
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const cookies: string[] = [clearCookie(OAUTH_STATE_COOKIE, this.env.cookieSecure)];

    const fail = (reason: string): void => {
      reply.header('set-cookie', cookies);
      reply.redirect(`/app?error=${encodeURIComponent(reason)}`, HttpStatus.FOUND);
    };

    // The advocate pressed Cancel on Google's consent screen. Not an error
    // worth a log line or an alarming message.
    if (error) return fail(error === 'access_denied' ? 'google_cancelled' : 'google_failed');
    if (!code || !state) return fail('google_failed');

    try {
      const { profile, returnTo } = await this.google.completeFlow({
        code,
        queryState: state,
        cookieState: readCookie(req.headers.cookie, OAUTH_STATE_COOKIE),
      });

      const session = await this.auth.signInWithGoogle({
        profile,
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip ?? null,
      });

      cookies.push(this.sessionCookie(session));
      reply.header('set-cookie', cookies);
      reply.redirect(returnTo, HttpStatus.FOUND);
    } catch (err) {
      if (err instanceof OAuthError) return fail(err.code.toLowerCase());
      if (err instanceof AuthError) return fail(err.code.toLowerCase());

      this.logger.error({ err }, 'Google sign-in failed unexpectedly');
      return fail('google_failed');
    }
  }

  // ---------------------------------------------------------------------------
  // The signed-in account
  // ---------------------------------------------------------------------------

  @Get('api/auth/me')
  @UseGuards(UserAuthGuard)
  async me(@Req() req: WebRequest) {
    const user = req.principal!.user;
    const [balance, identities] = await Promise.all([
      this.credits.balance(user.id, user.role),
      this.repo.listIdentities(user.id),
    ]);

    return {
      user: publicUser(user),
      credits: balance,
      identities: identities.map((i) => ({ provider: i.provider, email: i.email })),
      capabilities: {
        google: this.google.isConfigured,
        emailRecovery: this.env.emailConfigured,
        payments: this.env.razorpayConfigured,
      },
    };
  }

  @Post('api/auth/password/forgot')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() body: { email?: string }) {
    if (!this.env.emailConfigured) {
      // Refused rather than pretended. Accepting this and returning the usual
      // "check your inbox" would be a lie the user cannot detect until they
      // have waited and retried.
      throw new HttpException(
        {
          code: 'EMAIL_NOT_CONFIGURED',
          message:
            'Password reset by email is not available on this deployment. Sign in with Google, or contact support.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    await this.auth.requestPasswordReset(body?.email ?? '');

    // Deliberately identical whether or not the address exists. See the class
    // comment in auth.service.ts.
    return { sent: true };
  }

  @Post('api/auth/password/reset')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: { token?: string; password?: string }) {
    const ok = await this.run(() =>
      this.auth.completePasswordReset(body?.token ?? '', body?.password ?? ''),
    );

    if (!ok) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'This reset link has expired or has already been used. Request a new one.',
      });
    }

    return { reset: true };
  }

  @Post('api/auth/password/change')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserAuthGuard)
  async changePassword(
    @Body() body: { currentPassword?: string; newPassword?: string },
    @Req() req: WebRequest,
  ) {
    await this.run(() =>
      this.auth.changePassword(req.principal!.user, body?.currentPassword ?? '', body?.newPassword ?? ''),
    );
    return { changed: true };
  }

  @Post('api/auth/email/verify')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() body: { token?: string }) {
    const ok = await this.auth.verifyEmail(body?.token ?? '');
    if (!ok) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'This confirmation link has expired or has already been used.',
      });
    }
    return { verified: true };
  }

  @Post('api/auth/email/resend')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserAuthGuard)
  async resendVerification(@Req() req: WebRequest) {
    const result = await this.auth.sendVerificationEmail(req.principal!.user);
    return { sent: result.sent, emailConfigured: this.env.emailConfigured };
  }

  // ---------------------------------------------------------------------------
  // Linking a WhatsApp number
  // ---------------------------------------------------------------------------

  /**
   * Ask for a code to prove ownership of a number.
   *
   * The code is returned in the response and shown on screen. That is safe and
   * deliberate: the caller already holds a session for the account being
   * linked, so the code tells them nothing they could not already do. What it
   * cannot do is prove the handset is theirs - only sending it from that
   * handset does that, which is the next step.
   */
  @Post('api/auth/phone/start')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserAuthGuard)
  async startPhoneLink(@Body() body: { phoneNumber?: string }, @Req() req: WebRequest) {
    try {
      const { code, phoneNumber } = await this.phoneLink.requestCode(
        req.principal!.user,
        body?.phoneNumber ?? '',
      );

      return {
        code,
        phoneNumber,
        expiresInSeconds: 900,
        // The number the advocate must send the code to. Null when it has not
        // been configured, and the UI says so rather than showing an empty box
        // beside an instruction to message it.
        botNumber: this.env.WHATSAPP_DISPLAY_NUMBER || null,
        whatsappConfigured: this.env.whatsappConfigured,
      };
    } catch (err) {
      if (err instanceof Error && err.message === 'INVALID_PHONE') {
        throw new BadRequestException({
          code: 'INVALID_PHONE',
          message: 'Enter your WhatsApp number in international format, for example 919876543210.',
        });
      }
      throw err;
    }
  }

  /**
   * Has the code been sent yet?
   *
   * The browser polls this while the advocate switches to WhatsApp. The linking
   * itself happens in the conversation flow when the message arrives - there is
   * no endpoint to "confirm" from the web side, because the whole point is that
   * the proof comes from the handset.
   */
  @Get('api/auth/phone/status')
  @UseGuards(UserAuthGuard)
  async phoneLinkStatus(@Req() req: WebRequest) {
    const user = req.principal!.user;
    const pending = await this.phoneLink.pendingFor(user.id);

    return {
      linked: Boolean(user.phone_verified_at && user.phone_number),
      phoneNumber: user.phone_number ? maskPhoneTail(user.phone_number) : null,
      pending: pending ? { phoneNumber: pending.phoneNumber, expiresAt: pending.expiresAt } : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Every device currently signed in.
   *
   * Worth having for its own sake, and worth having because it is the only way
   * an advocate can tell that someone else is in their account. The current
   * device is flagged so "which one is me" is not a guess.
   */
  @Get('api/auth/sessions')
  @UseGuards(UserAuthGuard)
  async sessions(@Req() req: WebRequest) {
    const principal = req.principal!;
    const rows = await this.repo.listSessions(principal.user.id);

    return rows.map((row) => ({
      id: row.id,
      current: row.id === principal.session.id,
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  @Delete('api/auth/sessions/:id')
  @UseGuards(UserAuthGuard)
  async revokeSession(@Param('id') id: string, @Req() req: WebRequest) {
    await this.repo.revokeSessionById(req.principal!.user.id, id);
    return { revoked: true };
  }

  @Post('api/auth/sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserAuthGuard)
  async revokeAll(@Req() req: WebRequest) {
    const principal = req.principal!;
    // The current device is kept: signing the user out of the browser they are
    // using to press the button is a confusing way to confirm it worked.
    const revoked = await this.auth.signOutEverywhere(principal.user.id, principal.token);
    return { revoked };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private completeSignIn(session: SignedInSession, reply: FastifyReply) {
    reply.header('set-cookie', this.sessionCookie(session));
    return {
      user: publicUser(session.user),
      emailConfigured: this.env.emailConfigured,
    };
  }

  private sessionCookie(session: SignedInSession): string {
    return serializeCookie(this.env.SESSION_COOKIE_NAME, session.token, {
      secure: this.env.cookieSecure,
      maxAgeSeconds: this.env.sessionTtlSeconds,
    });
  }

  /**
   * Turn an AuthError into the right HTTP status.
   *
   * Kept in one place so that adding a failure mode cannot accidentally return
   * 500 for something the user can fix - which is the difference between "your
   * password is too short" and "the service is broken".
   */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;

      const status =
        err.code === 'TOO_MANY_ATTEMPTS'
          ? HttpStatus.TOO_MANY_REQUESTS
          : err.code === 'EMAIL_TAKEN'
            ? HttpStatus.CONFLICT
            : err.code === 'INVALID_CREDENTIALS' || err.code === 'ACCOUNT_BLOCKED'
              ? HttpStatus.UNAUTHORIZED
              : HttpStatus.BAD_REQUEST;

      throw new HttpException({ code: err.code, message: err.message }, status);
    }
  }
}

/**
 * The shape of a user the browser is allowed to see.
 *
 * An explicit allow-list, not a delete-list. `password_hash` is the reason: a
 * denylist that someone forgets to update when a column is added is how
 * credentials end up in a JSON response, and the failure is silent. Adding a
 * column here is a deliberate act; forgetting to add one is harmless.
 */
function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.email_verified_at),
    fullName: user.full_name,
    avatarUrl: user.avatar_url,
    phoneNumber: user.phone_number ? maskPhoneTail(user.phone_number) : null,
    phoneVerified: Boolean(user.phone_verified_at),
    city: user.city,
    state: user.bar_council_state,
    role: user.role,
    verificationStatus: user.verification_status,
    barCouncilOnRecord: Boolean(user.bar_council_id_hash),
    preferredLanguage: user.preferred_language,
    createdAt: user.created_at,
  };
}

/** Show enough of a number to recognise it, not enough to publish it. */
function maskPhoneTail(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${'•'.repeat(Math.max(2, phone.length - 4))}${phone.slice(-4)}`;
}

/**
 * Constrain the post-sign-in destination to this application.
 *
 * `returnTo` reaches us from the query string, so without this an attacker can
 * hand out a link that signs someone in and then bounces them to a page under
 * their control - an open redirect, and a convincing one precisely because the
 * first half of the journey is genuine. Only a same-origin absolute path is
 * accepted; `//evil.example` is rejected because a protocol-relative URL is a
 * cross-origin destination wearing a path's clothes.
 */
function safeReturnTo(value: string | undefined): string {
  if (!value) return '/app';
  if (!value.startsWith('/') || value.startsWith('//')) return '/app';
  return value;
}

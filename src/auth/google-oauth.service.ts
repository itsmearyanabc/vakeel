import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { RedisService } from '../redis/redis.service';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Google's `iss` values. Both are valid and both are seen in practice. */
const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** How long a half-finished sign-in stays resumable. */
const FLOW_TTL_SECONDS = 600;

export interface GoogleProfile {
  /** The `sub` claim. Stable for the life of the Google account. */
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Google sign-in, server side.
 *
 * ## Which flow this is, and why
 *
 * The authorization-code flow with PKCE, run entirely from the backend. The
 * browser is redirected to Google and back with a code; the code is exchanged
 * for tokens by this service, over TLS, authenticated with the client secret.
 * The secret never reaches the browser and no token is ever exposed to page
 * JavaScript - the outcome is a session cookie, exactly as an email sign-in
 * produces.
 *
 * The implicit flow, and Google's client-side JavaScript library, both put
 * tokens in the browser. That is a larger surface for no benefit here: the
 * application has a server and a session store, so there is nothing the
 * front-channel variants would simplify.
 *
 * ## Two separate protections, doing two different jobs
 *
 * **`state`** stops login CSRF - an attacker feeding their own authorization
 * code to your browser so you end up signed into *their* account without
 * noticing. It is bound to the browser by a cookie, and the callback requires
 * cookie and query parameter to agree. Storing state server-side alone would
 * not do this: the whole point is proving the callback belongs to the same
 * browser that started the flow.
 *
 * **PKCE** stops an intercepted authorization code being redeemed by someone
 * else. It is strictly speaking belt-and-braces for a confidential client that
 * already holds a secret - and it is cheap, it is what Google recommends, and
 * the code appears in a redirect URL that lands in browser history and proxy
 * logs.
 *
 * ## Why the id_token's signature is not verified here
 *
 * The token is not accepted from the browser. It arrives in the response body
 * of a direct, server-to-server, TLS-authenticated POST to Google's token
 * endpoint, in which we prove our identity with the client secret. OpenID
 * Connect Core §3.1.3.7 explicitly permits skipping signature validation in
 * exactly this case, because TLS already establishes that the issuer sent it.
 *
 * What is *not* optional, and is done below: checking `aud` is our client id,
 * `iss` is Google, and the token has not expired. Skipping those would accept a
 * token minted for a different application.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = getLogger().child({ module: 'auth:google' });

  constructor(
    @InjectEnv() private readonly env: AppEnv,
    private readonly redis: RedisService,
  ) {}

  get isConfigured(): boolean {
    return this.env.googleOAuthConfigured;
  }

  /**
   * Begin a sign-in.
   *
   * Returns the URL to redirect to and the `state` value, which the caller must
   * also set as a short-lived httpOnly cookie. Both halves are required at the
   * callback; neither is sufficient alone.
   */
  async beginFlow(returnTo: string): Promise<{ url: string; state: string }> {
    if (!this.isConfigured) {
      throw new OAuthError('NOT_CONFIGURED', 'Google sign-in is not configured on this deployment.');
    }

    const state = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    await this.redis.setJson(this.flowKey(state), { codeVerifier, returnTo }, FLOW_TTL_SECONDS);

    const params = new URLSearchParams({
      client_id: this.env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: this.env.googleOAuthRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      // No refresh token is requested: this application uses Google to
      // establish identity once and then issues its own session. Asking for
      // offline access would mean holding a long-lived credential to someone's
      // Google account for no purpose we have.
      access_type: 'online',
      // Lets an advocate with several Google accounts pick, rather than being
      // silently signed in as whichever one the browser defaults to.
      prompt: 'select_account',
    });

    return { url: `${AUTHORIZE_URL}?${params.toString()}`, state };
  }

  /**
   * Complete a sign-in.
   *
   * `cookieState` is what the browser sent back; `queryState` is what Google
   * appended to the redirect. They must match each other *and* a flow we
   * started - a callback that satisfies only one of those is either a stale tab
   * or an attack, and neither should produce a session.
   */
  async completeFlow(input: {
    code: string;
    queryState: string;
    cookieState: string | undefined;
  }): Promise<{ profile: GoogleProfile; returnTo: string }> {
    if (!this.isConfigured) {
      throw new OAuthError('NOT_CONFIGURED', 'Google sign-in is not configured on this deployment.');
    }

    if (!input.cookieState || input.cookieState !== input.queryState) {
      this.logger.warn('Google callback rejected: state cookie did not match the callback parameter');
      throw new OAuthError('STATE_MISMATCH', 'This sign-in link has expired. Please try again.');
    }

    const flow = await this.redis.getJson<{ codeVerifier: string; returnTo: string }>(
      this.flowKey(input.queryState),
    );
    if (!flow) {
      throw new OAuthError('STATE_EXPIRED', 'This sign-in took too long. Please try again.');
    }

    // Single use. Deleted before the exchange, so a replayed callback cannot
    // ride the same flow record even if the exchange below is slow.
    await this.redis.del(this.flowKey(input.queryState));

    const tokens = await this.exchangeCode(input.code, flow.codeVerifier);
    const profile = this.readIdToken(tokens.id_token);

    return { profile, returnTo: flow.returnTo };
  }

  private async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ id_token: string; access_token?: string }> {
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.env.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: this.env.GOOGLE_OAUTH_CLIENT_SECRET,
          redirect_uri: this.env.googleOAuthRedirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.logger.error({ err }, 'Could not reach Google to exchange the authorization code');
      throw new OAuthError('NETWORK', 'Could not reach Google. Please try again.');
    }

    const body = (await response.json().catch(() => ({}))) as {
      id_token?: string;
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !body.id_token) {
      // `redirect_uri_mismatch` is far and away the most common failure and the
      // least self-explanatory, so the configured value is logged beside it -
      // it is the string that has to match the Google Console entry exactly.
      this.logger.error(
        {
          status: response.status,
          error: body.error,
          description: body.error_description,
          redirectUri: this.env.googleOAuthRedirectUri,
        },
        'Google rejected the authorization code exchange',
      );
      throw new OAuthError('EXCHANGE_FAILED', 'Google could not complete the sign-in. Please try again.');
    }

    return { id_token: body.id_token, access_token: body.access_token };
  }

  /**
   * Read the claims out of an id_token.
   *
   * See the class comment for why the signature is not checked and why these
   * three claims still are.
   */
  private readIdToken(idToken: string): GoogleProfile {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw new OAuthError('BAD_TOKEN', 'Google returned an unreadable token.');
    }

    let claims: {
      sub?: string;
      aud?: string;
      iss?: string;
      exp?: number;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };

    try {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new OAuthError('BAD_TOKEN', 'Google returned an unreadable token.');
    }

    if (claims.aud !== this.env.GOOGLE_OAUTH_CLIENT_ID) {
      // A token minted for a different application. TLS proves Google sent it;
      // only this check proves it was meant for us.
      this.logger.error({ aud: claims.aud }, 'Google id_token audience is not this client');
      throw new OAuthError('BAD_TOKEN', 'This sign-in could not be verified.');
    }

    if (!claims.iss || !VALID_ISSUERS.has(claims.iss)) {
      throw new OAuthError('BAD_TOKEN', 'This sign-in could not be verified.');
    }

    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new OAuthError('BAD_TOKEN', 'This sign-in has expired. Please try again.');
    }

    if (!claims.sub || !claims.email) {
      throw new OAuthError('NO_EMAIL', 'Google did not return an email address for this account.');
    }

    return {
      providerAccountId: claims.sub,
      email: claims.email.toLowerCase(),
      // Google sets this false for some Workspace configurations. It decides
      // whether the address is trusted enough to adopt an existing account -
      // see AuthService.signInWithGoogle, where an unverified address is not.
      emailVerified: claims.email_verified === true,
      name: claims.name ?? null,
      picture: claims.picture ?? null,
    };
  }

  private flowKey(state: string): string {
    return `oauth:google:${state}`;
  }
}

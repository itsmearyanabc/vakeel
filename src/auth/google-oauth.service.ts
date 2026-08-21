import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { signPayload, verifyPayload } from './signed-payload';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Google's `iss` values. Both are valid and both are seen in practice. */
const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** How long a half-finished sign-in stays resumable. */
const FLOW_TTL_SECONDS = 600;

/** What the flow cookie carries between the redirect and the callback. */
interface FlowState {
  /** PKCE verifier. Not a secret from this browser - see signed-payload.ts. */
  v: string;
  /** Where to land afterwards. Signed, so it cannot be turned into an open redirect. */
  r: string;
}

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
  ) {}

  get isConfigured(): boolean {
    return this.env.googleOAuthConfigured;
  }

  /**
   * Begin a sign-in.
   *
   * Returns the redirect URL plus two values the caller must set as short-lived
   * httpOnly cookies: `state`, which proves the callback belongs to this
   * browser, and `flow`, which carries the PKCE verifier and the destination.
   *
   * Both are required at the callback and neither is sufficient alone. The flow
   * cookie replaced a Redis record in migration 0013 - it is the same data, held
   * by the only party that will ever present it, signed so it cannot be edited.
   */
  beginFlow(returnTo: string): { url: string; state: string; flow: string } {
    if (!this.isConfigured) {
      throw new OAuthError('NOT_CONFIGURED', 'Google sign-in is not configured on this deployment.');
    }

    const state = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const flow = signPayload<FlowState>(
      { v: codeVerifier, r: returnTo },
      this.env.JWT_SECRET,
      FLOW_TTL_SECONDS,
    );

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

    return { url: `${AUTHORIZE_URL}?${params.toString()}`, state, flow };
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
    flowCookie: string | undefined;
  }): Promise<{ profile: GoogleProfile; returnTo: string }> {
    if (!this.isConfigured) {
      throw new OAuthError('NOT_CONFIGURED', 'Google sign-in is not configured on this deployment.');
    }

    if (!input.cookieState || input.cookieState !== input.queryState) {
      this.logger.warn('Google callback rejected: state cookie did not match the callback parameter');
      throw new OAuthError('STATE_MISMATCH', 'This sign-in link has expired. Please try again.');
    }

    const flow = verifyPayload<FlowState>(input.flowCookie, this.env.JWT_SECRET);
    if (!flow) {
      // Expired, tampered with, or simply absent - all indistinguishable to the
      // caller on purpose, and all resolved the same way: start again.
      throw new OAuthError('STATE_EXPIRED', 'This sign-in took too long. Please try again.');
    }

    const tokens = await this.exchangeCode(input.code, flow.v);
    const profile = this.readIdToken(tokens.id_token);

    // Re-checked here as well as when it was issued. The cookie is signed, so
    // this cannot have been edited - but the check costs nothing and means a
    // bug in the issuing path cannot become an open redirect.
    return { profile, returnTo: safeReturnTo(flow.r) };
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

}

/**
 * Constrain the post-sign-in destination to this application.
 *
 * Only a same-origin absolute path is accepted. `//evil.example` is rejected
 * because a protocol-relative URL is a cross-origin destination wearing a
 * path's clothes.
 */
function safeReturnTo(value: string | undefined): string {
  if (!value) return '/app';
  if (!value.startsWith('/') || value.startsWith('//')) return '/app';
  return value;
}

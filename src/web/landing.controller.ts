import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProviderRegistry } from '../ai/providers/provider.registry';
import { AuthService } from '../auth/auth.service';
import { readCookie } from '../auth/cookies';
import { RawResponse } from '../common/api-response';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CREDIT_COST } from '../credits/credits.service';
import { SettingsService } from '../settings/settings.service';
import { LANDING_CSS } from './assets/landing.css';
import { renderPrivacy } from './assets/legal.html';
import { LandingView, renderLanding } from './assets/landing.html';

/**
 * The public front page.
 *
 * ## Why `/` stopped being the app
 *
 * It used to serve the application shell, which meant every visitor who typed
 * the domain landed on a sign-in form. That is the right destination for
 * somebody who already has an account and the wrong one for everybody else:
 * a person who has never heard of the product is asked for a password before
 * being told what the password would be for.
 *
 * So `/` is now a page that explains the product and offers two doors, and the
 * app keeps `/app` - where it already lived, and where every existing link,
 * OAuth callback and email already points. Nothing that worked before moved.
 *
 * ## Why the header is rendered on the server
 *
 * The alternative is to serve one anonymous page and let JavaScript swap the
 * header after asking `/api/auth/me`. That flashes "Log in" at somebody who is
 * signed in, on every load, and does nothing at all when scripts are blocked.
 * Resolving the cookie here costs one indexed lookup and only for visitors who
 * actually carry a session - an anonymous visitor, which is nearly all of the
 * traffic a landing page gets, never touches the database.
 */
@Controller()
export class LandingController {
  private readonly logger = getLogger().child({ module: 'web:landing' });

  constructor(
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
    private readonly providers: ProviderRegistry,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  @Get('/')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('referrer-policy', 'same-origin')
  @Header('x-content-type-options', 'nosniff')
  // Clickjacking: the header carries an authenticated identity and links
  // straight into the app, so there is no legitimate reason to frame it.
  @Header('x-frame-options', 'DENY')
  async landing(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RawResponse<string>> {
    const principal = await this.resolvePrincipal(req);

    /**
     * The response varies by cookie, and one of the two variants has a person's
     * name in it.
     *
     * Cloudflare sits in front of this origin and, on the plan this runs, does
     * not honour `Vary` for anything but `Accept-Encoding`. `Vary: Cookie` is
     * therefore documentation rather than protection, and the thing that
     * actually keeps one advocate's name off another advocate's screen is that
     * the signed-in variant is never storable at all. `no-store` is doing real
     * work here; do not relax it to `no-cache`, which permits storage.
     *
     * The anonymous variant is identical for everyone and is the only one worth
     * caching, so it gets a short public TTL - which is also what a cache in
     * front of this will serve to crawlers and to WhatsApp's link preview
     * fetcher, neither of which sends a cookie.
     */
    reply.header('vary', 'Cookie');
    reply.header(
      'cache-control',
      principal ? 'private, no-store' : 'public, max-age=300, must-revalidate',
    );

    return new RawResponse(renderLanding(this.buildView(principal), LANDING_CSS));
  }


  /**
   * The privacy policy.
   *
   * Public, uncached-by-identity and cheap: it touches no database and varies
   * for nobody, so unlike `/` it needs no cookie handling and can be cached
   * outright. Meta fetches this URL before it will publish the app, and an
   * unpublished app receives no production webhooks at all - which makes this
   * page a dependency of the bot receiving messages.
   */
  @Get('/privacy')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('x-content-type-options', 'nosniff')
  @Header('cache-control', 'public, max-age=3600')
  privacy(): RawResponse<string> {
    return new RawResponse(
      renderPrivacy(
        {
          publicUrl: this.env.APP_PUBLIC_URL,
          operator: this.env.LEGAL_OPERATOR_NAME,
          contactEmail: this.env.LEGAL_CONTACT_EMAIL,
          year: new Date().getFullYear(),
          updated: new Date().toISOString().slice(0, 10),
        },
        LANDING_CSS,
      ),
    );
  }

  /**
   * Who is asking, when that is cheap to establish.
   *
   * Three deliberate behaviours:
   *
   *  - No cookie means no query. Anonymous traffic is the common case on this
   *    page and it must not cost a round trip to Supabase.
   *  - An unresolvable session renders as anonymous rather than as an error.
   *    Expired, revoked and forged are indistinguishable here on purpose; all
   *    three mean "show them the sign-in door".
   *  - A database failure renders as anonymous too. The front page of the
   *    product must not 500 because the free-tier database paused overnight -
   *    the worst outcome of getting this wrong is a signed-in visitor being
   *    offered a sign-in button they do not need.
   */
  private async resolvePrincipal(req: FastifyRequest): Promise<{ fullName: string | null } | null> {
    const token = readCookie(req.headers.cookie, this.env.SESSION_COOKIE_NAME);
    if (!token) return null;

    try {
      const resolved = await this.auth.resolveSession(token);
      if (!resolved || resolved.user.is_blocked) return null;
      return { fullName: resolved.user.full_name };
    } catch (err) {
      this.logger.warn({ err }, 'Could not resolve session for the landing page; rendering anonymously');
      return null;
    }
  }

  /**
   * Everything the page renders, resolved from live configuration.
   *
   * Read through SettingsService rather than `env` directly, so the page agrees
   * with what the bot is actually running - a value overridden in the admin
   * panel is the value in force, and a landing page describing the environment
   * variable instead would be confidently wrong.
   */
  private buildView(principal: { fullName: string | null } | null): LandingView {
    const precedentSource = this.settings.get('PRECEDENT_SOURCE') || 'auto';
    const kanoonConfigured = this.settings.get('KANOON_API_KEY') !== '';

    return {
      signedIn: principal !== null,
      displayName: principal?.fullName ?? null,

      // From CREDIT_COST rather than a number typed into the markup: the page
      // that quotes a price and the code that charges it must not be able to
      // disagree.
      searchCost: CREDIT_COST.SECTION_LOOKUP,
      caseStatusCost: CREDIT_COST.CASE_STATUS,
      freeMonthlyCredits: this.settings.getNumber('CREDITS_FREE_MONTHLY', this.env.CREDITS_FREE_MONTHLY),
      signupBonus: this.settings.getNumber('CREDITS_SIGNUP_BONUS', this.env.CREDITS_SIGNUP_BONUS),

      whatsappNumber: this.settings.get('WHATSAPP_DISPLAY_NUMBER'),

      // `local` means the operator has pointed this at their own corpus, which
      // this class cannot count without a query it does not want to make on
      // every page load. Kanoon is the case that is knowable from config.
      caseLawLive: precedentSource === 'local' || kanoonConfigured,
      caseStatusLive: (this.settings.get('ECOURTS_MODE') || 'mock') === 'http',
      // The registry already encodes "selected but no key falls back to mock",
      // so asking it is the only way to be right about this.
      answersLive: !this.providers.isSynthesisMocked,

      publicUrl: this.env.APP_PUBLIC_URL,
      year: new Date().getFullYear(),
    };
  }
}

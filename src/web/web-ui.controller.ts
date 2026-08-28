import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RawResponse } from '../common/api-response';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { APP_CSS } from './assets/app.css';
import { APP_JS } from './assets/app.js';

/**
 * The page that loads the advocate-facing app.
 *
 * ## Why the document is unauthenticated
 *
 * A browser navigating to a URL cannot attach an Authorization header, and the
 * session cookie may legitimately be absent - this is where someone signs in.
 * So the shell is served to anyone, and it contains no data at all: every byte
 * of user information arrives afterwards from `/api/*`, which is guarded. The
 * unauthenticated surface here is a sign-in form and nothing else.
 *
 * ## Why one document serves every path under /app
 *
 * Routing happens in the browser, but three of the routes arrive by navigation
 * from outside - the Google callback lands on `/app`, and the links in
 * verification and reset emails land on `/app/verify-email` and
 * `/app/reset-password`. If the server 404s those, every one of those journeys
 * ends on an error page. Serving the same shell for all of them means the
 * client reads `location.pathname` and shows the right screen.
 */
@Controller()
export class WebUiController {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  /**
   * The application shell.
   *
   * No longer answers `/`. That is the landing page now - see LandingController
   * for why somebody who has never heard of this product should not arrive at a
   * password field. Nothing that already worked moved: the Google callback,
   * both email links and the app's own routing all point at `/app` and always
   * did.
   */
  // `app/*` and not Nest 11's named `app/*path`: the named form is an Express
  // convention, and Fastify's router rejects it outright with "Wildcard must be
  // the last character in the route" - at boot, so the whole service fails to
  // start rather than just this route.
  @Get(['app', 'app/*'])
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  @Header('referrer-policy', 'same-origin')
  // Clickjacking: an advocate's chat interface inside a hostile iframe is a
  // credential-and-content leak, and there is no legitimate reason to embed it.
  @Header('x-frame-options', 'DENY')
  @Header('x-content-type-options', 'nosniff')
  app(): RawResponse<string> {
    return new RawResponse(APP_HTML);
  }

  /**
   * The landing page is indexable; nothing else is.
   *
   * This was a blanket `Disallow: /`, which was correct when every URL on the
   * origin was either a sign-in form or a private conversation. Now that `/`
   * explains the product, that rule would hide the only page worth indexing.
   *
   * The disallows are by prefix: `/app` is a signed-in application's shell,
   * `/admin` is an operations panel, and `/api`, `/auth` and `/webhooks` are
   * machine surfaces. None has a public document behind it, and a crawler
   * following them spends its budget on redirects to a sign-in form.
   *
   * What this is not is access control. robots.txt is a request that only
   * polite crawlers honour, and it is itself public - it tells anyone curious
   * exactly where the admin panel is. That is acceptable precisely because
   * every path below is guarded on its own; if it were not, hiding it here
   * would not help.
   */
  @Get('robots.txt')
  @Header('content-type', 'text/plain; charset=utf-8')
  robots(): RawResponse<string> {
    return new RawResponse(
      [
        'User-agent: *',
        'Allow: /$',
        'Disallow: /app',
        'Disallow: /admin',
        'Disallow: /api',
        'Disallow: /auth',
        'Disallow: /webhooks',
        '',
        `Sitemap: ${this.publicBase()}/sitemap.xml`,
        '',
      ].join('\n'),
    );
  }

  /**
   * One URL, because there is one public page.
   *
   * Trivial today and still worth having: it is what a search console asks for,
   * and the day there is a second public page it is a line in this array rather
   * than something somebody has to remember to create.
   */
  @Get('sitemap.xml')
  @Header('content-type', 'application/xml; charset=utf-8')
  sitemap(): RawResponse<string> {
    return new RawResponse(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        `  <url><loc>${this.publicBase()}/</loc><changefreq>weekly</changefreq>` +
        '<priority>1.0</priority></url>\n' +
        // Listed because it is a real public page, and because a policy nobody
        // can find is not much of a policy. Low priority and yearly: it is not
        // what anyone is searching for.
        `  <url><loc>${this.publicBase()}/privacy</loc><changefreq>yearly</changefreq>` +
        '<priority>0.3</priority></url>\n' +
        '</urlset>\n',
    );
  }

  /** APP_PUBLIC_URL without its trailing slash, so joins do not double up. */
  private publicBase(): string {
    return this.env.APP_PUBLIC_URL.replace(/\/+$/, '');
  }

  /**
   * The old JSON status document, kept at its own path.
   *
   * `/` returns the landing page and answers a platform probe with a 200 just
   * as well, so nothing needs this - but anything already pointed here keeps
   * getting a machine-readable answer instead of a page of HTML.
   */
  @Get('status')
  status(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(HttpStatus.OK);
    return { service: 'vakeel-saathi', status: 'ok', app: '/app', health: '/health/ready' };
  }
}

/**
 * The document.
 *
 * CSS and JS are inlined rather than served as separate files. Two reasons:
 * there is no static-asset pipeline in this service and adding one to ship two
 * files is disproportionate; and a single document means the app is usable on
 * the first round trip, which matters on the mobile connections a lot of
 * advocates will be on.
 *
 * The JS is a module so it gets strict mode and deferred execution without a
 * `defer` attribute or an IIFE wrapper.
 */
const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Vakeel Saathi</title>
<style>${APP_CSS}</style>
</head>
<body>
<noscript>
  <div style="max-width:520px;margin:80px auto;padding:24px;font-family:sans-serif;line-height:1.6">
    <h1 style="font-size:20px">JavaScript is required</h1>
    <p>Vakeel Saathi's web app needs JavaScript. You can also use the service entirely
    over WhatsApp, which needs nothing but your phone.</p>
  </div>
</noscript>
<script type="module">${APP_JS}</script>
</body>
</html>`;

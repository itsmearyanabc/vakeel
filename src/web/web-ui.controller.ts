import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RawResponse } from '../common/api-response';
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
  /**
   * The application shell.
   *
   * Also answers `/`, which hosting platforms probe on every deploy. Returning
   * the app there is both the right thing for a visitor and a valid 200 for the
   * probe, so nothing needs a redirect.
   */
  @Get(['/', 'app', 'app/*path'])
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
   * Deliberately not indexed.
   *
   * Every URL under /app is either a sign-in form or a private conversation.
   * When there is a marketing site to index, it should be a separate origin
   * with its own robots policy rather than an exception carved out here.
   */
  @Get('robots.txt')
  @Header('content-type', 'text/plain; charset=utf-8')
  robots(): RawResponse<string> {
    return new RawResponse('User-agent: *\nDisallow: /\n');
  }

  /**
   * Health probes sometimes issue HEAD on `/`; Fastify answers those from the
   * GET route above. This exists only so that a request for the old JSON
   * status document gets something useful rather than the HTML shell.
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

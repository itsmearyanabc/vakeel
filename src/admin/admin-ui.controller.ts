import { Controller, Get, Header } from '@nestjs/common';
import { RawResponse } from '../common/api-response';
import { ADMIN_UI_HTML } from './admin-ui.html';

/**
 * Serves the admin panel shell.
 *
 * Deliberately NOT behind AdminGuard. A browser navigating to a URL cannot
 * attach an `Authorization` header, so guarding this would make the page
 * unreachable - you would get a 401 document instead of a login form.
 *
 * The document itself contains no data: every byte of user or configuration
 * information is fetched afterwards by JavaScript, from `/admin/*` endpoints
 * that *are* guarded. So the unauthenticated surface here is a login form and
 * nothing else.
 *
 * `X-Robots-Tag` because this is a public URL on a public domain and there is no
 * reason for it to be indexed.
 */
@Controller('admin')
export class AdminUiController {
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex, nofollow')
  @Header('referrer-policy', 'same-origin')
  panel(): RawResponse<string> {
    return new RawResponse(ADMIN_UI_HTML);
  }
}

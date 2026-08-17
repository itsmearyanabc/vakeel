import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

/**
 * Favicon only.
 *
 * `/` used to return a small JSON status document here, so that platform
 * probes did not log a 404 on every deploy. It now serves the web application
 * itself - see WebUiController - which answers the probe just as well and is
 * considerably more useful to a person who types the domain in. The JSON moved
 * to `/status`.
 */
@Controller()
export class RootController {
  /**
   * Browsers request this unprompted on every page load, and the 404 was logged
   * at warn level - the same noise that made a bare `/` route worth adding,
   * arriving through a different door. 204 is the honest answer: there is no
   * icon, and that is not an error worth a log line.
   */
  @Get('favicon.ico')
  @HttpCode(HttpStatus.NO_CONTENT)
  favicon(): void {}
}

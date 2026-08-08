import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

/**
 * The root route.
 *
 * Hosting platforms probe `/` by default (Render sends a HEAD on every deploy
 * and periodically after). Without this, each probe logs a 404, which buries
 * genuine errors in noise and makes the service look broken to anyone reading
 * the logs.
 *
 * `@Controller()` with an empty prefix is what puts this at `/` - putting a
 * bare `@Get()` inside the health controller would map it to `/health`.
 *
 * Deliberately says nothing about the deployment's internal state: this is an
 * unauthenticated public URL, so no version numbers, dependency status or
 * configuration hints. Readiness detail lives behind `/health/ready`.
 */
@Controller()
export class RootController {
  @Get()
  @HttpCode(HttpStatus.OK)
  root() {
    return {
      service: 'vakeel-saathi',
      status: 'ok',
      admin: '/admin',
      health: '/health/ready',
    };
  }
}

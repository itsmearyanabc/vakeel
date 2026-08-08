import dns from 'dns';
// Force IPv4 DNS resolution. Supabase returns AAAA (IPv6) records but Render
// containers lack IPv6 connectivity, causing ENETUNREACH on every DB connect.
dns.setDefaultResultOrder('ipv4first');

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { PinoLoggerService, createRootLogger } from './common/logger';
import { ResponseInterceptor } from './common/response.interceptor';
import { loadEnv } from './config/env';

/**
 * Web process entrypoint: WhatsApp webhook, admin API, health checks.
 *
 * The worker lives in worker.ts and is started as a separate Railway service
 * from the same image.
 */
async function bootstrap(): Promise<void> {
  // Node's built-in .env loader (>= 20.12), so no dotenv dependency. On Railway
  // the file does not exist and variables come from the platform.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file - expected in production.
  }

  const env = loadEnv();
  const logger = createRootLogger(env.LOG_LEVEL, !env.isProduction);

  const adapter = new FastifyAdapter({
    // Meta webhook payloads are small; a low cap limits the blast radius of a
    // malicious POST to a public endpoint.
    bodyLimit: 1_048_576,
    trustProxy: true,
    // Fastify does its own logging; pino is wired in through Nest instead.
    logger: false,
  });

  /**
   * Capture the raw request body.
   *
   * Meta's X-Hub-Signature-256 is an HMAC over the exact bytes received.
   * Re-serialising the parsed object produces different bytes (key order,
   * whitespace) and the signature will never match, so the raw buffer has to be
   * preserved before parsing.
   *
   * This must be registered before NestFactory.create() registers routes.
   */
  adapter.getInstance().addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req: FastifyRequest & { rawBody?: Buffer }, body: Buffer, done) => {
      req.rawBody = body;

      if (body.length === 0) {
        done(null, {});
        return;
      }

      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: new PinoLoggerService(logger),
    bufferLogs: false,
    bodyParser: false,
  });

  // Rate limiting. The webhook is exempt: Meta legitimately bursts on retries
  // and during high message volume, and throttling it causes exactly the
  // delivery failures the limiter is supposed to prevent. The admin API and
  // everything else are limited.
  await app.register(import('@fastify/rate-limit'), {
    max: 300,
    timeWindow: '1 minute',
    allowList: (req: FastifyRequest) => req.url.startsWith('/webhooks/whatsapp'),
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.enableShutdownHooks();

  // 0.0.0.0 is required on Railway - binding to localhost makes the container
  // unreachable and the healthcheck fails with no obvious cause.
  await app.listen(env.PORT, '0.0.0.0');

  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      whatsapp: env.whatsappConfigured ? 'configured' : 'log-only (no credentials)',
      webhookUrl: `${env.APP_PUBLIC_URL}/webhooks/whatsapp`,
    },
    'Vakeel Saathi web process started',
  );

  if (!env.whatsappConfigured) {
    logger.warn(
      'WhatsApp credentials are incomplete - outbound messages will be logged instead of sent. ' +
        'Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET to go live.',
    );
  }
}

bootstrap().catch((err) => {
  // The logger may not exist yet if config validation threw.
  console.error('Failed to start web process:', err);
  process.exit(1);
});

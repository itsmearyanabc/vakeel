import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module';
import { PinoLoggerService, createRootLogger } from './common/logger';
import { loadEnv } from './config/env';

/**
 * Worker process entrypoint.
 *
 * Consumes the BullMQ queue and runs scheduled jobs. No HTTP server - this is
 * created as a Nest *application context* rather than an application, so
 * nothing binds a port. On Railway that means the worker service needs no
 * healthcheck and no public domain.
 */
async function bootstrap(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file - expected in production.
  }

  const env = loadEnv();
  const logger = createRootLogger(env.LOG_LEVEL, !env.isProduction);

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new PinoLoggerService(logger),
  });

  // Without this, SIGTERM from a Railway deploy kills the process mid-job and
  // BullMQ has to wait for the stalled-job timeout to redeliver it.
  app.enableShutdownHooks();

  logger.info(
    {
      env: env.NODE_ENV,
      concurrency: env.WORKER_CONCURRENCY,
      ecourtsMode: env.ECOURTS_MODE,
    },
    'Vakeel Saathi worker process started',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down worker');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Failed to start worker process:', err);
  process.exit(1);
});

import { Test } from '@nestjs/testing';
import { AppModule, WorkerModule } from './app.module';
import { resetEnvCache } from './config/env';

/**
 * Dependency-injection wiring, checked at test time instead of at boot.
 *
 * ## Why this exists
 *
 * Nest resolves the provider graph when the application starts, so a missing
 * module import compiles cleanly, passes every unit test, builds a working
 * Docker image, and then kills the container on deploy:
 *
 *     Nest can't resolve dependencies of the AdminController (..., ?, ...).
 *     Please make sure that the argument KanoonService at index [8] is
 *     available in the AdminModule module.
 *
 * That is exactly what happened after KanoonService was added to
 * AdminController without adding KanoonModule to AdminModule's imports. Types
 * were fine, 206 tests passed, the build succeeded, and production went down.
 *
 * `Test.createTestingModule(...).compile()` performs the same resolution the
 * runtime does. Calling it here turns a deploy-time crash into a failing test.
 *
 * ## Why compile() and not init()
 *
 * `.compile()` resolves and instantiates providers but does not run
 * `onModuleInit`, so nothing opens a database connection or starts the worker
 * loop. Every provider is exercised for real, which is the point — a mock of
 * the module under test would defeat the purpose.
 *
 * Nothing is stubbed any more. RedisService used to be, because it opened a
 * socket from its constructor; since migration 0013 removed Redis there is no
 * provider left that does I/O before `onModuleInit`.
 */

/**
 * The minimum required to satisfy env validation. Deliberately not read from a
 * .env file - the test must behave identically on a laptop and in CI.
 */
function setTestEnv(): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    JWT_SECRET: 'test-jwt-secret-at-least-16-chars',
    ENCRYPTION_KEY: 'a'.repeat(64),
  });
  resetEnvCache();
}

describe('application wiring', () => {
  beforeAll(setTestEnv);
  afterAll(() => resetEnvCache());

  it('resolves every dependency in the web process', async () => {
    // Catches a controller or service injecting something its module does not
    // import - the failure mode that only shows up on deploy.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30_000);

  it('resolves every dependency in the worker process', async () => {
    // The worker builds a different module graph, so it can break independently
    // of the web process - and its failures are quieter, because nothing is
    // serving HTTP to notice.
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30_000);
});

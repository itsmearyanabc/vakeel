import { Global, Inject, Module } from '@nestjs/common';
import { AppEnv, loadEnv } from './env';

/** DI token for the validated environment. */
export const APP_ENV = Symbol('APP_ENV');

/** Sugar so services read `@InjectEnv() private env: AppEnv`. */
export const InjectEnv = () => Inject(APP_ENV);

/**
 * Global so every module gets the environment without importing ConfigModule.
 * The env object is immutable and process-wide; there is no benefit to scoping it.
 */
@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: (): AppEnv => loadEnv() }],
  exports: [APP_ENV],
})
export class ConfigModule {}

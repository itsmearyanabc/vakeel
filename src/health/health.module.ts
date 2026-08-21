import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { HealthController } from './health.controller';
import { RootController } from './root.controller';

/**
 * JobsModule is imported for the queue-depth endpoint. It used to arrive
 * transitively through the global RedisModule, which no longer exists - the
 * kind of edge that compiles fine and only fails when Nest resolves the graph
 * at boot, which is why app.wiring.spec.ts exists.
 */
@Module({
  imports: [JobsModule],
  controllers: [HealthController, RootController],
})
export class HealthModule {}

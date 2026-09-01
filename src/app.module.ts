import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { EcourtsModule } from './ecourts/ecourts.module';
import { HealthModule } from './health/health.module';
import { CreditsModule } from './credits/credits.module';
import { JobsModule } from './jobs/jobs.module';
import { SecurityModule } from './security/security.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';
import { WebModule } from './web/web.module';
import { PaymentsModule } from './payments/payments.module';
import { WhatsAppModule, WhatsAppWorkerModule } from './whatsapp/whatsapp.module';
import { RetentionJob } from './jobs/retention.job';

/**
 * Shared infrastructure. Both process entrypoints build on this.
 */
const INFRASTRUCTURE = [ConfigModule, DatabaseModule, JobsModule, SecurityModule, SettingsModule];

/**
 * The web process: WhatsApp webhook, admin API, health checks.
 *
 * Deliberately does NOT register the queue consumer. Web replicas scale on
 * inbound HTTP; worker replicas scale on queue depth. Mixing them means every
 * webhook replica also processes jobs, and neither can be scaled for its actual
 * bottleneck.
 */
@Module({
  imports: [
    ...INFRASTRUCTURE,
    AiModule,
    UsersModule,
    CreditsModule,
    AuthModule,
    EcourtsModule,
    WhatsAppModule,
    WebModule,
    PaymentsModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}

/**
 * The worker process: consumes the queue, runs the scheduled retention sweep.
 * No HTTP controllers.
 */
@Module({
  imports: [
    ...INFRASTRUCTURE,
    ScheduleModule.forRoot(),
    AiModule,
    UsersModule,
    CreditsModule,
    AuthModule,
    EcourtsModule,
    WhatsAppWorkerModule,
  ],
  providers: [RetentionJob],
})
export class WorkerModule {}

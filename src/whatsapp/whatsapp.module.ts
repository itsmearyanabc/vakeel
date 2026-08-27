import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { InboundWorker } from '../jobs/inbound.worker';
import { JobsModule } from '../jobs/jobs.module';
import { EcourtsModule } from '../ecourts/ecourts.module';
import { CreditsModule } from '../credits/credits.module';
import { UsersModule } from '../users/users.module';
import { ConversationService } from './conversation.service';
import { WebhookController } from './webhook.controller';
import { WhatsAppApiModule } from './whatsapp-api.module';

/**
 * The webhook controller and the queue consumer are separated on purpose.
 *
 * `WhatsAppModule` (web process) exposes the webhook and enqueues.
 * `WhatsAppWorkerModule` (worker process) consumes and replies.
 *
 * Registering the consumer in the web process would mean every web replica also
 * competes for jobs, which defeats the point of scaling the two independently -
 * and a web replica restart mid-deploy would then interrupt message
 * processing.
 */
@Module({
  imports: [AiModule, AuthModule, EcourtsModule, CreditsModule, UsersModule, JobsModule, WhatsAppApiModule],
  controllers: [WebhookController],
  providers: [ConversationService],
  // The module, not the service: WhatsAppModule no longer provides the client
  // itself, and Nest can only re-export a provider it owns. Re-exporting the
  // module keeps every existing consumer's import working unchanged.
  exports: [WhatsAppApiModule, ConversationService],
})
export class WhatsAppModule {}

@Module({
  imports: [AiModule, AuthModule, EcourtsModule, CreditsModule, UsersModule, JobsModule, WhatsAppApiModule],
  providers: [ConversationService, InboundWorker],
})
export class WhatsAppWorkerModule {}

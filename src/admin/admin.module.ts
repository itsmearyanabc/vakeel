import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module';
import { EcourtsModule } from '../ecourts/ecourts.module';
import { JobsModule } from '../jobs/jobs.module';
import { KanoonModule } from '../kanoon/kanoon.module';
import { UsersModule } from '../users/users.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminUiController } from './admin-ui.controller';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

/**
 * Unguarded controllers are registered first so their routes - the HTML shell
 * and the login endpoint - are matched before the guarded API catch-alls.
 */
@Module({
  // KanoonModule and EcourtsModule are needed for the dashboard's source
  // status: whether case law is live, and whether CNR lookups are reaching the
  // provider or failing on a wrong base URL. Nest only reports a missing import
  // at boot, which is why module resolution has its own test - and why this
  // list has twice been one entry short of a working deploy. See
  // app.wiring.spec.ts.
  imports: [UsersModule, WhatsAppModule, KanoonModule, EcourtsModule, CreditsModule, JobsModule],
  controllers: [AdminUiController, AdminAuthController, AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}

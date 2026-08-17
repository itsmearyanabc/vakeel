import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module';
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
  // KanoonModule is needed for the dashboard's case-law source status. Nest
  // only reports a missing import at boot, which is why module-resolution has
  // its own test - see app.wiring.spec.ts.
  imports: [UsersModule, WhatsAppModule, KanoonModule, CreditsModule],
  controllers: [AdminUiController, AdminAuthController, AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}

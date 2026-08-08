import { Module } from '@nestjs/common';
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
  imports: [UsersModule, WhatsAppModule],
  controllers: [AdminUiController, AdminAuthController, AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}

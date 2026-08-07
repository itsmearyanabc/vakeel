import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AdminUiController } from './admin-ui.controller';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

/**
 * AdminUiController is registered before AdminController so the bare `GET
 * /admin` route (the HTML shell) is matched by the unguarded controller rather
 * than falling through to the guarded API.
 */
@Module({
  imports: [UsersModule, WhatsAppModule],
  controllers: [AdminUiController, AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}

import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [UsersModule, WhatsAppModule],
  controllers: [AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}

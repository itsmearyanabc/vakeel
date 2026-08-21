import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SettingsService } from './settings.service';
import { WhatsAppConnectionTester } from './whatsapp-tester.service';

/**
 * Global so that anything can read runtime configuration without every module
 * declaring an import edge for it - the same treatment ConfigModule gets, for
 * the same reason.
 *
 * CryptoService comes from the global SecurityModule, so there is no import
 * edge here and therefore no module cycle.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [SettingsService, WhatsAppConnectionTester],
  exports: [SettingsService, WhatsAppConnectionTester],
})
export class SettingsModule {}

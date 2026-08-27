import { Module } from '@nestjs/common';
import { WhatsAppApiService } from './whatsapp-api.service';

/**
 * The Graph API client, on its own.
 *
 * ## Why this is a module and not just a provider in WhatsAppModule
 *
 * `WhatsAppModule` imports `AuthModule`, because the conversation flow redeems
 * phone-link codes that arrive as chat messages. Sign-up verification needs the
 * traffic to run the other way - `AuthModule` has to send a code - and adding
 * that import directly would close the loop into a cycle, which is exactly what
 * AuthModule's own class comment says must not happen.
 *
 * Splitting the client out breaks the loop rather than papering over it with
 * `forwardRef`. It can be a leaf because it depends on nothing local:
 * SettingsService and MessageRepository both come from `@Global()` modules, so
 * this module declares no imports at all and can be pulled in from either side.
 */
@Module({
  providers: [WhatsAppApiService],
  exports: [WhatsAppApiService],
})
export class WhatsAppApiModule {}

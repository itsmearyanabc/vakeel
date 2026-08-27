import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module';
import { WhatsAppApiModule } from '../whatsapp/whatsapp-api.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { GoogleOAuthService } from './google-oauth.service';
import { PhoneLinkService } from './phone-link.service';
import { PhoneVerificationService } from './phone-verification.service';
import { UserAuthGuard } from './user-auth.guard';

const providers = [
  AuthService,
  GoogleOAuthService,
  EmailService,
  PhoneLinkService,
  PhoneVerificationService,
  UserAuthGuard,
];

/**
 * End-user authentication.
 *
 * Exports its services rather than keeping them private because two other
 * modules need them: the web chat guards its endpoints with UserAuthGuard, and
 * the WhatsApp conversation flow redeems phone-link codes through
 * PhoneLinkService - the code arrives as a chat message, so the WhatsApp side
 * is where it is redeemed.
 *
 * That direction matters. AuthModule does not import WhatsAppModule; the
 * dependency runs one way only, which is what keeps the two from becoming a
 * cycle that Nest resolves at runtime with forwardRef and a debugging session.
 *
 * Sign-up verification needs to send a code, which is traffic in the opposite
 * direction. It gets there through WhatsAppApiModule - a leaf holding only the
 * Graph client - so the edge added here points at something that imports
 * nothing, and the rule above still holds.
 */
@Module({
  imports: [CreditsModule, WhatsAppApiModule],
  controllers: [AuthController],
  providers,
  exports: providers,
})
export class AuthModule {}

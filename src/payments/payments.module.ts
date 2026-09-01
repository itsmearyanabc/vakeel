import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { PaymentsController, RazorpayWebhookController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RazorpayService } from './razorpay.service';

/**
 * Buying credits.
 *
 * Web-process only. The worker has nothing to do here: a checkout is answered
 * on the connection it arrived on, and a webhook is a signature check plus one
 * idempotent grant - neither is slow enough to be worth a queue, and putting the
 * grant behind one would mean an advocate's balance lagging their payment.
 *
 * AuthModule is imported for UserAuthGuard; CreditsModule for the wallet the
 * purchase is written into. The gateway client is local to this module because
 * nothing outside payments has any business holding the API secret.
 */
@Module({
  imports: [AuthModule, CreditsModule],
  controllers: [PaymentsController, RazorpayWebhookController],
  providers: [PaymentsService, RazorpayService],
  exports: [PaymentsService],
})
export class PaymentsModule {}

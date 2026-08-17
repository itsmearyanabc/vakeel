import { Module } from '@nestjs/common';
import { CreditsService } from './credits.service';

/**
 * The credit wallet.
 *
 * Replaces the former QuotaModule. That module held a Redis counter and a
 * `daily_usage` row - a rate limiter, which is what the product needed while
 * there was nothing to bill. This one is a ledger, because the moment credits
 * can be bought, "how many are left" stops being the only question and
 * "where did they go" starts being asked. See credits.service.ts.
 *
 * CreditRepository is provided by DatabaseModule, which is global.
 */
@Module({ providers: [CreditsService], exports: [CreditsService] })
export class CreditsModule {}

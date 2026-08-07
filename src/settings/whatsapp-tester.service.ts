import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { SettingsService } from './settings.service';

export interface ConnectionCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** What the operator should do about it. Null when the check passed. */
  fix: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  checks: ConnectionCheck[];
  /** Live details from Meta when the credentials work. */
  number?: {
    displayPhoneNumber?: string;
    verifiedName?: string;
    qualityRating?: string;
    platform?: string;
  };
  webhookUrl: string;
}

/**
 * "Test connection" for the admin panel's WhatsApp settings page.
 *
 * Pasting credentials into a form and getting a green tick is worth a great deal
 * here, because the alternative failure mode is silent: with a bad token the bot
 * accepts webhooks, processes them, and fails only at the final send - so the
 * user sees nothing and the operator sees nothing until they read the logs.
 *
 * This calls Meta directly and reports what is actually wrong, mapped to the
 * specific field the operator needs to fix.
 */
@Injectable()
export class WhatsAppConnectionTester {
  private readonly logger = getLogger().child({ module: 'whatsapp:tester' });

  constructor(
    private readonly settings: SettingsService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  async test(): Promise<ConnectionTestResult> {
    const checks: ConnectionCheck[] = [];
    const token = this.settings.whatsappAccessToken;
    const phoneNumberId = this.settings.whatsappPhoneNumberId;
    const appSecret = this.settings.whatsappAppSecret;
    const verifyToken = this.settings.whatsappVerifyToken;

    const webhookUrl = `${this.env.APP_PUBLIC_URL}/webhooks/whatsapp`;

    // --- Presence checks, before spending a network round trip --------------
    checks.push({
      name: 'Phone number ID present',
      ok: Boolean(phoneNumberId),
      detail: phoneNumberId ? `Configured (${phoneNumberId})` : 'Not set',
      fix: phoneNumberId ? null : 'Meta dashboard > WhatsApp > API Setup, copy the ID under "From".',
    });

    checks.push({
      name: 'Access token present',
      ok: Boolean(token),
      detail: token ? `Configured (••••${token.slice(-4)})` : 'Not set',
      fix: token ? null : 'Generate a permanent System User token in Meta Business Settings.',
    });

    checks.push({
      name: 'App secret present',
      ok: Boolean(appSecret),
      detail: appSecret ? 'Configured' : 'Not set - inbound webhooks cannot be verified',
      fix: appSecret ? null : 'Meta dashboard > App Settings > Basic > App Secret.',
    });

    checks.push({
      name: 'Verify token present',
      ok: Boolean(verifyToken),
      detail: verifyToken ? 'Configured' : 'Not set - the Meta webhook handshake will fail',
      fix: verifyToken ? null : 'Invent any long random string, then paste the same value into Meta.',
    });

    // Without these two there is nothing to call Meta with.
    if (!token || !phoneNumberId) {
      return { ok: false, checks, webhookUrl };
    }

    // --- Live credential check ---------------------------------------------
    try {
      const url =
        `${this.settings.whatsappGraphRoot}/${phoneNumberId}` +
        `?fields=verified_name,display_phone_number,quality_rating,platform_type`;

      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        display_phone_number?: string;
        verified_name?: string;
        quality_rating?: string;
        platform_type?: string;
        error?: { message?: string; code?: number; type?: string };
      };

      if (!response.ok) {
        const message = payload.error?.message ?? `HTTP ${response.status}`;
        checks.push({
          name: 'Meta credentials accepted',
          ok: false,
          detail: message,
          fix: this.explainMetaError(payload.error?.code, response.status),
        });
        return { ok: false, checks, webhookUrl };
      }

      checks.push({
        name: 'Meta credentials accepted',
        ok: true,
        detail: `Connected to ${payload.display_phone_number ?? phoneNumberId}`,
        fix: null,
      });

      // Quality rating is worth surfacing: a number rated RED is close to being
      // restricted by Meta, which throttles or blocks sending entirely.
      if (payload.quality_rating && payload.quality_rating.toUpperCase() !== 'GREEN') {
        checks.push({
          name: 'Number quality rating',
          ok: false,
          detail: `Meta rates this number ${payload.quality_rating}`,
          fix: 'A YELLOW or RED rating means users are blocking or reporting the number. Sending limits drop and can reach zero. Review message content and frequency.',
        });
      }

      return {
        ok: checks.every((c) => c.ok),
        checks,
        number: {
          displayPhoneNumber: payload.display_phone_number,
          verifiedName: payload.verified_name,
          qualityRating: payload.quality_rating,
          platform: payload.platform_type,
        },
        webhookUrl,
      };
    } catch (err) {
      this.logger.error({ err }, 'WhatsApp connection test failed');
      checks.push({
        name: 'Meta credentials accepted',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        fix: 'Could not reach graph.facebook.com. Check outbound network access from this container.',
      });
      return { ok: false, checks, webhookUrl };
    }
  }

  /** Turn Meta's numeric error codes into something actionable. */
  private explainMetaError(code: number | undefined, status: number): string {
    switch (code) {
      case 190:
        return 'The access token is invalid or expired. Temporary tokens last 24 hours - generate a permanent System User token instead.';
      case 100:
        return 'The phone number ID is wrong, or the token does not have access to it. Confirm both come from the same Meta app.';
      case 200:
      case 10:
        return 'The token lacks the whatsapp_business_messaging permission. Re-generate it with that permission granted.';
      case 4:
      case 80007:
        return 'Rate limited by Meta. Wait and retry.';
      default:
        return status === 401 || status === 403
          ? 'Meta rejected the credentials. Re-check the access token and phone number ID.'
          : 'Unexpected response from Meta. Check the detail above.';
    }
  }
}

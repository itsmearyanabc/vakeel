import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';

const RESEND_URL = 'https://api.resend.com/emails';

export interface EmailResult {
  sent: boolean;
  error?: string;
}

/**
 * Transactional email for verification links and password resets.
 *
 * ## Why this can be switched off, and what happens when it is
 *
 * `EMAIL_PROVIDER=log` is the default, and on that setting nothing is sent -
 * the message is written to the log instead. That is deliberate, and it is
 * mirrored all the way up to the interface: `env.emailConfigured` is false, the
 * account screen says password reset is unavailable, and no screen ever tells
 * an advocate to check an inbox that will stay empty.
 *
 * This follows the pattern the WhatsApp client already uses on this service -
 * missing credentials degrade to logging, loudly, rather than to a feature that
 * appears to work and silently does not. A "we've sent you a link" message for
 * a link that was never sent is the single most expensive kind of bug in an
 * auth flow, because the user retries, waits, and eventually files a support
 * ticket about an email that does not exist.
 *
 * ## Why Resend and not SMTP
 *
 * Resend's API is an HTTPS POST, so it needs nothing but `fetch`. SMTP would
 * mean adding nodemailer to the credential path of a service that currently has
 * no mail dependency at all. If you would rather use SMTP - Zoho and Gmail are
 * the usual choices in India - the seam is `send()` below: add a branch, keep
 * the same return shape, and nothing above this file changes.
 */
@Injectable()
export class EmailService {
  private readonly logger = getLogger().child({ module: 'email' });

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  /** True when mail can actually be delivered. Gates the UI. */
  get isConfigured(): boolean {
    return this.env.emailConfigured;
  }

  async sendVerification(to: string, link: string): Promise<EmailResult> {
    return this.send({
      to,
      subject: 'Confirm your email — Vakeel Saathi',
      heading: 'Confirm your email address',
      body: 'Tap the button below to confirm this address belongs to you. The link is valid for 24 hours.',
      cta: { label: 'Confirm email', href: link },
      footer: 'If you did not create a Vakeel Saathi account, you can ignore this message.',
    });
  }

  async sendPasswordReset(to: string, link: string): Promise<EmailResult> {
    return this.send({
      to,
      subject: 'Reset your password — Vakeel Saathi',
      heading: 'Reset your password',
      body: 'Tap the button below to choose a new password. The link is valid for one hour and can be used once.',
      cta: { label: 'Choose a new password', href: link },
      footer:
        'If you did not ask to reset your password, ignore this message — your current password still works.',
    });
  }

  private async send(message: {
    to: string;
    subject: string;
    heading: string;
    body: string;
    cta: { label: string; href: string };
    footer: string;
  }): Promise<EmailResult> {
    const html = renderEmail(message);

    if (!this.isConfigured) {
      // The link is logged in full. On a deployment without mail configured this
      // is the only way to complete a verification or reset, and an operator
      // reading the logs to help a user is a better outcome than a dead end.
      this.logger.warn(
        { to: message.to, subject: message.subject, link: message.cta.href },
        'Email is not configured (EMAIL_PROVIDER=log) - the message below was NOT sent',
      );
      return { sent: false, error: 'EMAIL_NOT_CONFIGURED' };
    }

    try {
      const response = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.env.EMAIL_FROM,
          to: [message.to],
          subject: message.subject,
          html,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.error(
          { status: response.status, detail: detail.slice(0, 500) },
          'Resend rejected the message',
        );
        return { sent: false, error: `Mail provider returned ${response.status}` };
      }

      this.logger.info({ to: maskEmail(message.to), subject: message.subject }, 'Email sent');
      return { sent: true };
    } catch (err) {
      this.logger.error({ err }, 'Could not reach the mail provider');
      return { sent: false, error: 'Could not reach the mail provider' };
    }
  }
}

/**
 * Mask an address for logs.
 *
 * Email addresses are personal data under the DPDP Act, and logs are copied
 * into places the database is not. Mirrors maskPhone() in common/logger.ts.
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/**
 * One inlined-CSS template for both messages.
 *
 * Table layout and inline styles because email clients are not browsers:
 * Outlook renders with Word's engine, Gmail strips `<style>` blocks, and
 * flexbox is unavailable across most of the field. This is the boring shape
 * that survives all of them.
 */
function renderEmail(message: {
  heading: string;
  body: string;
  cta: { label: string; href: string };
  footer: string;
}): string {
  const escape = (value: string): string =>
    value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F4F6EC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6EC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #D9E2C4;border-radius:14px;padding:32px;">
        <tr><td style="font-size:18px;font-weight:700;color:#1C2411;padding-bottom:4px;">Vakeel Saathi</td></tr>
        <tr><td style="font-size:13px;color:#5A6B45;padding-bottom:24px;">Legal research for Indian advocates</td></tr>
        <tr><td style="font-size:20px;font-weight:700;color:#1C2411;padding-bottom:12px;">${escape(message.heading)}</td></tr>
        <tr><td style="font-size:15px;line-height:1.6;color:#3A4A28;padding-bottom:24px;">${escape(message.body)}</td></tr>
        <tr><td style="padding-bottom:24px;">
          <a href="${escape(message.cta.href)}" style="display:inline-block;background:#6B8E23;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:9px;">${escape(message.cta.label)}</a>
        </td></tr>
        <tr><td style="font-size:13px;line-height:1.6;color:#5A6B45;padding-bottom:8px;">If the button does not work, copy this link into your browser:</td></tr>
        <tr><td style="font-size:12px;line-height:1.5;color:#6B8E23;word-break:break-all;padding-bottom:24px;">${escape(message.cta.href)}</td></tr>
        <tr><td style="border-top:1px solid #E4EBD4;padding-top:16px;font-size:12px;line-height:1.6;color:#8A9A72;">${escape(message.footer)}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

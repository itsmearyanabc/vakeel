import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';

/**
 * Verification of Meta's `X-Hub-Signature-256` webhook signature.
 *
 * The webhook URL is public. Without this check anyone who finds it can post a
 * fabricated message and make the bot answer as though it came from any phone
 * number - which, for a service that spends money per message and stores legal
 * queries against a user record, is not a theoretical problem.
 *
 * Two things are easy to get wrong here and both fail silently:
 *
 *  1. The HMAC is over the *raw request bytes*. `JSON.stringify(request.body)`
 *     re-serialises with different key order and whitespace and will not match.
 *     See the content type parser in main.ts that preserves the raw buffer.
 *
 *  2. The comparison must be constant-time. A `===` on the hex digest leaks
 *     enough timing information to forge a signature byte by byte.
 *
 * ## Why the secret is a parameter
 *
 * The app secret is now runtime-configurable from the admin panel, so it cannot
 * be captured from the environment at construction time - a value read once in
 * the constructor would keep verifying against the old credentials after an
 * admin switched the bot to a different WhatsApp number.
 *
 * Passing it in also makes this class a pure function of its inputs, which is
 * why the tests need no DI container.
 */
@Injectable()
export class SignatureService {
  private readonly logger = getLogger().child({ module: 'signature' });

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  /**
   * @param rawBody   exact bytes received, before any JSON parsing
   * @param header    value of the X-Hub-Signature-256 header ("sha256=...")
   * @param appSecret current Meta app secret, resolved through SettingsService
   */
  verifyWhatsAppSignature(
    rawBody: Buffer | string | undefined,
    header: string | undefined,
    appSecret: string,
  ): boolean {
    if (!appSecret) {
      // Local development without Meta credentials. Refuse in production
      // rather than quietly accepting unsigned traffic.
      if (this.env.isProduction) {
        this.logger.error('No WhatsApp app secret configured; rejecting webhook in production');
        return false;
      }
      this.logger.warn('No WhatsApp app secret configured; skipping signature check (development only)');
      return true;
    }

    if (!rawBody || !header) {
      this.logger.warn({ hasBody: Boolean(rawBody), hasHeader: Boolean(header) }, 'Missing body or signature');
      return false;
    }

    if (!header.startsWith('sha256=')) {
      this.logger.warn('Signature header is not sha256-prefixed');
      return false;
    }

    const expected = createHmac('sha256', appSecret)
      .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
      .digest();

    let received: Buffer;
    try {
      received = Buffer.from(header.slice('sha256='.length), 'hex');
    } catch {
      return false;
    }

    if (received.length !== expected.length) return false;
    return timingSafeEqual(received, expected);
  }

  /**
   * Meta's subscription handshake.
   *
   * Meta GETs the webhook URL with a verify token; echo back `hub.challenge`
   * verbatim if it matches. Constant-time here too - the token is a shared
   * secret like any other.
   */
  verifySubscription(
    mode: string | undefined,
    token: string | undefined,
    expectedToken: string,
  ): boolean {
    if (mode !== 'subscribe' || !token || !expectedToken) return false;

    const expected = Buffer.from(expectedToken);
    const received = Buffer.from(token);
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  }
}

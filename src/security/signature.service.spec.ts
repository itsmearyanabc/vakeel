import { createHmac } from 'node:crypto';
import { AppEnv } from '../config/env';
import { SignatureService } from './signature.service';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

/**
 * The secrets are call arguments rather than constructor state, so the only
 * thing the service needs from the environment is whether we are in production
 * (which decides fail-open vs fail-closed when no secret is configured).
 */
function makeService(isProduction = false): SignatureService {
  return new SignatureService({ isProduction } as AppEnv);
}

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('SignatureService', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  describe('webhook signature', () => {
    it('accepts a correctly signed body', () => {
      expect(makeService().verifyWhatsAppSignature(Buffer.from(body), sign(body), APP_SECRET)).toBe(true);
    });

    it('rejects a body signed with the wrong secret', () => {
      expect(
        makeService().verifyWhatsAppSignature(Buffer.from(body), sign(body, 'wrong'), APP_SECRET),
      ).toBe(false);
    });

    it('rejects a tampered body', () => {
      // The exact attack the check exists to stop: valid signature, altered
      // payload, so a forged message would be answered as though it were real.
      const signature = sign(body);
      const tampered = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ evil: true }] });
      expect(makeService().verifyWhatsAppSignature(Buffer.from(tampered), signature, APP_SECRET)).toBe(false);
    });

    it('rejects a missing or malformed header', () => {
      const service = makeService();
      expect(service.verifyWhatsAppSignature(Buffer.from(body), undefined, APP_SECRET)).toBe(false);
      expect(service.verifyWhatsAppSignature(Buffer.from(body), 'sha1=abc', APP_SECRET)).toBe(false);
      expect(service.verifyWhatsAppSignature(Buffer.from(body), 'sha256=nothex!!', APP_SECRET)).toBe(false);
    });

    it('rejects a missing body', () => {
      expect(makeService().verifyWhatsAppSignature(undefined, sign(body), APP_SECRET)).toBe(false);
    });

    it('treats a string body identically to a buffer', () => {
      expect(makeService().verifyWhatsAppSignature(body, sign(body), APP_SECRET)).toBe(true);
    });

    it('skips the check in development when no secret is configured', () => {
      expect(makeService(false).verifyWhatsAppSignature(Buffer.from(body), undefined, '')).toBe(true);
    });

    it('REJECTS in production when no secret is configured', () => {
      // Failing open in production would leave the webhook publicly writable.
      expect(makeService(true).verifyWhatsAppSignature(Buffer.from(body), sign(body), '')).toBe(false);
    });

    it('verifies against the secret passed in, not one captured at construction', () => {
      // The admin panel can swap the app secret at runtime. A service that
      // cached the old secret would keep rejecting every webhook from the new
      // number, which is the bug this signature change exists to prevent.
      const rotated = 'rotated-app-secret';
      const service = makeService();
      expect(service.verifyWhatsAppSignature(Buffer.from(body), sign(body, rotated), rotated)).toBe(true);
      expect(service.verifyWhatsAppSignature(Buffer.from(body), sign(body, rotated), APP_SECRET)).toBe(false);
    });
  });

  describe('subscription handshake', () => {
    it('accepts the correct mode and token', () => {
      expect(makeService().verifySubscription('subscribe', VERIFY_TOKEN, VERIFY_TOKEN)).toBe(true);
    });

    it('rejects a wrong token, wrong mode, or missing token', () => {
      const service = makeService();
      expect(service.verifySubscription('subscribe', 'wrong-token', VERIFY_TOKEN)).toBe(false);
      expect(service.verifySubscription('unsubscribe', VERIFY_TOKEN, VERIFY_TOKEN)).toBe(false);
      expect(service.verifySubscription('subscribe', undefined, VERIFY_TOKEN)).toBe(false);
    });

    it('rejects when no verify token is configured', () => {
      // Otherwise an unconfigured deployment would accept any handshake.
      expect(makeService().verifySubscription('subscribe', 'anything', '')).toBe(false);
    });

    it('rejects a token of a different length without throwing', () => {
      // timingSafeEqual throws on length mismatch; the guard must come first.
      const service = makeService();
      expect(() => service.verifySubscription('subscribe', 'short', VERIFY_TOKEN)).not.toThrow();
      expect(service.verifySubscription('subscribe', 'short', VERIFY_TOKEN)).toBe(false);
    });
  });
});

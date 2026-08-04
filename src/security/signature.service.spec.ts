import { createHmac } from 'node:crypto';
import { AppEnv } from '../config/env';
import { SignatureService } from './signature.service';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function makeService(overrides: Partial<AppEnv> = {}): SignatureService {
  const env = {
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    isProduction: false,
    ...overrides,
  } as AppEnv;
  return new SignatureService(env);
}

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('SignatureService', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  describe('webhook signature', () => {
    it('accepts a correctly signed body', () => {
      expect(makeService().verifyWhatsAppSignature(Buffer.from(body), sign(body))).toBe(true);
    });

    it('rejects a body signed with the wrong secret', () => {
      expect(makeService().verifyWhatsAppSignature(Buffer.from(body), sign(body, 'wrong'))).toBe(false);
    });

    it('rejects a tampered body', () => {
      // The exact attack the check exists to stop: valid signature, altered
      // payload, so a forged message would be answered as though it were real.
      const signature = sign(body);
      const tampered = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ evil: true }] });
      expect(makeService().verifyWhatsAppSignature(Buffer.from(tampered), signature)).toBe(false);
    });

    it('rejects a missing or malformed header', () => {
      const service = makeService();
      expect(service.verifyWhatsAppSignature(Buffer.from(body), undefined)).toBe(false);
      expect(service.verifyWhatsAppSignature(Buffer.from(body), 'sha1=abc')).toBe(false);
      expect(service.verifyWhatsAppSignature(Buffer.from(body), 'sha256=nothex!!')).toBe(false);
    });

    it('rejects a missing body', () => {
      expect(makeService().verifyWhatsAppSignature(undefined, sign(body))).toBe(false);
    });

    it('treats a string body identically to a buffer', () => {
      expect(makeService().verifyWhatsAppSignature(body, sign(body))).toBe(true);
    });

    it('skips the check in development when no secret is configured', () => {
      const service = makeService({ WHATSAPP_APP_SECRET: '', isProduction: false });
      expect(service.verifyWhatsAppSignature(Buffer.from(body), undefined)).toBe(true);
    });

    it('REJECTS in production when no secret is configured', () => {
      // Failing open in production would leave the webhook publicly writable.
      const service = makeService({ WHATSAPP_APP_SECRET: '', isProduction: true });
      expect(service.verifyWhatsAppSignature(Buffer.from(body), sign(body))).toBe(false);
    });
  });

  describe('subscription handshake', () => {
    it('accepts the correct mode and token', () => {
      expect(makeService().verifySubscription('subscribe', VERIFY_TOKEN)).toBe(true);
    });

    it('rejects a wrong token, wrong mode, or missing token', () => {
      const service = makeService();
      expect(service.verifySubscription('subscribe', 'wrong-token')).toBe(false);
      expect(service.verifySubscription('unsubscribe', VERIFY_TOKEN)).toBe(false);
      expect(service.verifySubscription('subscribe', undefined)).toBe(false);
    });

    it('rejects a token of a different length without throwing', () => {
      // timingSafeEqual throws on length mismatch; the guard must come first.
      expect(() => makeService().verifySubscription('subscribe', 'short')).not.toThrow();
      expect(makeService().verifySubscription('subscribe', 'short')).toBe(false);
    });
  });
});

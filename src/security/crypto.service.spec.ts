import { AppEnv } from '../config/env';
import { CryptoService } from './crypto.service';

const KEY = 'a'.repeat(64); // 32 bytes hex

function makeService(key = KEY): CryptoService {
  return new CryptoService({ ENCRYPTION_KEY: key } as AppEnv);
}

describe('CryptoService', () => {
  const service = makeService();

  describe('encrypt / decrypt', () => {
    it('round-trips a value', () => {
      const plaintext = 'D/1234/2015';
      expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
    });

    it('produces different ciphertext each time', () => {
      // A fresh IV per call. Identical ciphertext would leak that two advocates
      // share an enrolment number.
      const a = service.encrypt('D/1234/2015');
      const b = service.encrypt('D/1234/2015');
      expect(a).not.toBe(b);
      expect(service.decrypt(a)).toBe(service.decrypt(b));
    });

    it('handles unicode', () => {
      const plaintext = 'अधिवक्ता D/1234/2015';
      expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
    });

    it('rejects tampered ciphertext', () => {
      // GCM authenticates; a flipped byte must fail loudly rather than decrypt
      // to plausible garbage.
      const encrypted = service.encrypt('D/1234/2015');
      const [iv, ct, tag] = encrypted.split('.');
      const corrupted = `${iv}.${ct.slice(0, -2)}XY.${tag}`;
      expect(() => service.decrypt(corrupted)).toThrow();
    });

    it('rejects a malformed payload', () => {
      expect(() => service.decrypt('not-valid')).toThrow(/Malformed ciphertext/);
    });

    it('cannot be decrypted with a different key', () => {
      const other = makeService('b'.repeat(64));
      expect(() => other.decrypt(service.encrypt('secret'))).toThrow();
    });
  });

  describe('blindIndex', () => {
    it('is deterministic', () => {
      expect(service.blindIndex('D/1234/2015')).toBe(service.blindIndex('D/1234/2015'));
    });

    it('normalises case and surrounding whitespace', () => {
      // The same enrolment number typed differently must collide, or the
      // uniqueness constraint does not catch a duplicate registration.
      expect(service.blindIndex('  d/1234/2015 ')).toBe(service.blindIndex('D/1234/2015'));
    });

    it('differs for different values', () => {
      expect(service.blindIndex('D/1234/2015')).not.toBe(service.blindIndex('D/1234/2016'));
    });

    it('is key-dependent', () => {
      const other = makeService('c'.repeat(64));
      expect(other.blindIndex('D/1234/2015')).not.toBe(service.blindIndex('D/1234/2015'));
    });
  });

  describe('safeEqual', () => {
    it('compares equal and unequal values', () => {
      expect(service.safeEqual('token', 'token')).toBe(true);
      expect(service.safeEqual('token', 'other')).toBe(false);
    });

    it('does not throw on mismatched lengths', () => {
      expect(() => service.safeEqual('short', 'much-longer-value')).not.toThrow();
      expect(service.safeEqual('short', 'much-longer-value')).toBe(false);
    });
  });
});

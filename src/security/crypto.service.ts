import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';

/**
 * Application-level encryption for PII at rest.
 *
 * Supabase encrypts the whole disk, which protects against someone walking off
 * with the storage. It does not protect against a leaked service-role key or an
 * accidental `SELECT *` in a support query. Bar council registration numbers are
 * regulated personal data under the DPDP Act 2023, so they get a second layer
 * that is only removable with a key the database never sees.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(@InjectEnv() env: AppEnv) {
    this.key = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  }

  /**
   * AES-256-GCM. Output is `iv.ciphertext.authTag`, base64url per part.
   *
   * GCM rather than CBC because it authenticates as well as encrypts: a
   * tampered ciphertext fails to decrypt instead of yielding plausible garbage.
   * A fresh random IV per call is what makes the same input produce different
   * ciphertext each time - which is also why this output can never be used for
   * lookups. Use {@link blindIndex} for that.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64url'), ciphertext.toString('base64url'), authTag.toString('base64url')].join(
      '.',
    );
  }

  decrypt(encoded: string): string {
    const parts = encoded.split('.');
    if (parts.length !== 3) {
      throw new Error('Malformed ciphertext: expected iv.ciphertext.authTag');
    }
    const [iv, ciphertext, authTag] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /**
   * Deterministic HMAC of a value, for equality search on encrypted columns.
   *
   * This is the standard blind-index trick: the same input always produces the
   * same digest, so it can carry a unique constraint and answer "is this bar
   * council number already registered?" - but it is not reversible, so a dump
   * of the column reveals nothing.
   *
   * The tradeoff is that identical inputs are visibly identical. That is
   * acceptable for a registration number (which is unique by definition) and
   * would not be for something low-entropy like a PIN.
   */
  blindIndex(value: string): string {
    return createHmac('sha256', this.key).update(value.trim().toUpperCase()).digest('hex');
  }

  /** Constant-time comparison, for anything secret-shaped. */
  safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    // timingSafeEqual throws on length mismatch, which is itself a leak; the
    // length check is unavoidable, so compare against a fixed-size digest.
    if (bufA.length !== bufB.length) {
      const digestA = createHmac('sha256', this.key).update(bufA).digest();
      const digestB = createHmac('sha256', this.key).update(bufB).digest();
      return timingSafeEqual(digestA, digestB);
    }
    return timingSafeEqual(bufA, bufB);
  }
}

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { CryptoService } from '../security/crypto.service';
import { RedisService } from '../redis/redis.service';
import { SETTING_DEFINITIONS, isKnownSetting, isSecretSetting } from './settings.catalog';

/** Redis channel every process listens on for "settings changed, re-read". */
const SETTINGS_CHANNEL = 'vakeel:settings:changed';

/**
 * Safety net for a dropped pub/sub connection. Pub/sub is fire-and-forget: if a
 * worker's subscriber drops at the moment an admin saves, it would keep serving
 * stale settings forever. A slow poll bounds that staleness to 60s.
 */
const REFRESH_INTERVAL_MS = 60_000;

export interface SettingRow {
  key: string;
  value: string;
  is_secret: boolean;
  updated_by: string;
  updated_at: Date;
}

/** What the admin API exposes. Secret values are never included. */
export interface SettingView {
  key: string;
  /** Plaintext for ordinary settings; null for secrets. */
  value: string | null;
  isSecret: boolean;
  isSet: boolean;
  /** Last 4 characters of a secret, e.g. '••••a3f9'. Null when unset. */
  hint: string | null;
  /** True when the live value comes from app_settings rather than the env. */
  overridden: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * Runtime configuration with database override.
 *
 * Resolution order for any key in the catalogue:
 *
 *     app_settings row  ->  environment variable  ->  undefined
 *
 * Everything reads through here rather than touching `env` directly, which is
 * what makes "paste new WhatsApp credentials into the admin panel and have the
 * bot switch numbers" work without a redeploy.
 *
 * ## Consistency model
 *
 * Each process keeps an in-memory snapshot. A write publishes on Redis and every
 * process re-reads. So a change is visible across web and worker in roughly the
 * time of one Redis round trip, with a 60-second poll as backstop.
 *
 * This is deliberately eventually-consistent. The alternative - reading the
 * table on every message - would add a query to the hot path of a system whose
 * whole design goal is a sub-200ms webhook ack, to fix a race that lasts
 * milliseconds and whose worst outcome is one message answered with the
 * previous configuration.
 */
@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = getLogger().child({ module: 'settings' });

  /** Decrypted, ready to read. Empty until the first refresh completes. */
  private cache = new Map<string, string>();
  private meta = new Map<string, { updatedBy: string; updatedAt: Date }>();

  private subscriber?: Redis;
  private timer?: NodeJS.Timeout;
  private ready = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();

    // A subscribed ioredis connection cannot issue ordinary commands, so this
    // needs its own socket rather than sharing the main client.
    this.subscriber = this.redis.createQueueConnection();
    await this.subscriber.subscribe(SETTINGS_CHANNEL).catch((err) => {
      this.logger.warn({ err }, 'Could not subscribe to settings channel; falling back to polling');
    });
    this.subscriber.on('message', (channel) => {
      if (channel !== SETTINGS_CHANNEL) return;
      void this.refresh().catch((err) => this.logger.error({ err }, 'Settings refresh failed'));
    });

    this.timer = setInterval(() => {
      void this.refresh().catch((err) => this.logger.debug({ err }, 'Periodic settings refresh failed'));
    }, REFRESH_INTERVAL_MS);
    // Do not hold the event loop open just for the refresh timer.
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }

  /**
   * Reload the whole table into memory.
   *
   * A row that fails to decrypt is skipped rather than thrown: that happens when
   * ENCRYPTION_KEY is rotated without re-encrypting, and it must degrade to
   * "this setting falls back to the environment", not "the process will not
   * start".
   */
  async refresh(): Promise<void> {
    let rows: SettingRow[];
    try {
      rows = await this.db.sql<SettingRow[]>`SELECT key, value, is_secret, updated_by, updated_at FROM app_settings`;
    } catch (err) {
      // Migration 0007 may not have run yet. Env-only operation is a valid state.
      this.logger.warn({ err }, 'Could not read app_settings; using environment values only');
      this.ready = true;
      return;
    }

    const next = new Map<string, string>();
    const nextMeta = new Map<string, { updatedBy: string; updatedAt: Date }>();

    for (const row of rows) {
      if (!isKnownSetting(row.key)) continue;

      let value = row.value;
      if (row.is_secret) {
        try {
          value = this.crypto.decrypt(row.value);
        } catch (err) {
          this.logger.error(
            { err, key: row.key },
            'Could not decrypt setting - has ENCRYPTION_KEY changed? Falling back to the environment value.',
          );
          continue;
        }
      }

      next.set(row.key, value);
      nextMeta.set(row.key, { updatedBy: row.updated_by, updatedAt: row.updated_at });
    }

    this.cache = next;
    this.meta = nextMeta;
    this.ready = true;
    this.logger.debug({ count: next.size }, 'Settings refreshed');
  }

  /** True once the first load has completed. */
  isReady(): boolean {
    return this.ready;
  }

  // --- Reads ----------------------------------------------------------------

  /** Database override, else environment, else empty string. */
  get(key: string): string {
    const override = this.cache.get(key);
    if (override !== undefined && override !== '') return override;

    const fromEnv = (this.env as unknown as Record<string, unknown>)[key];
    return fromEnv === undefined || fromEnv === null ? '' : String(fromEnv);
  }

  getNumber(key: string, fallback: number): number {
    const raw = this.get(key);
    if (raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  getBoolean(key: string, fallback = false): boolean {
    const raw = this.get(key).toLowerCase();
    if (raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw);
  }

  /** True when a live value exists from either source. */
  has(key: string): boolean {
    return this.get(key) !== '';
  }

  // --- WhatsApp convenience -------------------------------------------------
  //
  // These mirror the derived fields on AppEnv, but resolve through the override
  // chain. Anything sending or verifying WhatsApp traffic must use these rather
  // than env.whatsappApiBase, or an admin-panel credential change is ignored.

  get whatsappAccessToken(): string {
    return this.get('WHATSAPP_ACCESS_TOKEN');
  }

  get whatsappPhoneNumberId(): string {
    return this.get('WHATSAPP_PHONE_NUMBER_ID');
  }

  get whatsappAppSecret(): string {
    return this.get('WHATSAPP_APP_SECRET');
  }

  get whatsappVerifyToken(): string {
    return this.get('WHATSAPP_VERIFY_TOKEN');
  }

  /** Graph root for the *currently configured* number. */
  get whatsappApiBase(): string {
    const version = this.get('WHATSAPP_API_VERSION') || 'v23.0';
    return `${this.env.WHATSAPP_GRAPH_BASE_URL}/${version}/${this.whatsappPhoneNumberId}`;
  }

  /** Graph root without a phone number, for media and account endpoints. */
  get whatsappGraphRoot(): string {
    const version = this.get('WHATSAPP_API_VERSION') || 'v23.0';
    return `${this.env.WHATSAPP_GRAPH_BASE_URL}/${version}`;
  }

  /** Can we actually send? Mirrors env.whatsappConfigured but override-aware. */
  get whatsappConfigured(): boolean {
    return Boolean(this.whatsappAccessToken && this.whatsappPhoneNumberId && this.whatsappAppSecret);
  }

  // --- Writes ---------------------------------------------------------------

  /**
   * Persist a setting and tell every process to re-read.
   *
   * Secrets are encrypted here, so the plaintext never reaches the database.
   */
  async set(key: string, value: string, changedBy = 'admin'): Promise<void> {
    if (!isKnownSetting(key)) {
      throw new Error(`Unknown setting: ${key}`);
    }

    const secret = isSecretSetting(key);
    const stored = secret ? this.crypto.encrypt(value) : value;
    const previous = this.cache.get(key);

    await this.db.sql`
      INSERT INTO app_settings (key, value, is_secret, updated_by)
      VALUES (${key}, ${stored}, ${secret}, ${changedBy})
      ON CONFLICT (key) DO UPDATE
        SET value      = EXCLUDED.value,
            is_secret  = EXCLUDED.is_secret,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
    `;

    await this.audit(key, 'SET', previous, value, secret, changedBy);
    await this.publishChange();

    this.logger.info({ key, changedBy, secret }, 'Setting updated');
  }

  /** Remove the override so the environment value applies again. */
  async clear(key: string, changedBy = 'admin'): Promise<void> {
    if (!isKnownSetting(key)) {
      throw new Error(`Unknown setting: ${key}`);
    }

    const previous = this.cache.get(key);
    await this.db.sql`DELETE FROM app_settings WHERE key = ${key}`;
    await this.audit(key, 'CLEAR', previous, undefined, isSecretSetting(key), changedBy);
    await this.publishChange();

    this.logger.info({ key, changedBy }, 'Setting cleared - reverting to environment value');
  }

  /** Apply several settings in one go, skipping blanks. */
  async setMany(values: Record<string, string>, changedBy = 'admin'): Promise<string[]> {
    const applied: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (!isKnownSetting(key)) continue;
      // A blank secret means "leave the existing one alone" - otherwise the
      // admin form, which never renders secret values, would wipe every secret
      // on each save.
      if (value === '' && isSecretSetting(key)) continue;
      await this.set(key, value, changedBy);
      applied.push(key);
    }
    return applied;
  }

  private async audit(
    key: string,
    action: 'SET' | 'CLEAR',
    oldValue: string | undefined,
    newValue: string | undefined,
    secret: boolean,
    changedBy: string,
  ): Promise<void> {
    // Never record secret values, not even truncated - a 20-character prefix of
    // an access token is still most of an access token.
    const preview = (v: string | undefined): string | null =>
      v === undefined ? null : secret ? '(secret)' : v.slice(0, 200);

    try {
      await this.db.sql`
        INSERT INTO settings_audit (key, action, old_preview, new_preview, changed_by)
        VALUES (${key}, ${action}, ${preview(oldValue)}, ${preview(newValue)}, ${changedBy})
      `;
    } catch (err) {
      this.logger.warn({ err, key }, 'Could not write settings audit row');
    }
  }

  private async publishChange(): Promise<void> {
    await this.refresh();
    try {
      await this.redis.client.publish(SETTINGS_CHANNEL, Date.now().toString());
    } catch (err) {
      // Other processes will still pick the change up on their next poll.
      this.logger.warn({ err }, 'Could not publish settings change; peers will refresh within 60s');
    }
  }

  // --- Admin presentation ---------------------------------------------------

  /** Every catalogue entry with its current state, safe to serialise to the UI. */
  describeAll(): SettingView[] {
    return SETTING_DEFINITIONS.map((def) => {
      const override = this.cache.get(def.key);
      const live = this.get(def.key);
      const meta = this.meta.get(def.key);
      const secret = def.type === 'secret';

      return {
        key: def.key,
        value: secret ? null : live,
        isSecret: secret,
        isSet: live !== '',
        hint: secret && live !== '' ? `••••${live.slice(-4)}` : null,
        overridden: override !== undefined && override !== '',
        updatedBy: meta?.updatedBy ?? null,
        updatedAt: meta?.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
      };
    });
  }
}

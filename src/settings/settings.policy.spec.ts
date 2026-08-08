import { SETTING_DEFINITIONS, isSecretSetting } from './settings.catalog';

/**
 * The credential policy, asserted at the catalogue level.
 *
 * SettingsService.set() refuses any key where `isSecretSetting(key)` is true, so
 * whether a given credential is protected comes down entirely to its `type` in
 * the catalogue. A new API key added with `type: 'text'` would be silently
 * writable from the panel - and, worse, would then shadow the environment
 * variable, which is the exact failure that took the WhatsApp integration down.
 *
 * These tests are the guard on that mistake.
 */
describe('credential settings policy', () => {
  const CREDENTIAL_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/;

  it('marks every credential-shaped key as a secret', () => {
    const misclassified = SETTING_DEFINITIONS.filter(
      (def) => CREDENTIAL_PATTERN.test(def.key) && def.type !== 'secret',
    ).map((def) => def.key);

    expect(misclassified).toEqual([]);
  });

  it('recognises each known credential', () => {
    for (const key of [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_VERIFY_TOKEN',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'KANOON_API_KEY',
      'ECOURTS_API_KEY',
    ]) {
      expect(isSecretSetting(key)).toBe(true);
    }
  });

  it('leaves operational tuning editable', () => {
    // The panel would be pointless if these needed a redeploy.
    for (const key of [
      'PRECEDENT_SOURCE',
      'RAG_FINAL_TOP_K',
      'QUOTA_GUEST_DAILY',
      'ECOURTS_MODE',
      'LLM_SYNTHESIS_PROVIDER',
      'KANOON_CACHE_TTL_SECONDS',
    ]) {
      expect(isSecretSetting(key)).toBe(false);
    }
  });

  it('never exposes the infrastructure credentials in the catalogue at all', () => {
    // These are needed to reach or decrypt the settings table itself, so a
    // panel that could edit them could lock the operator out of the form that
    // fixes them.
    const keys = SETTING_DEFINITIONS.map((d) => d.key);
    for (const forbidden of ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY', 'JWT_SECRET', 'ADMIN_PASSWORD']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('gives every setting help text an operator can act on', () => {
    for (const def of SETTING_DEFINITIONS) {
      expect(def.help.length).toBeGreaterThan(20);
      expect(def.label.length).toBeGreaterThan(0);
    }
  });

  it('gives every select option at least two choices', () => {
    for (const def of SETTING_DEFINITIONS.filter((d) => d.type === 'select')) {
      expect(def.options?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});

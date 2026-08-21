import { Injectable } from '@nestjs/common';
import { CircuitBreaker, CircuitOpenError } from '../common/circuit-breaker';
import { getLogger } from '../common/logger';
import { LruCache } from '../common/lru-cache';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { isValidCnr } from '../ai/legal-patterns';
import { SettingsService } from '../settings/settings.service';

export interface CaseStatus {
  cnr: string;
  caseNumber: string | null;
  caseType: string | null;
  filingDate: string | null;
  registrationDate: string | null;
  court: string | null;
  judge: string | null;
  petitioner: string | null;
  respondent: string | null;
  petitionerAdvocate: string | null;
  respondentAdvocate: string | null;
  stage: string | null;
  nextHearingDate: string | null;
  lastHearingDate: string | null;
  status: 'PENDING' | 'DISPOSED' | 'UNKNOWN';
  /** True when this came from the mock adapter and is not real court data. */
  mocked: boolean;
}

export class CnrNotFoundError extends Error {
  constructor(cnr: string) {
    super(`No case found for CNR ${cnr}`);
    this.name = 'CnrNotFoundError';
  }
}

/** Cache successful lookups for an hour; cause lists move daily, not hourly. */
const CACHE_TTL_SECONDS = 3600;

/**
 * Case status lookup by CNR.
 *
 * ## Why this is an adapter with a mock mode
 *
 * India's eCourts services expose no free public API. The realistic options are
 * a paid third-party API, or scraping the eCourts portal - and the portal is
 * CAPTCHA-protected and changes without notice, which the spec's own risk
 * matrix rates as high impact and high probability.
 *
 * Rather than ship a scraper that will break, this is an adapter with two
 * modes. `mock` returns clearly-labelled synthetic data so the whole
 * conversation flow can be built and demonstrated. `http` calls a provider you
 * have subscribed to; point ECOURTS_BASE_URL at it and map the response in
 * {@link mapProviderResponse}, which is the only method that should need
 * changing.
 *
 * Note the spec also proposes CAPTCHA-solving as mitigation. That is
 * deliberately not implemented here - defeating a government portal's bot
 * protection is a legal exposure the product does not need, and an official API
 * subscription is the durable answer.
 */
@Injectable()
export class EcourtsService {
  private readonly logger = getLogger().child({ module: 'ecourts' });
  private readonly breaker: CircuitBreaker;

  private readonly cache = new LruCache<CaseStatus>(1_000, CACHE_TTL_SECONDS);

  constructor(
    @InjectEnv() private readonly env: AppEnv,
    private readonly settings: SettingsService,
  ) {
    this.breaker = new CircuitBreaker('ecourts', env.ECOURTS_BREAKER_THRESHOLD, env.ECOURTS_BREAKER_RESET_MS);
  }

  /** Read per-call so the admin panel can flip mock/http without a redeploy. */
  private get mode(): string {
    return this.settings.get('ECOURTS_MODE') || this.env.ECOURTS_MODE;
  }

  async lookup(rawCnr: string): Promise<CaseStatus> {
    const cnr = rawCnr.toUpperCase().replace(/[\s\-_/]/g, '');

    if (!isValidCnr(cnr)) {
      throw new CnrNotFoundError(cnr);
    }

    // Memory only, unlike Kanoon. A CNR lookup is free to us either way, so
    // there is nothing to protect against a deploy - and cause lists move
    // daily, so a cache that survived restarts would mostly serve stale
    // hearing dates.
    const cacheKey = `ecourts:cnr:${cnr}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug({ cnr }, 'CNR served from cache');
      return cached;
    }

    const result =
      this.mode === 'mock'
        ? this.mockLookup(cnr)
        : await this.breaker.execute(
            () => this.httpLookup(cnr),
            // "No such case" is a healthy response, not an outage.
            (err) => !(err instanceof CnrNotFoundError),
          );

    this.cache.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  /** True when the upstream is currently being skipped, for user-facing messaging. */
  get isDegraded(): boolean {
    return this.breaker.currentState === 'OPEN';
  }

  private async httpLookup(cnr: string): Promise<CaseStatus> {
    const baseUrl = this.settings.get('ECOURTS_BASE_URL') || this.env.ECOURTS_BASE_URL;
    const apiKey = this.settings.get('ECOURTS_API_KEY') || this.env.ECOURTS_API_KEY;

    if (!baseUrl) {
      throw new Error('eCourts mode is set to http but no provider base URL is configured');
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/case/${cnr}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(this.env.ECOURTS_TIMEOUT_MS),
    });

    if (response.status === 404) {
      // A genuine "no such case" must not count towards the breaker - it is a
      // correct answer from a healthy upstream. Thrown before the generic
      // error check so it never trips the circuit.
      throw new CnrNotFoundError(cnr);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`eCourts provider returned ${response.status}: ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.mapProviderResponse(cnr, payload);
  }

  /**
   * Map a provider payload onto {@link CaseStatus}.
   *
   * Field names vary between providers, so this reads several plausible keys
   * for each value. When you subscribe to one, replace the guesswork with its
   * documented field names.
   */
  private mapProviderResponse(cnr: string, payload: Record<string, unknown>): CaseStatus {
    const data = (payload.data ?? payload.result ?? payload) as Record<string, unknown>;
    const pick = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return null;
    };

    const stage = pick('case_stage', 'stage', 'caseStage');
    const nextHearing = pick('next_hearing_date', 'nextHearingDate', 'next_date');

    return {
      cnr,
      caseNumber: pick('case_number', 'caseNumber', 'case_no'),
      caseType: pick('case_type', 'caseType'),
      filingDate: pick('filing_date', 'filingDate'),
      registrationDate: pick('registration_date', 'registrationDate'),
      court: pick('court_name', 'courtName', 'court'),
      judge: pick('judge', 'judge_name', 'coram'),
      petitioner: pick('petitioner', 'petitioner_name', 'plaintiff'),
      respondent: pick('respondent', 'respondent_name', 'defendant'),
      petitionerAdvocate: pick('petitioner_advocate', 'petitionerAdvocate'),
      respondentAdvocate: pick('respondent_advocate', 'respondentAdvocate'),
      stage,
      nextHearingDate: nextHearing,
      lastHearingDate: pick('last_hearing_date', 'lastHearingDate'),
      status: /dispos/i.test(stage ?? '') ? 'DISPOSED' : nextHearing ? 'PENDING' : 'UNKNOWN',
      mocked: false,
    };
  }

  /**
   * Synthetic but deterministic case data.
   *
   * Derived from the CNR itself so the same input always returns the same case,
   * which makes it usable in tests and demos. `mocked: true` propagates to the
   * reply so nobody mistakes it for a real cause list entry.
   */
  private mockLookup(cnr: string): CaseStatus {
    const seed = [...cnr].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const year = cnr.slice(12, 16);

    const stages = [
      'Appearance',
      'Framing of Charge',
      'Prosecution Evidence',
      'Defence Evidence',
      'Final Arguments',
      'Judgment',
    ];
    const courts = [
      'District & Sessions Court, Central Delhi',
      'Additional Sessions Judge, Mumbai',
      'Chief Judicial Magistrate, Pune',
      'District Court, Bengaluru Urban',
    ];

    const nextHearing = new Date();
    nextHearing.setDate(nextHearing.getDate() + (seed % 45) + 5);

    const lastHearing = new Date();
    lastHearing.setDate(lastHearing.getDate() - ((seed % 30) + 3));

    return {
      cnr,
      caseNumber: `CC/${1000 + (seed % 8999)}/${year}`,
      caseType: seed % 2 === 0 ? 'Criminal Case' : 'Civil Suit',
      filingDate: `${year}-0${(seed % 9) + 1}-1${seed % 9}`,
      registrationDate: `${year}-0${(seed % 9) + 1}-2${seed % 8}`,
      court: courts[seed % courts.length],
      judge: `Hon'ble Judge (Court No. ${(seed % 12) + 1})`,
      petitioner: 'State of Maharashtra',
      respondent: `Accused No. ${(seed % 4) + 1}`,
      petitionerAdvocate: 'Public Prosecutor',
      respondentAdvocate: 'Adv. (on record)',
      stage: stages[seed % stages.length],
      nextHearingDate: nextHearing.toISOString().slice(0, 10),
      lastHearingDate: lastHearing.toISOString().slice(0, 10),
      status: 'PENDING',
      mocked: true,
    };
  }
}

export { CircuitOpenError };

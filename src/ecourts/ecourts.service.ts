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
  /**
   * The registration number, as an advocate would quote it - "W.P.(C) 138/2024".
   *
   * Not the provider's internal `caseNumber`, which on eCourtsIndia is a
   * 15-digit string that appears on no document anybody holds.
   */
  caseNumber: string | null;
  /**
   * The filing number, which is a different number from the registration one.
   *
   * The card printed `caseNumber` on both lines and so asserted the two were
   * the same. On the first real record they were "9623/2024" and "138/2024".
   */
  filingNumber: string | null;
  caseType: string | null;
  filingDate: string | null;
  registrationDate: string | null;
  /**
   * First listing, which is not the last one.
   *
   * The card labelled a line "First Hearing Date" and printed
   * `lastHearingDate` into it. On a matter running two years that is a
   * confidently wrong date on the field an advocate checks first.
   */
  firstHearingDate: string | null;
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

/**
 * The adapter is pointed at something that is not the provider's API.
 *
 * Distinct from a transport failure because the operator's next step is
 * completely different, and because the two are otherwise indistinguishable
 * from the log line: both are "a request did not produce a case".
 *
 * This exists because it happened. A deployment was configured with
 * ECOURTS_BASE_URL=https://ecourtsindia.com - the marketing site - instead of
 * the API host. Every lookup got 403 text/plain, which is not a 404, so it was
 * reported to advocates as "the court records service is not responding" and to
 * the operator as an upstream outage. Nothing pointed at the one line of
 * configuration that was wrong, and eCourts was working perfectly the whole
 * time.
 */
export class EcourtsMisconfiguredError extends Error {
  constructor(readonly detail: string) {
    super(`eCourts is not correctly configured: ${detail}`);
    this.name = 'EcourtsMisconfiguredError';
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

  /**
   * Why the last lookup could not reach the provider, if it was our fault.
   *
   * Held because a misconfiguration deliberately does not open the circuit -
   * retrying will never fix a wrong base URL - which means `isDegraded` stays
   * false and the panel would otherwise show eCourts as perfectly healthy while
   * every advocate gets an error. This is the one place an operator can see the
   * actual sentence.
   *
   * Cleared by the next successful lookup, so a fixed deployment stops
   * reporting a fault it no longer has.
   */
  private configurationFault: string | null = null;

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

    const result = await this.runLookup(cnr);

    this.cache.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  /** The lookup itself, wrapped so the configuration fault can be tracked. */
  private async runLookup(cnr: string): Promise<CaseStatus> {
    try {
      const result = await this.dispatch(cnr);
      this.configurationFault = null;
      return result;
    } catch (err) {
      if (err instanceof EcourtsMisconfiguredError) {
        this.configurationFault = err.detail;
        this.logger.error(
          { detail: err.detail },
          'eCourts is misconfigured - this is a settings problem, not an upstream outage',
        );
      }
      throw err;
    }
  }

  private async dispatch(cnr: string): Promise<CaseStatus> {
    return this.mode === 'mock'
        ? this.mockLookup(cnr)
        : await this.breaker.execute(
            () => this.httpLookup(cnr),
            /*
             * What counts as an outage.
             *
             * "No such case" is a healthy response. So, in a different way, is
             * a rejected key or a wrong base URL: the upstream is fine and
             * retrying will never help. Counting either towards the breaker
             * would open the circuit and replace a precise error with a generic
             * "service unavailable" for the next minute - hiding the one message
             * that says what to fix.
             */
            (err) =>
              !(err instanceof CnrNotFoundError) && !(err instanceof EcourtsMisconfiguredError),
          );
  }

  /** True when the upstream is currently being skipped, for user-facing messaging. */
  get isDegraded(): boolean {
    return this.breaker.currentState === 'OPEN';
  }

  /**
   * The last configuration fault, for the admin panel.
   *
   * Null when the adapter is in mock mode - a deployment that has deliberately
   * not configured eCourts is not misconfigured, and reporting it as a fault
   * would train the operator to ignore this field.
   */
  get configurationError(): string | null {
    return this.mode === 'mock' ? null : this.configurationFault;
  }

  private async httpLookup(cnr: string): Promise<CaseStatus> {
    const baseUrl = this.settings.get('ECOURTS_BASE_URL') || this.env.ECOURTS_BASE_URL;
    const apiKey = this.settings.get('ECOURTS_API_KEY') || this.env.ECOURTS_API_KEY;

    if (!baseUrl) {
      throw new Error('eCourts mode is set to http but no provider base URL is configured');
    }

    const url = `${baseUrl.replace(/\/$/, '')}/case/${cnr}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(this.env.ECOURTS_TIMEOUT_MS),
    });

    // What kind of thing answered. A provider returns JSON; a web server that
    // has never heard of this path returns HTML or plain text, and that
    // difference is the whole of the diagnosis below.
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('json');

    /*
     * Credentials, not connectivity.
     *
     * 401 and 403 are answers from a healthy service saying the key is wrong,
     * expired, or being sent somewhere that does not want it. Reporting that as
     * an outage sends the operator to the provider's status page instead of to
     * their own environment.
     */
    if (response.status === 401 || response.status === 403) {
      const where = new URL(url).host;
      throw new EcourtsMisconfiguredError(
        `${where} rejected the API key with ${response.status}. ` +
          'Check ECOURTS_API_KEY, and check ECOURTS_BASE_URL points at the provider API ' +
          '(for eCourtsIndia: https://webapi.ecourtsindia.com/api/partner) rather than at their website.',
      );
    }

    if (response.status === 404) {
      /*
       * A 404 means "no such case" only if a provider said it.
       *
       * Any web server 404s an unknown path, so a base URL pointing at the
       * wrong host makes *every* CNR come back as not found - charged, refunded,
       * and reported to the advocate as a case that does not exist. That is the
       * silent version of the misconfiguration above, and it is worse: nothing
       * in the logs looks like an error at all.
       *
       * A JSON body is the signal that the provider answered. Anything else is
       * a wrong address.
       */
      if (!isJson) {
        throw new EcourtsMisconfiguredError(
          `${new URL(url).host} returned 404 with ${contentType || 'no content type'}, not a provider response. ` +
            'ECOURTS_BASE_URL is almost certainly wrong.',
        );
      }

      // A genuine "no such case" must not count towards the breaker - it is a
      // correct answer from a healthy upstream.
      throw new CnrNotFoundError(cnr);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`eCourts provider returned ${response.status}: ${body.slice(0, 200)}`);
    }

    // A 200 that is not JSON is the same wrong address wearing a friendlier
    // status code - a marketing page, or a proxy's holding response.
    if (!isJson) {
      throw new EcourtsMisconfiguredError(
        `${new URL(url).host} answered 200 with ${contentType || 'no content type'} instead of JSON. ` +
          'ECOURTS_BASE_URL is pointing at something that is not the provider API.',
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.mapProviderResponse(cnr, payload);
  }

  /**
   * Map an eCourtsIndia payload onto {@link CaseStatus}.
   *
   * Written against a real response rather than guessed at. The three things
   * that guessing got wrong, all of which produce a card that looks fine and is
   * missing the fields an advocate actually reads:
   *
   *   1. **The case sits two levels down**, under `data.courtCaseData`.
   *      Unwrapping only `data` reaches an object whose values are all
   *      containers, matches nothing, and renders "Not available" from a 200.
   *
   *   2. **Parties and judges are arrays.** `petitioners`, `respondents`,
   *      `judges` and both advocate fields are lists, so a reader that only
   *      accepts a string returns null for every one of them - which is to say,
   *      for everything a case status is actually for.
   *
   *   3. **The hearing dates are not in `courtCaseData` at all.** They are on
   *      the sibling `entityInfo` block, as `nextDateOfHearing` and
   *      `lastDateOfHearing`. Reading them off the case object yields null, and
   *      a null next hearing is what {@link CaseStatus.status} uses to decide a
   *      case is UNKNOWN rather than pending.
   *
   * ## The enum lookup is worth using
   *
   * Several fields are codes: `courtName` is "DLHC", `caseType` is "WP_C". The
   * response carries `descriptions.enumLookup` translating each to "High Court
   * of Delhi, Delhi" and "Writ Petition (Civil)". Printing the code instead is
   * not wrong, exactly - it is just unreadable to the person the card is for.
   *
   * The generic key lists are kept underneath so this stays an adapter: a
   * deployment pointed at another provider should not need a code change.
   */
  private mapProviderResponse(cnr: string, payload: Record<string, unknown>): CaseStatus {
    const envelope = (payload.data ?? payload.result ?? payload) as Record<string, unknown>;
    const data = (envelope.courtCaseData ?? envelope.caseDetails ?? envelope) as Record<string, unknown>;
    const entity = (envelope.entityInfo ?? {}) as Record<string, unknown>;
    const lookup = ((envelope.descriptions as Record<string, unknown> | undefined)?.enumLookup ??
      {}) as Record<string, Record<string, string>>;

    /** First key holding a usable scalar. */
    const text = (source: Record<string, unknown>, ...keys: string[]): string | null => {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      }
      return null;
    };

    /** First key holding a non-empty list of names, joined for display. */
    const names = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = data[key];
        if (Array.isArray(value)) {
          const joined = value
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter(Boolean)
            .join(', ');
          if (joined) return joined;
        }
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return null;
    };

    /** Translate a coded value through the response's own lookup table. */
    const label = (table: string, code: string | null): string | null => {
      if (!code) return null;
      return lookup[table]?.[code] ?? null;
    };

    /** Dates arrive as either a plain day or a full ISO timestamp. */
    const day = (value: string | null): string | null => {
      if (!value) return null;
      return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
    };

    const rawStatus = text(data, 'caseStatus', 'case_status', 'status');

    // "Listed for final arguments" is what an advocate wants under Stage;
    // "DISPOSED" is the status and is printed on its own line.
    const stage =
      text(data, 'purpose', 'case_stage', 'stage', 'caseStage') ??
      label('caseStatus', rawStatus) ??
      rawStatus;

    const nextHearing = day(
      text(entity, 'nextDateOfHearing') ?? text(data, 'next_hearing_date', 'nextHearingDate', 'nextDate'),
    );

    // The registration number is the one an advocate quotes - "W.P.(C) 138/2024"
    // - not the internal 15-digit `caseNumber`, which appears on nothing.
    const caseTypeLabel =
      label('caseType', text(data, 'caseType')) ?? text(data, 'caseTypeRaw', 'caseType', 'case_type');
    const registration = text(data, 'registrationNumber', 'filingNumber', 'case_number', 'caseNumber');

    const mapped: CaseStatus = {
      cnr,
      caseNumber:
        caseTypeLabel && registration ? `${caseTypeLabel} ${registration}` : registration,
      filingNumber: text(data, 'filingNumber', 'filing_number'),
      caseType: caseTypeLabel,
      filingDate: day(text(data, 'filingDate', 'filing_date')),
      registrationDate: day(text(data, 'registrationDate', 'registration_date')),
      firstHearingDate: day(text(data, 'firstHearingDate', 'first_hearing_date')),
      court:
        label('courtCode', text(data, 'cnrCourtCode', 'courtComplexCode')) ??
        text(data, 'court_name', 'courtName', 'court'),
      judge: names('judges', 'judge', 'judge_name', 'coram'),
      petitioner: names('petitioners', 'petitioner', 'plaintiff'),
      respondent: names('respondents', 'respondent', 'defendant'),
      petitionerAdvocate: names('petitionerAdvocates', 'petitioner_advocate'),
      respondentAdvocate: names('respondentAdvocates', 'respondent_advocate'),
      stage,
      nextHearingDate: nextHearing,
      lastHearingDate: day(
        text(entity, 'lastDateOfHearing') ?? text(data, 'lastHearingDate', 'last_hearing_date'),
      ),
      /*
       * Read from the provider's own status where it gives one.
       *
       * Inferring "pending" from the presence of a next hearing date - which is
       * what this did - is wrong in both directions on real data: a disposed
       * case can carry a stale listing, and a pending case between hearings has
       * no next date at all. This response says DISPOSED outright.
       */
      status: /dispos/i.test(rawStatus ?? '')
        ? 'DISPOSED'
        : /pend/i.test(rawStatus ?? '') || nextHearing
          ? 'PENDING'
          : 'UNKNOWN',
      mocked: false,
    };

    /*
     * A 200 that mapped to nothing is a bug here, not an empty court record.
     *
     * Without this the advocate pays a credit and receives a card whose every
     * line reads "Not available", which is indistinguishable from a case the
     * court has no data for - so nobody reports it, and the log says the lookup
     * succeeded. Throwing routes it through the caller's existing refund path
     * and prints the keys the provider actually sent, which is the one thing
     * needed to correct the names above.
     */
    if (!mappedAnything(mapped)) {
      this.logger.error(
        {
          cnr,
          envelopeKeys: Object.keys(envelope).slice(0, 30),
          caseKeys: Object.keys(data).slice(0, 40),
        },
        'eCourts returned a case but no field could be mapped - the provider field names differ from mapProviderResponse()',
      );
      throw new Error('eCourts response could not be mapped to a case record');
    }

    return mapped;
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
      filingNumber: `F/${2000 + (seed % 7999)}/${year}`,
      caseType: seed % 2 === 0 ? 'Criminal Case' : 'Civil Suit',
      filingDate: `${year}-0${(seed % 9) + 1}-1${seed % 9}`,
      registrationDate: `${year}-0${(seed % 9) + 1}-2${seed % 8}`,
      firstHearingDate: `${year}-0${(seed % 9) + 1}-2${seed % 8}`,
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

/**
 * Did the mapping find anything an advocate can read?
 *
 * `cnr` and `mocked` are set by us, not by the provider, so they are excluded -
 * counting them would make every failed mapping look partially successful.
 */
function mappedAnything(status: CaseStatus): boolean {
  const { cnr: _cnr, mocked: _mocked, status: _status, ...fromProvider } = status;
  return Object.values(fromProvider).some((value) => value !== null && value !== '');
}

export { CircuitOpenError };

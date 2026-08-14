import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CircuitBreaker } from '../common/circuit-breaker';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { PrecedentRow } from '../database/types';
import { RedisService } from '../redis/redis.service';
import { SettingsService } from '../settings/settings.service';
import { applyCourtFilter, toPrecedentRows } from './kanoon.mapper';
import { KanoonSearchDoc, KanoonSearchResponse } from './kanoon.types';
import { parseFoundCount } from './kanoon.mapper';

/** Kanoon returns ten results per page; there is no page-size parameter. */
const PAGE_SIZE = 10;

export class KanoonNotConfiguredError extends Error {
  constructor() {
    super('Indian Kanoon API key is not configured');
    this.name = 'KanoonNotConfiguredError';
  }
}

/**
 * Live case law search against Indian Kanoon.
 *
 * ## Caching is not an optimisation here
 *
 * Indian Kanoon bills per query. Without a cache, every WhatsApp message that
 * mentions case law costs money and adds a network round trip to the reply -
 * and advocates researching one matter ask near-identical questions repeatedly.
 * Results are cached for a day by default, which is safe because reported
 * judgments do not change once published.
 *
 * ## What this can and cannot give you
 *
 * Kanoon's search returns a snippet, a title, a court and a date. It does NOT
 * return citations, headnotes, the ratio, or the statutory provisions at issue -
 * those fields come back null, and the WhatsApp card offers the indiankanoon.org
 * link instead. Fabricating a citation-shaped string here would be worse than
 * useless: it would look quotable in a filing and not be real.
 *
 * ## Failure behaviour
 *
 * Wrapped in the same circuit breaker as the eCourts adapter, so a Kanoon
 * outage stops being retried rather than adding fifteen seconds of timeout to
 * every message. The caller falls back to the local corpus.
 */
@Injectable()
export class KanoonService {
  private readonly logger = getLogger().child({ module: 'kanoon' });
  private readonly breaker: CircuitBreaker;

  constructor(
    @InjectEnv() private readonly env: AppEnv,
    private readonly settings: SettingsService,
    private readonly redis: RedisService,
  ) {
    this.breaker = new CircuitBreaker(
      'kanoon',
      this.env.KANOON_BREAKER_THRESHOLD,
      this.env.KANOON_BREAKER_RESET_MS,
    );
  }

  /** Resolved through settings so the key can be pasted into the admin panel. */
  private get apiKey(): string {
    return this.settings.get('KANOON_API_KEY') || this.env.KANOON_API_KEY;
  }

  private get baseUrl(): string {
    return (this.settings.get('KANOON_BASE_URL') || this.env.KANOON_BASE_URL).replace(/\/$/, '');
  }

  private get cacheTtl(): number {
    return this.settings.getNumber('KANOON_CACHE_TTL_SECONDS', this.env.KANOON_CACHE_TTL_SECONDS);
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** True while the breaker is open, for user-facing messaging. */
  get isDegraded(): boolean {
    return this.breaker.currentState === 'OPEN';
  }

  /**
   * Search case law, newest first, capped at `maxResults`.
   *
   * Throws {@link KanoonNotConfiguredError} when no key is set so the caller can
   * fall back to the local corpus without treating it as an outage.
   */
  async search(query: string, maxResults: number): Promise<PrecedentRow[]> {
    if (!this.isConfigured) throw new KanoonNotConfiguredError();

    const normalised = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalised) return [];

    const cacheKey = this.cacheKey(normalised, maxResults);

    const cached = await this.redis.getJson<PrecedentRow[]>(cacheKey);
    if (cached) {
      this.logger.debug({ query: normalised, results: cached.length }, 'Kanoon result served from cache');
      // JSON has no Date type, so judgment_date came back as a string and the
      // formatter's date handling would silently produce "Invalid Date".
      return cached.map((row) => ({
        ...row,
        judgment_date: row.judgment_date ? new Date(row.judgment_date) : null,
      }));
    }

    const rows = await this.breaker.execute(
      () => this.fetchPages(normalised, maxResults),
      // A configuration mistake is not an outage; do not let it open the breaker.
      (err) => !(err instanceof KanoonNotConfiguredError),
    );

    await this.redis.setJson(cacheKey, rows, this.cacheTtl);
    return rows;
  }

  /**
   * Fetch enough pages to satisfy `maxResults`.
   *
   * Pages are requested in parallel: Kanoon has no page-size parameter, so 15
   * results always means two calls, and doing them sequentially would double
   * the latency an advocate waits for.
   */
  private async fetchPages(query: string, maxResults: number): Promise<PrecedentRow[]> {
    const pageCount = Math.min(Math.ceil(maxResults / PAGE_SIZE), 3);

    const pages = await Promise.all(
      Array.from({ length: pageCount }, (_, index) => this.fetchPage(query, index)),
    );

    const docs: KanoonSearchDoc[] = [];
    let total: number | null = null;

    for (const page of pages) {
      if (total === null) total = parseFoundCount(page.found);
      docs.push(...(page.docs ?? []));
    }

    const rows = toPrecedentRows(docs, total ?? docs.length, maxResults);

    this.logger.info(
      { query, pages: pageCount, received: docs.length, returned: rows.length, total },
      'Kanoon search complete',
    );

    return rows;
  }

  private async fetchPage(query: string, pageNum: number): Promise<KanoonSearchResponse> {
    // A named court becomes a doctypes: restriction. Sent verbatim it is only
    // relevance text, so "judgments from Karnataka High Court" returned Delhi
    // and Bombay - the advocate's one explicit constraint was the only part of
    // the question ignored.
    const url = `${this.baseUrl}/search/?formInput=${encodeURIComponent(applyCourtFilter(query))}&pagenum=${pageNum}`;

    // Kanoon's API is POST-only and uses `Token <key>`, not `Bearer`.
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Token ${this.apiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.env.KANOON_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      // Distinguished from a generic failure because the fix is a new key, not
      // a retry - and because it should be visible in the logs as such.
      throw new Error(`Indian Kanoon rejected the API key (HTTP ${response.status})`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Indian Kanoon returned ${response.status}: ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as KanoonSearchResponse;

    // The API answers 200 with an error body on some malformed queries.
    if (payload.error || payload.errmsg) {
      throw new Error(`Indian Kanoon error: ${payload.errmsg ?? payload.error}`);
    }

    return payload;
  }

  /**
   * Hash the query rather than embedding it in the key.
   *
   * Advocates' questions are personal data under the DPDP Act, and Redis keys
   * turn up in monitoring dashboards and slow-log output. The hash keeps the
   * cache working without putting the question itself in a place nobody
   * remembers to redact.
   */
  private cacheKey(query: string, maxResults: number): string {
    const digest = createHash('sha256').update(`${query}|${maxResults}`).digest('hex').slice(0, 32);
    return `kanoon:search:${digest}`;
  }
}

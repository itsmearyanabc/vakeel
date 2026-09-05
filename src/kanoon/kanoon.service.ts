import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CircuitBreaker } from '../common/circuit-breaker';
import { getLogger } from '../common/logger';
import { LruCache } from '../common/lru-cache';
import { CacheRepository } from '../database/repositories/cache.repository';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { PrecedentRow } from '../database/types';
import { SettingsService } from '../settings/settings.service';
import { applyCourtFilter, toPrecedentRows } from './kanoon.mapper';
import { DocumentHeader, parseDocumentHeader } from './document.parser';
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

  /**
   * In-process tier. Bounded so a long-running container cannot grow until it
   * is killed; 500 searches is far more than any one advocate produces in a day.
   */
  private readonly hot = new LruCache<PrecedentRow[]>(500, 86_400);

  /**
   * Parsed document headers, keyed by Kanoon's document id.
   *
   * Larger than the search cache and far cheaper per entry - two short strings
   * against a page of rows - because the same judgment turns up across many
   * different searches and each miss costs a billed call and a megabyte.
   */
  private readonly hotHeaders = new LruCache<DocumentHeader>(2_000, 86_400);

  constructor(
    private readonly cache: CacheRepository,
    @InjectEnv() private readonly env: AppEnv,
    private readonly settings: SettingsService,
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

    // Two tiers, because the two failure modes are different. Memory is free
    // and fast and empty after every deploy; the table survives a restart,
    // which is what stops a release from re-buying every search an advocate
    // already paid for today. Kanoon bills per query, so that is real money.
    const hot = this.hot.get(cacheKey);
    if (hot) {
      this.logger.debug({ query: normalised, results: hot.length }, 'Kanoon result served from memory');
      return reviveDates(hot);
    }

    const stored = await this.cache.get<PrecedentRow[]>(cacheKey);
    if (stored) {
      this.logger.debug({ query: normalised, results: stored.length }, 'Kanoon result served from the cache table');
      this.hot.set(cacheKey, stored, this.cacheTtl);
      return reviveDates(stored);
    }

    const rows = await this.breaker.execute(
      () => this.fetchPages(normalised, maxResults),
      // A configuration mistake is not an outage; do not let it open the breaker.
      (err) => !(err instanceof KanoonNotConfiguredError),
    );

    this.hot.set(cacheKey, rows, this.cacheTtl);
    await this.cache.set(cacheKey, rows, this.cacheTtl);
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

    /*
     * The field names on the first document, verbatim.
     *
     * Every live search so far has produced "LEGAL PRINCIPLE: Not available" on
     * every card, and best_excerpt comes from one field - `headline`. Whether
     * that field is absent from these responses, or present and empty, or
     * present under another name, is not something the mapped rows can answer:
     * by then it is a null either way.
     *
     * Logged once per search rather than reasoned about. Also `bench` and
     * `author`, which fill the BENCH line and have been intermittent in the
     * same way.
     */
    const sample = docs[0];
    this.logger.info(
      {
        query,
        pages: pageCount,
        received: docs.length,
        returned: rows.length,
        total,
        fields: sample ? Object.keys(sample).sort() : [],
        hasHeadline: Boolean(sample?.headline),
        hasAuthor: Boolean(sample?.author),
        headlineLength: sample?.headline?.length ?? 0,
      },
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
  /**
   * The case number and the coram, from the judgment itself.
   *
   * ## Why this needs a second call
   *
   * Neither is a field. The live API returns, for a search result: authorid,
   * bench, catids, docsize, docsource, doctype, fragment, headline, numcitedby,
   * numcites, publishdate, tid, title - and `bench` is a list of numeric author
   * ids, not names. The document adds `doc`, the judgment as HTML, and the
   * case number and the real coram are inside its header.
   *
   * ## What is cached, and what is not
   *
   * The parsed header, never the document. The sample was 1.1 MB and there is
   * no version of putting that in a Postgres cache table, once per judgment,
   * that ends well. Everything downstream needs is two short strings.
   *
   * Never throws. A judgment whose header cannot be read still has a title, a
   * date and a court, and losing the whole card over a missing case number
   * would be a poor trade - so a failure leaves those two fields empty and the
   * search carries on.
   */
  async documentHeader(tid: number): Promise<DocumentHeader> {
    const empty: DocumentHeader = { caseNumber: null, bench: [] };
    if (!this.isConfigured) return empty;

    const key = `kanoon:doc:${tid}`;

    const hot = this.hotHeaders.get(key);
    if (hot) return hot;

    const stored = await this.cache.get<DocumentHeader>(key).catch(() => null);
    if (stored) {
      this.hotHeaders.set(key, stored, this.cacheTtl);
      return stored;
    }

    try {
      const response = await this.breaker.execute(() => this.fetchDocument(tid));
      const header = parseDocumentHeader(response);

      // Cached even when empty. A judgment whose header states no case number
      // will not grow one, and re-buying that answer on every search is the
      // expensive way to learn it twice.
      this.hotHeaders.set(key, header, this.cacheTtl);
      await this.cache.set(key, header, this.cacheTtl).catch(() => undefined);

      this.logger.debug(
        { tid, caseNumber: header.caseNumber, judges: header.bench.length },
        'Kanoon document header read',
      );
      return header;
    } catch (err) {
      this.logger.warn({ err, tid }, 'Could not read the Kanoon document header');
      return empty;
    }
  }

  private async fetchDocument(tid: number): Promise<string> {
    const response = await fetch(`${this.baseUrl}/doc/${tid}/`, {
      method: 'POST',
      headers: { authorization: `Token ${this.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(this.env.KANOON_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Indian Kanoon returned ${response.status} for document ${tid}`);
    }

    const payload = (await response.json()) as { doc?: string };
    return payload.doc ?? '';
  }

  private cacheKey(query: string, maxResults: number): string {
    const digest = createHash('sha256').update(`${query}|${maxResults}`).digest('hex').slice(0, 32);
    return `kanoon:search:${digest}`;
  }
}

/**
 * Restore Date objects lost to JSON.
 *
 * JSON has no date type, so `judgment_date` comes back from either cache tier
 * as a string. The precedent formatter calls date methods on it, and a string
 * silently produces "Invalid Date" in an advocate's results rather than
 * throwing anywhere anyone would notice.
 */
function reviveDates(rows: PrecedentRow[]): PrecedentRow[] {
  return rows.map((row) => ({
    ...row,
    judgment_date: row.judgment_date ? new Date(row.judgment_date) : null,
  }));
}

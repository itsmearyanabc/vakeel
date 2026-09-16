/**
 * What Indian Kanoon actually returns, printed verbatim.
 *
 * ## Why this exists
 *
 * Three fields on the WhatsApp card have been empty in every live search:
 * CASE NO., EQUIVALENT CITATIONS, and often LEGAL PRINCIPLE. By the time a
 * response has been mapped into a PrecedentRow, "the field was absent", "the
 * field was empty" and "the field is called something else" are the same null,
 * so no amount of reading the cards can tell them apart.
 *
 * The last mapper written from documentation rather than from a live response
 * was the eCourts one, and it was wrong three separate ways - nesting, arrays,
 * and where the dates lived - none of which surfaced until a real call was
 * made. This runs that call first.
 *
 * ## Usage, on the box that has the key
 *
 *   npx ts-node -r tsconfig-paths/register scripts/kanoon-probe.ts
 *   npx ts-node -r tsconfig-paths/register scripts/kanoon-probe.ts "your query"
 *   npx ts-node -r tsconfig-paths/register scripts/kanoon-probe.ts --tid 257876
 *   npx ts-node -r tsconfig-paths/register scripts/kanoon-probe.ts --operators
 *
 * ## What the second version looks for
 *
 * The first run showed no citation field in /search/ or /doc/, and that was
 * reported as final. It was not: Kanoon's documentation lists two things that
 * run never touched. /docmeta/<docid>/ has an undocumented response, and the
 * search API accepts a `cite:` filter - "cite: 1993 AIR" - which can only work
 * if the index holds reporter citations somewhere. So this also calls docmeta,
 * and asks /doc/ for citeList and citedbyList, which are only sent on request.
 *
 * The default query is a reported Supreme Court judgment, because a case with
 * no AIR or SCC citation cannot show whether a citation field exists.
 *
 * It prints field names and truncated values. Nothing is written anywhere, no
 * credit is spent by the app, and the API key is read from .env and never
 * printed - so the output is safe to paste back.
 *
 * Costs two billed Kanoon calls: one search, one document.
 */

// Node's own loader, as scripts/migrate.ts uses - the repo has no dotenv
// dependency and adding one for a diagnostic would be the wrong trade.
try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the ambient environment.
}

const BASE = (process.env.KANOON_BASE_URL || 'https://api.indiankanoon.org').replace(/\/$/, '');
const KEY = process.env.KANOON_API_KEY || '';
const tidFlag = process.argv.indexOf('--tid');
const TID = tidFlag >= 0 ? process.argv[tidFlag + 1] : null;
const QUERY =
  (tidFlag < 0 && process.argv[2]) || 'Kesavananda Bharati vs State Of Kerala doctypes:supremecourt';

/** Truncated, single-line, so a whole judgment does not fill the terminal. */
function preview(value: unknown, limit = 220): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `[${value.length}] ${JSON.stringify(value).slice(0, limit)}`;
  }
  if (typeof value === 'object') return JSON.stringify(value).slice(0, limit);

  const text = String(value).replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;
}

function dump(label: string, payload: Record<string, unknown>): void {
  console.log(`\n=== ${label} ===`);
  console.log(`fields: ${Object.keys(payload).sort().join(', ')}\n`);
  for (const key of Object.keys(payload).sort()) {
    console.log(`  ${key.padEnd(18)} ${preview(payload[key])}`);
  }
}

async function call(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Token ${KEY}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Confirm the documented search operators against the live API.
 *
 * `title:` and `cite:` are documented, and the app now leads with them - but a
 * documented syntax the account rejects would fail every search that uses it,
 * and enough failures would open the circuit breaker for all searches. So they
 * are checked here, on the real key, before anything relies on them.
 *
 * Four billed searches. Each prints how many documents matched and the first
 * three titles, which is enough to see whether the operator narrowed.
 */
async function probeOperators(): Promise<void> {
  const queries = [
    'title: Kesavananda Bharati',
    'doctypes:patna title: Rajesh Kumar Mittal State of Bihar',
    'cite: AIR 1973 SUPREME COURT 1461',
    'cite: 1973 AIR',
  ];

  for (const query of queries) {
    try {
      const result = await call(`/search/?formInput=${encodeURIComponent(query)}&pagenum=0`);
      const docs = (result.docs as Record<string, unknown>[] | undefined) ?? [];
      console.log(`
=== ${query} ===`);
      console.log(`found: ${preview(result.found)}   docs: ${docs.length}`);
      for (const doc of docs.slice(0, 3)) {
        console.log(`  - ${preview(doc.title, 110)}  [${preview(doc.citation ?? 'no citation', 60)}]`);
      }
      if (result.error || result.errmsg) console.log(`  ERROR: ${preview(result.errmsg ?? result.error)}`);
    } catch (err) {
      console.log(`
=== ${query} ===
FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('KANOON_API_KEY is not set in .env');

  console.log(`base:  ${BASE}`);

  if (process.argv.includes('--operators')) {
    await probeOperators();
    return;
  }

  let tid: unknown = TID;
  if (!tid) {
    console.log(`query: ${QUERY}`);
    const search = await call(`/search/?formInput=${encodeURIComponent(QUERY)}&pagenum=0`);
    const docs = (search.docs as Record<string, unknown>[] | undefined) ?? [];

    console.log(`\nfound: ${preview(search.found)}   docs: ${docs.length}`);
    if (docs.length === 0) {
      console.log('No documents matched - try a different query.');
      return;
    }
    dump('SEARCH RESULT [0]', docs[0]);
    tid = docs[0].tid;
  }

  /*
   * /docmeta/ first - the candidate. Its response is undocumented, which is
   * precisely why it has to be looked at rather than reasoned about.
   */
  console.log(`\nfetching /docmeta/${String(tid)}/ …`);
  try {
    const meta = await call(`/docmeta/${String(tid)}/`);
    dump(`DOCMETA ${String(tid)}`, meta);
    console.log('\n=== DOCMETA RAW (first 1500 chars) ===\n');
    console.log(JSON.stringify(meta).slice(0, 1500));
  } catch (err) {
    console.log(`docmeta failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // citeList and citedbyList are only sent when asked for. They are other
  // judgments - what this one relies on and what relies on it - not equivalent
  // citations, and they are printed so that difference is visible, not assumed.
  console.log(`\nfetching /doc/${String(tid)}/?maxcites=5&maxcitedby=5 …`);
  const doc = await call(`/doc/${String(tid)}/?maxcites=5&maxcitedby=5`);
  dump(`DOCUMENT ${String(tid)}`, doc);

  for (const list of ['citeList', 'citedbyList']) {
    const entries = (doc[list] as Record<string, unknown>[] | undefined) ?? [];
    console.log(`\n=== ${list}: ${entries.length} entries ===`);
    if (entries[0]) dump(`${list}[0]`, entries[0]);
  }

  /*
   * The judgment's own header, where a case number lives if it lives anywhere.
   * Printed as plain text because it is HTML in the response and the cause
   * title is the first few hundred characters of it.
   */
  const body = String(doc.doc ?? '');
  if (body) {
    const text = body
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log('\n=== FIRST 900 CHARACTERS OF THE JUDGMENT ===\n');
    console.log(text.slice(0, 900));
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

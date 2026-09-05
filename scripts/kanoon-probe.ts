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
const QUERY = process.argv[2] || 'Rajesh Kumar Mittal State Of Bihar';

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

async function main(): Promise<void> {
  if (!KEY) throw new Error('KANOON_API_KEY is not set in .env');

  console.log(`base:  ${BASE}`);
  console.log(`query: ${QUERY}`);

  const search = await call(`/search/?formInput=${encodeURIComponent(QUERY)}&pagenum=0`);
  const docs = (search.docs as Record<string, unknown>[] | undefined) ?? [];

  console.log(`\nfound: ${preview(search.found)}   docs: ${docs.length}`);
  if (docs.length === 0) {
    console.log('No documents matched - try a different query.');
    return;
  }

  dump('SEARCH RESULT [0]', docs[0]);

  // The one that decides whether CASE NO. and the citations are reachable at
  // all. The search result carries neither; if the document does not either,
  // there is nothing to parse and the fields are not a bug.
  const tid = docs[0].tid;
  console.log(`\nfetching /doc/${String(tid)}/ …`);
  const doc = await call(`/doc/${String(tid)}/`);
  dump(`DOCUMENT ${String(tid)}`, doc);

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

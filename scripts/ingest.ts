/**
 * Corpus ingestion.
 *
 *   npm run ingest -- --file data/judgments.jsonl    ingest judgments
 *   npm run ingest -- --statutes                     backfill statute embeddings
 *   npm run ingest -- --file x.jsonl --no-embed      ingest text only (lexical search still works)
 *   npm run ingest -- --stats                        corpus counts
 *
 * Input is JSONL - one JSON object per line - because judgment corpora are
 * large and this streams rather than loading the whole file into memory.
 *
 * Expected fields per line (only case_title and full_text are required):
 *   case_title, court_name, court_type, neutral_citation, reporter_citations[],
 *   judgment_date (YYYY-MM-DD), bench[], bench_strength, act_sections[],
 *   keywords[], headnote, ratio_decidendi, disposition, full_text, source_url
 *
 * Re-running is safe: judgments are keyed by a hash of their full text, so an
 * unchanged document is skipped and a changed one has its chunks rebuilt.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import postgres, { Sql } from 'postgres';
import { MockEmbeddingProvider } from '../src/ai/providers/mock.provider';
import { GoogleEmbeddingProvider } from '../src/ai/providers/google.provider';
import { OpenAiEmbeddingProvider } from '../src/ai/providers/openai.provider';
import { EmbeddingProvider } from '../src/ai/providers/llm-provider.interface';
import { AppEnv, loadEnv } from '../src/config/env';

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the ambient environment.
}

/**
 * Chunking parameters.
 *
 * ~1200 characters is roughly a long paragraph of a judgment - big enough to
 * contain a complete point of reasoning, small enough that a retrieved chunk is
 * mostly signal. The overlap stops a holding that straddles a boundary from
 * being split so that neither half is retrievable.
 */
const TARGET_CHUNK_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 200;
const MIN_CHUNK_CHARS = 100;

interface JudgmentInput {
  case_title?: string;
  court_name?: string;
  court_type?: string;
  neutral_citation?: string;
  reporter_citations?: string[];
  judgment_date?: string;
  bench?: string[];
  bench_strength?: number;
  act_sections?: string[];
  keywords?: string[];
  headnote?: string;
  ratio_decidendi?: string;
  disposition?: string;
  full_text?: string;
  source_url?: string;
}

interface Chunk {
  content: string;
  paraNumber: number | null;
}

/**
 * Split a judgment into retrieval chunks.
 *
 * Indian judgments are numbered by paragraph, and advocates cite paragraph
 * numbers - so paragraph boundaries are preferred over a fixed window, and the
 * number is captured when the text carries one. A citation that can say
 * "para 14" is far more checkable than one that cannot.
 */
export function chunkJudgment(text: string): Chunk[] {
  const normalised = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalised) return [];

  const paragraphs = normalised.split(/\n\s*\n/);
  const chunks: Chunk[] = [];

  let buffer = '';
  let bufferPara: number | null = null;

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length >= MIN_CHUNK_CHARS) {
      chunks.push({ content: trimmed, paraNumber: bufferPara });
    }
    buffer = '';
    bufferPara = null;
  };

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Leading "12." or "(12)" is a paragraph number in most reported judgments.
    const paraMatch = /^\(?(\d{1,4})[.)]\s/.exec(trimmed);
    const paraNumber = paraMatch ? Number(paraMatch[1]) : null;

    // A single paragraph longer than the target gets windowed on sentence
    // boundaries rather than being emitted whole.
    if (trimmed.length > TARGET_CHUNK_CHARS * 1.5) {
      flush();
      for (const piece of windowText(trimmed)) {
        chunks.push({ content: piece, paraNumber });
      }
      continue;
    }

    if (buffer.length + trimmed.length > TARGET_CHUNK_CHARS && buffer.length > 0) {
      const tail = buffer.slice(-CHUNK_OVERLAP_CHARS);
      flush();
      buffer = tail;
    }

    if (bufferPara === null) bufferPara = paraNumber;
    buffer += (buffer ? '\n\n' : '') + trimmed;
  }

  flush();
  return chunks;
}

/** Window an over-long paragraph, breaking on sentence ends where possible. */
function windowText(text: string): string[] {
  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > TARGET_CHUNK_CHARS) {
    const window = remaining.slice(0, TARGET_CHUNK_CHARS);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '));
    if (cut < TARGET_CHUNK_CHARS * 0.5) cut = window.lastIndexOf(' ');
    if (cut < 0) cut = TARGET_CHUNK_CHARS;

    pieces.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(Math.max(0, cut + 1 - CHUNK_OVERLAP_CHARS)).trim();
  }

  if (remaining.length >= MIN_CHUNK_CHARS) pieces.push(remaining);
  return pieces;
}

function resolveEmbeddingProvider(env: AppEnv): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case 'openai':
      return env.OPENAI_API_KEY ? new OpenAiEmbeddingProvider(env) : new MockEmbeddingProvider(env);
    case 'google':
      return env.GOOGLE_API_KEY ? new GoogleEmbeddingProvider(env) : new MockEmbeddingProvider(env);
    default:
      return new MockEmbeddingProvider(env);
  }
}

const toVectorLiteral = (v: number[]): string => `[${v.join(',')}]`;

async function ingestFile(sql: Sql, env: AppEnv, filePath: string, embed: boolean): Promise<void> {
  const provider = resolveEmbeddingProvider(env);

  if (embed && provider.name === 'mock') {
    console.warn(
      '⚠️  Using MOCK embeddings (no embedding provider key configured).\n' +
        '   These are lexical hash vectors with no semantic meaning. Fine for testing\n' +
        '   the pipeline; re-run with a real key before serving actual queries.\n',
    );
  }

  const stream = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  let lineNo = 0;
  let ingested = 0;
  let skipped = 0;
  let totalChunks = 0;

  for await (const line of stream) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let doc: JudgmentInput;
    try {
      doc = JSON.parse(trimmed) as JudgmentInput;
    } catch {
      console.warn(`  line ${lineNo}: not valid JSON, skipped`);
      continue;
    }

    if (!doc.case_title || !doc.full_text) {
      console.warn(`  line ${lineNo}: missing case_title or full_text, skipped`);
      continue;
    }

    const contentHash = createHash('sha256').update(doc.full_text).digest('hex');

    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM judgments WHERE content_hash = ${contentHash}
    `;
    if (existing) {
      skipped++;
      continue;
    }

    const chunks = chunkJudgment(doc.full_text);
    if (chunks.length === 0) {
      console.warn(`  line ${lineNo}: produced no chunks, skipped`);
      continue;
    }

    let vectors: number[][] = [];
    if (embed) {
      // Embed the chunk with its case title prepended. Judgment paragraphs
      // often refer to "the appellant" with no other context, and the title
      // gives the vector something to anchor on.
      const inputs = chunks.map((c) => `${doc.case_title}\n\n${c.content}`);
      vectors = await provider.embed(inputs);
    }

    await sql.begin(async (tx) => {
      const [judgment] = await tx<{ id: string }[]>`
        INSERT INTO judgments (
          case_title, court_name, court_type, neutral_citation, reporter_citations,
          judgment_date, bench, bench_strength, act_sections, keywords,
          headnote, ratio_decidendi, disposition, full_text, source_url, content_hash
        ) VALUES (
          ${doc.case_title!},
          ${doc.court_name ?? 'Unknown'},
          ${doc.court_type ?? 'HIGH_COURT'},
          ${doc.neutral_citation ?? null},
          ${doc.reporter_citations ?? []}::text[],
          ${doc.judgment_date ?? null}::date,
          ${doc.bench ?? []}::text[],
          ${doc.bench_strength ?? null},
          ${doc.act_sections ?? []}::text[],
          ${doc.keywords ?? []}::text[],
          ${doc.headnote ?? null},
          ${doc.ratio_decidendi ?? null},
          ${doc.disposition ?? null},
          ${doc.full_text!},
          ${doc.source_url ?? null},
          ${contentHash}
        )
        ON CONFLICT (content_hash) DO UPDATE SET case_title = EXCLUDED.case_title
        RETURNING id
      `;

      // Rebuild rather than merge: chunk boundaries shift when the text
      // changes, so stale chunks would no longer line up with anything.
      await tx`DELETE FROM judgment_chunks WHERE judgment_id = ${judgment.id}`;

      for (const [index, chunk] of chunks.entries()) {
        const vector = vectors[index] ? toVectorLiteral(vectors[index]) : null;

        await tx`
          INSERT INTO judgment_chunks (
            judgment_id, chunk_index, content, para_number, token_count,
            court_name, court_type, judgment_date, act_sections, embedding
          ) VALUES (
            ${judgment.id},
            ${index},
            ${chunk.content},
            ${chunk.paraNumber},
            ${Math.ceil(chunk.content.length / 4)},
            ${doc.court_name ?? 'Unknown'},
            ${doc.court_type ?? 'HIGH_COURT'},
            ${doc.judgment_date ?? null}::date,
            ${doc.act_sections ?? []}::text[],
            ${vector}::vector
          )
        `;
      }
    });

    ingested++;
    totalChunks += chunks.length;

    if (ingested % 10 === 0) {
      console.log(`  ${ingested} judgments, ${totalChunks} chunks...`);
    }
  }

  console.log(
    `\n✓ Ingested ${ingested} judgment(s), ${totalChunks} chunk(s). ` +
      `${skipped} already present (unchanged).`,
  );
}

/** Backfill embeddings for statute rows seeded without them. */
async function embedStatutes(sql: Sql, env: AppEnv): Promise<void> {
  const provider = resolveEmbeddingProvider(env);

  const rows = await sql<{ id: string; act_code: string; section_number: string; section_title: string; section_text: string }[]>`
    SELECT id, act_code, section_number, section_title, section_text
      FROM statutes
     WHERE embedding IS NULL
  `;

  if (rows.length === 0) {
    console.log('✓ All statutes already have embeddings.');
    return;
  }

  console.log(`Embedding ${rows.length} statute section(s) using ${provider.name}...`);

  const inputs = rows.map(
    (r) => `${r.act_code} Section ${r.section_number}: ${r.section_title}\n\n${r.section_text}`,
  );

  const BATCH = 32;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const vectors = await provider.embed(inputs.slice(i, i + BATCH));

    for (const [j, row] of slice.entries()) {
      await sql`
        UPDATE statutes SET embedding = ${toVectorLiteral(vectors[j])}::vector WHERE id = ${row.id}
      `;
    }
    console.log(`  ${Math.min(i + BATCH, inputs.length)}/${inputs.length}`);
  }

  console.log('✓ Statute embeddings written.');
}

async function showStats(sql: Sql): Promise<void> {
  const [row] = await sql<
    { judgments: string; chunks: string; embedded_chunks: string; statutes: string; embedded_statutes: string }[]
  >`
    SELECT (SELECT COUNT(*) FROM judgments)                                     AS judgments,
           (SELECT COUNT(*) FROM judgment_chunks)                               AS chunks,
           (SELECT COUNT(*) FROM judgment_chunks WHERE embedding IS NOT NULL)   AS embedded_chunks,
           (SELECT COUNT(*) FROM statutes)                                      AS statutes,
           (SELECT COUNT(*) FROM statutes WHERE embedding IS NOT NULL)          AS embedded_statutes
  `;

  console.log('\nCorpus');
  console.log(`  Judgments:          ${row.judgments}`);
  console.log(`  Chunks:             ${row.chunks} (${row.embedded_chunks} embedded)`);
  console.log(`  Statute sections:   ${row.statutes} (${row.embedded_statutes} embedded)\n`);

  if (Number(row.chunks) > 0 && Number(row.embedded_chunks) === 0) {
    console.log('  Note: no chunks are embedded, so retrieval is lexical-only.');
    console.log('  Configure an embedding provider and re-run with --file to fix.\n');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const env = loadEnv();

  const sql = postgres(env.migrationDatabaseUrl, {
    max: 1,
    ssl: env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : false,
    prepare: false,
    onnotice: () => undefined,
  });

  try {
    if (args.includes('--stats')) {
      await showStats(sql);
      return;
    }

    if (args.includes('--statutes')) {
      await embedStatutes(sql, env);
      return;
    }

    const fileIndex = args.indexOf('--file');
    if (fileIndex === -1 || !args[fileIndex + 1]) {
      console.log(
        [
          'Usage:',
          '  npm run ingest -- --file <path.jsonl>    ingest judgments',
          '  npm run ingest -- --statutes             backfill statute embeddings',
          '  npm run ingest -- --stats                show corpus counts',
          '',
          'Options:',
          '  --no-embed    skip embedding (lexical search only)',
          '',
          'A sample file is included: data/samples/judgments.sample.jsonl',
        ].join('\n'),
      );
      return;
    }

    await ingestFile(sql, env, args[fileIndex + 1], !args.includes('--no-embed'));
    await showStats(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});

/**
 * Migration runner.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --status  show what is applied
 *
 * Connects on DIRECT_URL (port 5432) rather than DATABASE_URL. The Supabase
 * transaction pooler cannot run DDL reliably - CREATE INDEX and CREATE TYPE
 * need a session, and the pooler hands out a different backend per statement.
 *
 * Everything here is also plain SQL in supabase/migrations/, so pasting the
 * files into the Supabase SQL Editor in filename order is an equally valid way
 * to do this. This script just makes it repeatable and tracks what ran.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the ambient environment.
}

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

interface Migration {
  filename: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    // Lexicographic order is why the files are numbered 0001_, 0002_, ...
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    });
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DIRECT_URL (preferred) or DATABASE_URL before running migrations.');
    process.exit(1);
  }

  if (url.includes(':6543')) {
    console.warn(
      '⚠️  This looks like the Supabase transaction pooler (port 6543).\n' +
        '   DDL can fail there. Use the direct connection on port 5432 as DIRECT_URL.\n',
    );
  }

  const sql = postgres(url, {
    max: 1,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    // DDL must run on one session, so prepared statements are fine and wanted.
    prepare: false,
    onnotice: () => undefined,
  });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    VARCHAR(32) NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const applied = await sql<{ filename: string; checksum: string; applied_at: Date }[]>`
      SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename
    `;
    const appliedMap = new Map(applied.map((row) => [row.filename, row]));

    const migrations = loadMigrations();

    if (process.argv.includes('--status')) {
      console.log('\nMigration status\n');
      for (const migration of migrations) {
        const record = appliedMap.get(migration.filename);
        const state = !record
          ? 'PENDING'
          : record.checksum === migration.checksum
            ? 'applied'
            : 'APPLIED (file has changed since!)';
        console.log(`  ${state.padEnd(32)} ${migration.filename}`);
      }
      console.log('');
      return;
    }

    const pending = migrations.filter((m) => !appliedMap.has(m.filename));

    // A changed file that was already applied is worth shouting about: the
    // database and the repository have diverged, and the fix is a new
    // migration, not editing an old one.
    for (const migration of migrations) {
      const record = appliedMap.get(migration.filename);
      if (record && record.checksum !== migration.checksum) {
        console.warn(
          `⚠️  ${migration.filename} has changed since it was applied ` +
            `(${record.applied_at.toISOString().slice(0, 10)}). It will NOT be re-run. ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
    }

    if (pending.length === 0) {
      console.log(`✓ Database is up to date (${migrations.length} migration(s) applied).`);
      return;
    }

    console.log(`Applying ${pending.length} migration(s)...\n`);

    for (const migration of pending) {
      process.stdout.write(`  ${migration.filename} ... `);
      const started = Date.now();

      try {
        // .simple() sends the file as one simple-protocol query, which is what
        // allows multiple statements separated by semicolons. The extended
        // protocol permits only one statement per message.
        await sql.unsafe(migration.sql).simple();

        await sql`
          INSERT INTO schema_migrations (filename, checksum)
               VALUES (${migration.filename}, ${migration.checksum})
          ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum
        `;

        console.log(`ok (${Date.now() - started}ms)`);
      } catch (err) {
        console.log('FAILED\n');
        console.error(err instanceof Error ? err.message : err);
        console.error(
          `\nMigration ${migration.filename} failed. Fix the SQL and re-run; ` +
            'migrations already applied are not repeated.',
        );
        process.exit(1);
      }
    }

    console.log('\n✓ All migrations applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('Migration runner failed:', err);
  process.exit(1);
});

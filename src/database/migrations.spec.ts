import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Conventions the migration runner and Supabase both depend on.
 *
 * A migration is the one artefact in this repository with no dry run: it is
 * applied to a live database mid-deploy, before the new code starts, and a
 * mistake takes the service down with it. `nest build` does not read these
 * files, TypeScript does not either, and no unit test touches them - so
 * everything below is a failure that would first be discovered by `deploy.sh`
 * stopping halfway.
 *
 * These check shape rather than SQL semantics, which needs a real Postgres.
 * That is a deliberate limit: the mistakes that actually happen here are
 * ordering, re-runnability and the guards this codebase uses everywhere, and
 * all three are visible in the text.
 */

const DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  // Lexicographic order is what the runner uses, which is why they are numbered.
  .sort();

const sources = new Map(files.map((name) => [name, readFileSync(join(DIR, name), 'utf8')]));

describe('migration files', () => {
  it('are numbered without gaps or duplicates', () => {
    // The runner applies them in filename order and records each by name. Two
    // files sharing a number apply in an order nobody chose; a gap usually means
    // one was renamed after being applied somewhere, which is a checksum warning
    // and a database that has silently diverged.
    const numbers = files.map((name) => Number(name.slice(0, 4)));

    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it.each(files)('%s follows the naming convention', (name) => {
    expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it.each(files)('%s is not empty', (name) => {
    expect((sources.get(name) ?? '').trim().length).toBeGreaterThan(0);
  });

  it.each(files)('%s creates tables idempotently', (name) => {
    // Re-running the whole chain against a populated database has to be a
    // no-op: docker-compose applies these on first boot, deploy.sh applies the
    // pending ones, and somebody will paste one into the SQL editor twice.
    const statements = (sources.get(name) ?? '').match(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi);
    expect(statements).toBeNull();
  });

  it.each(files)('%s creates indexes idempotently', (name) => {
    const statements = (sources.get(name) ?? '').match(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS|CONCURRENTLY)/gi,
    );
    expect(statements).toBeNull();
  });

  it.each(files)('%s guards every CREATE TYPE against re-running', (name) => {
    // Postgres has no IF NOT EXISTS for CREATE TYPE, so the codebase wraps each
    // one in a DO block that swallows duplicate_object. A bare CREATE TYPE
    // aborts the entire migration on the second run.
    const sql = sources.get(name) ?? '';
    const created = (sql.match(/CREATE\s+TYPE/gi) ?? []).length;
    if (created === 0) return;

    const guarded = (sql.match(/EXCEPTION\s+WHEN\s+duplicate_object/gi) ?? []).length;
    expect(guarded).toBeGreaterThanOrEqual(created);
  });

  it.each(files)('%s adds columns idempotently', (name) => {
    const statements = (sources.get(name) ?? '').match(
      /ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi,
    );
    expect(statements).toBeNull();
  });

  it.each(files)('%s never drops a table', (name) => {
    // Nothing here is allowed to destroy data. Retiring something means a flag
    // or a nullable column, never a DROP - a migration that loses an advocate's
    // research history cannot be undone by rolling back the deploy.
    expect(sources.get(name) ?? '').not.toMatch(/DROP\s+TABLE/i);
  });

  it('seeds only with ON CONFLICT DO NOTHING', () => {
    // A seed that overwrites is a migration that resets prices an operator has
    // since changed, on every deploy.
    //
    // Counted outside `$$ ... $$` only. Most INSERTs in this directory are
    // inside plpgsql function bodies - credit_spend and credit_grant writing to
    // credit_ledger - which are runtime writes, not seeds, and have no business
    // carrying ON CONFLICT.
    for (const [name, sql] of sources) {
      const topLevel = stripFunctionBodies(sql);
      const seeds = (topLevel.match(/INSERT\s+INTO/gi) ?? []).length;
      if (seeds === 0) continue;

      const guarded = (topLevel.match(/ON\s+CONFLICT/gi) ?? []).length;
      expect({ file: name, seeds, guarded }).toEqual({ file: name, seeds, guarded: seeds });
    }
  });
});

/**
 * Remove dollar-quoted bodies, leaving the migration's own statements.
 *
 * Everything inside `$$ ... $$` is a function definition: it runs when the
 * function is called, not when the migration is applied, so the conventions
 * this file checks - idempotency, seed guards - do not apply to it.
 */
function stripFunctionBodies(sql: string): string {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, ' ');
}

describe('the pricing migration', () => {
  const sql = sources.get('0015_plan_billing_period.sql') ?? '';

  it('exists', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it('extends credit_plans rather than creating a second price list', () => {
    // The mistake this migration was rewritten to undo: a parallel
    // `credit_packs` table duplicating credit_plans from 0012. Two tables for
    // one concept is how an order stops resolving against what it bought.
    expect(sql).toMatch(/ALTER\s+TABLE\s+credit_plans/i);
    expect(sql).not.toMatch(/CREATE\s+TABLE[^;]*credit_packs/i);
  });

  it('gives billing_period a default, so existing rows stay valid', () => {
    // A NOT NULL column added without a default fails outright on a populated
    // table, which on this deployment is every plan seeded by 0012.
    expect(sql).toMatch(/billing_period[\s\S]{0,80}NOT\s+NULL\s+DEFAULT/i);
  });
});

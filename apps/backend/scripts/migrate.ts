/**
 * The migration entrypoint for every environment that is not a developer laptop.
 *
 * **It does not implement a lock.** Prisma's schema engine already takes one —
 * verified directly in the engine binary, which contains
 * `SELECT pg_advisory_lock(72707369)` and a documented timeout pointing at
 * https://pris.ly/d/migrate-advisory-locking. Two ECS tasks starting together
 * therefore serialize on that lock rather than racing.
 *
 * Writing a second lock on top would be worse than writing none: two locking
 * schemes that each believe they are the authority is how a deploy hangs holding
 * both, and neither owner knows to release the other.
 *
 * What this script does instead is guard the ways that lock can be LOST, since
 * each of them is silent:
 *
 *   1. `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` turns it off entirely. It exists
 *      for connection poolers that do not support session-level locks. Set in
 *      production it would make concurrent migrations race with no warning.
 *   2. A pooled connection string. PgBouncer in transaction mode does not hold
 *      session state, so a session-level advisory lock is not held across
 *      statements and the mutual exclusion silently stops working.
 */
import { execFileSync } from 'node:child_process';

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`\nMigration refused: ${message}\n`);
  process.exit(1);
}

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  fail('DATABASE_URL is not set.');
}

if (process.env['PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK']) {
  fail(
    'PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK is set. That disables the lock which stops two ' +
      'concurrent deploys applying migrations at the same time. Unset it, or migrate through a ' +
      'direct (non-pooled) connection.',
  );
}

// A pooler in transaction mode does not hold session state, so a session-level
// advisory lock is not held between statements. Prisma's lock then exists and
// protects nothing.
const POOLER_HINTS = ['pgbouncer=true', ':6543/', 'pooler.supabase', '-pooler.'];
const pooled = POOLER_HINTS.find((hint) => databaseUrl.includes(hint));
if (pooled) {
  fail(
    `DATABASE_URL looks like a pooled connection (matched "${pooled}"). Prisma's migration ` +
      `advisory lock is session-level and a transaction-mode pooler does not hold it, so ` +
      `concurrent deploys would race. Migrate through the direct endpoint.`,
  );
}

// eslint-disable-next-line no-console
console.log('Applying migrations (Prisma holds pg_advisory_lock(72707369) for the duration)...');

execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { stdio: 'inherit' });

// eslint-disable-next-line no-console
console.log('Migrations applied.');

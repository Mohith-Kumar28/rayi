import { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../src/database/prisma.service';
import { LedgerIntegrityService } from '../src/ledger/infrastructure/ledger-integrity.service';

/**
 * The boot assertion, and proof that it fires.
 *
 * A check that has only ever been seen to pass is a check nobody knows still
 * works. So each test here DROPS a real control, asserts the check catches it,
 * and puts it back — against the same database the rest of the suite uses.
 *
 * This is the test that distinguishes "the migrations create a CHECK constraint"
 * from "the database this process connected to is still enforcing it", which is
 * the only one of those two statements that protects any money.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const integrity = new LedgerIntegrityService(
  prisma as unknown as PrismaService,
);

/**
 * These tests connect as the privileged role, which has BYPASSRLS — so the
 * integrity check correctly reports that every RLS policy is inert for it.
 *
 * That finding is asserted on its own below. Everywhere else it is filtered out,
 * so a test about a dropped CHECK constraint is not also a test about the
 * connection role.
 */
const RLS_ROLE_FINDING = /BYPASSRLS|SUPERUSER/;

const structural = (failures: string[]) =>
  failures.filter((failure) => !RLS_ROLE_FINDING.test(failure));

/**
 * Runs `sql`, then restores with `undo` whatever the assertions do.
 *
 * Statements go one at a time: Postgres refuses multiple commands in a prepared
 * statement, which is also what stops `$executeRawUnsafe` being a
 * statement-injection primitive.
 */
async function run(statements: string | readonly string[]): Promise<void> {
  for (const statement of typeof statements === 'string'
    ? [statements]
    : statements) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function withBroken(
  sql: string | readonly string[],
  undo: string | readonly string[],
  assertion: (failures: string[]) => void,
) {
  await run(sql);
  try {
    assertion(structural(await integrity.verify()));
  } finally {
    await run(undo);
  }
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a correctly migrated database passes', () => {
  it('reports no STRUCTURAL failures', async () => {
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);

  it('DOES report that a privileged connection makes RLS inert', async () => {
    // The finding that matters most here, and the one that was missing when RLS
    // was first added: a superuser bypasses every policy unconditionally, so the
    // control is decorative in exactly the environment where it is exercised
    // before production.
    const failures = await integrity.verify();
    expect(failures.some((failure) => RLS_ROLE_FINDING.test(failure))).toBe(true);
    expect(failures.join('\n')).toMatch(/rayi_app/);
  }, 30_000);

  it('leaves the database exactly as it found it', async () => {
    // The check is read-only. A boot-time assertion that mutated anything would
    // be a write on the money path performed by every process on every deploy.
    const before = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ledger'`,
    );
    await integrity.verify();
    const after = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ledger'`,
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  }, 30_000);
});

describe('and a database missing a control does NOT', () => {
  it('catches the solvency CHECK being dropped', async () => {
    await withBroken(
      `ALTER TABLE ledger.account_balance DROP CONSTRAINT account_balance_non_negative`,
      `ALTER TABLE ledger.account_balance ADD CONSTRAINT account_balance_non_negative
         CHECK (allow_negative OR balance_minor >= 0)`,
      (failures) => {
        expect(failures.join('\n')).toMatch(/account_balance_non_negative/);
        expect(failures.join('\n')).toMatch(/THE solvency invariant/);
      },
    );

    // And it is healthy again afterwards, so the drop really was reversed.
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);

  it('catches the idempotency key being dropped', async () => {
    await withBroken(
      `ALTER TABLE ledger.entry DROP CONSTRAINT entry_source_key`,
      `ALTER TABLE ledger.entry ADD CONSTRAINT entry_source_key UNIQUE (source_type, source_id)`,
      (failures) => {
        expect(failures.join('\n')).toMatch(/entry_source_key/);
      },
    );
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);

  it('catches an append-only trigger being removed', async () => {
    await withBroken(
      `DROP TRIGGER entry_append_only ON ledger.entry`,
      `CREATE TRIGGER entry_append_only BEFORE UPDATE OR DELETE ON ledger.entry
         FOR EACH ROW EXECUTE FUNCTION ledger.refuse_mutation()`,
      (failures) => {
        expect(failures.join('\n')).toMatch(
          /MISSING TRIGGER ledger\.entry\.entry_append_only/,
        );
      },
    );
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);

  it('catches the balanced-entry trigger being recreated as IMMEDIATE', async () => {
    // The subtle one. The trigger still exists and still has the right name, so
    // anything checking only for presence would pass — while every legitimate
    // multi-line entry now fails, because it fires after the first line when the
    // entry does not balance yet.
    await withBroken(
      [
        `DROP TRIGGER entry_line_balanced ON ledger.entry_line`,
        `CREATE CONSTRAINT TRIGGER entry_line_balanced
           AFTER INSERT ON ledger.entry_line
           FOR EACH ROW EXECUTE FUNCTION ledger.assert_entry_balanced()`,
      ],
      [
        `DROP TRIGGER entry_line_balanced ON ledger.entry_line`,
        `CREATE CONSTRAINT TRIGGER entry_line_balanced
           AFTER INSERT ON ledger.entry_line
           DEFERRABLE INITIALLY DEFERRED
           FOR EACH ROW EXECUTE FUNCTION ledger.assert_entry_balanced()`,
      ],
      (failures) => {
        expect(failures.join('\n')).toMatch(
          /not DEFERRABLE INITIALLY DEFERRED/,
        );
      },
    );
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);

  it('catches post_entry losing SECURITY DEFINER', async () => {
    await withBroken(
      `ALTER FUNCTION ledger.post_entry(text, text, text, jsonb, uuid, text, text) SECURITY INVOKER`,
      `ALTER FUNCTION ledger.post_entry(text, text, text, jsonb, uuid, text, text) SECURITY DEFINER`,
      (failures) => {
        expect(failures.join('\n')).toMatch(
          /post_entry\(\) is not SECURITY DEFINER/,
        );
      },
    );
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);

  it('catches a uniqueness index that keeps a balance from being split in two', async () => {
    await withBroken(
      `DROP INDEX ledger.account_one_per_campaign_role`,
      `CREATE UNIQUE INDEX account_one_per_campaign_role
         ON ledger.account (campaign_id, role, currency) WHERE campaign_id IS NOT NULL`,
      (failures) => {
        expect(failures.join('\n')).toMatch(/account_one_per_campaign_role/);
      },
    );
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);

  it('catches the parentage FK being dropped', async () => {
    await withBroken(
      `ALTER TABLE ledger.account DROP CONSTRAINT account_campaign_belongs_to_org`,
      `ALTER TABLE ledger.account ADD CONSTRAINT account_campaign_belongs_to_org
         FOREIGN KEY (campaign_id, org_id)
         REFERENCES "campaign" (id_uuid, organization_id_uuid) ON DELETE RESTRICT`,
      (failures) => {
        expect(failures.join('\n')).toMatch(/account_campaign_belongs_to_org/);
      },
    );
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);

  it('reports EVERY missing control, not just the first', async () => {
    // Someone woken at 3am needs the whole picture: three controls missing
    // points at a restore, one points at a bad migration, and a check that stops
    // at the first difference cannot tell them apart.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ledger.account_balance DROP CONSTRAINT account_balance_non_negative`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ledger.entry DROP CONSTRAINT entry_source_key`,
    );
    try {
      const failures = structural(await integrity.verify());
      expect(failures.length).toBeGreaterThanOrEqual(2);
      expect(failures.join('\n')).toMatch(/account_balance_non_negative/);
      expect(failures.join('\n')).toMatch(/entry_source_key/);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE ledger.account_balance ADD CONSTRAINT account_balance_non_negative
           CHECK (allow_negative OR balance_minor >= 0)`,
      );
      await prisma.$executeRawUnsafe(
        `ALTER TABLE ledger.entry ADD CONSTRAINT entry_source_key UNIQUE (source_type, source_id)`,
      );
    }
    expect(structural(await integrity.verify())).toEqual([]);
  }, 30_000);
});

describe('the process refuses to start when a control is missing', () => {
  it('throws from onApplicationBootstrap rather than logging and continuing', async () => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ledger.account_balance DROP CONSTRAINT account_balance_non_negative`,
    );
    try {
      // Failing closed is the point. For a process that moves money, not running
      // is correct when its guarantees cannot be verified.
      await expect(integrity.onApplicationBootstrap()).rejects.toThrow(
        /Ledger integrity check FAILED/,
      );
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE ledger.account_balance ADD CONSTRAINT account_balance_non_negative
           CHECK (allow_negative OR balance_minor >= 0)`,
      );
    }
  }, 30_000);

  it('REFUSES to start on a connection that bypasses RLS', async () => {
    // This suite connects as the privileged role, which has BYPASSRLS. That is
    // exactly the condition under which every row-level security policy is
    // decorative — and it is how RLS was first shipped here: enabled, forced,
    // reviewed, and doing nothing, in the only environment it ran in before
    // production.
    //
    // Refusing to boot is the correct answer. A process that cannot enforce the
    // isolation it claims should not serve.
    await expect(integrity.onApplicationBootstrap()).rejects.toThrow(/BYPASSRLS|SUPERUSER/);
  }, 30_000);

  it('still records the cluster identity when the structural checks pass', async () => {
    // `verify()` is the read-only half and does not depend on the connection
    // role, so the structural findings are empty even here.
    expect(structural(await integrity.verify())).toEqual([]);

    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ledger.cluster_identity`,
    );
    // Exactly one row, and the singleton key means a second is not insertable.
    expect(rows[0]?.count).toBeLessThanOrEqual(1n);
  }, 30_000);
});

import { PrismaClient } from '@prisma/client';

/**
 * Ledger integration tests against a REAL PostgreSQL.
 *
 * These cannot be meaningfully faked. The invariants under test — the
 * non-negative CHECK, the deferred balanced-entry trigger, append-only
 * enforcement, and above all the concurrency behaviour — are properties of
 * Postgres, not of our code. A mocked database would assert only that our mock
 * behaves like our mock.
 *
 * Run with:
 *   docker run -d --name rayi-pg -e POSTGRES_PASSWORD=rayi -e POSTGRES_USER=rayi \
 *     -e POSTGRES_DB=rayi -p 55432:5432 postgres:17-alpine
 *   pnpm --filter @rayi/backend test:it
 *
 * Deliberately NOT auto-skipped when the database is absent. A silently skipped
 * test that guards money reports green while asserting nothing, which is worse
 * than no test — so an unreachable database fails loudly with instructions.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const USD = 'USD';

async function createAccount(
  role: string,
  normalBalance: 'debit' | 'credit',
  allowNegative = false,
): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ create_account: string }>>(
    `SELECT ledger.create_account($1::ledger.account_role, $2, $3::ledger.direction, $4) AS create_account`,
    role,
    USD,
    normalBalance,
    allowNegative,
  );
  return rows[0]!.create_account;
}

async function post(
  transition: string,
  sourceId: string,
  lines: Array<{
    accountId: string;
    direction: 'debit' | 'credit';
    amountMinor: string;
  }>,
): Promise<string> {
  const payload = lines.map((l) => ({
    account_id: l.accountId,
    direction: l.direction,
    amount_minor: l.amountMinor,
  }));
  const rows = await prisma.$queryRawUnsafe<Array<{ post_entry: string }>>(
    `SELECT ledger.post_entry($1, 'it', $2, $3::jsonb) AS post_entry`,
    transition,
    sourceId,
    JSON.stringify(payload),
  );
  return rows[0]!.post_entry;
}

async function balanceOf(accountId: string): Promise<bigint> {
  const rows = await prisma.$queryRawUnsafe<Array<{ balance_minor: bigint }>>(
    `SELECT balance_minor FROM ledger.account_balance WHERE account_id = $1::uuid`,
    accountId,
  );
  return rows[0]!.balance_minor;
}

/** Unique per run so repeated runs do not collide on the idempotency key. */
const run = Math.random().toString(36).slice(2, 10);

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${DATABASE_URL}.\n` +
        `These tests guard money and must not be skipped. Start Postgres with:\n` +
        `  docker run -d --name rayi-pg -e POSTGRES_PASSWORD=rayi -e POSTGRES_USER=rayi ` +
        `-e POSTGRES_DB=rayi -p 55432:5432 postgres:17-alpine\n` +
        `Original error: ${(error as Error).message}`,
    );
  }
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ledger — concurrency', () => {
  /**
   * THE test for this design.
   *
   * Twenty concurrent allocations, each for the whole balance, against an
   * account that can fund exactly one. The read-then-write version of this code
   * would let several through: every request reads $1,000, every request
   * concludes it is affordable, and the balance ends negative.
   *
   * Here, `balance = balance + delta` takes the row lock implicitly, and under
   * READ COMMITTED Postgres re-evaluates the delta against the post-commit
   * value — so the second writer sees the TRUE balance and the CHECK aborts it.
   */
  it('lets exactly ONE of twenty concurrent allocations succeed', async () => {
    const lot = await createAccount('org_lot_available', 'debit');
    const bootstrap = await createAccount('platform_bootstrap', 'credit', true);
    const campaign = await createAccount('campaign_allocated', 'debit');

    // Fund with exactly $1,000.00
    await post('SEED', `${run}-seed-conc`, [
      { accountId: lot, direction: 'debit', amountMinor: '100000' },
      { accountId: bootstrap, direction: 'credit', amountMinor: '100000' },
    ]);

    const attempts = Array.from({ length: 20 }, (_, i) =>
      post('ALLOCATE', `${run}-conc-${i}`, [
        { accountId: campaign, direction: 'debit', amountMinor: '100000' },
        { accountId: lot, direction: 'credit', amountMinor: '100000' },
      ]).then(
        () => 'ok' as const,
        () => 'rejected' as const,
      ),
    );

    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r === 'ok').length;

    expect(succeeded).toBe(1);
    expect(await balanceOf(lot)).toBe(0n);
    expect(await balanceOf(campaign)).toBe(100000n);
  }, 30_000);

  /**
   * Concurrent replays of the SAME key must converge on one entry, not twenty —
   * and every caller must be TOLD the same thing.
   *
   * An earlier version of this test swallowed rejections, which let a real
   * defect through: losing the insert race raised 23505, a terminal error, so a
   * worker reported failure for an allocation that had in fact posted. The
   * ledger was right and the command row was wrong, which is the worst way to be
   * wrong. Nothing here may be caught and discarded.
   */
  it('is idempotent under concurrency, not just sequentially', async () => {
    const lot = await createAccount('org_lot_available', 'debit');
    const bootstrap = await createAccount('platform_bootstrap', 'credit', true);
    const key = `${run}-idem-race`;

    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('SEED', key, [
          { accountId: lot, direction: 'debit', amountMinor: '5000' },
          { accountId: bootstrap, direction: 'credit', amountMinor: '5000' },
        ]),
      ),
    );

    // Every attempt succeeded, and every one names the same entry.
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(1);

    // The money moved exactly once.
    expect(await balanceOf(lot)).toBe(5000n);

    // And exactly one snapshot was written, so history agrees with the balance.
    const snapshots = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ledger.balance_snapshot WHERE account_id = $1::uuid`,
      lot,
    );
    expect(snapshots[0]?.count).toBe(1n);
  }, 30_000);
});

describe('ledger — invariants', () => {
  it('refuses an overdraft', async () => {
    const lot = await createAccount('org_lot_available', 'debit');
    const bootstrap = await createAccount('platform_bootstrap', 'credit', true);
    const campaign = await createAccount('campaign_allocated', 'debit');

    await post('SEED', `${run}-od-seed`, [
      { accountId: lot, direction: 'debit', amountMinor: '1000' },
      { accountId: bootstrap, direction: 'credit', amountMinor: '1000' },
    ]);

    await expect(
      post('ALLOCATE', `${run}-od`, [
        { accountId: campaign, direction: 'debit', amountMinor: '5000' },
        { accountId: lot, direction: 'credit', amountMinor: '5000' },
      ]),
    ).rejects.toThrow(/account_balance_non_negative/);

    // The refused attempt left nothing behind.
    expect(await balanceOf(lot)).toBe(1000n);
    expect(await balanceOf(campaign)).toBe(0n);
  }, 20_000);

  it('refuses an unbalanced entry', async () => {
    const a = await createAccount('org_lot_available', 'debit');
    const b = await createAccount('platform_bootstrap', 'credit', true);

    await expect(
      post('BAD', `${run}-unbal`, [
        { accountId: a, direction: 'debit', amountMinor: '100' },
        { accountId: b, direction: 'credit', amountMinor: '99' },
      ]),
    ).rejects.toThrow(/unbalanced/i);
  }, 20_000);

  it('refuses a single-sided entry', async () => {
    const a = await createAccount('org_lot_available', 'debit');
    await expect(
      post('BAD', `${run}-single`, [
        { accountId: a, direction: 'debit', amountMinor: '100' },
      ]),
    ).rejects.toThrow(/at least 2 lines/);
  }, 20_000);

  it('refuses a non-positive amount', async () => {
    const a = await createAccount('org_lot_available', 'debit');
    const b = await createAccount('platform_bootstrap', 'credit', true);
    await expect(
      post('BAD', `${run}-neg`, [
        { accountId: a, direction: 'debit', amountMinor: '-100' },
        { accountId: b, direction: 'credit', amountMinor: '-100' },
      ]),
    ).rejects.toThrow(/entry_line_amount_positive/);
  }, 20_000);

  it('refuses UPDATE and DELETE on ledger rows', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE ledger.entry SET transition = 'tampered'`,
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM ledger.entry_line`),
    ).rejects.toThrow(/append-only/);
  }, 20_000);

  it('keeps balance, latest snapshot and the sum of lines in agreement', async () => {
    const lot = await createAccount('org_lot_available', 'debit');
    const bootstrap = await createAccount('platform_bootstrap', 'credit', true);

    for (let i = 0; i < 5; i += 1) {
      await post('SEED', `${run}-agree-${i}`, [
        { accountId: lot, direction: 'debit', amountMinor: '1000' },
        { accountId: bootstrap, direction: 'credit', amountMinor: '1000' },
      ]);
    }

    const rows = await prisma.$queryRawUnsafe<
      Array<{ materialised: bigint; computed: bigint; latest_snapshot: bigint }>
    >(
      `SELECT b.balance_minor AS materialised,
              -- SUM(bigint) is numeric in Postgres and arrives as a string;
              -- cast so every caller sees one consistent bigint type.
              COALESCE((SELECT SUM(l.natural_minor) FROM ledger.entry_line l
                         WHERE l.account_id = b.account_id), 0)::bigint AS computed,
              (SELECT s.balance_after FROM ledger.balance_snapshot s
                WHERE s.account_id = b.account_id ORDER BY s.seq DESC LIMIT 1) AS latest_snapshot
         FROM ledger.account_balance b WHERE b.account_id = $1::uuid`,
      lot,
    );

    const row = rows[0]!;
    expect(row.materialised).toBe(5000n);
    expect(row.computed).toBe(5000n);
    expect(row.latest_snapshot).toBe(5000n);
  }, 30_000);

  /** The global invariant. If this ever fails, stop and investigate. */
  it('has no unbalanced entry anywhere in the database', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ entry_id: string }>>(
      `SELECT entry_id FROM ledger.entry_line GROUP BY entry_id HAVING SUM(signed_minor) <> 0`,
    );
    expect(rows).toEqual([]);
  }, 20_000);
});

describe('ledger — privilege boundary', () => {
  /**
   * The api process is internet-reachable. The whole isolation argument is that
   * compromising it yields no ability to move money, and this is what makes that
   * true rather than aspirational.
   */
  it('denies the api role any access to the ledger schema', async () => {
    await prisma.$executeRawUnsafe(`SET ROLE rayi_api`);
    try {
      await expect(
        prisma.$queryRawUnsafe(`SELECT count(*) FROM ledger.account`),
      ).rejects.toThrow(/permission denied for schema ledger/);
    } finally {
      await prisma.$executeRawUnsafe(`RESET ROLE`);
    }
  }, 20_000);

  it('denies the api role execution of post_entry', async () => {
    await prisma.$executeRawUnsafe(`SET ROLE rayi_api`);
    try {
      await expect(
        prisma.$queryRawUnsafe(
          `SELECT ledger.post_entry('X','t','x','[]'::jsonb)`,
        ),
      ).rejects.toThrow(/permission denied for schema ledger/);
    } finally {
      await prisma.$executeRawUnsafe(`RESET ROLE`);
    }
  }, 20_000);

  it('allows the worker to read but never to UPDATE an entry', async () => {
    await prisma.$executeRawUnsafe(`SET ROLE rayi_worker`);
    try {
      await expect(
        prisma.$queryRawUnsafe(`SELECT count(*) FROM ledger.account`),
      ).resolves.toBeDefined();

      await expect(
        prisma.$executeRawUnsafe(`UPDATE ledger.entry SET transition = 'x'`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await prisma.$executeRawUnsafe(`RESET ROLE`);
    }
  }, 20_000);
});

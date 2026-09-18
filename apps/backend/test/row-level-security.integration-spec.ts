import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../src/database/prisma.service';
import { TenantScope } from '../src/database/tenant-scope';

/**
 * Row-level security, and an honest account of what it buys.
 *
 * Every tenant query already carries its predicate in the WHERE clause, and the
 * composite foreign keys make a cross-org row unrepresentable. This is the third
 * layer, for the case the other two cannot cover: a query someone writes LATER
 * that forgets the predicate.
 *
 * The threat is not a malicious developer. It is
 * `findMany({ where: { state: 'live' } })` in a reporting endpoint six months
 * from now — correct-looking, reviewed, and returning every organization's rows.
 *
 * RLS does not make that impossible; it changes the FAILURE MODE. A query
 * without a tenant returns ZERO rows rather than everyone's — a visibly broken
 * feature instead of a silent leak. These tests assert exactly that, including
 * the parts RLS does not cover.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ?? 'postgresql://rayi:rayi@localhost:55432/rayi';

/**
 * A SECOND client, connected as `rayi_app`.
 *
 * This is the whole reason the test is shaped this way. The default development
 * role has `rolsuper` and `rolbypassrls`, and both bypass every policy
 * unconditionally — `FORCE ROW LEVEL SECURITY` subjects the table OWNER to
 * policies but cannot touch a superuser.
 *
 * Testing through the superuser connection would have passed by seeing every
 * row, and the first environment where RLS mattered would have been the first
 * one where it had never run. So the assertions go through the role the
 * application actually connects as.
 */
const APP_ROLE_URL = DATABASE_URL.replace(/\/\/[^@]+@/, '//rayi_app:rls-test-password@');

/** The privileged client: seeds fixtures and grants the app role a login. */
const admin = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
let prisma: PrismaClient;
let scope: TenantScope;

let orgA: string;
let orgB: string;

beforeAll(async () => {
  await admin.$queryRaw`SELECT 1`;

  // The credential lives here rather than in the migration: a login password
  // committed to a repo is a login password in production.
  await admin.$executeRawUnsafe(
    `ALTER ROLE rayi_app WITH LOGIN PASSWORD 'rls-test-password'`,
  );

  prisma = new PrismaClient({ datasources: { db: { url: APP_ROLE_URL } } });
  scope = new TenantScope(prisma as unknown as PrismaService);

  // Prove the premise before relying on it. If the app role ever acquires
  // superuser or bypassrls, every assertion below becomes vacuous — passing
  // while testing nothing.
  const [role] = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  if (role?.rolsuper || role?.rolbypassrls) {
    throw new Error(
      'The test connection bypasses RLS, so these assertions would prove nothing.',
    );
  }

  const run = randomUUID().slice(0, 12);

  await (async (tx: typeof admin) => {
    const a = await tx.organization.create({ data: { name: 'Acme', slug: `rls-a-${run}` } });
    const b = await tx.organization.create({ data: { name: 'Rival', slug: `rls-b-${run}` } });
    orgA = a.id;
    orgB = b.id;

    const wa = await tx.workspace.create({
      data: { organizationId: orgA, name: 'A', slug: 'a' },
    });
    const wb = await tx.workspace.create({
      data: { organizationId: orgB, name: 'B', slug: 'b' },
    });

    await tx.campaign.create({
      data: { organizationId: orgA, workspaceId: wa.id, name: 'A campaign', state: 'live' },
    });
    await tx.campaign.create({
      data: { organizationId: orgB, workspaceId: wb.id, name: 'B campaign', state: 'live' },
    });
  })(admin);
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await admin.$disconnect();
});

describe('a query with a tenant set sees only that tenant', () => {
  it('returns only org A’s campaigns, WITHOUT a WHERE clause', async () => {
    // The whole point: this query has no tenant predicate at all. It is exactly
    // the shape a reporting endpoint would have.
    const campaigns = await scope.withTenant(orgA, (tx) =>
      tx.campaign.findMany({ where: { state: 'live' } }),
    );

    expect(campaigns.length).toBeGreaterThan(0);
    expect(campaigns.every((campaign) => campaign.organizationId === orgA)).toBe(true);
  }, 20_000);

  it('returns only org B’s, from the same query', async () => {
    const campaigns = await scope.withTenant(orgB, (tx) =>
      tx.campaign.findMany({ where: { state: 'live' } }),
    );
    expect(campaigns.every((campaign) => campaign.organizationId === orgB)).toBe(true);
  }, 20_000);

  it('hides another tenant’s row even when asked for BY ID', async () => {
    // An IDOR attempt: the id is known, the tenant is not theirs.
    const theirs = await scope.withTenant(orgB, (tx) => tx.campaign.findFirstOrThrow({}));

    const found = await scope.withTenant(orgA, (tx) =>
      tx.campaign.findFirst({ where: { id: theirs.id } }),
    );
    expect(found).toBeNull();
  }, 20_000);

  it('applies to workspaces, members, money authority and treasury commands', async () => {
    const counts = await scope.withTenant(orgA, async (tx) => ({
      workspaces: await tx.workspace.count(),
      members: await tx.member.count(),
      authorities: await tx.moneyAuthority.count(),
      commands: await tx.treasuryCommand.count(),
    }));

    // Org A has exactly one workspace and no members, authorities or commands.
    // Without RLS these would be every organization's totals, which in this
    // database is a large number.
    expect(counts.workspaces).toBe(1);
    expect(counts.members).toBe(0);
    expect(counts.authorities).toBe(0);
    expect(counts.commands).toBe(0);
  }, 20_000);
});

describe('a query with NO tenant sees nothing', () => {
  it('returns zero rows rather than every row', async () => {
    // THE asymmetry that makes this worth having. A forgotten `withTenant` is a
    // visibly broken feature, not a silent cross-tenant leak.
    const leaked = await prisma.campaign.findMany({ where: { state: 'live' } });
    expect(leaked).toEqual([]);
  }, 20_000);

  it('cannot INSERT into a tenant either', async () => {
    // WITH CHECK, not just USING. Otherwise a connection with no tenant could
    // write rows it would then be unable to read — which is worse than either.
    const workspace = await scope.crossTenant('fetch a workspace id', (tx) =>
      tx.workspace.findFirstOrThrow({ where: { organizationId: orgA } }),
    );

    await expect(
      prisma.campaign.create({
        data: { organizationId: orgA, workspaceId: workspace.id, name: 'Smuggled' },
      }),
    ).rejects.toThrow();
  }, 20_000);

  it('cannot write into ANOTHER tenant while scoped to one', async () => {
    const workspace = await scope.crossTenant('fetch org B workspace', (tx) =>
      tx.workspace.findFirstOrThrow({ where: { organizationId: orgB } }),
    );

    await expect(
      scope.withTenant(orgA, (tx) =>
        tx.campaign.create({
          data: { organizationId: orgB, workspaceId: workspace.id, name: 'Cross-tenant write' },
        }),
      ),
    ).rejects.toThrow();
  }, 20_000);
});

describe('the tenant does not leak between operations', () => {
  it('is reverted when the scope ends', async () => {
    // `SET LOCAL`, not `SET`. A plain `SET` outlives the transaction and, on a
    // pooled connection, leaks the tenant into whatever runs next — which would
    // be WORSE than no RLS, because the next request reads someone else's data
    // while every check passes.
    await scope.withTenant(orgA, (tx) => tx.campaign.findMany());

    const afterwards = await prisma.campaign.findMany();
    expect(afterwards).toEqual([]);
  }, 20_000);

  it('is reverted even when the scope throws', async () => {
    await expect(
      scope.withTenant(orgA, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await prisma.campaign.findMany()).toEqual([]);
  }, 20_000);

  it('does not leak out of a cross-tenant scope either', async () => {
    await scope.crossTenant('check leakage', (tx) => tx.campaign.findMany());
    expect(await prisma.campaign.findMany()).toEqual([]);
  }, 20_000);
});

describe('the cross-tenant escape hatch', () => {
  it('sees every tenant, which is what the nightly reconciliation needs', async () => {
    const all = await scope.crossTenant('reconciliation', (tx) =>
      tx.campaign.findMany({ where: { organizationId: { in: [orgA, orgB] } } }),
    );
    expect(all).toHaveLength(2);
  }, 20_000);

  it('must be asked for BY NAME rather than acquired by forgetting something', async () => {
    // Granting the application role BYPASSRLS would make the policies
    // decorative. This is explicit, greppable, and appears in the code using it.
    const withoutIt = await prisma.campaign.findMany();
    expect(withoutIt).toEqual([]);
  }, 20_000);
});

describe('what RLS does NOT cover', () => {
  it('refuses an empty organization id rather than matching nothing silently', async () => {
    // An empty string would set the tenant to '' and match no rows — a silent
    // zero-row result rather than an obvious mistake.
    await expect(scope.withTenant('', async () => undefined)).rejects.toThrow(
      /requires an organization id/i,
    );
  }, 20_000);

  it('does not protect a tenant id that was never checked', async () => {
    // Stated as a test so the limitation cannot be forgotten. RLS enforces
    // "rows belong to THE TENANT ON THE CONNECTION". It has no opinion about
    // whether the caller was entitled to that tenant — that is what
    // PermissionGuard and the use-case scope check are for, and RLS does not
    // replace either.
    const rows = await scope.withTenant(orgB, (tx) => tx.campaign.findMany());
    expect(rows.every((row) => row.organizationId === orgB)).toBe(true);
  }, 20_000);
});

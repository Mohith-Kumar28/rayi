import { PrismaClient } from '@prisma/client';
import { ALL_OPERATIONS } from '@rayi/contracts';

/**
 * Every permission a route declares must be held by at least one role.
 *
 * A route naming a permission nobody has FAILS CLOSED — which is the right
 * direction, and exactly why it is dangerous. It 403s for every user including
 * the owner, no alarm fires, no test breaks, and the first report is a customer
 * saying a button does nothing. The manifest and the role matrix are two files
 * that must agree and nothing made them.
 *
 * `platform:*` is excluded: it is deliberately held by NO organization role.
 * That separation is asserted by the manifest tests, and granting it to a role
 * here would be the bug rather than the fix.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ?? 'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

function declaredPermissions(): string[] {
  const permissions = new Set<string>();
  for (const operation of ALL_OPERATIONS) {
    if (operation.access.kind !== 'permission') continue;
    if (operation.access.permission.startsWith('platform:')) continue;
    permissions.add(operation.access.permission);
  }
  return [...permissions].sort();
}

async function grantedPermissions(): Promise<Set<string>> {
  const rows = await prisma.rolePermission.findMany({ select: { permission: true } });
  return new Set(rows.map((row) => row.permission));
}

describe('permission coverage', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('grants every permission the manifest declares to at least one role', async () => {
    const granted = await grantedPermissions();
    const orphaned = declaredPermissions().filter((permission) => !granted.has(permission));

    expect(orphaned).toEqual([]);
  });

  /**
   * The check, seen to fail.
   *
   * A rule only ever observed passing is a rule nobody knows still works, so the
   * negative case runs the same comparison against a role matrix with one
   * permission removed and asserts it is caught.
   */
  it('catches a permission that is declared but granted to nobody', async () => {
    const granted = await grantedPermissions();
    const declared = declaredPermissions();
    expect(declared.length).toBeGreaterThan(0);

    const sabotaged = new Set(granted);
    const dropped = declared[0]!;
    sabotaged.delete(dropped);

    const orphaned = declared.filter((permission) => !sabotaged.has(permission));
    expect(orphaned).toEqual([dropped]);
  });

  /**
   * The reverse direction is deliberately NOT asserted.
   *
   * A permission granted to a role but declared by no route is harmless — it is
   * a capability nothing currently gates, and roles are seeded ahead of the
   * routes that use them on purpose. Asserting it would turn "we planned for
   * this" into a failing build.
   */
  it('does not require every granted permission to have a route', async () => {
    const granted = await grantedPermissions();
    expect(granted.size).toBeGreaterThanOrEqual(declaredPermissions().length);
  });

  /**
   * `platform:*` stays out of the organization role matrix.
   *
   * One compromised super-admin session sees every brand's funding position. An
   * org role that could reach it would mean a brand owner promoting themselves
   * into the platform surface.
   */
  it('gives no organization role a platform permission', async () => {
    const platformGrants = await prisma.rolePermission.findMany({
      where: { permission: { startsWith: 'platform:' }, scope: { not: 'platform' } },
      select: { role: true, permission: true },
    });
    expect(platformGrants).toEqual([]);
  });
});

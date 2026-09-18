import { z } from 'zod';

import { MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * The super-admin surface.
 *
 * **This is the only part of the system that reads across tenants**, and that
 * makes it the highest-value target in the product: one compromised session here
 * sees every brand's funding position, every creator's earnings, and the full
 * shape of the business.
 *
 * So it is treated as its own population rather than as a powerful role:
 *
 *   - Its own `platform:*` permissions, held by nobody in any organization's
 *     role matrix. An org owner cannot reach these however senior they are.
 *   - Served from an **isolated origin** (`admin.rayi.com`), so an XSS anywhere
 *     in the brand or creator app cannot reach an admin session.
 *   - Every read goes through `crossTenant(reason)`, which logs each call. A
 *     cross-tenant query nobody can account for is the first sign one was added
 *     carelessly.
 *
 * Deliberately READ-ONLY for now. An admin surface that can also act is a single
 * session that can move any brand's money, and nothing here yet needs that.
 */

export const BrandSummarySchema = z.object({
  organizationId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.iso.datetime(),
  memberCount: z.int(),
  campaignCount: z.int(),
  activeDealCount: z.int(),
});

export const listBrands = defineOperation({
  operationId: 'listBrands',
  method: 'get',
  path: '/v1/admin/brands',
  summary: 'Every brand on the platform',
  description:
    'Reads across tenants. Available only to platform staff, from an isolated origin, and every ' +
    'call is logged — a cross-tenant read nobody can account for is how one gets added carelessly.',
  tags: ['admin'],
  access: { kind: 'permission', permission: 'platform:read' },
  successStatus: 200,
  response: z.object({ brands: z.array(BrandSummarySchema) }),
  errors: ['unauthenticated', 'forbidden'],
});

export const PlatformStatsSchema = z.object({
  brandCount: z.int(),
  creatorCount: z.int(),
  activeDealCount: z.int(),
  /**
   * Money that has actually moved to creators. Never anything merely approved —
   * an internal dashboard that overstates is how a business plans around revenue
   * it does not have.
   */
  releasedToCreators: MoneySchema,
  /** Held for brands. NOT revenue: it is their money, sitting at Stripe. */
  fundsUnderManagement: MoneySchema,
  /**
   * What Rayi has actually earned in fees.
   *
   * Kept strictly separate from funds under management. Conflating the two is
   * the single most misleading thing an internal dashboard can do, and the
   * mistake gets repeated in every board deck built from it.
   */
  platformRevenue: MoneySchema,
  /** Deliverables waiting on a brand decision, across every tenant. */
  pendingReviews: z.int(),
  /**
   * When the worker last computed this.
   *
   * Shown, always. A figure with no timestamp is a figure someone will assume is
   * live — and this one is not, deliberately: it is computed on a schedule
   * because the api process cannot read the ledger at all.
   */
  computedAt: z.iso.datetime(),
});

export const getPlatformStats = defineOperation({
  operationId: 'getPlatformStats',
  method: 'get',
  path: '/v1/admin/stats',
  summary: 'Platform-wide figures',
  description:
    'Funds under management and platform revenue are DIFFERENT numbers and are never added ' +
    'together. One is brands’ money sitting at Stripe; the other is what Rayi has earned.',
  tags: ['admin'],
  access: { kind: 'permission', permission: 'platform:read' },
  successStatus: 200,
  response: PlatformStatsSchema,
  errors: ['unauthenticated', 'forbidden'],
});

/**
 * The invariants that must hold across the whole ledger, for an operator.
 *
 * The most valuable screen in the system, and the one that runs forever: a
 * nightly reconciliation that must come out at zero. A failure here means the
 * ledger disagrees with itself, and everything else on the platform is suspect
 * until it is explained.
 */
export const LedgerHealthSchema = z.object({
  /** When the worker last checked. Null when it never has. */
  checkedAt: z.iso.datetime().nullable(),
  /** Entries whose debits and credits do not sum to zero. Must be empty. */
  unbalancedEntries: z.array(z.string()),
  /** Accounts whose materialised balance disagrees with the sum of their lines. */
  driftedAccounts: z.array(z.string()),
  /** Breaks in the audit log's hash chain. */
  auditChainBreaks: z.array(z.object({ seq: z.string(), reason: z.string() })),
  /** Treasury commands that failed and were never resolved. */
  failedCommands: z.int(),
});

export const getLedgerHealth = defineOperation({
  operationId: 'getLedgerHealth',
  method: 'get',
  path: '/v1/admin/ledger-health',
  summary: 'Do the books agree with themselves?',
  description:
    'Every list here must be empty. A non-empty one means the ledger disagrees with itself, and ' +
    'nothing else on the platform can be trusted until it is explained.',
  tags: ['admin'],
  access: { kind: 'permission', permission: 'platform:read' },
  successStatus: 200,
  response: LedgerHealthSchema,
  errors: ['unauthenticated', 'forbidden'],
});

export const ADMIN_OPERATIONS = [listBrands, getPlatformStats, getLedgerHealth] as const;

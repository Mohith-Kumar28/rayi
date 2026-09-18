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


// ---------------------------------------------------------------------------
// Operational surfaces
//
// Everything below is READ-ONLY, like everything above it. An admin surface
// that can also act is a single session that can move any brand's money, and
// nothing here yet needs that. When one eventually does, it gets its own
// permission and its own step-up rather than being folded into `platform:read`.
// ---------------------------------------------------------------------------

export const BrandDetailSchema = BrandSummarySchema.extend({
  frozen: z.boolean(),
  bankAccountStatus: z.enum(['none', 'pending_verification', 'verified', 'blocked']),
  /**
   * Ledger figures for ONE brand, from the worker-computed snapshot.
   *
   * Never read live: `rayi_api` has no grants on the ledger schema at all, so a
   * balance read here would fail in production while passing in development as
   * a superuser — the worst kind of difference, because it only appears once
   * real money is behind it.
   */
  funded: MoneySchema,
  allocated: MoneySchema,
  released: MoneySchema,
  computedAt: z.iso.datetime().nullable(),
  workspaces: z.array(
    z.object({ workspaceId: z.uuid(), name: z.string(), campaignCount: z.int() }),
  ),
  owners: z.array(z.object({ email: z.email(), role: z.string() })),
});

export const getBrandDetail = defineOperation({
  operationId: 'getBrandDetail',
  method: 'get',
  /**
   * `{brandId}`, deliberately NOT `{orgId}`.
   *
   * `{orgId}` is the tenant-scope parameter: the guard resolves it as "is the
   * caller a member of this organization", and a non-member gets 404. Platform
   * staff are members of nothing, so reusing the name would mean either
   * breaking this route or teaching the tenant guard an exception — and an
   * exception in the tenant guard is the one place the system cannot afford one.
   *
   * The different name says the different thing: here an organization is the
   * SUBJECT being read, not the scope the caller is acting within.
   */
  path: '/v1/admin/brands/{brandId}',
  summary: 'One brand, across tenants',
  tags: ['admin'],
  access: { kind: 'permission', permission: 'platform:read' },
  pathParams: z.object({ brandId: z.uuid() }),
  successStatus: 200,
  response: BrandDetailSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const PlatformCreatorSchema = z.object({
  creatorId: z.uuid(),
  handle: z.string(),
  email: z.email(),
  payoutsEnabled: z.boolean(),
  /** A creator on hold cannot be paid, and is the first thing support is asked about. */
  payoutHoldUntil: z.iso.datetime().nullable(),
  brandCount: z.int(),
  activeDealCount: z.int(),
  totalReleased: MoneySchema,
  joinedAt: z.iso.datetime(),
});

export const listPlatformCreators = defineOperation({
  operationId: 'listPlatformCreators',
  method: 'get',
  path: '/v1/admin/creators',
  summary: 'Every creator on the platform',
  description:
    'The population that RECEIVES the money and has the weakest authentication. Payout holds and ' +
    'disabled payouts are surfaced first, because those are what support is actually contacted about.',
  tags: ['admin'],
  access: { kind: 'permission', permission: 'platform:read' },
  query: z.object({ search: z.string().max(80).optional(), blockedOnly: z.boolean().optional() }),
  successStatus: 200,
  response: z.object({
    creators: z.array(PlatformCreatorSchema),
    /** Creators who have money owed and cannot receive it. The actionable number. */
    blockedCount: z.int(),
  }),
  errors: ['unauthenticated', 'forbidden'],
});

/**
 * The treasury command inbox.
 *
 * The internal RPC is a row, not a network call — so the queue IS a table, and
 * this is that table. A `failed` command is money work that was requested and
 * did not happen, which is the single most important operational signal in the
 * system and the reason this screen exists at all.
 */
export const TreasuryCommandSchema = z.object({
  commandId: z.uuid(),
  kind: z.string(),
  state: z.enum(['pending', 'claimed', 'succeeded', 'failed', 'abandoned']),
  organizationId: z.uuid(),
  organizationName: z.string(),
  /** How many times a worker has picked this up. A rising count is a stuck command. */
  attempts: z.int(),
  claimedBy: z.string().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** The failure, in the worker's words. Null while it has not failed. */
  lastError: z.string().nullable(),
  /**
   * What the command expected to be available when it was written.
   *
   * The worker re-derives everything authoritative from the database rather than
   * trusting the payload — the payload is a POINTER, never an instruction — so
   * this figure is for a human comparing intent against outcome, not for the
   * worker.
   */
  expectedAvailable: MoneySchema.nullable(),
});

export const listTreasuryCommands = defineOperation({
  operationId: 'listTreasuryCommands',
  method: 'get',
  path: '/v1/admin/treasury-commands',
  summary: 'The treasury command inbox',
  description:
    'Failed commands first. A failed command is money work that was requested and did not happen, ' +
    'and every one of them is a person waiting for something.',
  tags: ['admin'],
  access: { kind: 'permission', permission: 'platform:read' },
  query: z.object({
    state: z.enum(['pending', 'claimed', 'succeeded', 'failed', 'abandoned']).optional(),
  }),
  successStatus: 200,
  response: z.object({
    commands: z.array(TreasuryCommandSchema),
    failedCount: z.int(),
    /** Claimed a long time ago and never finished — a worker died holding the lease. */
    stuckCount: z.int(),
  }),
  errors: ['unauthenticated', 'forbidden'],
});

export const WebhookDeliverySchema = z.object({
  deliveryId: z.uuid(),
  source: z.enum(['stripe_platform', 'stripe_connect', 'resend']),
  eventType: z.string(),
  /**
   * Whether the signature verified over the RAW bytes.
   *
   * A delivery that fails this is stored and shown rather than dropped: a burst
   * of signature failures is either a rotated secret or somebody probing, and
   * both are things an operator needs to see rather than infer from silence.
   */
  signatureValid: z.boolean(),
  state: z.enum(['received', 'processed', 'failed', 'ignored']),
  receivedAt: z.iso.datetime(),
  processedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
});

export const listWebhookDeliveries = defineOperation({
  operationId: 'listWebhookDeliveries',
  method: 'get',
  path: '/v1/admin/webhooks',
  summary: 'Recent webhook deliveries',
  description:
    'A blocked or unprocessed webhook is a silent money bug with a three-day fuse — the provider ' +
    'retries for that long and then stops, and nothing else announces it.',
  tags: ['admin'],
  access: { kind: 'permission', permission: 'platform:read' },
  query: z.object({
    source: z.enum(['stripe_platform', 'stripe_connect', 'resend']).optional(),
    failedOnly: z.boolean().optional(),
  }),
  successStatus: 200,
  response: z.object({
    deliveries: z.array(WebhookDeliverySchema),
    failedCount: z.int(),
    /** Verified, stored, and never interpreted. The queue nobody drained. */
    unprocessedCount: z.int(),
  }),
  errors: ['unauthenticated', 'forbidden'],
});

export const PlatformAuditEventSchema = z.object({
  seq: z.string().describe('Monotonic, but NOT gapless — a rolled-back transaction burns a value.'),
  occurredAt: z.iso.datetime(),
  action: z.string(),
  label: z.string(),
  actorEmail: z.email().nullable(),
  organizationId: z.uuid().nullable(),
  organizationName: z.string().nullable(),
  ipAddress: z.string().nullable(),
  /** Whether this row's hash still matches the chain. False is an incident. */
  chainValid: z.boolean(),
});

export const listAuditEvents = defineOperation({
  operationId: 'listAuditEvents',
  method: 'get',
  path: '/v1/admin/audit',
  summary: 'The audit log, across tenants',
  description:
    'Append-only and hash-chained. `chainValid` is per row, so a break is located rather than ' +
    'merely counted — and the sequence is deliberately NOT checked for gaps, because identity ' +
    'columns are not gapless and a rolled-back transaction would otherwise alarm on every failure.',
  tags: ['admin'],
  access: { kind: 'permission', permission: 'platform:read' },
  query: z.object({
    action: z.string().max(80).optional(),
    organizationId: z.uuid().optional(),
    moneyOnly: z.boolean().optional(),
  }),
  successStatus: 200,
  response: z.object({
    events: z.array(PlatformAuditEventSchema),
    /** Rows whose hash does not match. Must be zero. */
    chainBreakCount: z.int(),
  }),
  errors: ['unauthenticated', 'forbidden'],
});

export const ADMIN_OPERATIONS = [
  listBrands,
  getPlatformStats,
  getLedgerHealth,
  getBrandDetail,
  listPlatformCreators,
  listTreasuryCommands,
  listWebhookDeliveries,
  listAuditEvents,
] as const;

/**
 * Ledger domain types. Pure — no NestJS, no Prisma, no I/O.
 *
 * These mirror the enums in the migration. They are duplicated deliberately
 * rather than generated: the database is the authority, and a conformance test
 * asserts the two agree, so a drift produces a failing test rather than a
 * runtime cast error deep in the money path.
 */

export const Direction = {
  Debit: 'debit',
  Credit: 'credit',
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export const AccountRole = {
  /** Brand money, per deposit — never one pooled account. See docs/04-money-rules.md. */
  OrgLotAvailable: 'org_lot_available',
  OrgLotClearing: 'org_lot_clearing',
  /** MEMO accounts: unsettled ACH. No allocation transition may debit these. */
  OrgDepositPendingMemo: 'org_deposit_pending_memo',
  StripeAchInTransitMemo: 'stripe_ach_in_transit_memo',
  CampaignAllocated: 'campaign_allocated',
  DeliverableReserved: 'deliverable_reserved',
  CreatorPayable: 'creator_payable',
  PlatformFeeRevenue: 'platform_fee_revenue',
  FraudReserve: 'fraud_reserve',
  PlatformBootstrap: 'platform_bootstrap',
  PspStripePending: 'psp_stripe_pending',
  PspStripeAvailable: 'psp_stripe_available',
} as const;
export type AccountRole = (typeof AccountRole)[keyof typeof AccountRole];

export interface EntryLineInput {
  readonly accountId: string;
  readonly direction: Direction;
  /** Always POSITIVE. `direction` carries the sign. */
  readonly amountMinor: bigint;
}

export interface PostEntryCommand {
  /** Domain name for what happened, e.g. `ALLOCATE_BUDGET`. Enumerable and reviewable. */
  readonly transition: string;
  /**
   * The idempotency key, as a pair. Replaying the same (type, id) posts nothing
   * new and returns the original entry.
   *
   * DERIVE it from the intent — `allocate:{campaignId}:{version}` — never from a
   * random value. A random key held in client memory is destroyed by exactly the
   * page refresh a user reaches for when a money action appears to hang.
   */
  readonly sourceType: string;
  readonly sourceId: string;
  readonly lines: readonly EntryLineInput[];
  readonly actorPrincipalId?: string;
  readonly requestId?: string;
  readonly codeVersion?: string;
}

export type LedgerErrorCode =
  | 'UNBALANCED'
  | 'INSUFFICIENT_FUNDS'
  | 'NO_SUCH_ACCOUNT'
  | 'DUPLICATE_POSTING'
  | 'POST_FAILED';

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

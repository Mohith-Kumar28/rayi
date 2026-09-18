/**
 * The ledger's controls, declared.
 *
 * Every entry here is something the migrations create and the money safety
 * argument depends on. `LedgerIntegrityService` asserts each one exists in the
 * database the process actually connected to, at boot, before anything serves.
 *
 * Why this list is hand-written rather than derived from the catalog: derived
 * from the catalog it would assert "the database looks like the database", which
 * is true in every state including a compromised one. Written down, it asserts
 * "the database looks like what this code was reviewed against" — so dropping a
 * constraint in a migration, or pointing a worker at the wrong database, or a
 * restore that predates a control, all fail loudly at boot.
 *
 * A migration that legitimately removes a control must edit this file, which
 * puts the removal in the diff a human reads.
 */

export interface ExpectedCheck {
  readonly table: string;
  readonly name: string;
  /** What breaks if this is missing. Printed in the failure, so the on-call page explains itself. */
  readonly guards: string;
}

/** CHECK and FOREIGN KEY constraints. */
export const EXPECTED_CONSTRAINTS: readonly ExpectedCheck[] = [
  {
    table: 'ledger.account_balance',
    name: 'account_balance_non_negative',
    guards: 'THE solvency invariant. Without it an account can be overdrawn.',
  },
  {
    table: 'ledger.account_balance',
    name: 'account_balance_allow_negative_fk',
    guards:
      'Stops the denormalised allow_negative flag being flipped to grant an account the right to go negative.',
  },
  {
    table: 'ledger.entry_line',
    name: 'entry_line_amount_positive',
    guards: 'Amounts are always positive; direction carries the sign.',
  },
  {
    table: 'ledger.entry_line',
    name: 'entry_line_account_fk',
    guards:
      'Currency and normal_balance on a line must match its account. Without it a mixed-currency entry is insertable.',
  },
  {
    table: 'ledger.entry',
    name: 'entry_source_key',
    guards: 'Idempotency. Without it a replayed webhook or retried job posts twice.',
  },
  {
    table: 'ledger.account',
    name: 'account_currency_iso4217',
    guards: 'Currency is a three-letter code, not free text.',
  },
  {
    table: 'ledger.account',
    name: 'account_campaign_requires_org',
    guards:
      'A NULL org_id would silently bypass the parentage FK below, because a composite FK is only enforced when every column is non-null.',
  },
  {
    table: 'ledger.account',
    name: 'account_campaign_belongs_to_org',
    guards:
      'A campaign account cannot be parented to the wrong organization. Without it, a caller with another tenant’s campaign id posts against their money.',
  },
];

export interface ExpectedTrigger {
  readonly table: string;
  readonly name: string;
  readonly deferrable: boolean;
  readonly guards: string;
}

export const EXPECTED_TRIGGERS: readonly ExpectedTrigger[] = [
  {
    table: 'ledger.entry',
    name: 'entry_append_only',
    deferrable: false,
    guards: 'Corrections are reversing entries, never edits.',
  },
  {
    table: 'ledger.entry_line',
    name: 'entry_line_append_only',
    deferrable: false,
    guards: 'A posted line can never be rewritten.',
  },
  {
    table: 'ledger.balance_snapshot',
    name: 'balance_snapshot_append_only',
    deferrable: false,
    guards: 'Balance history is immutable, so drift is detectable.',
  },
  {
    table: 'ledger.entry_line',
    name: 'entry_line_balanced',
    // DEFERRABLE INITIALLY DEFERRED, so it runs at COMMIT. Lines are inserted one
    // at a time and an entry only has to balance once it is complete. Recreated
    // as an immediate trigger it would reject every legitimate multi-line entry.
    deferrable: true,
    guards: 'Every entry sums to zero and has at least two lines.',
  },
];

export interface ExpectedFunction {
  readonly name: string;
  readonly securityDefiner: boolean;
  readonly guards: string;
}

export const EXPECTED_FUNCTIONS: readonly ExpectedFunction[] = [
  {
    name: 'post_entry',
    securityDefiner: true,
    guards: 'The only door into the ledger. Callers need EXECUTE on this and nothing else.',
  },
  {
    name: 'create_account',
    securityDefiner: true,
    guards: 'An account and its balance row are created together, or not at all.',
  },
  {
    name: 'account_for_campaign',
    securityDefiner: true,
    guards:
      'Account derivation. Without it a caller names an account id, and can therefore name someone else’s.',
  },
  {
    name: 'org_lot_to_spend',
    securityDefiner: true,
    guards: 'Refuses to choose between lots rather than silently picking one.',
  },
];

export interface ExpectedIndex {
  readonly table: string;
  readonly name: string;
  readonly guards: string;
}

export const EXPECTED_UNIQUE_INDEXES: readonly ExpectedIndex[] = [
  {
    table: 'ledger.account',
    name: 'account_one_lot_per_deposit',
    guards: 'A deposit cannot have two available lots.',
  },
  {
    table: 'ledger.account',
    name: 'account_one_per_campaign_role',
    guards:
      'A duplicate campaign account splits a balance in two. Each half satisfies >= 0 while the real position is misreported — constraints fine, number wrong.',
  },
  {
    table: 'ledger.account',
    name: 'account_one_per_org_role',
    guards: 'Same, for org-scoped non-lot accounts.',
  },
];

export interface ExpectedGeneratedColumn {
  readonly table: string;
  readonly column: string;
  readonly guards: string;
}

export const EXPECTED_GENERATED_COLUMNS: readonly ExpectedGeneratedColumn[] = [
  {
    table: 'ledger.entry_line',
    column: 'signed_minor',
    guards:
      'Debits positive, credits negative — the SUM = 0 assertion reads this. If it stopped being generated, application code could write a sign.',
  },
  {
    table: 'ledger.entry_line',
    column: 'natural_minor',
    guards:
      'Movement in the account’s own normal direction — every balance reads this. If it stopped being generated, balances could be written by hand.',
  },
];

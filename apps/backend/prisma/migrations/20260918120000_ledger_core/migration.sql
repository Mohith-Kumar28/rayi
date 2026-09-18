-- ============================================================================
-- LEDGER CORE
-- ============================================================================
--
-- The central idea: AN ACCOUNT IS A STATE OF MONEY. There is no `status` column
-- on a dollar and no mutable balance field that code can assign to. A dollar's
-- state is the account it sits in, so every "X cannot exceed Y" invariant
-- collapses into one uniform rule: THIS ACCOUNT CANNOT GO NEGATIVE.
--
-- Over-allocation, over-reservation, over-release and the workspace budget cap
-- are then all the same CHECK constraint, enforced by the storage engine rather
-- than by application code that can forget.
--
-- Hand-written rather than generated, because Prisma cannot express deferred
-- constraint triggers, generated columns, REVOKE, composite foreign keys onto
-- partial unique indexes, or SECURITY DEFINER functions — and every one of those
-- is load-bearing here.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS ledger;

-- ----------------------------------------------------------------------------
-- Vocabulary
-- ----------------------------------------------------------------------------

-- One enum for both "which way is this line going" and "which way does this
-- account increase". They are the same vocabulary, and sharing the type is not
-- merely tidy: comparing two values of the SAME enum is immutable, which is what
-- lets `natural_minor` below be a generated column. Comparing across two enums
-- would require an ::text cast, which Postgres rejects as non-immutable.
CREATE TYPE ledger.direction AS ENUM ('debit', 'credit');

CREATE TYPE ledger.account_role AS ENUM (
  -- Brand money, per deposit. NOT one pooled account: a pooled balance makes
  -- "unallocated funds are refundable to the ORIGINATING bank account"
  -- unenforceable, which is the definition of the hosted wallet we must not be.
  'org_lot_available',      -- settled and past its ACH return window
  'org_lot_clearing',       -- settled, still inside the return window
  -- Unsettled ACH. A MEMO class: no allocation transition may debit these, so a
  -- bug in allocation code cannot reach money that has not arrived.
  'org_deposit_pending_memo',
  'stripe_ach_in_transit_memo',
  -- Committed money
  'campaign_allocated',
  'deliverable_reserved',
  'creator_payable',
  -- Platform
  'platform_fee_revenue',
  'fraud_reserve',
  'platform_bootstrap',
  -- Stripe's own balance, split on available_on. Without the split the solvency
  -- invariant passes while transfers.create returns balance_insufficient.
  'psp_stripe_pending',
  'psp_stripe_available'
);

-- ----------------------------------------------------------------------------
-- Accounts
-- ----------------------------------------------------------------------------

CREATE TABLE ledger.account (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role           ledger.account_role   NOT NULL,
  currency       char(3)               NOT NULL,
  -- Which way this account increases. Asset and expense accounts grow on the
  -- debit side; liability, equity and revenue accounts grow on the credit side.
  normal_balance ledger.direction NOT NULL,

  -- Only the PSP clearing and fraud-reserve accounts may go negative: Stripe can
  -- claw funds back from the platform balance after an ACH return, and refusing
  -- to record that would leave the ledger disagreeing with reality.
  allow_negative boolean NOT NULL DEFAULT false,

  -- Scope. Exactly one of these is set for a tenant account; platform accounts
  -- have none.
  org_id         uuid,
  deposit_id     uuid,
  campaign_id    uuid,
  deliverable_id uuid,
  creator_id     uuid,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Referenced by the composite foreign key from entry_line. Denormalising
  -- currency and normal_balance onto each line makes a mixed-currency or
  -- mis-signed line UNREPRESENTABLE rather than merely incorrect.
  CONSTRAINT account_id_currency_normal_key UNIQUE (id, currency, normal_balance),
  CONSTRAINT account_id_allow_negative_key  UNIQUE (id, allow_negative),

  CONSTRAINT account_currency_iso4217 CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX account_org_idx      ON ledger.account (org_id)     WHERE org_id IS NOT NULL;
CREATE INDEX account_deposit_idx  ON ledger.account (deposit_id) WHERE deposit_id IS NOT NULL;
CREATE INDEX account_campaign_idx ON ledger.account (campaign_id) WHERE campaign_id IS NOT NULL;

-- One lot account per (deposit, role) — a deposit cannot have two available lots.
CREATE UNIQUE INDEX account_one_lot_per_deposit
  ON ledger.account (deposit_id, role)
  WHERE deposit_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Journal entries
-- ----------------------------------------------------------------------------

CREATE TABLE ledger.entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What happened, in domain terms. Named transitions rather than free text so
  -- the set of legal money movements is enumerable and reviewable.
  transition text NOT NULL,

  -- IDEMPOTENCY. Replaying a Stripe webhook, retrying a job, or double-clicking
  -- a release can never double-post: the unique index rejects the second insert.
  source_type text NOT NULL,
  source_id   text NOT NULL,

  -- Forensics. Enough to reconstruct how a balance reached a wrong value.
  actor_principal_id uuid,
  request_id         text,
  code_version       text,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entry_source_key UNIQUE (source_type, source_id)
);

CREATE INDEX entry_created_idx ON ledger.entry (created_at);

-- ----------------------------------------------------------------------------
-- Entry lines
-- ----------------------------------------------------------------------------

CREATE TABLE ledger.entry_line (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES ledger.entry (id),

  account_id     uuid             NOT NULL,
  currency       char(3)          NOT NULL,
  normal_balance ledger.direction NOT NULL,

  direction    ledger.direction NOT NULL,
  -- ALWAYS POSITIVE. Direction carries the sign, so application code never
  -- writes one. Sign confusion is the classic financial bug; this makes it
  -- unrepresentable rather than merely discouraged.
  amount_minor bigint NOT NULL,

  -- Used ONLY for the balanced-entry assertion: debits positive, credits
  -- negative, and every entry must sum to zero.
  signed_minor bigint GENERATED ALWAYS AS (
    CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END
  ) STORED,

  -- Used ONLY for balances: movement in the account's own normal direction, so
  -- every account has a plain non-negative balance in its own terms and no
  -- reporting code ever negates anything.
  natural_minor bigint GENERATED ALWAYS AS (
    CASE WHEN direction = normal_balance THEN amount_minor ELSE -amount_minor END
  ) STORED,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entry_line_amount_positive CHECK (amount_minor > 0),

  -- The currency and normal_balance on this line MUST match the account's. A
  -- mixed-currency entry cannot be inserted at all.
  CONSTRAINT entry_line_account_fk
    FOREIGN KEY (account_id, currency, normal_balance)
    REFERENCES ledger.account (id, currency, normal_balance)
);

CREATE INDEX entry_line_entry_idx   ON ledger.entry_line (entry_id);
CREATE INDEX entry_line_account_idx ON ledger.entry_line (account_id);

-- ----------------------------------------------------------------------------
-- Balances
-- ----------------------------------------------------------------------------
--
-- One mutable row per account carrying the running balance, and this is where
-- solvency is enforced.
--
-- Every posting does `balance_minor = balance_minor + :delta`. The UPDATE takes
-- the row lock implicitly, so concurrent writers to the same account serialize.
-- Under plain READ COMMITTED, Postgres re-evaluates the delta against the
-- post-commit value (EvalPlanQual), so the second writer computes the TRUE new
-- balance and the CHECK aborts it.
--
-- That means no SERIALIZABLE and no 40001 retry storms on the hot path.
CREATE TABLE ledger.account_balance (
  account_id   uuid PRIMARY KEY REFERENCES ledger.account (id),
  balance_minor bigint NOT NULL DEFAULT 0,
  version      bigint NOT NULL DEFAULT 0,

  -- Denormalised so the CHECK can see it, with a composite FK guaranteeing it
  -- agrees with the account. Without the FK someone could flip this row and
  -- quietly grant an account the right to go negative.
  allow_negative boolean NOT NULL,

  CONSTRAINT account_balance_allow_negative_fk
    FOREIGN KEY (account_id, allow_negative)
    REFERENCES ledger.account (id, allow_negative),

  -- THE INVARIANT. An overdraft becomes SQLSTATE 23514 from the storage engine,
  -- un-bypassable by any code path — including a future one that forgets a guard.
  CONSTRAINT account_balance_non_negative
    CHECK (allow_negative OR balance_minor >= 0)
);

-- Append-only history. Written in the SAME STATEMENT as the balance update via a
-- CTE, so the mutable row and the immutable snapshot cannot diverge: if the
-- CHECK fires, the whole statement aborts and neither exists.
CREATE TABLE ledger.balance_snapshot (
  account_id    uuid   NOT NULL REFERENCES ledger.account (id),
  seq           bigint NOT NULL,
  balance_after bigint NOT NULL,
  entry_id      uuid   NOT NULL REFERENCES ledger.entry (id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (account_id, seq)
);

-- ----------------------------------------------------------------------------
-- Append-only enforcement
-- ----------------------------------------------------------------------------
--
-- Corrections are new reversing entries, never edits. That is also what an
-- auditor expects to see.

CREATE OR REPLACE FUNCTION ledger.refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ledger.% is append-only; % is not permitted. Correct with a reversing entry.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;

CREATE TRIGGER entry_append_only
  BEFORE UPDATE OR DELETE ON ledger.entry
  FOR EACH ROW EXECUTE FUNCTION ledger.refuse_mutation();

CREATE TRIGGER entry_line_append_only
  BEFORE UPDATE OR DELETE ON ledger.entry_line
  FOR EACH ROW EXECUTE FUNCTION ledger.refuse_mutation();

CREATE TRIGGER balance_snapshot_append_only
  BEFORE UPDATE OR DELETE ON ledger.balance_snapshot
  FOR EACH ROW EXECUTE FUNCTION ledger.refuse_mutation();

-- ----------------------------------------------------------------------------
-- Balanced-entry assertion
-- ----------------------------------------------------------------------------
--
-- DEFERRABLE INITIALLY DEFERRED so it runs at COMMIT — lines are inserted one at
-- a time, and an entry is only required to balance once it is complete.
--
-- Also asserts at least two lines: a single-line "entry" is not double-entry
-- bookkeeping, it is a number someone wrote down.

CREATE OR REPLACE FUNCTION ledger.assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sum   bigint;
  v_count integer;
BEGIN
  SELECT COALESCE(SUM(signed_minor), 0), COUNT(*)
    INTO v_sum, v_count
    FROM ledger.entry_line
   WHERE entry_id = NEW.entry_id;

  IF v_count < 2 THEN
    RAISE EXCEPTION 'Entry % has % line(s); double-entry requires at least 2.',
      NEW.entry_id, v_count
      USING ERRCODE = '23514';
  END IF;

  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Entry % is unbalanced: debits minus credits = %.',
      NEW.entry_id, v_sum
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entry_line_balanced
  AFTER INSERT ON ledger.entry_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_entry_balanced();

-- ----------------------------------------------------------------------------
-- Database roles
-- ----------------------------------------------------------------------------
--
-- The privilege boundary. `rayi_api` is internet-reachable, so it gets no access
-- to the ledger schema AT ALL — a SQL injection in a brand-facing endpoint
-- cannot reach money. Only the worker may post entries, and even it may only
-- INSERT: the append-only triggers make UPDATE and DELETE impossible, and the
-- absent grants mean it never gets that far.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rayi_api') THEN
    CREATE ROLE rayi_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rayi_worker') THEN
    CREATE ROLE rayi_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rayi_webhooks') THEN
    CREATE ROLE rayi_webhooks NOLOGIN;
  END IF;
END;
$$;

-- Nobody gets anything by default.
REVOKE ALL ON SCHEMA ledger FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ledger FROM PUBLIC;

-- api: no access to the ledger schema whatsoever.
-- (Deliberately no GRANT. The absence IS the control.)

-- worker: may read everything and INSERT. Never UPDATE or DELETE.
GRANT USAGE ON SCHEMA ledger TO rayi_worker;
GRANT SELECT, INSERT ON ledger.entry, ledger.entry_line, ledger.balance_snapshot TO rayi_worker;
GRANT SELECT, INSERT, UPDATE ON ledger.account_balance TO rayi_worker; -- the running balance
GRANT SELECT, INSERT ON ledger.account TO rayi_worker;

-- webhooks: raw event ingestion only; it never interprets or posts.
-- (No ledger grants at all.)

-- New tables inherit the boundary rather than depending on someone remembering.
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger GRANT SELECT, INSERT ON TABLES TO rayi_worker;

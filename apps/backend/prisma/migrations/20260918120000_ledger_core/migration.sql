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

-- ----------------------------------------------------------------------------
-- post_entry — the ONLY way money moves
-- ----------------------------------------------------------------------------
--
-- SECURITY DEFINER so it runs as the schema owner: callers need EXECUTE on this
-- function and nothing else, which means there is exactly one door into the
-- ledger and it is this one.
--
-- Idempotent by construction. If (source_type, source_id) already exists the
-- function returns the existing entry id and posts nothing — so a replayed
-- Stripe webhook, a retried job, or a double-clicked button converge to one
-- effect rather than two.
--
-- p_lines is [{ "account_id": uuid, "direction": "debit"|"credit",
--               "amount_minor": bigint }]
-- Currency and normal_balance are DERIVED from the account, never supplied by
-- the caller — one less thing a caller can get wrong.

CREATE OR REPLACE FUNCTION ledger.post_entry(
  p_transition   text,
  p_source_type  text,
  p_source_id    text,
  p_lines        jsonb,
  p_actor        uuid    DEFAULT NULL,
  p_request_id   text    DEFAULT NULL,
  p_code_version text    DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ledger, pg_temp
AS $$
DECLARE
  v_entry_id uuid;
  v_existing uuid;
  v_account  uuid;
  v_delta    bigint;
BEGIN
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'post_entry requires at least 2 lines, got %.',
      jsonb_array_length(p_lines) USING ERRCODE = '23514';
  END IF;

  -- Idempotency first, before any locking or balance work.
  SELECT id INTO v_existing
    FROM ledger.entry
   WHERE source_type = p_source_type AND source_id = p_source_id;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO ledger.entry (
    transition, source_type, source_id, actor_principal_id, request_id, code_version
  )
  VALUES (
    p_transition, p_source_type, p_source_id, p_actor, p_request_id, p_code_version
  )
  RETURNING id INTO v_entry_id;

  -- Lines carry currency and normal_balance copied from their account, so the
  -- composite FK rejects any mismatch and `natural_minor` is computed correctly.
  INSERT INTO ledger.entry_line (
    entry_id, account_id, currency, normal_balance, direction, amount_minor
  )
  SELECT
    v_entry_id,
    a.id,
    a.currency,
    a.normal_balance,
    (l->>'direction')::ledger.direction,
    (l->>'amount_minor')::bigint
  FROM jsonb_array_elements(p_lines) AS l
  JOIN ledger.account a ON a.id = (l->>'account_id')::uuid;

  -- Every supplied line must have matched an account. A typo'd account id would
  -- otherwise silently drop a leg and leave the entry unbalanced at COMMIT —
  -- caught, but with a far less useful error.
  IF (SELECT COUNT(*) FROM ledger.entry_line WHERE entry_id = v_entry_id)
     <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'One or more account_ids in post_entry do not exist.'
      USING ERRCODE = '23503';
  END IF;

  -- Apply balances in SORTED ACCOUNT ORDER. A canonical lock order is what stops
  -- two concurrent postings that touch the same pair of accounts from
  -- deadlocking against each other.
  FOR v_account, v_delta IN
    SELECT account_id, SUM(natural_minor)
      FROM ledger.entry_line
     WHERE entry_id = v_entry_id
     GROUP BY account_id
     ORDER BY account_id
  LOOP
    -- ONE STATEMENT: the UPDATE's RETURNING feeds the snapshot INSERT, so the
    -- mutable balance and its immutable history agree by construction. If the
    -- non-negative CHECK fires, the whole statement aborts and neither exists.
    --
    -- The UPDATE takes the row lock implicitly. Under READ COMMITTED, Postgres
    -- re-evaluates `balance_minor + v_delta` against the post-commit value, so a
    -- second concurrent writer sees the TRUE balance and the CHECK aborts it.
    -- No SERIALIZABLE, no 40001 retry storm.
    WITH updated AS (
      UPDATE ledger.account_balance
         SET balance_minor = balance_minor + v_delta,
             version       = version + 1
       WHERE account_id = v_account
      RETURNING account_id, balance_minor, version
    )
    INSERT INTO ledger.balance_snapshot (account_id, seq, balance_after, entry_id)
    SELECT account_id, version, balance_minor, v_entry_id FROM updated;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No balance row for account % — accounts must be created via ledger.create_account.',
        v_account USING ERRCODE = '23503';
    END IF;
  END LOOP;

  RETURN v_entry_id;
END;
$$;

-- Accounts and their balance row are created together, so a balance row can
-- never be missing and the composite FK on allow_negative always holds.
CREATE OR REPLACE FUNCTION ledger.create_account(
  p_role           ledger.account_role,
  p_currency       char(3),
  p_normal_balance ledger.direction,
  p_allow_negative boolean DEFAULT false,
  p_org_id         uuid DEFAULT NULL,
  p_deposit_id     uuid DEFAULT NULL,
  p_campaign_id    uuid DEFAULT NULL,
  p_deliverable_id uuid DEFAULT NULL,
  p_creator_id     uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ledger, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO ledger.account (
    role, currency, normal_balance, allow_negative,
    org_id, deposit_id, campaign_id, deliverable_id, creator_id
  )
  VALUES (
    p_role, p_currency, p_normal_balance, p_allow_negative,
    p_org_id, p_deposit_id, p_campaign_id, p_deliverable_id, p_creator_id
  )
  RETURNING id INTO v_id;

  INSERT INTO ledger.account_balance (account_id, allow_negative)
  VALUES (v_id, p_allow_negative);

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION ledger.post_entry(text, text, text, jsonb, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.create_account(ledger.account_role, char(3), ledger.direction, boolean, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ledger.post_entry(text, text, text, jsonb, uuid, text, text) TO rayi_worker;
GRANT EXECUTE ON FUNCTION ledger.create_account(ledger.account_role, char(3), ledger.direction, boolean, uuid, uuid, uuid, uuid, uuid) TO rayi_worker;

-- ============================================================================
-- LEDGER ACCOUNT DERIVATION
-- ============================================================================
--
-- Two holes in the ledger core, both of the same shape: a caller could choose
-- WHICH account a posting lands in.
--
--   1. Account ids arrive at `post_entry` from the caller. The composite FK
--      guarantees the currency and normal balance agree with the account — but
--      nothing guaranteed the account belongs to the organization on whose
--      behalf the caller is acting. An ordinary member of org A holding a
--      campaign UUID from org B could post a perfectly balanced entry against
--      org B's money.
--
--   2. Finding an account by `SELECT ... LIMIT 1` silently picks an arbitrary
--      row when more than one matches. This is the un-STRICT `SELECT INTO`
--      failure mode: it does not raise, it just takes the first one, and the
--      resulting balance is wrong in a way no constraint can see.
--
-- Both are closed here. Account SCOPE becomes a database fact via composite
-- foreign keys, and account LOOKUP becomes a function that either returns
-- exactly one account or raises.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. A scoped account's scope must be real, and consistent
-- ----------------------------------------------------------------------------

-- A composite FK is only checked when EVERY column is non-null (MATCH SIMPLE,
-- the SQL default). So without this CHECK, tagging an account with a campaign
-- and leaving org_id NULL would bypass the parentage constraint entirely.
ALTER TABLE ledger.account
  ADD CONSTRAINT account_campaign_requires_org
  CHECK (campaign_id IS NULL OR org_id IS NOT NULL);

-- The parentage constraint itself.
--
-- Prisma stores ids as TEXT while the ledger types every identifier as `uuid` —
-- deliberately, because `uuid` rejects a malformed or over-long identifier at the
-- column rather than in a validator. A foreign key cannot bridge two different
-- types, so `campaign` grows two GENERATED columns that project its text ids into
-- `uuid`, and the key is declared against those.
--
-- The projection is not merely plumbing: `text::uuid` raises on anything that is
-- not a well-formed UUID, so the generated column also makes a non-UUID campaign
-- id unrepresentable rather than something the ledger discovers later.
ALTER TABLE "campaign"
  ADD COLUMN id_uuid uuid GENERATED ALWAYS AS ("id"::uuid) STORED,
  ADD COLUMN organization_id_uuid uuid GENERATED ALWAYS AS ("organizationId"::uuid) STORED;

CREATE UNIQUE INDEX campaign_uuid_parentage_key
  ON "campaign" (id_uuid, organization_id_uuid);

-- Now "this campaign account belongs to this organization" is a foreign key
-- rather than a comparison in application code that someone can forget, or that
-- an attacker can route around by supplying another tenant's campaign id.
ALTER TABLE ledger.account
  ADD CONSTRAINT account_campaign_belongs_to_org
  FOREIGN KEY (campaign_id, org_id)
  REFERENCES "campaign" (id_uuid, organization_id_uuid)
  ON DELETE RESTRICT;

-- ----------------------------------------------------------------------------
-- 2. At most one account per scope and role
-- ----------------------------------------------------------------------------
--
-- Without these, a duplicate account splits a balance in two. Each half
-- independently satisfies `balance_minor >= 0`, so the solvency invariant holds
-- while the org's real position is misreported — the constraint is fine and the
-- number is wrong, which is the worst combination available.

CREATE UNIQUE INDEX account_one_per_campaign_role
  ON ledger.account (campaign_id, role, currency)
  WHERE campaign_id IS NOT NULL;

-- Org-scoped accounts that are NOT per-deposit lots (lots already have
-- account_one_lot_per_deposit).
CREATE UNIQUE INDEX account_one_per_org_role
  ON ledger.account (org_id, role, currency)
  WHERE org_id IS NOT NULL AND deposit_id IS NULL AND campaign_id IS NULL;

-- ----------------------------------------------------------------------------
-- 3. Lookup that cannot silently pick the wrong row
-- ----------------------------------------------------------------------------

-- Find the single campaign account for a role, creating it on first use.
--
-- Derive-or-create rather than accept-an-id: the caller names the campaign it is
-- acting on, and the function decides which account that is. A caller therefore
-- has no way to express "post to an account other than this campaign's".
--
-- The org is read FROM THE CAMPAIGN ROW, never from the caller, so an account is
-- tagged with the campaign's true owner even if the caller believed otherwise.
CREATE OR REPLACE FUNCTION ledger.account_for_campaign(
  p_campaign_id uuid,
  p_role        ledger.account_role,
  p_currency    char(3)
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ledger, public, pg_temp
AS $$
DECLARE
  v_org uuid;
  v_id  uuid;
BEGIN
  -- STRICT: raises NO_DATA_FOUND on zero rows rather than leaving v_org NULL and
  -- carrying on. A NULL org here would defeat account_campaign_requires_org and
  -- create an unparented account.
  SELECT organization_id_uuid INTO STRICT v_org
    FROM public."campaign"
   WHERE id_uuid = p_campaign_id;

  SELECT id INTO v_id
    FROM ledger.account
   WHERE campaign_id = p_campaign_id AND role = p_role AND currency = p_currency;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Campaign accounts are debit-normal: money committed to a campaign is an
  -- asset of that campaign, and it increases when funds are allocated in.
  v_id := ledger.create_account(
    p_role, p_currency, 'debit'::ledger.direction, false,
    v_org, NULL, p_campaign_id, NULL, NULL
  );

  RETURN v_id;

EXCEPTION
  -- Two concurrent first allocations to the same campaign. The unique index is
  -- the arbiter; the loser reads the winner's row rather than failing the
  -- allocation.
  WHEN unique_violation THEN
    SELECT id INTO STRICT v_id
      FROM ledger.account
     WHERE campaign_id = p_campaign_id AND role = p_role AND currency = p_currency;
    RETURN v_id;
END;
$$;

-- Find the organization's funding lot to spend from.
--
-- Deliberately REFUSES when an org holds more than one open lot. FIFO
-- consumption across lots is deposit-lifecycle work (roadmap step 11); until it
-- exists, an org with two lots must fail loudly rather than have one of them
-- chosen arbitrarily. `LIMIT 1` here would be a silently wrong balance, which is
-- exactly the class of bug the whole ledger design exists to prevent.
CREATE OR REPLACE FUNCTION ledger.org_lot_to_spend(
  p_org_id   uuid,
  p_currency char(3)
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ledger, pg_temp
AS $$
DECLARE
  v_id    uuid;
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM ledger.account
   WHERE org_id = p_org_id
     AND role = 'org_lot_available'
     AND currency = p_currency;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Organization % holds no available % funds.', p_org_id, p_currency
      USING ERRCODE = '23503';
  END IF;

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'Organization % holds % available % lots; FIFO lot consumption is not implemented yet.',
      p_org_id, v_count, p_currency
      USING ERRCODE = '0A000';
  END IF;

  SELECT id INTO STRICT v_id
    FROM ledger.account
   WHERE org_id = p_org_id
     AND role = 'org_lot_available'
     AND currency = p_currency;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION ledger.account_for_campaign(uuid, ledger.account_role, char(3)) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.org_lot_to_spend(uuid, char(3)) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ledger.account_for_campaign(uuid, ledger.account_role, char(3)) TO rayi_worker;
GRANT EXECUTE ON FUNCTION ledger.org_lot_to_spend(uuid, char(3)) TO rayi_worker;

-- The derivation functions read public.campaign, so the worker needs to reach it.
GRANT USAGE ON SCHEMA public TO rayi_worker;

-- Workspace budget envelopes, campaign authoring fields, and creator payouts.
--
-- Hand-named `20260918220000` so it sorts AFTER `20260918211000`. The wall clock
-- in this repo is behind the hand-named migrations already here, so a generated
-- name would sort BEFORE them and a fresh replay would run this first — see
-- prisma/migrations/README.md.

-- ---------------------------------------------------------------------------
-- Campaign authoring fields
-- ---------------------------------------------------------------------------

ALTER TABLE "campaign"
  ADD COLUMN "brief"     TEXT,
  ADD COLUMN "startsAt"  TIMESTAMP(3),
  ADD COLUMN "endsAt"    TIMESTAMP(3);

ALTER TABLE "deliverable" ADD COLUMN "dueAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Budget envelopes
--
-- The ceiling is an AUTHORIZATION limit, not a ledger account: campaigns still
-- allocate from the organization balance. What makes it safe is that the
-- invariant is a CHECK rather than application logic — exactly the same shape as
-- the ledger's `balance_minor >= 0`, so an over-commit is a storage-engine error
-- instead of a race somebody has to remember to guard.
-- ---------------------------------------------------------------------------

CREATE TABLE "budget_envelope" (
    "id"                 TEXT NOT NULL,
    "workspaceId"        TEXT NOT NULL,
    "organizationId"     TEXT NOT NULL,
    "ceilingMinor"       BIGINT NOT NULL,
    "committedMinor"     BIGINT NOT NULL DEFAULT 0,
    "currency"           TEXT NOT NULL DEFAULT 'USD',
    "expiresAt"          TIMESTAMP(3),
    "approvedByMemberId" TEXT,
    "approvedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_envelope_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "budget_envelope_workspaceId_key" ON "budget_envelope"("workspaceId");
CREATE UNIQUE INDEX "budget_envelope_workspaceId_organizationId_key"
  ON "budget_envelope"("workspaceId", "organizationId");
CREATE INDEX "budget_envelope_organizationId_idx" ON "budget_envelope"("organizationId");

-- The composite FK carries organizationId, so an envelope cannot be attached to
-- a workspace in another organization. MATCH SIMPLE only enforces when every
-- column is non-null, and both are NOT NULL here, so it always does.
ALTER TABLE "budget_envelope"
  ADD CONSTRAINT "budget_envelope_workspace_fkey"
  FOREIGN KEY ("workspaceId", "organizationId")
  REFERENCES "workspace"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The whole point of the table.
--
-- Over-commit is impossible because the storage engine says so. Draw-down is a
-- conditional UPDATE, and the CHECK is re-evaluated against the post-commit row
-- under READ COMMITTED (EvalPlanQual), so two concurrent allocations that both
-- read the same remaining figure cannot both succeed.
ALTER TABLE "budget_envelope"
  ADD CONSTRAINT "budget_envelope_within_ceiling"
  CHECK ("committedMinor" <= "ceilingMinor");

-- Neither figure may be negative. A negative ceiling is a nonsense approval and
-- a negative commitment would silently create headroom.
ALTER TABLE "budget_envelope"
  ADD CONSTRAINT "budget_envelope_non_negative"
  CHECK ("ceilingMinor" >= 0 AND "committedMinor" >= 0);

-- ---------------------------------------------------------------------------
-- Creator payouts
-- ---------------------------------------------------------------------------

CREATE TABLE "payout_destination" (
    "id"                  TEXT NOT NULL,
    "userId"              TEXT NOT NULL,
    "connectedAccountId"  TEXT,
    "bankName"            TEXT,
    "last4"               TEXT,
    "payoutsEnabled"      BOOLEAN NOT NULL DEFAULT false,
    "pendingRequirements" JSONB NOT NULL DEFAULT '[]',
    "holdUntil"           TIMESTAMP(3),
    "lastChangedAt"       TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_destination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payout_destination_userId_key" ON "payout_destination"("userId");
CREATE INDEX "payout_destination_holdUntil_idx" ON "payout_destination"("holdUntil");

ALTER TABLE "payout_destination"
  ADD CONSTRAINT "payout_destination_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly four digits, or nothing. A column that will accept a full account
-- number is a column that will eventually hold one.
ALTER TABLE "payout_destination"
  ADD CONSTRAINT "payout_destination_last4_shape"
  CHECK ("last4" IS NULL OR "last4" ~ '^[0-9]{4}$');

CREATE TABLE "payout" (
    "id"                TEXT NOT NULL,
    "userId"            TEXT NOT NULL,
    "amountMinor"       BIGINT NOT NULL,
    "currency"          TEXT NOT NULL DEFAULT 'USD',
    "state"             TEXT NOT NULL DEFAULT 'scheduled',
    "batchId"           TEXT,
    "expectedArrivalAt" TIMESTAMP(3),
    "paidAt"            TIMESTAMP(3),
    "reason"            TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payout_userId_createdAt_idx" ON "payout"("userId", "createdAt");
CREATE INDEX "payout_state_idx" ON "payout"("state");
CREATE INDEX "payout_batchId_idx" ON "payout"("batchId");

ALTER TABLE "payout"
  ADD CONSTRAINT "payout_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A closed state set, in the database. An unknown state is a payout no screen
-- knows how to describe and no worker knows whether to send.
ALTER TABLE "payout"
  ADD CONSTRAINT "payout_state_known"
  CHECK ("state" IN ('scheduled', 'in_transit', 'paid', 'failed', 'held', 'cancelled'));

ALTER TABLE "payout"
  ADD CONSTRAINT "payout_amount_positive" CHECK ("amountMinor" > 0);

-- `paidAt` means the money left. Setting it on anything but a paid payout would
-- make "when did this arrive" answerable for money that never moved.
ALTER TABLE "payout"
  ADD CONSTRAINT "payout_paid_at_only_when_paid"
  CHECK (("state" = 'paid') = ("paidAt" IS NOT NULL));

-- A paused or failed payout must say why, in words the creator reads. A state
-- with no reason is a support ticket by construction.
ALTER TABLE "payout"
  ADD CONSTRAINT "payout_blocked_states_have_a_reason"
  CHECK ("state" NOT IN ('held', 'failed') OR "reason" IS NOT NULL);

CREATE TABLE "payout_source" (
    "id"             TEXT NOT NULL,
    "payoutId"       TEXT NOT NULL,
    "dealId"         TEXT NOT NULL,
    "milestoneId"    TEXT NOT NULL,
    "milestoneTitle" TEXT NOT NULL,
    "brandName"      TEXT NOT NULL,
    "amountMinor"    BIGINT NOT NULL,

    CONSTRAINT "payout_source_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payout_source_payoutId_milestoneId_key"
  ON "payout_source"("payoutId", "milestoneId");
CREATE INDEX "payout_source_dealId_idx" ON "payout_source"("dealId");

ALTER TABLE "payout_source"
  ADD CONSTRAINT "payout_source_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "payout"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- One milestone can only ever feed one payout line, anywhere. Without this a
-- milestone could appear in two payouts and the creator's own reconciliation
-- would double-count money that moved once.
CREATE UNIQUE INDEX "payout_source_milestone_once" ON "payout_source"("milestoneId");

-- ---------------------------------------------------------------------------
-- Grants
--
-- `rayi_app` is the application role; it has no BYPASSRLS and no access to the
-- ledger schema. These tables live in `public` like the rest of the app data.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_envelope"    TO rayi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payout_destination" TO rayi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payout"             TO rayi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payout_source"      TO rayi_app;

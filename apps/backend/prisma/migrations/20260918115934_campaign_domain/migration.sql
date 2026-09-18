-- CreateTable
CREATE TABLE "deal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creatorUserId" TEXT NOT NULL,
    "totalAmountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "state" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement_version" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "totalAmountMinor" BIGINT NOT NULL,
    "brandAcceptedAt" TIMESTAMP(3),
    "brandAcceptedBy" TEXT,
    "creatorAcceptedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone" (
    "id" TEXT NOT NULL,
    "agreementVersionId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "authoredBasisPoints" INTEGER,
    "condition" JSONB NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "ledgerEntryId" TEXT,

    CONSTRAINT "milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliverable" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'video',
    "brief" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission" (
    "id" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "assetKey" TEXT,
    "caption" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL DEFAULT 'HUMAN',
    "actorUserId" TEXT,
    "comment" TEXT,
    "voiceKey" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_transition" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_transition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deal_organizationId_state_idx" ON "deal"("organizationId", "state");

-- CreateIndex
CREATE INDEX "deal_creatorUserId_state_idx" ON "deal"("creatorUserId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "deal_id_organizationId_key" ON "deal"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "deal_campaignId_creatorUserId_key" ON "deal"("campaignId", "creatorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_version_dealId_version_key" ON "agreement_version"("dealId", "version");

-- CreateIndex
CREATE INDEX "milestone_dealId_releasedAt_idx" ON "milestone"("dealId", "releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "milestone_agreementVersionId_sequence_key" ON "milestone"("agreementVersionId", "sequence");

-- CreateIndex
CREATE INDEX "deliverable_dealId_state_idx" ON "deliverable"("dealId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "deliverable_dealId_sequence_key" ON "deliverable"("dealId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "submission_deliverableId_version_key" ON "submission"("deliverableId", "version");

-- CreateIndex
CREATE INDEX "review_deliverableId_decision_voidedAt_idx" ON "review"("deliverableId", "decision", "voidedAt");

-- CreateIndex
CREATE INDEX "deal_transition_dealId_createdAt_idx" ON "deal_transition"("dealId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "deal_transition_dealId_fromVersion_key" ON "deal_transition"("dealId", "fromVersion");

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_campaignId_organizationId_fkey" FOREIGN KEY ("campaignId", "organizationId") REFERENCES "campaign"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_version" ADD CONSTRAINT "agreement_version_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_agreementVersionId_fkey" FOREIGN KEY ("agreementVersionId") REFERENCES "agreement_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverable" ADD CONSTRAINT "deliverable_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "deliverable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_transition" ADD CONSTRAINT "deal_transition_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- The constraints that make the money rules UNREPRESENTABLE
-- ============================================================================

-- ----------------------------------------------------------------------------
-- At most ONE live approved review per deliverable
-- ----------------------------------------------------------------------------
--
-- THE load-bearing constraint on this whole surface.
--
-- Milestone conditions count DELIVERABLES in state APPROVED, never submissions
-- approved. If a deliverable could carry two live approved reviews — attempt 1
-- approved, then attempt 2 approved after a revision — it would count twice, and
-- "20 videos approved" would fire at 19. That is a silent overpay: every
-- constraint passes, the ledger balances, and the number is wrong.
--
-- `voidedAt IS NULL` is what makes UNDO work. Undo cannot delete the row — the
-- append-only discipline forbids it, and deleting would erase the fact that a
-- decision was made — so it VOIDS, and a voided row leaves the index.
CREATE UNIQUE INDEX review_one_live_approval_per_deliverable
  ON "review" ("deliverableId")
  WHERE decision = 'APPROVED' AND "voidedAt" IS NULL;

-- Enumerated rather than free text. A typo'd decision is a review that no query
-- matches and no milestone counts.
ALTER TABLE "review"
  ADD CONSTRAINT review_decision_known
  CHECK (decision IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED'));

ALTER TABLE "review"
  ADD CONSTRAINT review_actor_kind_known
  CHECK ("actorKind" IN ('HUMAN', 'SYSTEM_AUTO'));

-- A human decision must say who made it. A system one must not pretend to.
ALTER TABLE "review"
  ADD CONSTRAINT review_human_has_actor
  CHECK (("actorKind" = 'HUMAN') = ("actorUserId" IS NOT NULL));

-- ----------------------------------------------------------------------------
-- The milestone condition is a CLOSED set
-- ----------------------------------------------------------------------------
--
-- A generated column projects the JSONB discriminant into a plain text column,
-- and a CHECK bounds it. An unknown condition type is then rejected by the
-- storage engine rather than by whichever code path happens to parse it first —
-- and the thing that parses it decides when money leaves.

ALTER TABLE "milestone"
  ADD COLUMN condition_type text
  GENERATED ALWAYS AS (condition ->> 'type') STORED;

ALTER TABLE "milestone"
  ADD CONSTRAINT milestone_condition_type_known
  CHECK (condition_type IN (
    'ADVANCE',
    'DELIVERABLES_APPROVED_COUNT',
    'SPECIFIC_DELIVERABLES_APPROVED',
    'ALL_DELIVERABLES_APPROVED',
    'DATE_REACHED',
    'MANUAL_BRAND_APPROVAL'
  ));

CREATE INDEX milestone_condition_type_idx ON "milestone" (condition_type);

-- Money is never negative and never zero: a milestone worth nothing is a
-- milestone that should not exist, and one worth less than nothing is a charge.
ALTER TABLE "milestone"
  ADD CONSTRAINT milestone_amount_positive CHECK ("amountMinor" > 0);

ALTER TABLE "deal"
  ADD CONSTRAINT deal_total_positive CHECK ("totalAmountMinor" > 0);

-- ----------------------------------------------------------------------------
-- Milestones sum to the deal total
-- ----------------------------------------------------------------------------
--
-- Checked against the FROZEN amounts, not the authored percentages. A DEFERRED
-- constraint trigger, because milestones are inserted one at a time and an
-- agreement only has to balance once it is complete.
--
-- Enforced per AGREEMENT VERSION rather than per deal: an amendment is a new
-- version, and the old one must remain internally consistent forever so that
-- "what did we agree in March" stays answerable.

CREATE OR REPLACE FUNCTION public.assert_agreement_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_agreement uuid;
  v_sum   bigint;
  v_total bigint;
  v_accepted timestamp;
BEGIN
  v_agreement := COALESCE(NEW."agreementVersionId", OLD."agreementVersionId")::uuid;

  SELECT a."totalAmountMinor", a."creatorAcceptedAt"
    INTO v_total, v_accepted
    FROM "agreement_version" a
   WHERE a.id::uuid = v_agreement;

  -- Only ACCEPTED agreements must balance. A draft is mid-authoring by
  -- definition, and refusing to let a brand save a half-written schedule would
  -- make the editor unusable.
  IF v_accepted IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("amountMinor"), 0) INTO v_sum
    FROM "milestone" WHERE "agreementVersionId"::uuid = v_agreement;

  IF v_sum <> v_total THEN
    RAISE EXCEPTION
      'Milestones total % but the agreement is %. Every cent must belong to a milestone — an unallocated remainder is money nobody has decided about.',
      v_sum, v_total
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER milestone_agreement_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "milestone"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_agreement_balanced();

-- ----------------------------------------------------------------------------
-- A released milestone is immutable
-- ----------------------------------------------------------------------------
--
-- Once money has left against a milestone, its amount and condition are history.
-- Editing either would make the ledger entry unexplainable — the evidence stored
-- on the release would describe terms that no longer exist.

CREATE OR REPLACE FUNCTION public.milestone_released_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."releasedAt" IS NOT NULL
     AND (NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
       OR NEW.condition     IS DISTINCT FROM OLD.condition
       OR NEW."releasedAt"  IS DISTINCT FROM OLD."releasedAt") THEN
    RAISE EXCEPTION
      'Milestone % has already been released; its amount and condition cannot change.', OLD.id
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER milestone_released_immutable
  BEFORE UPDATE ON "milestone"
  FOR EACH ROW EXECUTE FUNCTION public.milestone_released_is_immutable();

-- ----------------------------------------------------------------------------
-- A submission is an immutable attempt
-- ----------------------------------------------------------------------------
--
-- A revision is a new VERSION, never an edit. Otherwise a dispute cannot show
-- attempt 1 and attempt 2 side by side, which is the entire reason submissions
-- are versioned.

CREATE OR REPLACE FUNCTION public.submission_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Submissions are immutable; a revision is a new version. % is not permitted.', TG_OP
    USING ERRCODE = '0A000';
END;
$$;

CREATE TRIGGER submission_immutable
  BEFORE UPDATE OR DELETE ON "submission"
  FOR EACH ROW EXECUTE FUNCTION public.submission_is_immutable();

-- A review's DECISION is immutable too. Changing your mind is a new review after
-- voiding the old one, so the history shows both.
CREATE OR REPLACE FUNCTION public.review_decision_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision      IS DISTINCT FROM OLD.decision
  OR NEW."submissionId" IS DISTINCT FROM OLD."submissionId"
  OR NEW."actorKind"    IS DISTINCT FROM OLD."actorKind"
  OR NEW."createdAt"    IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION
      'A review decision is immutable. Void it and record a new one, so the history shows both.'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_decision_immutable
  BEFORE UPDATE ON "review"
  FOR EACH ROW EXECUTE FUNCTION public.review_decision_is_immutable();

-- ----------------------------------------------------------------------------
-- State vocabularies
-- ----------------------------------------------------------------------------

ALTER TABLE "deal"
  ADD CONSTRAINT deal_state_known
  CHECK (state IN ('draft', 'offered', 'accepted', 'active', 'completed', 'cancelled', 'terminated'));

ALTER TABLE "deliverable"
  ADD CONSTRAINT deliverable_state_known
  CHECK (state IN ('pending', 'submitted', 'in_review', 'changes_requested', 'approved', 'cancelled'));

-- `approvedAt` and the approved state agree, or neither is trustworthy.
ALTER TABLE "deliverable"
  ADD CONSTRAINT deliverable_approved_at_matches_state
  CHECK ((state = 'approved') = ("approvedAt" IS NOT NULL));

-- ----------------------------------------------------------------------------
-- Tenant isolation, consistent with every other org-scoped table
-- ----------------------------------------------------------------------------

ALTER TABLE "deal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deal" FORCE ROW LEVEL SECURITY;

CREATE POLICY deal_tenant_isolation ON "deal"
  USING ("organizationId" = public.current_tenant())
  WITH CHECK ("organizationId" = public.current_tenant());

CREATE POLICY deal_cross_tenant ON "deal"
  USING (public.is_cross_tenant())
  WITH CHECK (public.is_cross_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "deal", "agreement_version", "milestone", "deliverable", "submission", "review", "deal_transition"
  TO rayi_app;

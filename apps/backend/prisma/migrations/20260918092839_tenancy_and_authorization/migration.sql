-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_member" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "money_authority" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "limitMinor" BIGINT,
    "grantedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "money_authority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "member_id_organizationId_key" ON "member"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_organizationId_slug_key" ON "workspace"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_id_organizationId_key" ON "workspace"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_member_workspaceId_memberId_key" ON "workspace_member"("workspaceId", "memberId");

-- CreateIndex
CREATE INDEX "money_authority_organizationId_idx" ON "money_authority"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "money_authority_memberId_capability_key" ON "money_authority"("memberId", "capability");

-- CreateIndex
CREATE INDEX "role_permission_role_scope_idx" ON "role_permission"("role", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_role_scope_permission_key" ON "role_permission"("role", "scope", "permission");

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "workspace"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_authority" ADD CONSTRAINT "money_authority_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- THE PERMISSION MATRIX
-- ============================================================================
--
-- Seeded as data rather than hard-coded in TypeScript, so "who can do what" is a
-- single queryable authority. Better Auth's own `ac` object is generated FROM
-- this at boot with an equality assertion, rather than being a second
-- hand-maintained copy that drifts.
--
-- Note what is ABSENT: no role here grants the ability to move money. Allocating
-- funds, releasing a deliverable and issuing a refund all additionally require a
-- MoneyAuthority row. A role gets you as far as *asking*.
--
-- The org/workspace split makes the strategy doc's core insight real: finance
-- approves the funding envelope once, and campaign managers then spend beneath it
-- without per-campaign approval.

INSERT INTO role_permission (id, role, scope, permission) VALUES
  -- Organization owner — everything, including inviting people and depositing.
  (gen_random_uuid(), 'owner', 'org', 'org:read'),
  (gen_random_uuid(), 'owner', 'org', 'org:update'),
  (gen_random_uuid(), 'owner', 'org', 'member:read'),
  (gen_random_uuid(), 'owner', 'org', 'member:invite'),
  (gen_random_uuid(), 'owner', 'org', 'member:remove'),
  (gen_random_uuid(), 'owner', 'org', 'workspace:read'),
  (gen_random_uuid(), 'owner', 'org', 'workspace:create'),
  (gen_random_uuid(), 'owner', 'org', 'funds:read'),
  (gen_random_uuid(), 'owner', 'org', 'funds:deposit'),
  (gen_random_uuid(), 'owner', 'org', 'funds:refund'),
  (gen_random_uuid(), 'owner', 'org', 'envelope:approve'),
  (gen_random_uuid(), 'owner', 'org', 'campaign:read'),
  (gen_random_uuid(), 'owner', 'org', 'campaign:allocate'),

  -- Admin — everything except removing the owner and refunding to the bank.
  (gen_random_uuid(), 'admin', 'org', 'org:read'),
  (gen_random_uuid(), 'admin', 'org', 'member:read'),
  (gen_random_uuid(), 'admin', 'org', 'member:invite'),
  (gen_random_uuid(), 'admin', 'org', 'workspace:read'),
  (gen_random_uuid(), 'admin', 'org', 'workspace:create'),
  (gen_random_uuid(), 'admin', 'org', 'funds:read'),
  (gen_random_uuid(), 'admin', 'org', 'funds:deposit'),
  (gen_random_uuid(), 'admin', 'org', 'envelope:approve'),
  (gen_random_uuid(), 'admin', 'org', 'campaign:read'),

  -- Member — can see the org exists and little else. Capability comes from the
  -- workspace roles below.
  (gen_random_uuid(), 'member', 'org', 'org:read'),
  (gen_random_uuid(), 'member', 'org', 'workspace:read'),

  -- Workspace admin — runs a sub-brand end to end, but cannot deposit or refund:
  -- money enters and leaves at the ORG level only.
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'workspace:read'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'workspace:update'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'campaign:read'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'campaign:create'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'campaign:allocate'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'deliverable:read'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'deliverable:review'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'deliverable:release'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'funds:read'),

  -- Campaign manager — "marketing spends at the speed of DMs". Allocates freely
  -- beneath the envelope finance approved, without asking again.
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'workspace:read'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'campaign:read'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'campaign:create'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'campaign:allocate'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'deliverable:read'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'deliverable:review'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'funds:read'),

  -- Reviewer — works the review queue. Can approve a deliverable, which is why
  -- deliverable:release is a SEPARATE permission: approving deterministically
  -- causes a transfer shortly after, so it is money authority in disguise.
  -- See the open question in docs/02-decisions.md.
  (gen_random_uuid(), 'reviewer', 'workspace', 'workspace:read'),
  (gen_random_uuid(), 'reviewer', 'workspace', 'campaign:read'),
  (gen_random_uuid(), 'reviewer', 'workspace', 'deliverable:read'),
  (gen_random_uuid(), 'reviewer', 'workspace', 'deliverable:review'),

  -- Viewer — read-only.
  (gen_random_uuid(), 'viewer', 'workspace', 'workspace:read'),
  (gen_random_uuid(), 'viewer', 'workspace', 'campaign:read'),
  (gen_random_uuid(), 'viewer', 'workspace', 'deliverable:read'),
  (gen_random_uuid(), 'viewer', 'workspace', 'funds:read')
ON CONFLICT (role, scope, permission) DO NOTHING;

-- Money-moving capabilities. A role NEVER grants these; they require a
-- MoneyAuthority row minted under step-up and dual control.
COMMENT ON TABLE money_authority IS
  'The only grant of money-moving capability. Never inferrable from a role string.';

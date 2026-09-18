-- CreateTable
CREATE TABLE "treasury_command" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "campaignId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "actorUserId" TEXT NOT NULL,
    "actorMemberId" TEXT NOT NULL,
    "requestId" TEXT,
    "ledgerEntryId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "treasury_command_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "treasury_command_idempotencyKey_key" ON "treasury_command"("idempotencyKey");

-- CreateIndex
CREATE INDEX "treasury_command_status_createdAt_idx" ON "treasury_command"("status", "createdAt");

-- CreateIndex
CREATE INDEX "treasury_command_organizationId_idx" ON "treasury_command"("organizationId");

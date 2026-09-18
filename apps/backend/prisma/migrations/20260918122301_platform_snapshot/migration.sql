-- CreateTable
CREATE TABLE "platform_snapshot" (
    "onlyRow" BOOLEAN NOT NULL DEFAULT true,
    "brandCount" INTEGER NOT NULL,
    "creatorCount" INTEGER NOT NULL,
    "activeDealCount" INTEGER NOT NULL,
    "pendingReviews" INTEGER NOT NULL,
    "releasedToCreatorsMinor" BIGINT NOT NULL,
    "fundsUnderManagementMinor" BIGINT NOT NULL,
    "platformRevenueMinor" BIGINT NOT NULL,
    "unbalancedEntryIds" TEXT[],
    "driftedAccountIds" TEXT[],
    "auditChainBreaks" JSONB NOT NULL DEFAULT '[]',
    "failedCommandCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_snapshot_pkey" PRIMARY KEY ("onlyRow")
);

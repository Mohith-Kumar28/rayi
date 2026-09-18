-- CreateTable
CREATE TABLE "campaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_organizationId_state_idx" ON "campaign"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_id_organizationId_key" ON "campaign"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "workspace"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

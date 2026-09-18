-- AlterTable
ALTER TABLE "treasury_command" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT;

-- CreateIndex
CREATE INDEX "treasury_command_status_claimedAt_idx" ON "treasury_command"("status", "claimedAt");

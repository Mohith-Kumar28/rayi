-- CreateTable
CREATE TABLE "step_up_grant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "resourceHash" TEXT,
    "usesRemaining" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "step_up_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "step_up_grant_userId_purpose_expiresAt_idx" ON "step_up_grant"("userId", "purpose", "expiresAt");

-- AddForeignKey
ALTER TABLE "step_up_grant" ADD CONSTRAINT "step_up_grant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

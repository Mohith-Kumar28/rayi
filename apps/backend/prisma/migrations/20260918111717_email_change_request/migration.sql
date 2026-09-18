-- CreateTable
CREATE TABLE "email_change_request" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "oldEmail" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "email_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_change_request_tokenHash_key" ON "email_change_request"("tokenHash");

-- CreateIndex
CREATE INDEX "email_change_request_userId_expiresAt_idx" ON "email_change_request"("userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "email_change_request" ADD CONSTRAINT "email_change_request_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

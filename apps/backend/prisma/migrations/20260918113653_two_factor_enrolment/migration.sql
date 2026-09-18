-- CreateTable
CREATE TABLE "two_factor_enrolment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_enrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_backup_code" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_backup_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_enrolment_userId_key" ON "two_factor_enrolment"("userId");

-- CreateIndex
CREATE INDEX "two_factor_enrolment_expiresAt_idx" ON "two_factor_enrolment"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_backup_code_codeHash_key" ON "two_factor_backup_code"("codeHash");

-- CreateIndex
CREATE INDEX "two_factor_backup_code_userId_usedAt_idx" ON "two_factor_backup_code"("userId", "usedAt");

-- AddForeignKey
ALTER TABLE "two_factor_enrolment" ADD CONSTRAINT "two_factor_enrolment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_backup_code" ADD CONSTRAINT "two_factor_backup_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

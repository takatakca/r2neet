ALTER TABLE "Customer" ADD COLUMN "googleAuthSubject" TEXT;

CREATE UNIQUE INDEX "Customer_googleAuthSubject_key"
ON "Customer"("googleAuthSubject");

CREATE TABLE "GoogleAuthTransaction" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "linkTokenHash" TEXT,
    "googleAuthSubject" TEXT,
    "verifiedPhone" TEXT,
    "returnTo" TEXT NOT NULL DEFAULT '/account',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "GoogleAuthTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleAuthTransaction_stateHash_key"
ON "GoogleAuthTransaction"("stateHash");

CREATE UNIQUE INDEX "GoogleAuthTransaction_linkTokenHash_key"
ON "GoogleAuthTransaction"("linkTokenHash");

CREATE INDEX "GoogleAuthTransaction_expiresAt_idx"
ON "GoogleAuthTransaction"("expiresAt");

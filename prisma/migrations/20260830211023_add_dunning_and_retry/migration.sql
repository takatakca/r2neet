-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "recipientField" TEXT,
ADD COLUMN     "renderVars" JSONB;

-- CreateTable
CREATE TABLE "DunningCase" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 1,
    "totalOwedCents" INTEGER NOT NULL DEFAULT 0,
    "firstFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "assignedTo" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DunningCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DunningCase_customerId_key" ON "DunningCase"("customerId");

-- CreateIndex
CREATE INDEX "DunningCase_status_lastFailedAt_idx" ON "DunningCase"("status", "lastFailedAt");

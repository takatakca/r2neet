-- Durable R2NETTE -> TAKATAK synchronization outbox.
-- Business transactions write rows here; the scheduler owns network delivery.

CREATE TABLE "TakatakSyncEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 10,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedUntil" TIMESTAMP(3),
    "claimedBy" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastHttpStatus" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TakatakSyncEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TakatakSyncEvent_status_nextAttemptAt_idx"
    ON "TakatakSyncEvent"("status", "nextAttemptAt");

CREATE INDEX "TakatakSyncEvent_externalUserId_createdAt_idx"
    ON "TakatakSyncEvent"("externalUserId", "createdAt");

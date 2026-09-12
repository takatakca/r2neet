-- CreateTable
CREATE TABLE "WorkerRun" (
    "id" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "detail" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkerRun_worker_status_finishedAt_idx" ON "WorkerRun"("worker", "status", "finishedAt");

-- CreateIndex
CREATE INDEX "WorkerRun_createdAt_idx" ON "WorkerRun"("createdAt");

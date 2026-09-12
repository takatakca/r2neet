-- CreateTable
CREATE TABLE "PromotionClaim" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "promotionFamily" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "bookingId" TEXT,
    "quoteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "amountCents" INTEGER NOT NULL,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "PromotionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromotionClaim_customerId_promotionFamily_status_idx" ON "PromotionClaim"("customerId", "promotionFamily", "status");

-- CreateIndex
CREATE INDEX "PromotionClaim_bookingId_idx" ON "PromotionClaim"("bookingId");

-- At most ONE active claim per customer per promotion family.
-- RELEASED claims are excluded so a failed checkout genuinely frees the offer.
CREATE UNIQUE INDEX "PromotionClaim_one_active_per_family"
  ON "PromotionClaim" ("customerId", "promotionFamily")
  WHERE "status" IN ('RESERVED', 'REDEEMED');

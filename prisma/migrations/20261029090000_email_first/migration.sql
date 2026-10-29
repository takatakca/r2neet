-- Codex — assistant OpenAI · 2026-10-29. Additive; no legacy identity linking.
ALTER TABLE "Customer" ADD COLUMN "emailAuthSubject" TEXT, ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Customer_emailAuthSubject_key" ON "Customer"("emailAuthSubject");
ALTER TABLE "CustomerSession" ALTER COLUMN "phoneVerifiedAt" DROP NOT NULL;
ALTER TABLE "CustomerSession" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
CREATE TABLE "EmailAuthChallenge" (
 "id" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "email" TEXT NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "EmailAuthChallenge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailAuthChallenge_tokenHash_key" ON "EmailAuthChallenge"("tokenHash");
CREATE INDEX "EmailAuthChallenge_expiresAt_idx" ON "EmailAuthChallenge"("expiresAt");

CREATE TABLE "CommercialEnquiry" (
 "id" TEXT NOT NULL, "customerId" TEXT NOT NULL, "company" TEXT NOT NULL, "contactName" TEXT NOT NULL,
 "email" TEXT NOT NULL, "phone" TEXT, "sector" TEXT NOT NULL, "cadence" TEXT NOT NULL,
 "preferredAt" TIMESTAMP(3), "details" TEXT NOT NULL, "locale" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'NEW', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "CommercialEnquiry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CommercialEnquiry_status_createdAt_idx" ON "CommercialEnquiry"("status", "createdAt");
CREATE INDEX "CommercialEnquiry_customerId_createdAt_idx" ON "CommercialEnquiry"("customerId", "createdAt");

CREATE TABLE "PrivacyConsent" (
 "id" TEXT NOT NULL, "visitorHash" TEXT NOT NULL, "version" TEXT NOT NULL,
 "analytics" BOOLEAN NOT NULL, "marketing" BOOLEAN NOT NULL,
 "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PrivacyConsent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrivacyConsent_visitorHash_recordedAt_idx" ON "PrivacyConsent"("visitorHash", "recordedAt");

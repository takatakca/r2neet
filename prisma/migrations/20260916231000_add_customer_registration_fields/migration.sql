-- AlterTable
ALTER TABLE "Customer"
ADD COLUMN "preferredLocale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN "registrationCompletedAt" TIMESTAMP(3),
ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN "termsVersion" TEXT,
ADD COLUMN "privacyAcceptedAt" TIMESTAMP(3),
ADD COLUMN "privacyVersion" TEXT,
ADD COLUMN "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "marketingConsentUpdatedAt" TIMESTAMP(3);
-- Protect temporary OTP registration proofs from the Supabase Data API.
ALTER TABLE "RegistrationSession" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "RegistrationSession"
FROM anon, authenticated;
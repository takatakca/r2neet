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
-- Protect temporary OTP registration proofs from the Supabase Data API when
-- those roles exist. MochaHost and CI run vanilla PostgreSQL, which has
-- neither role; an unconditional REVOKE fails the whole migration there.
ALTER TABLE "RegistrationSession" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "RegistrationSession" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "RegistrationSession" FROM authenticated';
  END IF;
END $$;
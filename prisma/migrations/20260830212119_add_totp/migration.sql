-- AlterTable
ALTER TABLE "StaffUser" ADD COLUMN     "lastTotpStep" BIGINT,
ADD COLUMN     "recoveryCodeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN     "totpSecret" TEXT;

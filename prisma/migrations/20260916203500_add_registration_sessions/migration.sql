-- CreateTable
CREATE TABLE "RegistrationSession" (
    "id" TEXT NOT NULL,
    "registrationTokenHash" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "phoneVerifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "userAgentHash" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "RegistrationSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationSession_registrationTokenHash_key"
ON "RegistrationSession"("registrationTokenHash");

-- CreateIndex
CREATE INDEX "RegistrationSession_phoneE164_idx"
ON "RegistrationSession"("phoneE164");

-- CreateIndex
CREATE INDEX "RegistrationSession_expiresAt_idx"
ON "RegistrationSession"("expiresAt");
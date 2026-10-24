-- Private, owner-managed CRM evidence. Does not grant login or marketing consent.
CREATE TYPE "CustomerContactStatus" AS ENUM ('TO_REVIEW', 'PROSPECT', 'CUSTOMER', 'OTHER');

CREATE TABLE "CustomerContact" (
    "id" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "CustomerContactStatus" NOT NULL DEFAULT 'TO_REVIEW',
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerContact_emailNormalized_key" ON "CustomerContact"("emailNormalized");
CREATE INDEX "CustomerContact_status_lastSeenAt_idx" ON "CustomerContact"("status", "lastSeenAt");

CREATE TABLE "CustomerContactSource" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerContactSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerContactSource_contactId_accountEmail_messageId_key"
    ON "CustomerContactSource"("contactId", "accountEmail", "messageId");
CREATE INDEX "CustomerContactSource_contactId_occurredAt_idx"
    ON "CustomerContactSource"("contactId", "occurredAt");
ALTER TABLE "CustomerContactSource" ADD CONSTRAINT "CustomerContactSource_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "CustomerContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

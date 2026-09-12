-- Legacy provenance, so re-running an import can never duplicate a record.
ALTER TABLE "Customer" ADD COLUMN "legacyExternalId" TEXT;
ALTER TABLE "Booking" ADD COLUMN "legacyExternalId" TEXT;

CREATE UNIQUE INDEX "Customer_legacyExternalId_key" ON "Customer"("legacyExternalId");
CREATE UNIQUE INDEX "Booking_legacyExternalId_key" ON "Booking"("legacyExternalId");

-- Preserve the property/service context the customer supplied for a booking.
-- Additive and nullable so every existing booking remains valid.

ALTER TABLE "Booking"
ADD COLUMN "serviceDetails" JSONB;

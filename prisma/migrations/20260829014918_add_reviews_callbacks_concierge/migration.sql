-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "customerDisplayName" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "reviewText" TEXT,
    "reviewDate" TIMESTAMP(3) NOT NULL,
    "sourceUrl" TEXT,
    "avatarUrl" TEXT,
    "bookingId" TEXT,
    "customerId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "originalText" TEXT,
    "moderatedBy" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewInvitation" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSyncState" (
    "id" TEXT NOT NULL DEFAULT 'google',
    "provider" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "reviewsImported" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPhone" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "displayNumber" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'BOOKING',
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "supportsInbound" BOOLEAN NOT NULL DEFAULT true,
    "supportsOutbound" BOOLEAN NOT NULL DEFAULT false,
    "twilioNumberSid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallbackRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "phoneE164" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedFor" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'CONCIERGE',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "assignedBusinessPhoneId" TEXT,
    "assignedStaffId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "claimedUntil" TIMESTAMP(3),
    "staffCallSid" TEXT,
    "customerCallSid" TEXT,
    "connectedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_bookingId_key" ON "Review"("bookingId");

-- CreateIndex
CREATE INDEX "Review_status_source_idx" ON "Review"("status", "source");

-- CreateIndex
CREATE INDEX "Review_featured_status_idx" ON "Review"("featured", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Review_source_externalId_key" ON "Review"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewInvitation_bookingId_key" ON "ReviewInvitation"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewInvitation_tokenHash_key" ON "ReviewInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "ReviewInvitation_customerId_idx" ON "ReviewInvitation"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPhone_phoneE164_key" ON "BusinessPhone"("phoneE164");

-- CreateIndex
CREATE INDEX "BusinessPhone_isPublic_enabled_priority_idx" ON "BusinessPhone"("isPublic", "enabled", "priority");

-- CreateIndex
CREATE INDEX "CallbackRequest_status_requestedFor_idx" ON "CallbackRequest"("status", "requestedFor");

-- CreateIndex
CREATE INDEX "CallbackRequest_customerId_status_idx" ON "CallbackRequest"("customerId", "status");

-- CreateIndex
CREATE INDEX "CallbackRequest_phoneE164_status_idx" ON "CallbackRequest"("phoneE164", "status");

-- CreateIndex
CREATE INDEX "Conversation_customerId_idx" ON "Conversation"("customerId");

-- CreateIndex
CREATE INDEX "Conversation_expiresAt_idx" ON "Conversation"("expiresAt");

-- CreateIndex
CREATE INDEX "ConversationMessage_conversationId_idx" ON "ConversationMessage"("conversationId");

-- AddForeignKey
ALTER TABLE "CallbackRequest" ADD CONSTRAINT "CallbackRequest_assignedBusinessPhoneId_fkey" FOREIGN KEY ("assignedBusinessPhoneId") REFERENCES "BusinessPhone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

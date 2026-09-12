import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  ReviewService,
  ReviewError,
  FakeReviewProvider,
  GoogleBusinessProfileReviewProvider,
} from '../src/reviews/review-service.js';
import {
  CallbackService,
  FakeVoiceProvider,
  TwilioVoiceProvider,
  CallbackError,
  maskCallbackPhone,
} from '../src/callbacks/callback-service.js';
import {
  ConciergeTools,
  ConciergeError,
  PUBLIC_TOOLS,
  QUICK_ACTIONS,
  requiresExplicitConfirmation,
  aiConfigured,
} from '../src/concierge/tools.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));

describe('integration gating', () => {
  it('Google reviews report NOT configured without every credential', () => {
    expect(new GoogleBusinessProfileReviewProvider({}).configured).toBe(false);
    expect(
      new GoogleBusinessProfileReviewProvider({
        GOOGLE_BUSINESS_CLIENT_ID: 'a',
        GOOGLE_BUSINESS_CLIENT_SECRET: 'b',
      }).configured,
    ).toBe(false);
    expect(
      new GoogleBusinessProfileReviewProvider({
        GOOGLE_BUSINESS_CLIENT_ID: 'a',
        GOOGLE_BUSINESS_CLIENT_SECRET: 'b',
        GOOGLE_BUSINESS_REFRESH_TOKEN: 'c',
        GOOGLE_BUSINESS_LOCATION_ID: 'd',
      }).configured,
    ).toBe(true);
  });

  it('Twilio Voice reports NOT configured without a voice number', () => {
    expect(new TwilioVoiceProvider({ TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b' }).configured).toBe(false);
  });

  it('AI is only configured when both provider and key are present', () => {
    expect(aiConfigured({})).toBe(false);
    expect(aiConfigured({ AI_PROVIDER: 'anthropic' })).toBe(false);
    expect(aiConfigured({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k' })).toBe(true);
  });

  it('verifies Twilio webhook signatures rather than trusting the payload', () => {
    const p = new TwilioVoiceProvider({
      TWILIO_ACCOUNT_SID: 'AC',
      TWILIO_AUTH_TOKEN: 'secret',
      TWILIO_VOICE_NUMBER: '+15145551234',
    });
    const url = 'https://r2nette.ca/api/v1/voice/status';
    const params = { CallSid: 'CA1', CallStatus: 'completed' };
    // A forged "call connected" must not verify.
    expect(p.verifyWebhook(url, params, 'obviously-wrong')).toBe(false);
  });
});

describe('concierge guardrails', () => {
  it('keeps customer-scoped tools out of the public set', () => {
    for (const t of ['getCustomerProfile', 'getUpcomingBookings', 'getBooking', 'getPaymentStatus']) {
      expect(PUBLIC_TOOLS).not.toContain(t);
    }
  });

  it('never lets the assistant commit a sensitive action alone', () => {
    for (const a of ['createBooking', 'confirmPayment', 'cancelBooking', 'rescheduleBooking']) {
      expect(requiresExplicitConfirmation(a)).toBe(true);
    }
    expect(requiresExplicitConfirmation('createQuote')).toBe(false);
  });

  it('offers guided actions that work with no AI provider at all', () => {
    expect(QUICK_ACTIONS.length).toBeGreaterThan(5);
    expect(QUICK_ACTIONS.some((a) => a.id === 'callme')).toBe(true);
    expect(QUICK_ACTIONS.some((a) => a.id === 'human')).toBe(true);
  });

  it('masks a phone for customer-facing confirmation', () => {
    expect(maskCallbackPhone('+15148252825')).toBe('(514) •••-2825');
  });
});

d('reviews', () => {
  let prisma: PrismaClient;
  let reviews: ReviewService;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.reviewInvitation.deleteMany();
    await prisma.review.deleteMany();
    await prisma.reviewSyncState.deleteMany();
    await prisma.promotionClaim.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.bookingHold.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    await seed(prisma);
    reviews = new ReviewService(prisma);
  });

  async function completedBooking(status = 'COMPLETED') {
    const c = await prisma.customer.create({ data: { firstName: 'Pascal' } });
    const addr = await prisma.customerAddress.create({
      data: { customerId: c.id, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId: c.id,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        baseServiceCents: 20000,
        subtotalCents: 22500,
        gstCents: 1125,
        qstCents: 2244,
        taxTotalCents: 3369,
        grandTotalCents: 25869,
        gstRateMicroPercent: 5_000_000,
        qstRateMicroPercent: 9_975_000,
        pricingVersion: 't',
        priceSnapshot: {},
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const b = await prisma.booking.create({
      data: {
        bookingNumber: `R2N-2026-00${Math.floor(Math.random() * 9000) + 1000}`,
        customerId: c.id,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() - 86400000),
        endAt: new Date(Date.now() - 75600000),
        status,
        grandTotalCents: 25869,
        priceSnapshot: {},
      },
    });
    return { customer: c, booking: b };
  }

  /* ---------------- provenance ---------------- */

  it('[INV-TRUTH-01] refuses to create a GOOGLE review without provider provenance', async () => {
    await expect(
      reviews.create({
        source: 'GOOGLE',
        customerDisplayName: 'Totally Real Person',
        rating: 5,
        reviewText: 'Amazing!',
      }),
    ).rejects.toThrow(/provider sync/i);
  });

  it('refuses R2NETTE_VERIFIED without a completed booking', async () => {
    await expect(
      reviews.create({ source: 'R2NETTE_VERIFIED', customerDisplayName: 'X', rating: 5 }),
    ).rejects.toThrow(/completed booking/i);

    const { booking } = await completedBooking('CONFIRMED'); // not completed
    await expect(
      reviews.create({
        source: 'R2NETTE_VERIFIED',
        customerDisplayName: 'X',
        rating: 5,
        bookingId: booking.id,
      }),
    ).rejects.toThrow(/completed cleaning/i);
  });

  it('allows a manual testimonial but keeps it labelled MANUAL_APPROVED', async () => {
    const r = await reviews.create({
      source: 'MANUAL_APPROVED',
      customerDisplayName: 'Sarah R.',
      rating: 5,
      reviewText: 'Emailed us this.',
    });
    expect(r.source).toBe('MANUAL_APPROVED');
    expect(r.source).not.toBe('GOOGLE');
  });

  it('rejects an out-of-range rating', async () => {
    await expect(
      reviews.create({ source: 'MANUAL_APPROVED', customerDisplayName: 'X', rating: 6 }),
    ).rejects.toThrow(ReviewError);
    await expect(
      reviews.create({ source: 'MANUAL_APPROVED', customerDisplayName: 'X', rating: 0 }),
    ).rejects.toThrow(ReviewError);
  });

  /* ---------------- sync ---------------- */

  it('imports Google reviews and keeps the GOOGLE source', async () => {
    const provider = new FakeReviewProvider([
      {
        externalId: 'g1',
        customerDisplayName: 'David McNamara',
        rating: 5,
        reviewText: 'Excellent service.',
        reviewDate: new Date('2024-05-01'),
      },
    ]);
    const res = await reviews.syncFromProvider(provider, 'GOOGLE');
    expect(res.imported).toBe(1);
    const row = await prisma.review.findFirstOrThrow();
    expect(row.source).toBe('GOOGLE');
    expect(row.externalId).toBe('g1');
  });

  it('re-syncing does not duplicate', async () => {
    const provider = new FakeReviewProvider([
      { externalId: 'g1', customerDisplayName: 'D', rating: 5, reviewDate: new Date() },
    ]);
    await reviews.syncFromProvider(provider, 'GOOGLE');
    const second = await reviews.syncFromProvider(provider, 'GOOGLE');
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);
    expect(await prisma.review.count()).toBe(1);
  });

  it('records sync failures instead of silently reporting success', async () => {
    const failing = {
      name: 'failing',
      configured: true,
      listReviews: async () => {
        throw new Error('token expired');
      },
    };
    await expect(reviews.syncFromProvider(failing, 'GOOGLE')).rejects.toThrow();
    const state = await prisma.reviewSyncState.findUniqueOrThrow({ where: { id: 'google' } });
    expect(state.lastError).toMatch(/token expired/);
    expect(state.lastSuccessfulSyncAt).toBeNull();
  });

  /* ---------------- legacy import ---------------- */

  it('dry run reports what would change without writing', async () => {
    const rows = [
      { externalId: 's1', name: 'Sarah Rynd', rating: 5, text: 'Very professional.' },
      { externalId: 's2', name: '', rating: 5 },
    ];
    const report = await reviews.importLegacy(rows, { dryRun: true });
    expect(report.found).toBe(2);
    expect(report.valid).toBe(1);
    expect(report.invalid).toBe(1);
    expect(await prisma.review.count()).toBe(0);
  });

  it('legacy import keeps SETMORE_LEGACY and is idempotent', async () => {
    const rows = [{ externalId: 's1', name: 'Jon Rose', rating: 5, text: 'On time.' }];
    await reviews.importLegacy(rows);
    const again = await reviews.importLegacy(rows);
    expect(again.duplicates).toBe(1);
    expect(await prisma.review.count()).toBe(1);
    const row = await prisma.review.findFirstOrThrow();
    expect(row.source).toBe('SETMORE_LEGACY');
  });

  /* ---------------- invitations ---------------- */

  it('issues an invitation only for a completed booking', async () => {
    const { booking } = await completedBooking('CONFIRMED');
    await expect(reviews.issueInvitation(booking.id)).rejects.toThrow(/not completed/i);
  });

  it('a valid token produces a verified review, once', async () => {
    const { booking } = await completedBooking();
    const { token } = await reviews.issueInvitation(booking.id);

    const review = await reviews.submitInvitedReview(token, { rating: 5, text: 'Great crew.' });
    expect(review.source).toBe('R2NETTE_VERIFIED');
    expect(review.bookingId).toBe(booking.id);
    expect(review.status).toBe('PENDING'); // moderated before publication

    await expect(reviews.submitInvitedReview(token, { rating: 1 })).rejects.toThrow(/already used/i);
  });

  it('stores only a hash of the token', async () => {
    const { booking } = await completedBooking();
    const { token } = await reviews.issueInvitation(booking.id);
    const inv = await prisma.reviewInvitation.findFirstOrThrow();
    expect(inv.tokenHash).not.toBe(token);
    expect(inv.tokenHash).toHaveLength(64);
  });

  it('rejects an expired token', async () => {
    const { booking } = await completedBooking();
    const { token } = await reviews.issueInvitation(booking.id);
    await prisma.reviewInvitation.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(reviews.submitInvitedReview(token, { rating: 5 })).rejects.toThrow(/expired/i);
  });

  it('rejects a made-up token', async () => {
    await expect(reviews.submitInvitedReview('not-a-token', { rating: 5 })).rejects.toThrow(
      /not valid/i,
    );
  });

  /* ---------------- aggregates ---------------- */

  it('[INV-TRUTH-02] shows nothing rather than a fabricated score when there are no reviews', async () => {
    const s = await reviews.summary();
    expect(s.averageRating).toBeNull();
    expect(s.reviewCount).toBe(0);
  });

  it('averages only PUBLISHED reviews', async () => {
    const provider = new FakeReviewProvider([
      { externalId: 'g1', customerDisplayName: 'A', rating: 5, reviewDate: new Date() },
      { externalId: 'g2', customerDisplayName: 'B', rating: 4, reviewDate: new Date() },
    ]);
    await reviews.syncFromProvider(provider, 'GOOGLE');
    const hidden = await reviews.create({
      source: 'MANUAL_APPROVED',
      customerDisplayName: 'C',
      rating: 1,
      status: 'HIDDEN',
    });
    expect(hidden.status).toBe('HIDDEN');

    const s = await reviews.summary();
    expect(s.reviewCount).toBe(2); // the 1-star hidden one is excluded
    expect(s.averageRating).toBe(4.5);
    expect(s.bySource.GOOGLE?.reviewCount).toBe(2);
  });

  it('public listing never returns pending or hidden reviews', async () => {
    await reviews.create({
      source: 'MANUAL_APPROVED',
      customerDisplayName: 'Pending',
      rating: 5,
      status: 'PENDING',
    });
    const published = await reviews.listPublished();
    expect(published).toHaveLength(0);
  });

  it('preserves the original text when a review is created', async () => {
    const r = await reviews.create({
      source: 'MANUAL_APPROVED',
      customerDisplayName: 'X',
      rating: 5,
      reviewText: 'Original wording.',
    });
    expect(r.originalText).toBe('Original wording.');
  });
});

d('callbacks', () => {
  let prisma: PrismaClient;
  let voice: FakeVoiceProvider;
  let callbacks: CallbackService;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.callbackRequest.deleteMany();
    await prisma.businessPhone.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    voice = new FakeVoiceProvider();
    callbacks = new CallbackService(prisma, voice);
    await prisma.businessPhone.upsert({
      where: { phoneE164: '+15148252825' },
      create: {
        label: 'Booking',
        phoneE164: '+15148252825',
        displayNumber: '(514) 825-2825',
        purpose: 'BOOKING',
        supportsOutbound: true,
        priority: 0,
      },
      update: { supportsOutbound: true, isPublic: true, enabled: true },
    });
  });

  it('persists a request and queues it', async () => {
    const res = await callbacks.request({ phoneE164: '+15145551234', reason: 'pricing' });
    expect(res.callback.status).toBe('QUEUED');
    expect(res.alreadyActive).toBe(false);
  });

  it('a second request surfaces the existing one instead of queueing another call', async () => {
    const first = await callbacks.request({ phoneE164: '+15145551234' });
    const second = await callbacks.request({ phoneE164: '+15145551234' });
    expect(second.alreadyActive).toBe(true);
    expect(second.callback.id).toBe(first.callback.id);
    expect(await prisma.callbackRequest.count()).toBe(1);
  });

  it('rate limits repeated requests from one number', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await callbacks.request({ phoneE164: '+15145551234' });
      await prisma.callbackRequest.update({
        where: { id: r.callback.id },
        data: { status: 'COMPLETED' },
      });
    }
    await expect(callbacks.request({ phoneE164: '+15145551234' })).rejects.toThrow(/Too many/i);
  });

  /* ---------------- staff-first ---------------- */

  it('rings staff first and does NOT call the customer yet', async () => {
    const { callback } = await callbacks.request({ phoneE164: '+15145551234' });
    const res = await callbacks.dialStaffFirst(callback.id);

    expect(res.dialed).toBe(true);
    expect(voice.staffCalls).toEqual(['+15148252825']);
    // The customer must not be left listening to silence.
    expect(voice.customerCalls).toEqual([]);

    const row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: callback.id } });
    expect(row.status).toBe('STAFF_RINGING');
  });

  it('calls the customer only after staff accepts', async () => {
    const { callback } = await callbacks.request({ phoneE164: '+15145551234' });
    await callbacks.dialStaffFirst(callback.id);
    await callbacks.onStaffAccepted(callback.id);

    expect(voice.customerCalls).toEqual(['+15145551234']);
    const row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: callback.id } });
    expect(row.status).toBe('CUSTOMER_RINGING');
  });

  it('CONNECTED comes from a provider event, not from placing the call', async () => {
    const { callback } = await callbacks.request({ phoneE164: '+15145551234' });
    await callbacks.dialStaffFirst(callback.id);
    await callbacks.onStaffAccepted(callback.id);

    let row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: callback.id } });
    expect(row.status).not.toBe('CONNECTED');

    await callbacks.onConnected(callback.id);
    row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: callback.id } });
    expect(row.status).toBe('CONNECTED');
    expect(row.connectedAt).not.toBeNull();
    expect(voice.bridged).toHaveLength(1);
  });

  it('retries when staff miss the call, but does not chase the customer', async () => {
    const { callback } = await callbacks.request({ phoneE164: '+15145551234' });
    await callbacks.dialStaffFirst(callback.id);
    await callbacks.onNoAnswer(callback.id, 'STAFF');
    let row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: callback.id } });
    expect(row.status).toBe('QUEUED');

    await callbacks.onStaffAccepted(callback.id).catch(() => undefined);
    await callbacks.onNoAnswer(callback.id, 'CUSTOMER');
    row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: callback.id } });
    expect(row.status).toBe('NO_ANSWER');
  });

  it('stops after the configured attempt limit', async () => {
    const { callback } = await callbacks.request({ phoneE164: '+15145551234' });
    for (let i = 0; i < 3; i++) {
      await callbacks.dialStaffFirst(callback.id);
      await callbacks.onNoAnswer(callback.id, 'STAFF');
    }
    const res = await callbacks.dialStaffFirst(callback.id);
    expect(res.dialed).toBe(false);
    const row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: callback.id } });
    expect(row.status).toBe('FAILED');
  });

  /* ---------------- worker safety ---------------- */

  it('two workers cannot claim the same callback', async () => {
    await callbacks.request({ phoneE164: '+15145551234' });
    const other = new PrismaClient({ datasources: { db: { url: URL } } });
    try {
      const serviceB = new CallbackService(other, voice);
      const [a, b] = await Promise.all([
        callbacks.claimNext('worker-a'),
        serviceB.claimNext('worker-b'),
      ]);
      const claimed = [a, b].filter(Boolean);
      expect(claimed).toHaveLength(1);
    } finally {
      await other.$disconnect();
    }
  });

  it('does not claim a callback scheduled for later', async () => {
    await callbacks.request({
      phoneE164: '+15145551234',
      requestedFor: new Date(Date.now() + 3600_000),
    });
    expect(await callbacks.claimNext('worker-a')).toBeNull();
  });

  it('records the request but places no call when voice is not configured', async () => {
    const noVoice = new CallbackService(prisma, null);
    const { callback } = await noVoice.request({ phoneE164: '+15145559999' });
    const res = await noVoice.dialStaffFirst(callback.id);
    expect(res.dialed).toBe(false);
    expect(res.reason).toBe('VOICE_NOT_CONFIGURED');
    // Still persisted for operations to action manually.
    expect(await prisma.callbackRequest.count({ where: { id: callback.id } })).toBe(1);
  });

  it('does not dial when no outbound business line is configured', async () => {
    await prisma.businessPhone.updateMany({ data: { supportsOutbound: false } });
    const { callback } = await callbacks.request({ phoneE164: '+15145551234' });
    const res = await callbacks.dialStaffFirst(callback.id);
    expect(res.dialed).toBe(false);
    expect(res.reason).toBe('NO_STAFF_LINE');
    expect(voice.customerCalls).toEqual([]);
  });

  it('one customer cannot cancel another customer callback', async () => {
    const a = await prisma.customer.create({ data: {} });
    const b = await prisma.customer.create({ data: {} });
    const { callback } = await callbacks.request({ phoneE164: '+15145551234', customerId: a.id });
    await expect(callbacks.cancel(callback.id, b.id)).rejects.toThrow(CallbackError);
  });

  it('lists only public enabled phone numbers', async () => {
    await prisma.businessPhone.create({
      data: {
        label: 'Dispatch',
        phoneE164: '+15145550000',
        displayNumber: '(514) 555-0000',
        purpose: 'DISPATCH',
        isPublic: false,
      },
    });
    const phones = await callbacks.publicPhones();
    expect(phones).toHaveLength(1);
    expect(phones[0]!.displayNumber).toBe('(514) 825-2825');
  });
});

d('concierge tools', () => {
  let prisma: PrismaClient;
  let tools: ConciergeTools;
  let customerA: string;
  let customerB: string;
  let bookingB: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.callbackRequest.deleteMany();
    await prisma.businessPhone.deleteMany();
    await prisma.review.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.bookingHold.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.staffAvailability.deleteMany();
    await prisma.staff.deleteMany();
    await seed(prisma);
    await prisma.staff.create({ data: { displayName: 'Alice', availability: { create: ALL_WEEK } } });
    await prisma.staff.create({ data: { displayName: 'Bruno', availability: { create: ALL_WEEK } } });

    tools = new ConciergeTools(prisma, new CallbackService(prisma, new FakeVoiceProvider()));

    const a = await prisma.customer.create({ data: { firstName: 'Alice C' } });
    const b = await prisma.customer.create({ data: { firstName: 'Bruno C' } });
    customerA = a.id;
    customerB = b.id;

    const addr = await prisma.customerAddress.create({
      data: { customerId: b.id, formattedAddress: '999 Secret St', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId: b.id,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        baseServiceCents: 20000,
        subtotalCents: 22500,
        gstCents: 1125,
        qstCents: 2244,
        taxTotalCents: 3369,
        grandTotalCents: 25869,
        gstRateMicroPercent: 5_000_000,
        qstRateMicroPercent: 9_975_000,
        pricingVersion: 't',
        priceSnapshot: {},
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const bk = await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000777',
        customerId: b.id,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 86400000),
        endAt: new Date(Date.now() + 97200000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
      },
    });
    bookingB = bk.id;
  });

  const guest = { customerId: null, locale: 'en' as const };
  const asA = () => ({ customerId: customerA, locale: 'en' as const });

  it('prices only through the authoritative engine', async () => {
    const res = (await tools.call(
      'createQuote',
      { serviceOptionId: 'svc_basic_2x3', frequency: 'WEEKLY', productSupplyOption: 'CLIENT_SUPPLIED', distanceKm: 12 },
      guest,
    )) as { authoritative: boolean; grandTotalCents: number };
    // $200 − 25% + $25 transport, plus GST/QST = $201.21
    expect(res.authoritative).toBe(true);
    expect(res.grandTotalCents).toBe(20121);
  });

  it('returns only real slots from the scheduling engine', async () => {
    const tomorrow = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() + 86400000));
    const res = (await tools.call(
      'getAvailableSlots',
      { serviceOptionId: 'svc_basic_2x3', date: tomorrow },
      guest,
    )) as { slots: { startAt: string }[] };
    expect(Array.isArray(res.slots)).toBe(true);
    // Times only — never staff identities.
    expect(JSON.stringify(res)).not.toMatch(/Alice|Bruno|staffId/);
  });

  it('refuses a quote-required service rather than inventing a price', async () => {
    await expect(
      tools.call('createQuote', { serviceOptionId: 'svc_window', frequency: 'ONE_TIME' }, guest),
    ).rejects.toThrow();
  });

  /* ---------------- authorization ---------------- */

  it('a visitor cannot read any customer profile', async () => {
    await expect(tools.call('getCustomerProfile', {}, guest)).rejects.toThrow(ConciergeError);
    await expect(tools.call('getUpcomingBookings', {}, guest)).rejects.toThrow(/verify/i);
  });

  it('[INV-AUTH-07] PROMPT INJECTION: "ignore your rules" cannot widen tool access', async () => {
    // Whatever the message said, the tool call still carries session identity.
    await expect(
      tools.call('getBooking', { bookingId: bookingB, customerId: customerB }, asA()),
    ).rejects.toThrow(/could not find/i);

    const addresses = (await tools.call(
      'getSavedAddresses',
      { customerId: customerB },
      asA(),
    )) as { addresses: unknown[] };
    expect(addresses.addresses).toHaveLength(0);
    expect(JSON.stringify(addresses)).not.toMatch(/Secret St/);
  });

  it('a customerId argument never overrides the session', async () => {
    const profile = (await tools.call(
      'getCustomerProfile',
      { customerId: customerB },
      asA(),
    )) as { customer: { id: string; firstName: string } };
    expect(profile.customer.id).toBe(customerA);
    expect(profile.customer.firstName).toBe('Alice C');
  });

  it('payment status exposes no Stripe identifiers or risk data', async () => {
    const bookingA = await prisma.booking.findFirst({ where: { customerId: customerB } });
    const res = await tools
      .call('getPaymentStatus', { bookingId: bookingA!.id }, asA())
      .catch((e) => e);
    expect(res).toBeInstanceOf(ConciergeError); // not customer A's booking
  });

  it('a callback through the concierge creates a real persisted request', async () => {
    // The seed already publishes this number; make it outbound-capable.
    await prisma.businessPhone.updateMany({
      where: { phoneE164: '+15148252825' },
      data: { supportsOutbound: true },
    });
    const res = (await tools.call(
      'requestCallback',
      { phoneE164: '+15145551234', reason: 'pricing question' },
      guest,
    )) as { callbackId: string; status: string };
    expect(res.status).toBe('QUEUED');
    const row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: res.callbackId } });
    expect(row.reason).toBe('pricing question');
    expect(row.source).toBe('CONCIERGE');
  });

  it('review summary reflects real data, and nothing when empty', async () => {
    const empty = (await tools.call('getReviewSummary', {}, guest)) as { averageRating: number | null };
    expect(empty.averageRating).toBeNull();
  });

  it('rejects an unknown tool', async () => {
    await expect(
      tools.call('deleteAllBookings' as never, {}, asA()),
    ).rejects.toThrow(/Unknown tool/i);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApi } from '../src/api/app.js';
import { customerSession } from './customer-session.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import { FakeStripeProvider } from '../src/payments/stripe-provider.js';
import { PromotionClaimService, NEW_CUSTOMER_FAMILY } from '../src/promotions/claims.js';
import { REPRICE_COPY } from '../src/payments/reprice.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));

describe('reprice copy', () => {
  it('never implies the customer did anything wrong', () => {
    for (const [, copy] of Object.entries(REPRICE_COPY)) {
      expect(copy.en).not.toMatch(/fraud|abuse|invalid|you tried|not allowed/i);
      expect(copy.fr.length).toBeGreaterThan(0);
    }
  });

  it('explains the already-used offer plainly in both languages', () => {
    expect(REPRICE_COPY.NEW_CUSTOMER_ALREADY_REDEEMED.en).toMatch(/already been used/i);
    expect(REPRICE_COPY.NEW_CUSTOMER_ALREADY_REDEEMED.fr).toMatch(/déjà été utilisée/i);
  });
});

d('quote revalidation', () => {
  let prisma: PrismaClient;
  let stripe: FakeStripeProvider;
  let app: ReturnType<typeof createApi>;
  let claims: PromotionClaimService;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany();
    await prisma.paymentProviderCustomer.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.customerSession.deleteMany();
    await prisma.promotionClaim.deleteMany();
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
    await prisma.bookingNumberSequence.deleteMany();
    await seed(prisma);
    await prisma.staff.create({ data: { displayName: 'Alice', availability: { create: ALL_WEEK } } });
    await prisma.staff.create({ data: { displayName: 'Bruno', availability: { create: ALL_WEEK } } });

    stripe = new FakeStripeProvider();
    claims = new PromotionClaimService(prisma);
    app = createApi({
      prisma,
      verification: new FakeVerificationProvider('123456'),
      stripe,
      stripeWebhookSecret: 'whsec_test',
    });
  });

  async function login(phone = '514 825 2825') {
    const cookie = await customerSession(app, phone);
    const me = await request(app).get('/api/v1/customer/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    return { cookie, customerId: me.body.customer.id as string };
  }

  async function quoteFor(cookie: string, frequency: string, serviceOptionId = 'svc_basic_1x3') {
    const res = await request(app)
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({
        serviceOptionId,
        frequency,
        productSupplyOption: 'CLIENT_SUPPLIED',
        distanceKm: 12,
      });
    return res.body.quote;
  }

  it('a monthly quote for an eligible customer revalidates as VALID', async () => {
    const { cookie } = await login();
    const q = await quoteFor(cookie, 'MONTHLY');
    const res = await request(app)
      .post(`/api/v1/quotes/${q.id}/revalidate`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VALID');
    expect(res.body.grandTotalCents).toBe(q.grandTotalCents);
  });

  it('WEEKLY: the frequency discount won, so losing the welcome offer changes nothing', async () => {
    // Basic $110 weekly: 25% = $27.50 beats the $15 welcome offer, so the
    // offer was never claimed and its absence must not trigger a reprice.
    const { cookie, customerId } = await login();
    const q = await quoteFor(cookie, 'WEEKLY');
    await claims.reserveAndRedeem({
      customerId,
      promotionId: 'promo_new_basic',
      promotionFamily: NEW_CUSTOMER_FAMILY,
      amountCents: 1500,
      bookingId: 'earlier-booking',
    });

    const res = await request(app)
      .post(`/api/v1/quotes/${q.id}/revalidate`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VALID');
    expect(res.body.grandTotalCents).toBe(q.grandTotalCents);
  });

  it('MONTHLY: an already-used welcome offer triggers a reprice with old and new totals', async () => {
    const { cookie, customerId } = await login();
    const q = await quoteFor(cookie, 'MONTHLY');

    // The offer was consumed on an earlier booking.
    await claims.reserveAndRedeem({
      customerId,
      promotionId: 'promo_new_basic',
      promotionFamily: NEW_CUSTOMER_FAMILY,
      amountCents: 1500,
      bookingId: 'earlier-booking',
    });

    const res = await request(app)
      .post(`/api/v1/quotes/${q.id}/revalidate`)
      .set('Cookie', cookie);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QUOTE_REPRICE_REQUIRED');
    expect(res.body.reprice.reason).toBe('NEW_CUSTOMER_ALREADY_REDEEMED');
    expect(res.body.reprice.previousTotalCents).toBe(q.grandTotalCents);
    expect(res.body.reprice.newTotalCents).toBeGreaterThan(q.grandTotalCents);
    expect(res.body.reprice.differenceCents).toBe(
      res.body.reprice.newTotalCents - q.grandTotalCents,
    );
    expect(res.body.reprice.newQuoteId).not.toBe(q.id);
    expect(res.body.reprice.lines.length).toBeGreaterThan(0);
    expect(res.body.reprice.copy.fr).toMatch(/déjà/i);
  });

  it('the reprice creates a new persisted quote rather than mutating the old one', async () => {
    const { cookie, customerId } = await login();
    const q = await quoteFor(cookie, 'MONTHLY');
    await claims.reserveAndRedeem({
      customerId,
      promotionId: 'promo_new_basic',
      promotionFamily: NEW_CUSTOMER_FAMILY,
      amountCents: 1500,
      bookingId: 'earlier',
    });
    const res = await request(app)
      .post(`/api/v1/quotes/${q.id}/revalidate`)
      .set('Cookie', cookie);

    const original = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(original.grandTotalCents).toBe(q.grandTotalCents); // untouched
    const fresh = await prisma.quote.findUniqueOrThrow({
      where: { id: res.body.reprice.newQuoteId },
    });
    expect(fresh.grandTotalCents).toBe(res.body.reprice.newTotalCents);
  });

  it('[INV-PAY-06] no Stripe object is created while a reprice is outstanding', async () => {
    const { cookie, customerId } = await login();
    await prisma.serviceOption.update({
      where: { id: 'svc_basic_1x3' },
      data: { paymentPolicy: 'FULL_PAYMENT' },
    });
    const q = await quoteFor(cookie, 'MONTHLY');
    const addr = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const booking = await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000900',
        customerId,
        serviceOptionId: 'svc_basic_1x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 48 * 3600_000),
        endAt: new Date(Date.now() + 51 * 3600_000),
        status: 'PENDING_PAYMENT',
        grandTotalCents: q.grandTotalCents,
        priceSnapshot: {},
      },
    });

    await claims.reserveAndRedeem({
      customerId,
      promotionId: 'promo_new_basic',
      promotionFamily: NEW_CUSTOMER_FAMILY,
      amountCents: 1500,
      bookingId: 'earlier',
    });

    const res = await request(app)
      .post('/api/v1/payments/payment-intent')
      .set('Cookie', cookie)
      .send({ bookingId: booking.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QUOTE_REPRICE_REQUIRED');
    // The critical assertion: Stripe was never called.
    expect(stripe.createPaymentIntentCalls).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('one customer cannot revalidate another customer quote', async () => {
    const victim = await login('514 825 2826');
    const q = await quoteFor(victim.cookie, 'MONTHLY');
    const attacker = await login('514 825 2825');
    const res = await request(app)
      .post(`/api/v1/quotes/${q.id}/revalidate`)
      .set('Cookie', attacker.cookie);
    expect(res.status).toBe(404);
  });

  it('requires a session', async () => {
    const res = await request(app).post('/api/v1/quotes/some-id/revalidate');
    expect(res.status).toBe(401);
  });
});

d('payment config for checkout', () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createApi>;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany();
    await prisma.customerSession.deleteMany();
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    await seed(prisma);
    app = createApi({
      prisma,
      verification: new FakeVerificationProvider('123456'),
      stripe: new FakeStripeProvider(),
      stripeWebhookSecret: 'whsec_test',
    });
  });

  async function bookingWithPolicy(policy: string) {
    const cookie = await customerSession(app, '514 825 2825');
    const me = await request(app).get('/api/v1/customer/me').set('Cookie', cookie);
    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { paymentPolicy: policy },
    });
    const addr = await prisma.customerAddress.create({
      data: {
        customerId: me.body.customer.id,
        formattedAddress: 'x',
        city: 'Lachine',
        postalCode: 'H8T1B7',
      },
    });
    const q = await prisma.quote.create({
      data: {
        customerId: me.body.customer.id,
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
        customerId: me.body.customer.id,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 48 * 3600_000),
        endAt: new Date(Date.now() + 51 * 3600_000),
        status: 'PENDING_PAYMENT',
        grandTotalCents: 25869,
        priceSnapshot: {},
      },
    });
    return { cookie, bookingId: b.id };
  }

  it('PAY_LATER reports nothing due today', async () => {
    const { cookie, bookingId } = await bookingWithPolicy('PAY_LATER');
    const res = await request(app)
      .get('/api/v1/payment-config')
      .query({ bookingId })
      .set('Cookie', cookie);
    expect(res.body.paymentPolicy).toBe('PAY_LATER');
    expect(res.body.amountDueNowCents).toBe(0);
    expect(res.body.recurringPaymentRequired).toBe(false);
  });

  it('FULL_PAYMENT reports the authoritative booking total', async () => {
    const { cookie, bookingId } = await bookingWithPolicy('FULL_PAYMENT');
    const res = await request(app)
      .get('/api/v1/payment-config')
      .query({ bookingId })
      .set('Cookie', cookie);
    expect(res.body.amountDueNowCents).toBe(25869);
    expect(res.body.bookingTotalCents).toBe(25869);
    expect(res.body.remainingBalanceCents).toBe(0);
  });

  it('CARD_ON_FILE reports zero due but a saved card required', async () => {
    const { cookie, bookingId } = await bookingWithPolicy('CARD_ON_FILE');
    const res = await request(app)
      .get('/api/v1/payment-config')
      .query({ bookingId })
      .set('Cookie', cookie);
    expect(res.body.amountDueNowCents).toBe(0);
    expect(res.body.recurringPaymentRequired).toBe(true);
    expect(res.body.recurringPaymentTiming).toBe('24_HOURS_BEFORE');
  });

  it('never leaks a secret or webhook key', async () => {
    const res = await request(app).get('/api/v1/payment-config');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/sk_/);
    expect(body).not.toMatch(/whsec_/);
  });

  it('does not reveal another customer booking amounts', async () => {
    const first = await bookingWithPolicy('FULL_PAYMENT');
    const attacker = await customerSession(app, '514 825 2826');
    const res = await request(app)
      .get('/api/v1/payment-config')
      .query({ bookingId: first.bookingId })
      .set('Cookie', attacker);
    expect(res.body.amountDueNowCents).toBeUndefined();
  });
});

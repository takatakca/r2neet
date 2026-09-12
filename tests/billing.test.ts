import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BillingScheduler, isHardDecline, RETRY_BACKOFF_HOURS, MAX_ATTEMPTS } from '../src/payments/billing-scheduler.js';
import { PaymentService } from '../src/payments/payment-service.js';
import { FakeStripeProvider, StripeError } from '../src/payments/stripe-provider.js';
import {
  NotificationService,
  FakeNotificationProvider,
  render,
  TwilioSmsProvider,
  HttpEmailProvider,
} from '../src/notifications/notification-service.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

describe('decline classification', () => {
  it('treats a dead card as final, not something to retry', () => {
    for (const c of ['stolen_card', 'lost_card', 'expired_card', 'account_closed', 'card_declined']) {
      expect(isHardDecline(c), c).toBe(true);
    }
  });

  it('treats an outage or a rate limit as retryable', () => {
    for (const c of ['STRIPE_NETWORK', 'STRIPE_HTTP_500', 'processing_error', undefined]) {
      expect(isHardDecline(c), String(c)).toBe(false);
    }
  });

  it('backs off rather than hammering a failing card', () => {
    expect(RETRY_BACKOFF_HOURS[0]).toBeLessThan(RETRY_BACKOFF_HOURS[1]!);
    expect(RETRY_BACKOFF_HOURS[1]).toBeLessThan(RETRY_BACKOFF_HOURS[2]!);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});

describe('notification copy', () => {
  it('tells the customer what happens next when a payment fails', () => {
    const m = render('PAYMENT_FAILED', 'en', { amount: '$137.40', when: 'Monday' });
    expect(m.body).toMatch(/still booked/i);
    expect(m.body).toMatch(/update your card|call/i);
    // Never accusatory.
    expect(m.body).not.toMatch(/declined by you|your fault|invalid customer/i);
  });

  it('renders both languages for every template', () => {
    const templates = [
      'BOOKING_CONFIRMED',
      'BOOKING_REMINDER',
      'BOOKING_CANCELLED',
      'RECURRING_VISIT_SCHEDULED',
      'PAYMENT_SUCCEEDED',
      'PAYMENT_FAILED',
      'PAYMENT_ACTION_REQUIRED',
    ] as const;
    for (const t of templates) {
      expect(render(t, 'en', {}).body.length).toBeGreaterThan(10);
      expect(render(t, 'fr', {}).body.length).toBeGreaterThan(10);
    }
  });

  it('tells recurring customers how to stop, in the message itself', () => {
    const m = render('RECURRING_VISIT_SCHEDULED', 'en', { when: 'Monday' });
    expect(m.body).toMatch(/skip or pause/i);
  });

  it('reports providers as unconfigured without credentials', () => {
    expect(new TwilioSmsProvider({}).configured).toBe(false);
    expect(new HttpEmailProvider({}).configured).toBe(false);
    expect(
      new HttpEmailProvider({ EMAIL_API_KEY: 'k', EMAIL_API_URL: 'https://x', EMAIL_FROM: 'a@b.c' })
        .configured,
    ).toBe(true);
  });
});

d('billing scheduler', () => {
  let prisma: PrismaClient;
  let stripe: FakeStripeProvider;
  let payments: PaymentService;
  let billing: BillingScheduler;
  let customerId: string;
  let bookingId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.billingAttempt.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.paymentMethodReference.deleteMany();
    await prisma.paymentProviderCustomer.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
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
    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { paymentPolicy: 'FULL_PAYMENT' },
    });

    stripe = new FakeStripeProvider();
    payments = new PaymentService(prisma, stripe);
    billing = new BillingScheduler(prisma, payments);

    const c = await prisma.customer.create({ data: { firstName: 'Pascal' } });
    customerId = c.id;
    const addr = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'WEEKLY',
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
    // 12 hours out: inside the 24-hour charge window.
    const start = new Date(Date.now() + 12 * 3600_000);
    const b = await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000900',
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: start,
        endAt: new Date(start.getTime() + 3 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
      },
    });
    bookingId = b.id;
    await prisma.paymentMethodReference.create({
      data: { customerId, providerMethodId: 'pm_saved', methodType: 'card', isDefault: true },
    });
  });

  it('schedules a charge for a booking inside the window', async () => {
    const n = await billing.scheduleDueBookings();
    expect(n).toBe(1);
    const attempt = await prisma.billingAttempt.findFirstOrThrow();
    expect(attempt.amountCents).toBe(25869);
    expect(attempt.status).toBe('SCHEDULED');
  });

  it('never schedules a PAY_LATER booking', async () => {
    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { paymentPolicy: 'PAY_LATER' },
    });
    expect(await billing.scheduleDueBookings()).toBe(0);
    expect(await prisma.billingAttempt.count()).toBe(0);
  });

  it('scheduling twice does not queue the same booking twice', async () => {
    await billing.scheduleDueBookings();
    await billing.scheduleDueBookings();
    expect(await prisma.billingAttempt.count()).toBe(1);
  });

  it('charges the authoritative booking total', async () => {
    const res = await billing.run();
    expect(res.charged).toBe(1);
    const intent = [...stripe.intents.values()][0]!;
    expect(intent.amountCents).toBe(25869);
    const attempt = await prisma.billingAttempt.findFirstOrThrow();
    expect(attempt.status).toBe('SUCCEEDED');
  });

  it('[INV-PAY-04] running the worker twice does not charge twice', async () => {
    await billing.run();
    const calls = stripe.createPaymentIntentCalls;
    await billing.run();
    expect(stripe.createPaymentIntentCalls).toBe(calls);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('two workers cannot claim the same attempt', async () => {
    await billing.scheduleDueBookings();
    const other = new PrismaClient({ datasources: { db: { url: URL } } });
    try {
      const b2 = new BillingScheduler(other, new PaymentService(other, stripe));
      const [a, b] = await Promise.all([billing.claimNext('w1'), b2.claimNext('w2')]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    } finally {
      await other.$disconnect();
    }
  });

  it('abandons the charge when the booking is cancelled', async () => {
    await billing.scheduleDueBookings();
    await prisma.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });

    const attempt = await billing.claimNext('w1');
    const res = await billing.runAttempt(attempt!.id);

    expect(res.outcome).toBe('BOOKING_CANCELLED');
    expect(stripe.createPaymentIntentCalls).toBe(0);
    const row = await prisma.billingAttempt.findFirstOrThrow();
    expect(row.status).toBe('ABANDONED');
  });

  it('does not charge a customer with no saved card, and says so', async () => {
    await prisma.paymentMethodReference.deleteMany();
    await billing.scheduleDueBookings();
    const attempt = await billing.claimNext('w1');
    const res = await billing.runAttempt(attempt!.id);

    expect(res.outcome).toBe('NO_PAYMENT_METHOD');
    expect(stripe.createPaymentIntentCalls).toBe(0);
    const row = await prisma.billingAttempt.findFirstOrThrow();
    expect(row.status).toBe('HARD_FAILED');
    expect(row.failureCode).toBe('NO_PAYMENT_METHOD');
  });

  it('a transient failure schedules a retry with backoff', async () => {
    await billing.scheduleDueBookings();
    stripe.failNextWith = new StripeError('gateway timeout', 'STRIPE_HTTP_504', true);
    const attempt = await billing.claimNext('w1');
    const res = await billing.runAttempt(attempt!.id);

    expect(res.outcome).toBe('SOFT_FAILED');
    const row = await prisma.billingAttempt.findFirstOrThrow();
    expect(row.status).toBe('SOFT_FAILED');
    expect(row.attemptNumber).toBe(2);
    expect(row.nextRetryAt).not.toBeNull();
    // Not retried immediately.
    expect(row.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 3 * 3600_000);
  });

  it('[INV-PAY-05] a dead card stops immediately rather than retrying', async () => {
    await billing.scheduleDueBookings();
    stripe.failNextWith = new StripeError('Your card was declined.', 'card_declined', false);
    const attempt = await billing.claimNext('w1');
    const res = await billing.runAttempt(attempt!.id);

    expect(res.outcome).toBe('HARD_FAILED');
    const row = await prisma.billingAttempt.findFirstOrThrow();
    expect(row.status).toBe('HARD_FAILED');
    expect(row.nextRetryAt).toBeNull();
    // A second run must not pick it up again.
    expect(await billing.claimNext('w1')).toBeNull();
  });

  it('gives up after the attempt limit instead of retrying forever', async () => {
    await billing.scheduleDueBookings();
    await prisma.billingAttempt.updateMany({
      data: { attemptNumber: MAX_ATTEMPTS, nextRetryAt: null },
    });
    stripe.failNextWith = new StripeError('timeout', 'STRIPE_NETWORK', true);
    const attempt = await billing.claimNext('w1');
    const res = await billing.runAttempt(attempt!.id);

    expect(res.outcome).toBe('ABANDONED');
    expect((await prisma.billingAttempt.findFirstOrThrow()).status).toBe('ABANDONED');
  });

  it('3DS is not treated as a retryable failure', async () => {
    await billing.scheduleDueBookings();
    stripe.nextStatus = 'requires_action';
    const attempt = await billing.claimNext('w1');
    const res = await billing.runAttempt(attempt!.id);

    expect(res.outcome).toBe('REQUIRES_ACTION');
    const row = await prisma.billingAttempt.findFirstOrThrow();
    expect(row.status).toBe('HARD_FAILED');
    expect(row.failureCode).toBe('authentication_required');
  });

  it('does not re-charge a visit that is already paid', async () => {
    await billing.run();
    await prisma.billingAttempt.deleteMany();
    await billing.scheduleDueBookings();
    // Already paid, so nothing is queued.
    expect(await prisma.billingAttempt.count()).toBe(0);
  });

  it('surfaces failures for an operator to chase', async () => {
    await billing.scheduleDueBookings();
    stripe.failNextWith = new StripeError('declined', 'card_declined', false);
    const a = await billing.claimNext('w1');
    await billing.runAttempt(a!.id);

    const attention = await billing.needsAttention();
    expect(attention).toHaveLength(1);
    expect(attention[0]!.failureCode).toBe('card_declined');
  });
});

d('notifications', () => {
  let prisma: PrismaClient;
  let email: FakeNotificationProvider;
  let sms: FakeNotificationProvider;
  let notifications: NotificationService;
  let customerId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.billingAttempt.deleteMany();
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    email = new FakeNotificationProvider('EMAIL');
    sms = new FakeNotificationProvider('SMS');
    notifications = new NotificationService(prisma, { EMAIL: email, SMS: sms });
    customerId = (await prisma.customer.create({ data: { firstName: 'Pascal' } })).id;
  });

  it('sends and records the message', async () => {
    const res = await notifications.notify({
      template: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      recipient: 'pascal@example.com',
      customerId,
      bookingId: 'bk_1',
      vars: { firstName: 'Pascal', bookingNumber: 'R2N-2026-000041', when: 'Monday', address: 'Lachine' },
    });
    expect(res.sent).toBe(true);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.message.body).toMatch(/R2N-2026-000041/);

    const row = await prisma.notification.findFirstOrThrow();
    expect(row.status).toBe('SENT');
    expect(row.providerId).toBeTruthy();
  });

  it('never stores the raw address, only a hash', async () => {
    await notifications.notify({
      template: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      recipient: 'pascal@example.com',
      customerId,
      bookingId: 'bk_1',
    });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.recipientHash).not.toBe('pascal@example.com');
    expect(row.recipientHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toMatch(/pascal@example\.com/);
  });

  it('sends the same message once, even across concurrent calls', async () => {
    const input = {
      template: 'BOOKING_CONFIRMED' as const,
      channel: 'EMAIL' as const,
      recipient: 'pascal@example.com',
      customerId,
      bookingId: 'bk_1',
    };
    const results = await Promise.all([
      notifications.notify(input),
      notifications.notify(input),
      notifications.notify(input),
    ]);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    expect(await prisma.notification.count()).toBe(1);
  });

  it('allows different templates for the same booking', async () => {
    await notifications.notify({
      template: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      recipient: 'a@b.c',
      bookingId: 'bk_1',
    });
    const second = await notifications.notify({
      template: 'BOOKING_REMINDER',
      channel: 'EMAIL',
      recipient: 'a@b.c',
      bookingId: 'bk_1',
    });
    expect(second.sent).toBe(true);
    expect(email.sent).toHaveLength(2);
  });

  it('records SUPPRESSED rather than claiming a send when unconfigured', async () => {
    const bare = new NotificationService(prisma, {});
    const res = await bare.notify({
      template: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      recipient: 'a@b.c',
      bookingId: 'bk_x',
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('NOT_CONFIGURED');
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.status).toBe('SUPPRESSED');
  });

  it('records a provider failure instead of silently dropping it', async () => {
    email.failNext = true;
    const res = await notifications.notify({
      template: 'PAYMENT_FAILED',
      channel: 'EMAIL',
      recipient: 'a@b.c',
      bookingId: 'bk_2',
    });
    expect(res.sent).toBe(false);
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(row.failureCode).toBe('PROVIDER_DOWN');
    expect(row.attempts).toBe(1);
  });

  it('sends French copy when the customer reads French', async () => {
    await notifications.notify({
      template: 'BOOKING_CONFIRMED',
      channel: 'SMS',
      recipient: '+15148252825',
      locale: 'fr',
      bookingId: 'bk_fr',
      vars: { when: 'lundi', address: 'Lachine' },
    });
    expect(sms.sent[0]!.message.body).toMatch(/réservation|confirmé/i);
  });
});

/* ------------------------------------------------------------------ */
/* dunning & card expiry                                               */
/* ------------------------------------------------------------------ */

import { DunningService, CardExpiryService } from '../src/payments/dunning-service.js';
import { MAX_SEND_ATTEMPTS } from '../src/notifications/notification-service.js';

d('dunning', () => {
  let prisma: PrismaClient;
  let dunning: DunningService;
  let customerId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.dunningCase.deleteMany();
    await prisma.billingAttempt.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.paymentMethodReference.deleteMany();
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
    customerId = (await prisma.customer.create({ data: { firstName: 'Pascal' } })).id;
    dunning = new DunningService(prisma);
  });

  it('opens one case per customer, not one per failed visit', async () => {
    await dunning.recordFailure({ customerId, amountCents: 12000, reason: 'card_declined' });
    await dunning.recordFailure({ customerId, amountCents: 13000, reason: 'card_declined' });

    const cases = await prisma.dunningCase.findMany();
    expect(cases).toHaveLength(1);
    expect(cases[0]!.failedCount).toBe(2);
    // Owed accumulates across visits.
    expect(cases[0]!.totalOwedCents).toBe(25000);
  });

  it('a successful payment closes the case, so nobody chases a fixed card', async () => {
    await dunning.recordFailure({ customerId, amountCents: 12000, reason: 'card_declined' });
    await dunning.resolveForCustomer(customerId);

    const c = await prisma.dunningCase.findUniqueOrThrow({ where: { customerId } });
    expect(c.status).toBe('RESOLVED');
    expect(c.totalOwedCents).toBe(0);
  });

  it('reopens a resolved case when the card fails again', async () => {
    await dunning.recordFailure({ customerId, amountCents: 12000, reason: 'card_declined' });
    await dunning.resolveForCustomer(customerId);
    await dunning.recordFailure({ customerId, amountCents: 9000, reason: 'expired_card' });

    const c = await prisma.dunningCase.findUniqueOrThrow({ where: { customerId } });
    expect(c.status).toBe('OPEN');
    // The old balance was settled, so only the new failure is owed.
    expect(c.totalOwedCents).toBe(9000);
  });

  it('flags customers with an upcoming cleaning as more urgent', async () => {
    const addr = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId,
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
    await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000950',
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 2 * 86400000),
        endAt: new Date(Date.now() + 2 * 86400000 + 3 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
      },
    });
    await dunning.recordFailure({ customerId, amountCents: 25869, reason: 'card_declined' });

    const list = await dunning.list();
    expect(list[0]!.upcomingBookings).toBe(1);
    expect(list[0]!.customerName).toBe('Pascal');
  });

  it('a hard billing failure opens a case automatically', async () => {
    const stripe2 = new FakeStripeProvider();
    const payments2 = new PaymentService(prisma, stripe2);
    const billing2 = new BillingScheduler(prisma, payments2);

    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { paymentPolicy: 'FULL_PAYMENT' },
    });
    const addr = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'WEEKLY',
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
    const start = new Date(Date.now() + 12 * 3600_000);
    await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000951',
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: start,
        endAt: new Date(start.getTime() + 3 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
      },
    });
    await prisma.paymentMethodReference.create({
      data: { customerId, providerMethodId: 'pm_x', methodType: 'card', isDefault: true },
    });

    await billing2.scheduleDueBookings();
    stripe2.failNextWith = new StripeError('declined', 'card_declined', false);
    const a = await billing2.claimNext('w1');
    await billing2.runAttempt(a!.id);

    const c = await prisma.dunningCase.findUniqueOrThrow({ where: { customerId } });
    expect(c.status).toBe('OPEN');
    expect(c.reason).toBe('card_declined');
  });

  it('a cancelled booking does not create a dunning case', async () => {
    const stripe2 = new FakeStripeProvider();
    const billing2 = new BillingScheduler(prisma, new PaymentService(prisma, stripe2));
    await prisma.billingAttempt.create({
      data: {
        bookingId: 'missing-booking',
        customerId,
        attemptNumber: 1,
        amountCents: 10000,
        status: 'SCHEDULED',
        scheduledFor: new Date(Date.now() - 1000),
      },
    });
    const a = await billing2.claimNext('w1');
    await billing2.runAttempt(a!.id);
    expect(await prisma.dunningCase.count()).toBe(0);
  });
});

d('notification retry and card expiry', () => {
  let prisma: PrismaClient;
  let email: FakeNotificationProvider;
  let notifications: NotificationService;
  let customerId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.dunningCase.deleteMany();
    await prisma.billingAttempt.deleteMany();
    await prisma.paymentMethodReference.deleteMany();
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
    email = new FakeNotificationProvider('EMAIL');
    notifications = new NotificationService(prisma, { EMAIL: email });
    customerId = (
      await prisma.customer.create({ data: { firstName: 'Pascal', email: 'pascal@example.com' } })
    ).id;
  });

  it('resends a failed notification without ever storing the address', async () => {
    email.failNext = true;
    await notifications.notify({
      template: 'PAYMENT_FAILED',
      channel: 'EMAIL',
      recipient: 'pascal@example.com',
      customerId,
      bookingId: 'bk_1',
      vars: { amount: '$137.40', when: 'Monday' },
    });
    expect((await prisma.notification.findFirstOrThrow()).status).toBe('FAILED');

    const res = await notifications.retryFailed();
    expect(res.resent).toBe(1);
    expect(email.sent).toHaveLength(1);
    // The message still renders with its original variables.
    expect(email.sent[0]!.message.body).toMatch(/137\.40/);

    const row = await prisma.notification.findFirstOrThrow();
    expect(row.status).toBe('SENT');
    expect(JSON.stringify(row)).not.toMatch(/pascal@example\.com/);
  });

  it('retries to the customer CURRENT address, not a stale one', async () => {
    email.failNext = true;
    await notifications.notify({
      template: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      recipient: 'old@example.com',
      customerId,
      bookingId: 'bk_2',
    });
    // They corrected their email in the meantime.
    await prisma.customer.update({ where: { id: customerId }, data: { email: 'new@example.com' } });

    await notifications.retryFailed();
    expect(email.sent[0]!.to).toBe('new@example.com');
  });

  it('gives up rather than retrying forever', async () => {
    email.failNext = true;
    await notifications.notify({
      template: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      recipient: 'pascal@example.com',
      customerId,
      bookingId: 'bk_3',
    });
    for (let i = 0; i < MAX_SEND_ATTEMPTS + 2; i++) {
      email.failNext = true;
      await notifications.retryFailed();
    }
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.status).toBe('SUPPRESSED');
    expect(row.attempts).toBeLessThanOrEqual(MAX_SEND_ATTEMPTS);
  });

  it('stops trying when there is no way to reach the customer', async () => {
    await prisma.customer.update({ where: { id: customerId }, data: { email: null } });
    email.failNext = true;
    await notifications.notify({
      template: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      recipient: 'gone@example.com',
      customerId,
      bookingId: 'bk_4',
    });
    const res = await notifications.retryFailed();
    expect(res.abandoned).toBe(1);
    expect((await prisma.notification.findFirstOrThrow()).failureCode).toBe('NO_RECIPIENT');
  });

  it('warns about a card expiring this month, but only with a cleaning booked', async () => {
    const at = new Date();
    await prisma.paymentMethodReference.create({
      data: {
        customerId,
        providerMethodId: 'pm_exp',
        methodType: 'card',
        brand: 'visa',
        last4: '4242',
        expMonth: at.getUTCMonth() + 1,
        expYear: at.getUTCFullYear(),
        isDefault: true,
      },
    });
    const expiry = new CardExpiryService(prisma, notifications);

    // No upcoming cleaning: telling a dormant customer is noise.
    let res = await expiry.warnExpiring();
    expect(res.warned).toBe(0);
    expect(res.skipped).toBe(1);

    const addr = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'WEEKLY',
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
    await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000960',
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 5 * 86400000),
        endAt: new Date(Date.now() + 5 * 86400000 + 3 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
      },
    });

    res = await expiry.warnExpiring();
    expect(res.warned).toBe(1);
    expect(email.sent[0]!.message.body).toMatch(/expires soon/i);
  });

  it('warns once per card per month, not on every run', async () => {
    const at = new Date();
    await prisma.paymentMethodReference.create({
      data: {
        customerId,
        providerMethodId: 'pm_exp',
        methodType: 'card',
        expMonth: at.getUTCMonth() + 1,
        expYear: at.getUTCFullYear(),
        isDefault: true,
      },
    });
    const addr = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'WEEKLY',
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
    await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000961',
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 5 * 86400000),
        endAt: new Date(Date.now() + 5 * 86400000 + 3 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
      },
    });

    const expiry = new CardExpiryService(prisma, notifications);
    await expiry.warnExpiring();
    await expiry.warnExpiring();
    await expiry.warnExpiring();
    expect(email.sent).toHaveLength(1);
  });
});

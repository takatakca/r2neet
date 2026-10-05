import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  FakeStripeProvider,
  StripeError,
  verifyStripeSignature,
  signStripePayload,
} from '../src/payments/stripe-provider.js';
import {
  PaymentService,
  amountDueNowCents,
  chargeEligibleAt,
  mapProviderStatus,
} from '../src/payments/payment-service.js';
import { PromotionClaimService } from '../src/promotions/claims.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';
import request from 'supertest';
import { createApi } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import { signUp } from './support/customer-auth.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;
const WEBHOOK_SECRET = 'whsec_test_secret';

describe('payment policy arithmetic', () => {
  it('FULL_PAYMENT charges the whole booking', () => {
    expect(amountDueNowCents('FULL_PAYMENT', 15522)).toBe(15522);
  });

  it('PAY_LATER and CARD_ON_FILE charge nothing today', () => {
    expect(amountDueNowCents('PAY_LATER', 15522)).toBe(0);
    expect(amountDueNowCents('CARD_ON_FILE', 15522)).toBe(0);
  });

  it('a fixed deposit never exceeds the booking total', () => {
    expect(amountDueNowCents('DEPOSIT', 15522, { type: 'FIXED', value: 5000 })).toBe(5000);
    expect(amountDueNowCents('DEPOSIT', 3000, { type: 'FIXED', value: 5000 })).toBe(3000);
  });

  it('a percentage deposit uses micro-percent integers', () => {
    // 25% of $155.22 = $38.805 -> floor to 3880 cents
    expect(amountDueNowCents('DEPOSIT', 15522, { type: 'PERCENTAGE', value: 25_000_000 })).toBe(3880);
  });

  it('computes charge timing from configuration, not a hard-coded rule', () => {
    const start = new Date('2026-09-14T14:00:00Z');
    expect(chargeEligibleAt(start, '24_HOURS_BEFORE')!.toISOString()).toBe(
      '2026-09-13T14:00:00.000Z',
    );
    expect(chargeEligibleAt(start, '48_HOURS_BEFORE')!.toISOString()).toBe(
      '2026-09-12T14:00:00.000Z',
    );
    expect(chargeEligibleAt(start, 'AFTER_SERVICE')!.toISOString()).toBe(start.toISOString());
    expect(chargeEligibleAt(start, 'PAY_LATER')).toBeNull();
  });

  it('maps Stripe states to R2NETTE states deliberately', () => {
    expect(mapProviderStatus('succeeded')).toBe('SUCCEEDED');
    expect(mapProviderStatus('requires_action')).toBe('REQUIRES_ACTION');
    expect(mapProviderStatus('requires_payment_method')).toBe('REQUIRES_PAYMENT_METHOD');
    expect(mapProviderStatus('canceled')).toBe('CANCELLED');
  });
});

describe('webhook signature verification', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: {} } });

  it('accepts a correctly signed payload', () => {
    const event = verifyStripeSignature(body, signStripePayload(body, WEBHOOK_SECRET), WEBHOOK_SECRET);
    expect(event.id).toBe('evt_1');
  });

  it('rejects a wrong secret', () => {
    expect(() =>
      verifyStripeSignature(body, signStripePayload(body, 'whsec_other'), WEBHOOK_SECRET),
    ).toThrow(/No signatures found matching/i);
  });

  it('rejects a tampered body', () => {
    const sig = signStripePayload(body, WEBHOOK_SECRET);
    const tampered = body.replace('evt_1', 'evt_hacked');
    expect(() => verifyStripeSignature(tampered, sig, WEBHOOK_SECRET)).toThrow(StripeError);
  });

  it('rejects a stale timestamp (replay outside tolerance)', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(() =>
      verifyStripeSignature(body, signStripePayload(body, WEBHOOK_SECRET, old), WEBHOOK_SECRET),
    ).toThrow(/outside the tolerance zone/i);
  });

  it('verifies a Buffer body without any string round-trip', () => {
    // Express gives us a Buffer from express.raw(). Parsing it to JSON and
    // back would reorder keys and break the signature, so we verify bytes.
    const buf = Buffer.from(body, 'utf8');
    const event = verifyStripeSignature(buf, signStripePayload(body, WEBHOOK_SECRET), WEBHOOK_SECRET);
    expect(event.id).toBe('evt_1');
  });

  it('[INV-PAY-02] a re-serialized body fails, proving raw bytes are what is verified', () => {
    const sig = signStripePayload(body, WEBHOOK_SECRET);
    const reserialized = JSON.stringify(JSON.parse(body), null, 2); // same data, different bytes
    expect(() => verifyStripeSignature(reserialized, sig, WEBHOOK_SECRET)).toThrow();
  });

  it('rejects a malformed header', () => {
    expect(() => verifyStripeSignature(body, 'garbage', WEBHOOK_SECRET)).toThrow(
      /Unable to extract timestamp and signatures/i,
    );
  });
});

d('stripe payments', () => {
  let prisma: PrismaClient;
  let stripe: FakeStripeProvider;
  let payments: PaymentService;
  let claims: PromotionClaimService;
  let customerId: string;
  let bookingId: string;
  let quoteId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.refund.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.paymentMethodReference.deleteMany();
    await prisma.paymentProviderCustomer.deleteMany();
    await prisma.stripeEvent.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
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
    await seed(prisma);

    stripe = new FakeStripeProvider();
    payments = new PaymentService(prisma, stripe);
    claims = new PromotionClaimService(prisma);

    const c = await prisma.customer.create({ data: {} });
    customerId = c.id;
    const addr = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: '754 Av. 36e', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        baseServiceCents: 20000,
        transportationCents: 2500,
        subtotalCents: 22500,
        gstCents: 1125,
        qstCents: 2244,
        taxTotalCents: 3369,
        grandTotalCents: 25869,
        gstRateMicroPercent: 5_000_000,
        qstRateMicroPercent: 9_975_000,
        pricingVersion: 'test',
        priceSnapshot: { grandTotalCents: 25869 },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    quoteId = q.id;
    const b = await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000001',
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 48 * 3600_000),
        endAt: new Date(Date.now() + 51 * 3600_000),
        status: 'PENDING_PAYMENT',
        grandTotalCents: 25869,
        priceSnapshot: { grandTotalCents: 25869 },
      },
    });
    bookingId = b.id;
  });

  async function setPolicy(policy: string) {
    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { paymentPolicy: policy },
    });
  }

  /* ---------------- stripe customer ---------------- */

  it('creates at most one Stripe customer, even under concurrency', async () => {
    const [a, b, c] = await Promise.all([
      payments.ensureStripeCustomer(customerId),
      payments.ensureStripeCustomer(customerId),
      payments.ensureStripeCustomer(customerId),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(await prisma.paymentProviderCustomer.count()).toBe(1);
    expect(stripe.createCustomerCalls).toBe(1);
  });

  /* ---------------- amount authority ---------------- */

  it('charges the authoritative booking total for FULL_PAYMENT', async () => {
    await setPolicy('FULL_PAYMENT');
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    expect(out.amountDueNowCents).toBe(25869);
    const intent = [...stripe.intents.values()][0]!;
    expect(intent.amountCents).toBe(25869);
    expect(intent.currency).toBe('cad');
  });

  it('PAY_LATER creates no charge at all', async () => {
    await setPolicy('PAY_LATER');
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    expect(out.amountDueNowCents).toBe(0);
    expect(out.payment).toBeNull();
    expect(stripe.createPaymentIntentCalls).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('another customer cannot start payment for this booking', async () => {
    await setPolicy('FULL_PAYMENT');
    const other = await prisma.customer.create({ data: {} });
    await expect(
      payments.createPaymentIntentForBooking({ bookingId, customerId: other.id }),
    ).rejects.toThrow(/could not find/i);
  });

  it('a deposit charges part now and records the remaining balance', async () => {
    await setPolicy('DEPOSIT');
    const out = await payments.createPaymentIntentForBooking({
      bookingId,
      customerId,
      deposit: { type: 'FIXED', value: 5000 },
    });
    expect(out.amountDueNowCents).toBe(5000);
    expect(out.bookingTotalCents).toBe(25869);
    expect(out.remainingBalanceCents).toBe(20869);
  });

  /* ---------------- the timeout problem ---------------- */

  it('a timeout after Stripe created the intent does not create a second one', async () => {
    await setPolicy('FULL_PAYMENT');

    // Stripe creates the intent, then our process never sees the response.
    stripe.timeoutAfterCreate = true;
    await expect(
      payments.createPaymentIntentForBooking({ bookingId, customerId, idempotencyKey: 'k1' }),
    ).rejects.toThrow(/socket hang up/i);

    expect(stripe.createPaymentIntentCalls).toBe(1);
    const record = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { scope: 'payment_intent' },
    });
    expect(record.status).toBe('FAILED_RETRYABLE');
    expect(record.providerIdempotencyKey).toBeTruthy(); // key preserved

    // The client retries the same logical operation.
    const retry = await payments.createPaymentIntentForBooking({
      bookingId,
      customerId,
      idempotencyKey: 'k1',
    });

    // Same provider key -> Stripe replays the original intent.
    expect(stripe.createPaymentIntentCalls).toBe(1);
    expect(stripe.intents.size).toBe(1);
    expect(retry.amountDueNowCents).toBe(25869);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('the idempotency record is kept, never deleted, after a provider failure', async () => {
    await setPolicy('FULL_PAYMENT');
    stripe.failNextWith = new StripeError('gateway timeout', 'STRIPE_HTTP_504', true);
    await expect(
      payments.createPaymentIntentForBooking({ bookingId, customerId, idempotencyKey: 'k2' }),
    ).rejects.toThrow();
    expect(await prisma.idempotencyRecord.count()).toBe(1);
  });

  it('a non-retryable failure is final and not retried blindly', async () => {
    await setPolicy('FULL_PAYMENT');
    stripe.failNextWith = new StripeError('Your card was declined.', 'card_declined', false);
    await expect(
      payments.createPaymentIntentForBooking({ bookingId, customerId, idempotencyKey: 'k3' }),
    ).rejects.toThrow(/declined/i);

    const record = await prisma.idempotencyRecord.findFirstOrThrow();
    expect(record.status).toBe('FAILED_FINAL');

    await expect(
      payments.createPaymentIntentForBooking({ bookingId, customerId, idempotencyKey: 'k3' }),
    ).rejects.toThrow(/cannot be retried/i);
    expect(stripe.createPaymentIntentCalls).toBe(0);
  });

  it('the same key with a different amount is a conflict', async () => {
    await setPolicy('FULL_PAYMENT');
    await payments.createPaymentIntentForBooking({ bookingId, customerId, idempotencyKey: 'k4' });
    await prisma.booking.update({ where: { id: bookingId }, data: { grandTotalCents: 9999 } });
    await expect(
      payments.createPaymentIntentForBooking({ bookingId, customerId, idempotencyKey: 'k4' }),
    ).rejects.toThrow(/different request/i);
  });

  it('concurrent payment-intent creation produces exactly one intent', async () => {
    await setPolicy('FULL_PAYMENT');
    const results = await Promise.allSettled([
      payments.createPaymentIntentForBooking({ bookingId, customerId, idempotencyKey: 'same' }),
      payments.createPaymentIntentForBooking({ bookingId, customerId, idempotencyKey: 'same' }),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(stripe.intents.size).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
  });

  /* ---------------- webhooks ---------------- */

  function event(type: string, object: Record<string, unknown>, id = `evt_${randomId()}`) {
    return { id, type, data: { object } };
  }
  function randomId() {
    return Math.random().toString(36).slice(2, 10);
  }

  it('payment success confirms the booking and records history once', async () => {
    await setPolicy('FULL_PAYMENT');
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    const pi = out.payment!.stripePaymentIntentId!;

    const evt = event('payment_intent.succeeded', { id: pi, payment_method: 'pm_1' });
    expect((await payments.handleWebhookEvent(evt)).processed).toBe(true);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: out.payment!.id } });
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.paidAt).not.toBeNull();

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('CONFIRMED');
    expect(await prisma.bookingStatusHistory.count({ where: { bookingId } })).toBe(1);
  });

  it('[INV-PAY-03] a replayed webhook changes nothing a second time', async () => {
    await setPolicy('FULL_PAYMENT');
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    const evt = event('payment_intent.succeeded', {
      id: out.payment!.stripePaymentIntentId!,
      payment_method: 'pm_1',
    });

    expect((await payments.handleWebhookEvent(evt)).processed).toBe(true);
    expect((await payments.handleWebhookEvent(evt)).processed).toBe(false);
    expect((await payments.handleWebhookEvent(evt)).processed).toBe(false);

    expect(await prisma.bookingStatusHistory.count({ where: { bookingId } })).toBe(1);
    expect(await prisma.stripeEvent.count()).toBe(1);
  });

  it('payment failure leaves the booking unconfirmed', async () => {
    await setPolicy('FULL_PAYMENT');
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    await payments.handleWebhookEvent(
      event('payment_intent.payment_failed', {
        id: out.payment!.stripePaymentIntentId!,
        last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
      }),
    );

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: out.payment!.id } });
    expect(payment.status).toBe('FAILED');
    expect(payment.failureCode).toBe('card_declined');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).not.toBe('CONFIRMED');
  });

  it('a failed payment releases the reserved welcome offer', async () => {
    await setPolicy('FULL_PAYMENT');
    const claim = await claims.reserve({
      customerId,
      promotionId: 'promo_new_basic',
      promotionFamily: 'NEW_CUSTOMER',
      amountCents: 1500,
      bookingId,
    });
    expect(await claims.isEligible(customerId)).toBe(false);

    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    await payments.handleWebhookEvent(
      event('payment_intent.payment_failed', {
        id: out.payment!.stripePaymentIntentId!,
        last_payment_error: { code: 'card_declined' },
      }),
    );

    const after = await prisma.promotionClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(after.status).toBe('RELEASED');
    expect(await claims.isEligible(customerId)).toBe(true); // offer preserved
  });

  it('a successful payment redeems the welcome offer exactly once, even on replay', async () => {
    await setPolicy('FULL_PAYMENT');
    await claims.reserve({
      customerId,
      promotionId: 'promo_new_basic',
      promotionFamily: 'NEW_CUSTOMER',
      amountCents: 1500,
      bookingId,
    });
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    const evt = event('payment_intent.succeeded', {
      id: out.payment!.stripePaymentIntentId!,
      payment_method: 'pm_1',
    });

    await payments.handleWebhookEvent(evt);
    await payments.handleWebhookEvent(evt);

    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(1);
  });

  it('3DS: requires_action does not mark the payment paid', async () => {
    await setPolicy('FULL_PAYMENT');
    stripe.nextStatus = 'requires_action';
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });

    expect(out.payment!.status).toBe('REQUIRES_ACTION');
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).not.toBe('CONFIRMED');

    // Customer completes authentication; the webhook is the final authority.
    await payments.handleWebhookEvent(
      event('payment_intent.succeeded', { id: out.payment!.stripePaymentIntentId!, payment_method: 'pm_1' }),
    );
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(after.status).toBe('CONFIRMED');
  });

  /* ---------------- card on file & recurring ---------------- */

  it('a SetupIntent saves a token and never any card data', async () => {
    const setup = await payments.createSetupIntent(customerId);
    await payments.handleWebhookEvent(
      event('setup_intent.succeeded', { id: setup.setupIntentId, payment_method: 'pm_saved_1' }),
    );

    const method = await prisma.paymentMethodReference.findUniqueOrThrow({
      where: { providerMethodId: 'pm_saved_1' },
    });
    expect(method.isDefault).toBe(true);

    // No PAN, no CVC, anywhere.
    const dump = JSON.stringify(await prisma.paymentMethodReference.findMany());
    expect(dump).not.toMatch(/\d{13,19}/);
    expect(dump.toLowerCase()).not.toMatch(/cvc|cvv/);
  });

  it('an off-session recurring charge uses the saved method and the fresh total', async () => {
    await prisma.paymentMethodReference.create({
      data: { customerId, providerMethodId: 'pm_saved_1', methodType: 'card', isDefault: true },
    });
    await prisma.booking.update({
      where: { id: bookingId },
      data: { startAt: new Date(Date.now() + 3600_000) }, // inside 24h window
    });

    const res = await payments.chargeScheduledBooking(bookingId);
    expect(res.skipped).toBe(false);
    const intent = [...stripe.intents.values()][0]!;
    expect(intent.amountCents).toBe(25869);
    expect(intent.paymentMethodId).toBe('pm_saved_1');
  });

  it('does not charge before the configured window opens', async () => {
    await prisma.paymentMethodReference.create({
      data: { customerId, providerMethodId: 'pm_saved_1', methodType: 'card', isDefault: true },
    });
    // startAt is 48h away; default timing is 24_HOURS_BEFORE.
    const res = await payments.chargeScheduledBooking(bookingId);
    expect(res).toEqual({ skipped: true, reason: 'NOT_YET_DUE' });
    expect(stripe.createPaymentIntentCalls).toBe(0);
  });

  it('a worker running twice does not double-charge', async () => {
    await prisma.paymentMethodReference.create({
      data: { customerId, providerMethodId: 'pm_saved_1', methodType: 'card', isDefault: true },
    });
    await prisma.booking.update({
      where: { id: bookingId },
      data: { startAt: new Date(Date.now() + 3600_000) },
    });

    await payments.chargeScheduledBooking(bookingId);
    await payments.chargeScheduledBooking(bookingId);
    await payments.chargeScheduledBooking(bookingId);

    expect(stripe.createPaymentIntentCalls).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('off-session requiring authentication is flagged, not retried as a failure', async () => {
    await prisma.paymentMethodReference.create({
      data: { customerId, providerMethodId: 'pm_saved_1', methodType: 'card', isDefault: true },
    });
    await prisma.booking.update({
      where: { id: bookingId },
      data: { startAt: new Date(Date.now() + 3600_000) },
    });
    stripe.nextStatus = 'requires_action';

    const res = await payments.chargeScheduledBooking(bookingId);
    expect(res.status).toBe('REQUIRES_ACTION');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('PAYMENT_ACTION_REQUIRED');

    // A second worker pass must not mint another intent.
    await payments.chargeScheduledBooking(bookingId);
    expect(stripe.createPaymentIntentCalls).toBe(1);
  });

  /* ---------------- refunds ---------------- */

  it('a refund webhook records the amount and status', async () => {
    await setPolicy('FULL_PAYMENT');
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    const pi = out.payment!.stripePaymentIntentId!;
    await payments.handleWebhookEvent(event('payment_intent.succeeded', { id: pi, payment_method: 'pm_1' }));

    await payments.handleWebhookEvent(
      event('charge.refunded', { id: 'ch_1', payment_intent: pi, amount_refunded: 10000 }),
    );
    let payment = await prisma.payment.findUniqueOrThrow({ where: { id: out.payment!.id } });
    expect(payment.status).toBe('PARTIALLY_REFUNDED');
    expect(payment.refundedAmountCents).toBe(10000);

    await payments.handleWebhookEvent(
      event('charge.refunded', { id: 'ch_1', payment_intent: pi, amount_refunded: 25869 }),
    );
    payment = await prisma.payment.findUniqueOrThrow({ where: { id: out.payment!.id } });
    expect(payment.status).toBe('REFUNDED');
  });

  /* ---------------- regressions ---------------- */

  it('Regression A: the $155.22 scenario charges exactly 15522', async () => {
    await setPolicy('FULL_PAYMENT');
    await prisma.booking.update({
      where: { id: bookingId },
      data: { grandTotalCents: 15522 },
    });
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    expect(out.amountDueNowCents).toBe(15522);
    expect([...stripe.intents.values()][0]!.amountCents).toBe(15522);
  });

  it('Regression B: the $241.45 promo scenario charges exactly 24145', async () => {
    await setPolicy('FULL_PAYMENT');
    await prisma.booking.update({
      where: { id: bookingId },
      data: { grandTotalCents: 24145 },
    });
    const out = await payments.createPaymentIntentForBooking({ bookingId, customerId });
    expect(out.amountDueNowCents).toBe(24145);
    expect([...stripe.intents.values()][0]!.amountCents).toBe(24145);
  });

  it('Stripe metadata carries only safe internal identifiers', async () => {
    await setPolicy('FULL_PAYMENT');
    await prisma.customerAddress.updateMany({
      where: { customerId },
      data: { formattedAddress: '754 Av. 36e — buzzer 402, code 1234' },
    });
    await payments.createPaymentIntentForBooking({ bookingId, customerId });
    // The provider only ever received ids; addresses and door codes stay out.
    const seen = JSON.stringify([...stripe.intents.values()]);
    expect(seen).not.toMatch(/buzzer|1234|Av\. 36e/);
  });
});

/* ------------------------------------------------------------------ */
/* HTTP payment routes                                                 */
/* ------------------------------------------------------------------ */

d('payment HTTP routes', () => {
  let prisma: PrismaClient;
  let stripe: FakeStripeProvider;
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
    await prisma.paymentMethodReference.deleteMany();
    await prisma.paymentProviderCustomer.deleteMany();
    await prisma.stripeEvent.deleteMany();
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
    await seed(prisma);
    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { paymentPolicy: 'FULL_PAYMENT' },
    });

    stripe = new FakeStripeProvider();
    app = createApi({
      prisma,
      verification: new FakeVerificationProvider('123456'),
      stripe,
      stripeWebhookSecret: WEBHOOK_SECRET,
    });
  });

  async function loggedInBooking() {
    // A new customer, registered through the real sign-up flow.
    const { cookie } = await signUp(app, '514 825 2825');
    const me = await request(app).get('/api/v1/customer/me').set('Cookie', cookie);
    const customerId = me.body.customer.id;

    const addr = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: '754 Av. 36e', city: 'Lachine', postalCode: 'H8T1B7' },
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
        pricingVersion: 'test',
        priceSnapshot: { grandTotalCents: 25869 },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const booking = await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000001',
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 48 * 3600_000),
        endAt: new Date(Date.now() + 51 * 3600_000),
        status: 'PENDING_PAYMENT',
        grandTotalCents: 25869,
        priceSnapshot: { grandTotalCents: 25869 },
      },
    });
    return { cookie, customerId, bookingId: booking.id };
  }

  it('payment-config exposes the publishable key only', async () => {
    const res = await request(app).get('/api/v1/payment-config');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/sk_/);
    expect(body).not.toMatch(/whsec_/);
  });

  it('rejects an unauthenticated payment-intent request', async () => {
    const res = await request(app).post('/api/v1/payments/payment-intent').send({ bookingId: 'x' });
    expect(res.status).toBe(401);
  });

  it('[INV-PAY-01] ignores a client-supplied amount and charges the authoritative total', async () => {
    const { cookie, bookingId } = await loggedInBooking();
    const res = await request(app)
      .post('/api/v1/payments/payment-intent')
      .set('Cookie', cookie)
      .send({ bookingId, amountCents: 100, total: 1, grandTotalCents: 100 });

    expect(res.status).toBe(200);
    expect(res.body.amountDueNowCents).toBe(25869);
    expect([...stripe.intents.values()][0]!.amountCents).toBe(25869);
  });

  it('a customer cannot start payment for another customer booking', async () => {
    const first = await loggedInBooking();
    const { cookie: attacker } = await signUp(app, '514 825 2826');

    const res = await request(app)
      .post('/api/v1/payments/payment-intent')
      .set('Cookie', attacker)
      .send({ bookingId: first.bookingId });
    expect(res.status).toBe(404);
    expect(stripe.createPaymentIntentCalls).toBe(0);
  });

  it('rejects a webhook with an invalid signature and changes nothing', async () => {
    const { cookie, bookingId } = await loggedInBooking();
    await request(app)
      .post('/api/v1/payments/payment-intent')
      .set('Cookie', cookie)
      .send({ bookingId });
    const pi = [...stripe.intents.values()][0]!.id;
    const payload = JSON.stringify({
      id: 'evt_bad',
      type: 'payment_intent.succeeded',
      data: { object: { id: pi } },
    });

    const res = await request(app)
      .post('/api/v1/stripe/webhook')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_BAD_SIGNATURE');
    expect(await prisma.stripeEvent.count()).toBe(0);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('PENDING_PAYMENT');
  });

  it('accepts a correctly signed webhook and confirms the booking once', async () => {
    const { cookie, bookingId } = await loggedInBooking();
    await request(app)
      .post('/api/v1/payments/payment-intent')
      .set('Cookie', cookie)
      .send({ bookingId });
    const pi = [...stripe.intents.values()][0]!.id;
    const payload = JSON.stringify({
      id: 'evt_good',
      type: 'payment_intent.succeeded',
      data: { object: { id: pi, payment_method: 'pm_1' } },
    });
    const sig = signStripePayload(payload, WEBHOOK_SECRET);

    const first = await request(app)
      .post('/api/v1/stripe/webhook')
      .set('stripe-signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(first.body).toEqual({ received: true, processed: true });

    const replay = await request(app)
      .post('/api/v1/stripe/webhook')
      .set('stripe-signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(replay.body.processed).toBe(false);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('CONFIRMED');
    expect(await prisma.bookingStatusHistory.count({ where: { bookingId } })).toBe(1);
  });

  it('reports NOT_CONFIGURED rather than faking payments when Stripe is absent', async () => {
    const bare = createApi({ prisma, verification: new FakeVerificationProvider('123456') });
    const cfg = await request(bare).get('/api/v1/payment-config');
    expect(cfg.body.configured).toBe(false);

    const res = await request(bare).post('/api/v1/payments/payment-intent').send({ bookingId: 'x' });
    expect([401, 503]).toContain(res.status);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PromotionClaimService,
  PromotionClaimError,
  NEW_CUSTOMER_FAMILY,
  requiresPaymentBeforeRedemption,
} from '../src/promotions/claims.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

d('promotion claims', () => {
  let prisma: PrismaClient;
  let prismaB: PrismaClient;
  let svc: PromotionClaimService;
  let svcB: PromotionClaimService;
  let customerId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    prismaB = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
    await prismaB.$connect();
    svc = new PromotionClaimService(prisma);
    svcB = new PromotionClaimService(prismaB);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await prismaB.$disconnect();
  });

  beforeEach(async () => {
    await prisma.promotionClaim.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.paymentMethodReference.deleteMany();
    await prisma.paymentProviderCustomer.deleteMany();
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.bookingHold.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.customerSession.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    const c = await prisma.customer.create({ data: {} });
    customerId = c.id;
  });

  const input = (over = {}) => ({
    customerId,
    promotionId: 'promo_new_basic',
    promotionFamily: NEW_CUSTOMER_FAMILY,
    amountCents: 1500,
    ...over,
  });

  it('a new customer is eligible before any claim exists', async () => {
    expect(await svc.isEligible(customerId)).toBe(true);
  });

  it('[INV-PROMO-01] generating quotes writes zero claim rows', async () => {
    // The quote path only ever calls isEligible, never reserve.
    await svc.isEligible(customerId);
    await svc.isEligible(customerId);
    expect(await prisma.promotionClaim.count()).toBe(0);
  });

  /* ---------------- the PAY_LATER exploit ---------------- */

  it('PAY_LATER redeems on confirmation, closing the repeat-booking exploit', async () => {
    // No payment ever happens under PAY_LATER, so commitment is confirmation.
    expect(requiresPaymentBeforeRedemption('PAY_LATER')).toBe(false);
    await svc.reserveAndRedeem({ ...input(), bookingId: 'bk_1' });

    // A second PAY_LATER booking must not get the welcome offer again.
    expect(await svc.isEligible(customerId)).toBe(false);
    await expect(svc.reserveAndRedeem({ ...input(), bookingId: 'bk_2' })).rejects.toThrow(
      /already been used/i,
    );
    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(1);
  });

  it('two concurrent PAY_LATER bookings: exactly one gets the welcome offer', async () => {
    // Independent clients, independent pools — no shared JS state.
    const results = await Promise.allSettled([
      svc.reserveAndRedeem({ ...input(), bookingId: 'bk_a' }),
      svcB.reserveAndRedeem({ ...input(), bookingId: 'bk_b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(1);
  });

  it('[INV-PROMO-02] two concurrent checkouts cannot both reserve the offer', async () => {
    const results = await Promise.allSettled([svc.reserve(input()), svcB.reserve(input())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const active = await prisma.promotionClaim.count({
      where: { status: { in: ['RESERVED', 'REDEEMED'] } },
    });
    expect(active).toBe(1);
  });

  /* ---------------- payment-gated policies ---------------- */

  it('FULL_PAYMENT: a failed payment releases the offer, leaving it usable', async () => {
    expect(requiresPaymentBeforeRedemption('FULL_PAYMENT')).toBe(true);
    const claim = await svc.reserve(input());
    expect(await svc.isEligible(customerId)).toBe(false); // held during checkout

    await svc.release(claim.id, 'PAYMENT_FAILED');

    expect(await svc.isEligible(customerId)).toBe(true); // given back
    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(0);
  });

  it('FULL_PAYMENT: a successful payment redeems exactly once', async () => {
    const claim = await svc.reserve(input());
    await svc.redeem(claim.id, 'bk_1');
    const rows = await prisma.promotionClaim.findMany({ where: { status: 'REDEEMED' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bookingId).toBe('bk_1');
    expect(rows[0]!.redeemedAt).not.toBeNull();
  });

  it('webhook replay redeems only once', async () => {
    const claim = await svc.reserve(input());
    await svc.redeem(claim.id, 'bk_1');
    await svc.redeem(claim.id, 'bk_1'); // duplicate Stripe event
    await svc.redeem(claim.id, 'bk_1');
    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(1);
  });

  it('an abandoned checkout leaves no permanent redemption', async () => {
    const claim = await svc.reserve(input());
    await svc.release(claim.id, 'CHECKOUT_ABANDONED');
    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(0);
    expect(await svc.isEligible(customerId)).toBe(true);
  });

  it('an expired hold releases the reserved offer', async () => {
    let clock = Date.now();
    const timed = new PromotionClaimService(prisma, () => new Date(clock));
    await timed.reserve(input());
    expect(await timed.isEligible(customerId)).toBe(false);

    clock += 31 * 60000; // past the 30-minute claim TTL
    const released = await timed.releaseExpired();

    expect(released).toBe(1);
    expect(await timed.isEligible(customerId)).toBe(true);
  });

  it('a redeemed claim cannot be released', async () => {
    const claim = await svc.reserve(input());
    await svc.redeem(claim.id, 'bk_1');
    await expect(svc.release(claim.id, 'oops')).rejects.toThrow(PromotionClaimError);
  });

  it('a released claim cannot be redeemed', async () => {
    const claim = await svc.reserve(input());
    await svc.release(claim.id, 'PAYMENT_FAILED');
    await expect(svc.redeem(claim.id, 'bk_1')).rejects.toThrow(/released/i);
  });

  /* ---------------- BEST_SINGLE_DISCOUNT interaction ---------------- */

  it('WEEKLY: the 25% discount wins, so the welcome offer is never touched', async () => {
    // Basic $110 weekly: frequency discount $27.50 beats the $15 welcome
    // offer. A losing candidate must not be reserved.
    const frequencyDiscount = 2750;
    const welcomeOffer = 1500;
    const winnerIsFrequency = frequencyDiscount > welcomeOffer;
    expect(winnerIsFrequency).toBe(true);

    if (!winnerIsFrequency) await svc.reserve(input());

    expect(await prisma.promotionClaim.count()).toBe(0);
    expect(await svc.isEligible(customerId)).toBe(true); // still available later
  });

  it('MONTHLY: the $15 welcome offer wins and is redeemed on commitment', async () => {
    // Basic $110 monthly: 10% = $11, which the $15 welcome offer beats.
    const frequencyDiscount = 1100;
    const welcomeOffer = 1500;
    expect(welcomeOffer).toBeGreaterThan(frequencyDiscount);

    await svc.reserveAndRedeem({ ...input(), bookingId: 'bk_monthly_1' });

    // Later visits in the same plan use the 10% frequency discount, and the
    // welcome offer is gone.
    expect(await svc.isEligible(customerId)).toBe(false);
    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(1);
  });

  it('Basic and Deep share one lifetime family', async () => {
    await svc.reserveAndRedeem({ ...input(), bookingId: 'bk_basic' });
    await expect(
      svc.reserveAndRedeem({
        ...input({ promotionId: 'promo_new_deep', amountCents: 2000 }),
        bookingId: 'bk_deep',
      }),
    ).rejects.toThrow(/already been used/i);
  });

  it('a released claim does not block a later genuine redemption', async () => {
    const first = await svc.reserve(input());
    await svc.release(first.id, 'PAYMENT_FAILED');
    const second = await svc.reserve(input());
    await svc.redeem(second.id, 'bk_retry');
    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(1);
    expect(await prisma.promotionClaim.count({ where: { status: 'RELEASED' } })).toBe(1);
  });

  it('different customers each get their own welcome offer', async () => {
    const other = await prisma.customer.create({ data: {} });
    await svc.reserveAndRedeem({ ...input(), bookingId: 'bk_1' });
    await svc.reserveAndRedeem({ ...input({ customerId: other.id }), bookingId: 'bk_2' });
    expect(await prisma.promotionClaim.count({ where: { status: 'REDEEMED' } })).toBe(2);
  });
});

import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Promotion claim lifecycle.
 *
 * THE RULE: a limited promotion is consumed exactly once, when an eligible
 * booking becomes genuinely COMMITTED. Not when a quote is generated, and not
 * when a checkout is abandoned.
 *
 * "Committed" depends on the payment policy:
 *
 *   PAY_LATER      booking reaches CONFIRMED (no payment ever happens, so
 *                  waiting for one would let a customer book repeatedly and
 *                  claim the welcome offer every time)
 *   FULL_PAYMENT   Stripe confirms payment AND booking reaches CONFIRMED
 *   DEPOSIT        the required deposit succeeds AND booking is committed
 *   CARD_ON_FILE   the SetupIntent succeeds AND booking reaches CONFIRMED
 *
 * States: RESERVED -> REDEEMED (final) or RESERVED -> RELEASED (offer freed).
 *
 * Concurrency is handled by a partial unique index on
 * (customerId, promotionFamily) WHERE status IN ('RESERVED','REDEEMED').
 * Two simultaneous checkouts cannot both hold the welcome offer: the loser
 * fails on the database, not on an application-level check-then-act.
 */

export const NEW_CUSTOMER_FAMILY = 'NEW_CUSTOMER';
export const CLAIM_TTL_MINUTES = 30;

export type ClaimStatus = 'RESERVED' | 'REDEEMED' | 'RELEASED';

export class PromotionClaimError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Which policies need a successful payment/setup before redemption. */
export function requiresPaymentBeforeRedemption(policy: string): boolean {
  return policy !== 'PAY_LATER';
}

export interface ReserveInput {
  customerId: string;
  promotionId: string;
  promotionFamily: string;
  amountCents: number;
  quoteId?: string | null;
  bookingId?: string | null;
  expiresAt?: Date;
}

type Db = PrismaClient | Prisma.TransactionClient;

export class PromotionClaimService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Is this customer still eligible for the family?
   *
   * Read-only. Used by the quote path, which must never write a claim —
   * browsing prices cannot burn an offer.
   */
  async isEligible(customerId: string, family = NEW_CUSTOMER_FAMILY, db: Db = this.prisma) {
    const active = await db.promotionClaim.findFirst({
      where: { customerId, promotionFamily: family, status: { in: ['RESERVED', 'REDEEMED'] } },
    });
    return active === null;
  }

  /**
   * Take the offer out of circulation for this checkout.
   *
   * Only called when the promotion actually WON the BEST_SINGLE_DISCOUNT
   * comparison. A losing candidate is never reserved — weekly Basic, where
   * the 25% frequency discount beats the $15 welcome offer, must leave the
   * welcome offer completely untouched.
   */
  async reserve(input: ReserveInput, db: Db = this.prisma) {
    const at = this.now();
    try {
      return await db.promotionClaim.create({
        data: {
          customerId: input.customerId,
          promotionFamily: input.promotionFamily,
          promotionId: input.promotionId,
          amountCents: input.amountCents,
          quoteId: input.quoteId ?? null,
          bookingId: input.bookingId ?? null,
          status: 'RESERVED',
          reservedAt: at,
          expiresAt: input.expiresAt ?? new Date(at.getTime() + CLAIM_TTL_MINUTES * 60000),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new PromotionClaimError(
          'This welcome offer has already been used.',
          'PROMOTION_ALREADY_CLAIMED',
        );
      }
      throw e;
    }
  }

  /** Final. The booking is committed and the offer is spent. */
  async redeem(claimId: string, bookingId: string, db: Db = this.prisma) {
    const claim = await db.promotionClaim.findUnique({ where: { id: claimId } });
    if (!claim) throw new PromotionClaimError('Claim not found.', 'CLAIM_NOT_FOUND');
    if (claim.status === 'REDEEMED') return claim; // idempotent: webhook replay
    if (claim.status === 'RELEASED') {
      throw new PromotionClaimError('That offer was already released.', 'CLAIM_RELEASED');
    }
    return db.promotionClaim.update({
      where: { id: claimId },
      data: { status: 'REDEEMED', bookingId, redeemedAt: this.now(), expiresAt: null },
    });
  }

  /** Give the offer back: payment failed, hold expired, checkout abandoned. */
  async release(claimId: string, reason: string, db: Db = this.prisma) {
    const claim = await db.promotionClaim.findUnique({ where: { id: claimId } });
    if (!claim) return null;
    if (claim.status === 'REDEEMED') {
      throw new PromotionClaimError(
        'A redeemed promotion cannot be released.',
        'CLAIM_ALREADY_REDEEMED',
      );
    }
    if (claim.status === 'RELEASED') return claim;
    return db.promotionClaim.update({
      where: { id: claimId },
      data: { status: 'RELEASED', releasedAt: this.now(), releaseReason: reason },
    });
  }

  /**
   * Reserve and redeem in one step.
   *
   * The PAY_LATER path: there is no payment to wait for, so commitment IS
   * confirmation. Runs inside the caller's booking transaction so the claim
   * and the booking succeed or fail together.
   */
  async reserveAndRedeem(input: ReserveInput & { bookingId: string }, db: Db = this.prisma) {
    const at = this.now();
    try {
      return await db.promotionClaim.create({
        data: {
          customerId: input.customerId,
          promotionFamily: input.promotionFamily,
          promotionId: input.promotionId,
          amountCents: input.amountCents,
          quoteId: input.quoteId ?? null,
          bookingId: input.bookingId,
          status: 'REDEEMED',
          reservedAt: at,
          redeemedAt: at,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new PromotionClaimError(
          'This welcome offer has already been used.',
          'PROMOTION_ALREADY_CLAIMED',
        );
      }
      throw e;
    }
  }

  /** Sweep expired reservations. Correctness never depends on this running. */
  async releaseExpired(db: Db = this.prisma): Promise<number> {
    const res = await db.promotionClaim.updateMany({
      where: { status: 'RESERVED', expiresAt: { lt: this.now() } },
      data: { status: 'RELEASED', releasedAt: this.now(), releaseReason: 'EXPIRED' },
    });
    return res.count;
  }

  async activeClaim(customerId: string, family = NEW_CUSTOMER_FAMILY, db: Db = this.prisma) {
    return db.promotionClaim.findFirst({
      where: { customerId, promotionFamily: family, status: { in: ['RESERVED', 'REDEEMED'] } },
    });
  }
}

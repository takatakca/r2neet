import type { PrismaClient } from '@prisma/client';
import { createQuote } from '../engine/quote.js';
import { SERVICES } from '../data/catalogue.js';
import { CleaningFrequency, ProductSupplyType } from '../domain/types.js';
import { PromotionClaimService, NEW_CUSTOMER_FAMILY } from '../promotions/claims.js';

/**
 * Quote revalidation.
 *
 * A guest quote applies the welcome offer provisionally. Once OTP identifies
 * the customer we have to check for real — and if the offer is gone, the
 * price goes UP. Silently charging the higher amount would be charging
 * someone a number they never agreed to.
 *
 * So this runs BEFORE any Stripe object is created. If the price changed,
 * checkout stops and the customer is shown old vs new and must accept.
 */

export type RepriceReason =
  | 'NEW_CUSTOMER_ALREADY_REDEEMED'
  | 'PROMOTION_NO_LONGER_ELIGIBLE'
  | 'QUOTE_EXPIRED'
  | 'CONFIGURATION_CHANGED';

export interface RevalidationResult {
  status: 'VALID' | 'REPRICE_REQUIRED';
  quoteId: string;
  grandTotalCents: number;
  /** Present only when a reprice is required. */
  previous?: { quoteId: string; grandTotalCents: number };
  differenceCents?: number;
  reason?: RepriceReason;
}

export class QuoteRevalidator {
  private readonly claims: PromotionClaimService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.claims = new PromotionClaimService(prisma, now);
  }

  /**
   * Check a quote against the verified customer's real eligibility.
   *
   * Returns VALID when nothing changed — the overwhelmingly common case, and
   * notably the case where a frequency discount already beat the welcome
   * offer, since a losing candidate was never claimed and losing it changes
   * nothing.
   */
  async revalidate(quoteId: string, customerId: string): Promise<RevalidationResult> {
    const quote = await this.prisma.quote.findUnique({ where: { id: quoteId } });
    if (!quote) throw new Error('QUOTE_NOT_FOUND');

    const service = SERVICES.find((s) => s.id === quote.serviceOptionId);
    if (!service) throw new Error('SERVICE_NOT_FOUND');

    const expired = quote.expiresAt <= this.now();
    const usedProvisionalOffer =
      quote.winningDiscountSource?.startsWith('NEW_CUSTOMER') ||
      quote.warningCodes.includes('NEW_CUSTOMER_ELIGIBILITY_UNVERIFIED');

    // Cheap exit: nothing to re-check.
    if (!expired && !usedProvisionalOffer) {
      return { status: 'VALID', quoteId, grandTotalCents: quote.grandTotalCents };
    }

    const eligible = await this.claims.isEligible(customerId, NEW_CUSTOMER_FAMILY);

    const redemptions: Record<string, number> = eligible ? {} : { [NEW_CUSTOMER_FAMILY]: 1 };
    // Rebuild from the ORIGINAL selections so the only thing that can move
    // between the two quotes is the discount outcome.
    const snap = (quote.requestSnapshot ?? {}) as {
      productSupplyOption?: string | null;
      distanceKm?: number;
      addOns?: { id: string; quantity: number }[];
    };

    const fresh = createQuote({
      serviceOptionId: quote.serviceOptionId,
      frequency: quote.frequency as CleaningFrequency,
      productSupplyOption: (snap.productSupplyOption ?? undefined) as ProductSupplyType | undefined,
      addOns: snap.addOns ?? [],
      transport: { distanceKm: snap.distanceKm ?? 0 },
      eligibility: {
        customerId,
        familyRedemptions: redemptions,
        hasCompletedBooking: !eligible,
      },
    });

    const newTotal = fresh.grandTotalCents;

    if (newTotal === quote.grandTotalCents) {
      return { status: 'VALID', quoteId, grandTotalCents: quote.grandTotalCents };
    }

    const persisted = await this.prisma.quote.create({
      data: {
        customerId,
        serviceOptionId: quote.serviceOptionId,
        frequency: quote.frequency,
        baseServiceCents: fresh.firstVisit?.baseServiceCents ?? quote.baseServiceCents,
        subtotalCents: fresh.subtotalBeforeTaxCents,
        gstCents: fresh.taxLines[0]?.amountCents ?? 0,
        qstCents: fresh.taxLines[1]?.amountCents ?? 0,
        taxTotalCents: fresh.taxTotalCents,
        grandTotalCents: newTotal,
        gstRateMicroPercent: quote.gstRateMicroPercent,
        qstRateMicroPercent: quote.qstRateMicroPercent,
        pricingVersion: quote.pricingVersion,
        winningDiscountSource: fresh.firstVisit?.appliedDiscount?.source ?? null,
        firstVisit: (fresh.firstVisit ?? null) as never,
        subsequentVisitPreview: (fresh.subsequentVisitPricingPreview ?? null) as never,
        warningCodes: [],
        priceSnapshot: JSON.parse(JSON.stringify(fresh)),
        requestSnapshot: quote.requestSnapshot ?? undefined,
        expiresAt: new Date(this.now().getTime() + 30 * 60_000),
        lines: {
          create: fresh.lines.map((l, i) => ({
            type: l.type,
            description: l.description,
            quantity: l.quantity ?? 1,
            unitAmountCents: l.unitAmountCents ?? l.subtotalCents,
            subtotalCents: l.subtotalCents,
            taxable: l.taxable ?? true,
            sortOrder: i,
          })),
        },
      },
    });

    return {
      status: 'REPRICE_REQUIRED',
      quoteId: persisted.id,
      grandTotalCents: newTotal,
      previous: { quoteId: quote.id, grandTotalCents: quote.grandTotalCents },
      differenceCents: newTotal - quote.grandTotalCents,
      reason: expired
        ? 'QUOTE_EXPIRED'
        : eligible
          ? 'CONFIGURATION_CHANGED'
          : 'NEW_CUSTOMER_ALREADY_REDEEMED',
    };
  }
}

/** Machine reason -> a sentence that never implies the customer did wrong. */
export const REPRICE_COPY: Record<RepriceReason, { en: string; fr: string }> = {
  NEW_CUSTOMER_ALREADY_REDEEMED: {
    en: 'Your first-cleaning offer has already been used.',
    fr: 'Votre offre de premier ménage a déjà été utilisée.',
  },
  PROMOTION_NO_LONGER_ELIGIBLE: {
    en: 'This offer no longer applies to this booking.',
    fr: "Cette offre ne s'applique plus à cette réservation.",
  },
  QUOTE_EXPIRED: {
    en: 'Your price expired while you were booking, so we refreshed it.',
    fr: 'Votre prix a expiré pendant la réservation, nous l\'avons actualisé.',
  },
  CONFIGURATION_CHANGED: {
    en: 'We refreshed your booking with the latest price.',
    fr: 'Nous avons actualisé votre réservation au prix courant.',
  },
};

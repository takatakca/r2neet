import { applyRate, type Cents } from '../domain/money.js';
import {
  PromotionType,
  type CleaningFrequency,
  type DiscountCandidate,
  type FrequencyRule,
  type Promotion,
  type ServiceOption,
} from '../domain/types.js';

/**
 * Discount resolution.
 *
 * Policy: BEST_SINGLE_DISCOUNT. Discounts do not stack. When several are
 * eligible we compute each one's real dollar value against its eligible base
 * and apply only the largest. Losing candidates are recorded on the quote so
 * the decision is auditable, and a limited promotion is NEVER marked used
 * unless it actually won.
 *
 * Discounts apply to the base cleaning service line only — never to products,
 * transportation, mileage, add-ons or tax.
 */

export interface CustomerEligibility {
  customerId: string | null;
  /** Redemptions already consumed, keyed by promotion family. */
  familyRedemptions: Record<string, number>;
  hasCompletedBooking: boolean;
}

export const GUEST: CustomerEligibility = {
  customerId: null,
  familyRedemptions: {},
  hasCompletedBooking: false,
};

export interface DiscountResolution {
  candidates: DiscountCandidate[];
  winner: DiscountCandidate | null;
  discountCents: Cents;
  /** True when the winner is a promotion whose eligibility could not be verified. */
  provisional: boolean;
  appliedPromotion: Promotion | null;
}

function promotionEligible(
  promo: Promotion,
  service: ServiceOption,
  eligibility: CustomerEligibility,
): { eligible: boolean; reason: string } {
  if (!promo.active) return { eligible: false, reason: 'promotion is inactive' };
  if (promo.ownerReviewRequired) return { eligible: false, reason: 'awaiting owner review' };

  if (promo.eligibleCategoryIds && !promo.eligibleCategoryIds.includes(service.categoryId)) {
    return { eligible: false, reason: 'service category not eligible' };
  }
  if (promo.eligibleServiceIds && !promo.eligibleServiceIds.includes(service.id)) {
    return { eligible: false, reason: 'service not eligible' };
  }

  if (promo.family && promo.lifetimeMaxUsagePerCustomer !== null) {
    const used = eligibility.familyRedemptions[promo.family] ?? 0;
    if (used >= promo.lifetimeMaxUsagePerCustomer) {
      return {
        eligible: false,
        reason: `${promo.family} lifetime limit already redeemed (${used}/${promo.lifetimeMaxUsagePerCustomer})`,
      };
    }
  }

  if (promo.firstBookingOnly && eligibility.hasCompletedBooking) {
    return { eligible: false, reason: 'customer already has a completed booking' };
  }

  return {
    eligible: true,
    reason: eligibility.customerId === null ? 'provisionally eligible (identity unverified)' : 'eligible',
  };
}

function promotionValue(promo: Promotion, baseCents: Cents): Cents {
  if (promo.type === PromotionType.FIXED) {
    // Never discount below zero.
    return Math.min(promo.amountCents ?? 0, baseCents);
  }
  return applyRate(baseCents, promo.rate ?? 0);
}

/**
 * @param isFirstVisit false when pricing the subsequent-visit preview of a
 *        recurring plan, where a first-booking promotion is no longer expected.
 */
export function resolveDiscount(params: {
  service: ServiceOption;
  baseServiceCents: Cents;
  frequency: CleaningFrequency;
  frequencyRule: FrequencyRule;
  promotions: Promotion[];
  eligibility: CustomerEligibility;
  isFirstVisit: boolean;
  couponCode?: string | null;
}): DiscountResolution {
  const { service, baseServiceCents, frequencyRule, promotions, eligibility, isFirstVisit } = params;
  const candidates: DiscountCandidate[] = [];

  // 1. Frequency discount.
  if (frequencyRule.discountRate > 0) {
    candidates.push({
      source: `${frequencyRule.frequency}_FREQUENCY`,
      label: frequencyRule.label.en,
      type: PromotionType.PERCENT,
      rate: frequencyRule.discountRate,
      amountCents: applyRate(baseServiceCents, frequencyRule.discountRate),
      eligible: true,
      applied: false,
      reason: 'recurring frequency discount',
    });
  }

  // 2. Promotions.
  for (const promo of promotions) {
    if (promo.firstBookingOnly && !isFirstVisit) {
      candidates.push({
        source: promo.code,
        label: promo.name.en,
        type: promo.type,
        rate: promo.rate,
        amountCents: promotionValue(promo, baseServiceCents),
        eligible: false,
        applied: false,
        reason: 'first-booking promotion does not apply to subsequent visits',
      });
      continue;
    }
    const { eligible, reason } = promotionEligible(promo, service, eligibility);
    candidates.push({
      source: promo.code,
      label: promo.name.en,
      type: promo.type,
      rate: promo.rate,
      amountCents: promotionValue(promo, baseServiceCents),
      eligible,
      applied: false,
      reason,
    });
  }

  // 3. BEST_SINGLE_DISCOUNT — largest customer saving wins.
  const eligibleCandidates = candidates.filter((c) => c.eligible && c.amountCents > 0);
  let winner: DiscountCandidate | null = null;
  for (const candidate of eligibleCandidates) {
    if (!winner || candidate.amountCents > winner.amountCents) winner = candidate;
  }
  if (winner) winner.applied = true;

  const appliedPromotion =
    winner === null ? null : (promotions.find((p) => p.code === winner!.source) ?? null);

  return {
    candidates,
    winner,
    discountCents: winner?.amountCents ?? 0,
    provisional: appliedPromotion !== null && eligibility.customerId === null,
    appliedPromotion,
  };
}

/**
 * Redemption is a SEPARATE operation from pricing.
 *
 * Quote generation never calls this. It is called once, inside the booking
 * confirmation transaction, after payment succeeds. Otherwise an abandoned
 * quote would burn a customer's single lifetime new-customer offer.
 */
export function recordRedemption(
  eligibility: CustomerEligibility,
  promo: Promotion,
): CustomerEligibility {
  if (!promo.family) return eligibility;
  return {
    ...eligibility,
    familyRedemptions: {
      ...eligibility.familyRedemptions,
      [promo.family]: (eligibility.familyRedemptions[promo.family] ?? 0) + 1,
    },
  };
}

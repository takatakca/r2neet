import { assertCents, sum, type Cents } from '../domain/money.js';
import {
  CleaningFrequency,
  PaymentPolicyType,
  ProductSupplyMode,
  ProductSupplyType,
  QuoteLineType,
  RecurrenceKind,
  ServicePricingMode,
  WarningCode,
  type Promotion,
  type Quote,
  type QuoteLine,
  type QuoteSnapshot,
  type TaxRule,
  type TransportationRule,
  type VisitPricing,
} from '../domain/types.js';
import { BUSINESS_CONFIG, FREQUENCY_RULES, TAX_RULES, TRANSPORTATION_RULE } from '../data/config.js';
import { getAddOn, getService, PRODUCT_OPTIONS } from '../data/catalogue.js';
import { PROMOTIONS } from '../data/promotions.js';
import { GUEST, resolveDiscount, type CustomerEligibility } from './discounts.js';
import { calculateTax } from './tax.js';

/**
 * THE authoritative pricing engine.
 *
 * Website, PWA, admin, mobile and Stripe all price through this one function.
 * A customer must never see one total on the site and a different one in
 * Stripe or on the invoice.
 *
 * The engine NEVER accepts a total from the caller and NEVER writes a
 * promotion redemption — see recordRedemption() for that.
 */

export class QuoteRequiredError extends Error {
  readonly code = 'QUOTE_REQUIRED';
  constructor(public serviceId: string) {
    super(`Service ${serviceId} requires a custom quote and cannot be priced as a fixed service.`);
  }
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
}

export interface QuoteRequest {
  serviceOptionId: string;
  frequency: CleaningFrequency;
  productSupplyOption?: ProductSupplyType | null;
  transport?: { distanceKm: number } | null;
  addOns?: { id: string; quantity: number }[];
  promotionCode?: string | null;
  eligibility?: CustomerEligibility;
  now?: Date;
}

export interface EngineTables {
  taxRules: TaxRule[];
  transportationRule: TransportationRule;
  promotions: Promotion[];
}

const DEFAULT_TABLES: EngineTables = {
  taxRules: TAX_RULES,
  transportationRule: TRANSPORTATION_RULE,
  promotions: PROMOTIONS,
};

let quoteCounter = 0;
function nextQuoteId(now: Date): string {
  quoteCounter += 1;
  return `R2N-Q-${now.getUTCFullYear()}-${String(quoteCounter).padStart(6, '0')}`;
}

export function createQuote(request: QuoteRequest, tables: EngineTables = DEFAULT_TABLES): Quote {
  const now = request.now ?? new Date();
  const eligibility = request.eligibility ?? GUEST;
  const service = getService(request.serviceOptionId);

  /* ---------------- validation ---------------- */

  if (service.pricingMode === ServicePricingMode.QUOTE_REQUIRED) {
    // Never returns a $0 checkout. This is what showed as "Free" on Setmore.
    throw new QuoteRequiredError(service.id);
  }
  if (!service.active || !service.publiclyBookable) {
    throw new ValidationError(`service ${service.id} is not publicly bookable`);
  }
  if (!Object.values(CleaningFrequency).includes(request.frequency)) {
    throw new ValidationError(`unknown frequency: ${request.frequency}`);
  }
  if (!service.allowedFrequencies.includes(request.frequency)) {
    throw new ValidationError(
      `frequency ${request.frequency} is not permitted for ${service.name.en}`,
    );
  }

  const productSelection = request.productSupplyOption ?? null;
  if (service.productSupplyMode === ProductSupplyMode.REQUIRED_SELECTION) {
    if (!productSelection) {
      throw new ValidationError(`${service.name.en} requires a cleaning-products selection`);
    }
    if (!service.allowedProductOptions.includes(productSelection)) {
      throw new ValidationError(
        `product option ${productSelection} is not permitted for ${service.name.en}`,
      );
    }
  } else if (productSelection && productSelection !== ProductSupplyType.CLIENT_SUPPLIED) {
    throw new ValidationError(`${service.name.en} does not accept cleaning-product charges`);
  }

  const distanceKm = request.transport?.distanceKm ?? 0;
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new ValidationError(`distance must be zero or greater, received ${distanceKm}`);
  }

  const addOnRequests = request.addOns ?? [];
  for (const item of addOnRequests) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new ValidationError(`add-on quantity must be a positive integer, received ${item.quantity}`);
    }
    const addOn = getAddOn(item.id);
    if (item.quantity > addOn.maxQuantity) {
      throw new ValidationError(`add-on ${addOn.name.en} quantity exceeds maximum ${addOn.maxQuantity}`);
    }
  }

  /* ---------------- service + discount ---------------- */

  const baseServiceCents = service.basePriceCents;
  if (baseServiceCents === null) throw new ValidationError('fixed service is missing a base price');
  assertCents(baseServiceCents);

  const frequencyRule = FREQUENCY_RULES[request.frequency];
  const activePromotions = tables.promotions.filter(
    (p) => !request.promotionCode || p.code === request.promotionCode || p.active,
  );

  const firstVisitResolution = resolveDiscount({
    service,
    baseServiceCents,
    frequency: request.frequency,
    frequencyRule,
    promotions: activePromotions,
    eligibility,
    isFirstVisit: true,
  });

  const isRecurring = request.frequency !== CleaningFrequency.ONE_TIME;

  // Subsequent visits: the first-booking promotion is assumed spent, so the
  // frequency discount is what remains. Always computed for recurring plans.
  const subsequentResolution = isRecurring
    ? resolveDiscount({
        service,
        baseServiceCents,
        frequency: request.frequency,
        frequencyRule,
        promotions: activePromotions,
        eligibility,
        isFirstVisit: false,
      })
    : null;

  const toVisitPricing = (
    resolution: ReturnType<typeof resolveDiscount>,
    provisional: boolean,
  ): VisitPricing => ({
    baseServiceCents,
    appliedDiscount: resolution.winner
      ? {
          source: resolution.winner.source,
          label: resolution.winner.label,
          rate: resolution.winner.rate,
          amountCents: resolution.winner.amountCents,
        }
      : null,
    discountedServiceCents: baseServiceCents - resolution.discountCents,
    candidatesConsidered: resolution.candidates,
    eligibilityStatus: provisional ? 'PROVISIONAL' : 'CONFIRMED',
  });

  /* ---------------- line items ---------------- */

  const lines: QuoteLine[] = [];

  lines.push({
    type: QuoteLineType.SERVICE,
    code: service.slug,
    description: service.name.en,
    quantity: 1,
    unitAmountCents: baseServiceCents,
    subtotalCents: baseServiceCents,
    taxable: service.taxable,
    discountEligible: true,
    meta: {
      requiredStaffCount: service.requiredStaffCount,
      appointmentDurationMinutes: service.appointmentDurationMinutes,
      labourMinutes: service.labourMinutes,
    },
  });

  if (firstVisitResolution.winner) {
    const w = firstVisitResolution.winner;
    const isFrequency = w.source.endsWith('_FREQUENCY');
    lines.push({
      type: isFrequency ? QuoteLineType.FREQUENCY_DISCOUNT : QuoteLineType.PROMOTION_DISCOUNT,
      code: w.source,
      description: w.label,
      quantity: 1,
      unitAmountCents: -w.amountCents,
      subtotalCents: -w.amountCents,
      taxable: service.taxable,
      discountEligible: false,
      meta: { rate: w.rate, appliedTo: 'base cleaning service' },
    });
  }

  // Products — per visit, never discounted.
  let productOption = null;
  if (productSelection) {
    productOption = PRODUCT_OPTIONS[productSelection];
    lines.push({
      type: QuoteLineType.PRODUCTS,
      code: productSelection,
      description: productOption.name.en,
      quantity: 1,
      unitAmountCents: productOption.amountCents,
      subtotalCents: productOption.amountCents,
      taxable: productOption.taxable,
      discountEligible: false,
      meta: { jobSheetLabel: productOption.jobSheetLabel },
    });
  }

  // Transportation — ONE per visit even with two cleaners. Taxable.
  const rule = tables.transportationRule;
  let transportSnapshot: QuoteSnapshot['transportation'] = null;
  let surchargeCents: Cents = 0;
  let billableExtraKm = 0;

  if (rule.enabled) {
    const transportTotal = rule.baseAmountCents * rule.quantityPerVisit;
    lines.push({
      type: QuoteLineType.TRANSPORT,
      code: 'TRANSPORT',
      description: `Transportation (${rule.includedDistanceKm} km included)`,
      quantity: rule.quantityPerVisit,
      unitAmountCents: rule.baseAmountCents,
      subtotalCents: transportTotal,
      taxable: rule.taxable,
      discountEligible: rule.discountEligible,
      meta: { origin: rule.originLabel, note: 'One fee per visit regardless of cleaner count' },
    });

    billableExtraKm = Math.max(0, Math.ceil(distanceKm - rule.includedDistanceKm));
    if (billableExtraKm > 0) {
      surchargeCents = billableExtraKm * rule.extraDistanceRateCentsPerKm;
      lines.push({
        type: QuoteLineType.DISTANCE,
        code: 'DISTANCE',
        description: `Additional distance — ${billableExtraKm} km beyond ${rule.includedDistanceKm} km`,
        quantity: billableExtraKm,
        unitAmountCents: rule.extraDistanceRateCentsPerKm,
        subtotalCents: surchargeCents,
        taxable: rule.taxable,
        discountEligible: rule.discountEligible,
      });
    }

    transportSnapshot = {
      baseAmountCents: rule.baseAmountCents,
      includedDistanceKm: rule.includedDistanceKm,
      extraDistanceRateCentsPerKm: rule.extraDistanceRateCentsPerKm,
      requestedDistanceKm: distanceKm,
      billableExtraKm,
      surchargeCents,
      quantity: rule.quantityPerVisit,
    };
  }

  // Add-ons.
  const addOnSnapshot: QuoteSnapshot['addOns'] = [];
  for (const item of addOnRequests) {
    const addOn = getAddOn(item.id);
    if (!addOn.active) continue;
    const subtotal = addOn.unitAmountCents * item.quantity;
    lines.push({
      type: QuoteLineType.ADD_ON,
      code: addOn.slug,
      description: `${addOn.name.en} × ${item.quantity}`,
      quantity: item.quantity,
      unitAmountCents: addOn.unitAmountCents,
      subtotalCents: subtotal,
      taxable: addOn.taxable,
      discountEligible: addOn.discountEligible,
    });
    addOnSnapshot.push({ id: addOn.id, unitAmountCents: addOn.unitAmountCents, quantity: item.quantity });
  }

  /* ---------------- tax + totals ---------------- */

  const taxResult = calculateTax(lines, tables.taxRules);
  const subtotalBeforeTaxCents = sum(...lines.map((l) => l.subtotalCents));
  const grandTotalCents = subtotalBeforeTaxCents + taxResult.taxTotalCents;

  const warningCodes: WarningCode[] = [];
  if (firstVisitResolution.provisional) {
    warningCodes.push(WarningCode.NEW_CUSTOMER_ELIGIBILITY_UNVERIFIED);
  }
  if (service.migrationReviewNote) {
    warningCodes.push(WarningCode.MIGRATION_PRICE_UNDER_REVIEW);
  }

  const expiresAt = new Date(now.getTime() + BUSINESS_CONFIG.quoteExpirationMinutes * 60_000);

  const snapshot: QuoteSnapshot = {
    serviceBasePriceCents: baseServiceCents,
    frequencyDiscountRate: frequencyRule.discountRate,
    productOption: productOption
      ? { type: productOption.type, amountCents: productOption.amountCents }
      : null,
    transportation: transportSnapshot,
    addOns: addOnSnapshot,
    promotionApplied: firstVisitResolution.appliedPromotion
      ? {
          id: firstVisitResolution.appliedPromotion.id,
          code: firstVisitResolution.appliedPromotion.code,
          amountCents: firstVisitResolution.discountCents,
        }
      : null,
    taxRates: tables.taxRules
      .filter((r) => r.active)
      .map((r) => ({ code: r.code, rate: r.rate, compounding: r.compounding })),
    grandTotalCents,
  };

  const paymentPolicy = BUSINESS_CONFIG.defaultPaymentPolicy;

  return Object.freeze({
    quoteId: nextQuoteId(now),
    currency: BUSINESS_CONFIG.currency,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    pricingVersion: BUSINESS_CONFIG.pricingVersion,

    serviceOptionId: service.id,
    serviceName: service.name.en,
    requiredStaffCount: service.requiredStaffCount,
    appointmentDurationMinutes: service.appointmentDurationMinutes,
    labourMinutes: service.labourMinutes,

    frequency: request.frequency,
    recurrence: isRecurring
      ? {
          kind: frequencyRule.recurrenceKind,
          intervalDays: frequencyRule.intervalDays,
          shortMonthPolicy: frequencyRule.shortMonthPolicy,
        }
      : null,

    lines,
    subtotalBeforeTaxCents,
    taxableSubtotalCents: taxResult.taxableSubtotalCents,
    nonTaxableSubtotalCents: taxResult.nonTaxableSubtotalCents,
    taxLines: taxResult.taxLines,
    taxTotalCents: taxResult.taxTotalCents,
    grandTotalCents,

    firstVisit: toVisitPricing(firstVisitResolution, firstVisitResolution.provisional),
    // Always present for recurring quotes, even when identical to firstVisit.
    subsequentVisitPricingPreview: subsequentResolution
      ? toVisitPricing(subsequentResolution, false)
      : null,

    paymentPolicy,
    amountDueNowCents: paymentPolicy === PaymentPolicyType.PAY_LATER ? 0 : grandTotalCents,

    productSupplySelection: productSelection,
    jobSheetProducts: productOption ? productOption.jobSheetLabel : 'NOT APPLICABLE',

    warningCodes,
    snapshot,
  }) as Quote;
}

export { RecurrenceKind };

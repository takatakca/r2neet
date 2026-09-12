import type { Cents, MicroPercent } from './money.js';

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const CleaningFrequency = {
  ONE_TIME: 'ONE_TIME',
  MONTHLY: 'MONTHLY',
  BIWEEKLY: 'BIWEEKLY',
  WEEKLY: 'WEEKLY',
} as const;
export type CleaningFrequency = (typeof CleaningFrequency)[keyof typeof CleaningFrequency];

export const RecurrenceKind = {
  NONE: 'NONE',
  FIXED_INTERVAL_DAYS: 'FIXED_INTERVAL_DAYS',
  CALENDAR_MONTH: 'CALENDAR_MONTH',
} as const;
export type RecurrenceKind = (typeof RecurrenceKind)[keyof typeof RecurrenceKind];

export const ShortMonthPolicy = {
  CLAMP_TO_LAST_DAY: 'CLAMP_TO_LAST_DAY',
} as const;
export type ShortMonthPolicy = (typeof ShortMonthPolicy)[keyof typeof ShortMonthPolicy];

export const ServicePricingMode = {
  FIXED: 'FIXED',
  QUOTE_REQUIRED: 'QUOTE_REQUIRED',
} as const;
export type ServicePricingMode = (typeof ServicePricingMode)[keyof typeof ServicePricingMode];

export const ServiceDurationMode = {
  FIXED: 'FIXED',
  QUOTE_REQUIRED: 'QUOTE_REQUIRED',
} as const;
export type ServiceDurationMode = (typeof ServiceDurationMode)[keyof typeof ServiceDurationMode];

export const ProductSupplyMode = {
  REQUIRED_SELECTION: 'REQUIRED_SELECTION',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;
export type ProductSupplyMode = (typeof ProductSupplyMode)[keyof typeof ProductSupplyMode];

export const ProductSupplyType = {
  CLIENT_SUPPLIED: 'CLIENT_SUPPLIED',
  R2NETTE_BASIC: 'R2NETTE_BASIC',
  R2NETTE_DEEP: 'R2NETTE_DEEP',
} as const;
export type ProductSupplyType = (typeof ProductSupplyType)[keyof typeof ProductSupplyType];

export const PaymentPolicyType = {
  PAY_LATER: 'PAY_LATER',
  DEPOSIT: 'DEPOSIT',
  FULL_PAYMENT: 'FULL_PAYMENT',
  CARD_ON_FILE: 'CARD_ON_FILE',
} as const;
export type PaymentPolicyType = (typeof PaymentPolicyType)[keyof typeof PaymentPolicyType];

export const PromotionType = { FIXED: 'FIXED', PERCENT: 'PERCENT' } as const;
export type PromotionType = (typeof PromotionType)[keyof typeof PromotionType];

export const PromotionFamily = { NEW_CUSTOMER: 'NEW_CUSTOMER' } as const;
export type PromotionFamily = (typeof PromotionFamily)[keyof typeof PromotionFamily];

export const DiscountStackingPolicy = {
  BEST_SINGLE_DISCOUNT: 'BEST_SINGLE_DISCOUNT',
  STACKABLE: 'STACKABLE',
} as const;
export type DiscountStackingPolicy =
  (typeof DiscountStackingPolicy)[keyof typeof DiscountStackingPolicy];

export const TaxCompounding = {
  COMPOUNDED: 'COMPOUNDED',
  NON_COMPOUNDED: 'NON_COMPOUNDED',
} as const;
export type TaxCompounding = (typeof TaxCompounding)[keyof typeof TaxCompounding];

export const LegacyPlanStatus = {
  OWNER_REVIEW_REQUIRED: 'OWNER_REVIEW_REQUIRED',
  GRANDFATHERED: 'GRANDFATHERED',
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
} as const;
export type LegacyPlanStatus = (typeof LegacyPlanStatus)[keyof typeof LegacyPlanStatus];

export const QuoteLineType = {
  SERVICE: 'SERVICE',
  FREQUENCY_DISCOUNT: 'FREQUENCY_DISCOUNT',
  PROMOTION_DISCOUNT: 'PROMOTION_DISCOUNT',
  PRODUCTS: 'PRODUCTS',
  TRANSPORT: 'TRANSPORT',
  DISTANCE: 'DISTANCE',
  ADD_ON: 'ADD_ON',
  TAX: 'TAX',
} as const;
export type QuoteLineType = (typeof QuoteLineType)[keyof typeof QuoteLineType];

export const WarningCode = {
  NEW_CUSTOMER_ELIGIBILITY_UNVERIFIED: 'NEW_CUSTOMER_ELIGIBILITY_UNVERIFIED',
  MIGRATION_PRICE_UNDER_REVIEW: 'MIGRATION_PRICE_UNDER_REVIEW',
} as const;
export type WarningCode = (typeof WarningCode)[keyof typeof WarningCode];

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export interface ServiceCategory {
  id: string;
  slug: string;
  name: { en: string; fr: string };
  sortOrder: number;
}

export interface ServiceOption {
  id: string;
  slug: string;
  categoryId: string;
  /** Original Setmore name, kept for migration traceability. Never shown to customers. */
  legacySetmoreName: string;
  name: { en: string; fr: string };
  shortDescription: { en: string; fr: string };

  pricingMode: ServicePricingMode;
  durationMode: ServiceDurationMode;

  /** null when pricingMode === QUOTE_REQUIRED */
  basePriceCents: Cents | null;

  /** Clock time the customer's appointment occupies. null when quote-required. */
  appointmentDurationMinutes: number | null;
  /** Number of cleaners who must be free for the whole appointment. */
  requiredStaffCount: number;
  /** appointmentDurationMinutes * requiredStaffCount. null when quote-required. */
  labourMinutes: number | null;

  productSupplyMode: ProductSupplyMode;
  allowedProductOptions: ProductSupplyType[];
  allowedFrequencies: CleaningFrequency[];

  taxable: boolean;
  active: boolean;
  publiclyBookable: boolean;
  sortOrder: number;

  migrationReviewNote?: string;
}

export interface AddOn {
  id: string;
  slug: string;
  name: { en: string; fr: string };
  unitAmountCents: Cents;
  unitLabel: { en: string; fr: string };
  quantityEnabled: boolean;
  maxQuantity: number;
  taxable: boolean;
  discountEligible: boolean;
  active: boolean;
}

export interface ProductSupplyOption {
  type: ProductSupplyType;
  name: { en: string; fr: string };
  amountCents: Cents;
  /** Text the cleaner sees on the job sheet. */
  jobSheetLabel: string;
  taxable: boolean;
  discountEligible: boolean;
}

/* ------------------------------------------------------------------ */
/* Pricing rules                                                       */
/* ------------------------------------------------------------------ */

export interface FrequencyRule {
  frequency: CleaningFrequency;
  discountRate: MicroPercent;
  recurrenceKind: RecurrenceKind;
  intervalDays: number | null;
  shortMonthPolicy: ShortMonthPolicy | null;
  label: { en: string; fr: string };
}

export interface TaxRule {
  id: string;
  code: string;
  name: string;
  rate: MicroPercent;
  compounding: TaxCompounding;
  displayOrder: number;
  active: boolean;
  appliesToServices: boolean;
  appliesToProducts: boolean;
  appliesToTransportation: boolean;
  appliesToMileage: boolean;
  appliesToAddOns: boolean;
}

export interface TransportationRule {
  id: string;
  baseAmountCents: Cents;
  includedDistanceKm: number;
  extraDistanceRateCentsPerKm: Cents;
  quantityPerVisit: number;
  enabled: boolean;
  taxable: boolean;
  discountEligible: boolean;
  originLabel: string;
}

export interface Promotion {
  id: string;
  code: string;
  name: { en: string; fr: string };
  type: PromotionType;
  /** for FIXED */
  amountCents: Cents | null;
  /** for PERCENT */
  rate: MicroPercent | null;
  family: PromotionFamily | null;
  /** Max redemptions per customer across the whole family. */
  lifetimeMaxUsagePerCustomer: number | null;
  firstBookingOnly: boolean;
  eligibleCategoryIds: string[] | null;
  eligibleServiceIds: string[] | null;
  minimumSpendCents: Cents | null;
  stackable: boolean;
  active: boolean;
  ownerReviewRequired: boolean;
  description: string;
}

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

export interface QuoteLine {
  type: QuoteLineType;
  code: string;
  description: string;
  quantity: number;
  unitAmountCents: Cents;
  /** Signed. Discounts are negative. */
  subtotalCents: Cents;
  taxable: boolean;
  discountEligible: boolean;
  meta?: Record<string, unknown>;
}

export interface TaxLine {
  code: string;
  name: string;
  rate: MicroPercent;
  taxableBaseCents: Cents;
  amountCents: Cents;
}

export interface DiscountCandidate {
  source: string;
  label: string;
  type: PromotionType;
  rate: MicroPercent | null;
  amountCents: Cents;
  eligible: boolean;
  applied: boolean;
  reason: string;
}

export interface VisitPricing {
  baseServiceCents: Cents;
  appliedDiscount: {
    source: string;
    label: string;
    rate: MicroPercent | null;
    amountCents: Cents;
  } | null;
  discountedServiceCents: Cents;
  candidatesConsidered: DiscountCandidate[];
  eligibilityStatus: 'CONFIRMED' | 'PROVISIONAL';
}

export interface Quote {
  quoteId: string;
  currency: 'CAD';
  createdAt: string;
  expiresAt: string;
  pricingVersion: string;

  serviceOptionId: string;
  serviceName: string;
  requiredStaffCount: number;
  appointmentDurationMinutes: number | null;
  labourMinutes: number | null;

  frequency: CleaningFrequency;
  recurrence: {
    kind: RecurrenceKind;
    intervalDays: number | null;
    shortMonthPolicy: ShortMonthPolicy | null;
  } | null;

  lines: QuoteLine[];
  subtotalBeforeTaxCents: Cents;
  taxableSubtotalCents: Cents;
  nonTaxableSubtotalCents: Cents;
  taxLines: TaxLine[];
  taxTotalCents: Cents;
  grandTotalCents: Cents;

  /** Always present when frequency !== ONE_TIME. */
  firstVisit: VisitPricing;
  /** Always present when frequency !== ONE_TIME, even if identical to firstVisit. */
  subsequentVisitPricingPreview: VisitPricing | null;

  paymentPolicy: PaymentPolicyType;
  amountDueNowCents: Cents;

  productSupplySelection: ProductSupplyType | null;
  jobSheetProducts: string;

  warningCodes: WarningCode[];
  /** Immutable snapshot of every rule used, so the quote never re-prices. */
  snapshot: QuoteSnapshot;
}

export interface QuoteSnapshot {
  serviceBasePriceCents: Cents;
  frequencyDiscountRate: MicroPercent;
  productOption: { type: ProductSupplyType; amountCents: Cents } | null;
  transportation: {
    baseAmountCents: Cents;
    includedDistanceKm: number;
    extraDistanceRateCentsPerKm: Cents;
    requestedDistanceKm: number;
    billableExtraKm: number;
    surchargeCents: Cents;
    quantity: number;
  } | null;
  addOns: { id: string; unitAmountCents: Cents; quantity: number }[];
  promotionApplied: { id: string; code: string; amountCents: Cents } | null;
  taxRates: { code: string; rate: MicroPercent; compounding: TaxCompounding }[];
  grandTotalCents: Cents;
}

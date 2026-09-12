import { dollars, percent, type Cents } from '../domain/money.js';
import {
  CleaningFrequency,
  DiscountStackingPolicy,
  PaymentPolicyType,
  RecurrenceKind,
  ShortMonthPolicy,
  TaxCompounding,
  type FrequencyRule,
  type TaxRule,
  type TransportationRule,
} from '../domain/types.js';

/**
 * Single source of truth for every business value.
 * Nothing in this file may be duplicated into a component, route or test.
 * In production this table is admin-editable; the shape does not change.
 */
export const BUSINESS_CONFIG = {
  currency: 'CAD' as const,
  timezone: 'America/Toronto' as const,

  generalHourlyMinimumMinutes: 180,
  quoteExpirationMinutes: 30,

  defaultPaymentPolicy: PaymentPolicyType.PAY_LATER,
  promotionStackingPolicy: DiscountStackingPolicy.BEST_SINGLE_DISCOUNT,
  newCustomerLifetimeLimit: 1,
  /** Guests see the advertised new-customer saving, flagged unverified internally. */
  guestPromotionEligibilityPolicy: 'PROVISIONAL_WITH_WARNING' as const,

  pricingVersion: '2026.08-phase1',
} as const;

/* ------------------------------------------------------------------ */
/* Frequency + recurrence                                              */
/* ------------------------------------------------------------------ */

export const FREQUENCY_RULES: Record<CleaningFrequency, FrequencyRule> = {
  [CleaningFrequency.ONE_TIME]: {
    frequency: CleaningFrequency.ONE_TIME,
    discountRate: percent(0),
    recurrenceKind: RecurrenceKind.NONE,
    intervalDays: null,
    shortMonthPolicy: null,
    label: { en: 'One-time', fr: 'Une seule fois' },
  },
  [CleaningFrequency.MONTHLY]: {
    frequency: CleaningFrequency.MONTHLY,
    discountRate: percent(10),
    // Calendar recurrence, NOT 30 days.
    recurrenceKind: RecurrenceKind.CALENDAR_MONTH,
    intervalDays: null,
    shortMonthPolicy: ShortMonthPolicy.CLAMP_TO_LAST_DAY,
    label: { en: 'Monthly — save 10%', fr: 'Mensuel — économisez 10 %' },
  },
  [CleaningFrequency.BIWEEKLY]: {
    frequency: CleaningFrequency.BIWEEKLY,
    discountRate: percent(15),
    recurrenceKind: RecurrenceKind.FIXED_INTERVAL_DAYS,
    intervalDays: 14,
    shortMonthPolicy: null,
    label: { en: 'Every 2 weeks — save 15%', fr: 'Aux 2 semaines — économisez 15 %' },
  },
  [CleaningFrequency.WEEKLY]: {
    frequency: CleaningFrequency.WEEKLY,
    discountRate: percent(25),
    // Every 7 days. Some months contain five visits.
    recurrenceKind: RecurrenceKind.FIXED_INTERVAL_DAYS,
    intervalDays: 7,
    shortMonthPolicy: null,
    label: { en: 'Weekly — save 25%', fr: 'Hebdomadaire — économisez 25 %' },
  },
};

/* ------------------------------------------------------------------ */
/* Tax — Québec                                                        */
/* ------------------------------------------------------------------ */

/**
 * GST and QST are each calculated independently on the PRE-TAX taxable
 * subtotal. QST does NOT compound on GST. displayOrder is presentation only
 * and must never influence the arithmetic.
 */
export const TAX_RULES: TaxRule[] = [
  {
    id: 'tax_gst',
    code: 'GST',
    name: 'TPS / GST',
    rate: percent(5),
    compounding: TaxCompounding.NON_COMPOUNDED,
    displayOrder: 1,
    active: true,
    appliesToServices: true,
    appliesToProducts: true,
    appliesToTransportation: true,
    appliesToMileage: true,
    appliesToAddOns: true,
  },
  {
    id: 'tax_qst',
    code: 'QST',
    name: 'TVQ / QST',
    rate: percent(9.975),
    compounding: TaxCompounding.NON_COMPOUNDED,
    displayOrder: 2,
    active: true,
    appliesToServices: true,
    appliesToProducts: true,
    appliesToTransportation: true,
    appliesToMileage: true,
    appliesToAddOns: true,
  },
];

/* ------------------------------------------------------------------ */
/* Transportation                                                      */
/* ------------------------------------------------------------------ */

export const TRANSPORTATION_RULE: TransportationRule = {
  id: 'transport_default',
  baseAmountCents: dollars(25),
  includedDistanceKm: 20,
  extraDistanceRateCentsPerKm: 65,
  // One transport per visit even when two cleaners travel together.
  quantityPerVisit: 1,
  enabled: true,
  taxable: true,
  discountEligible: false,
  originLabel: 'R2NETTE — Lachine, QC',
};

export const PRODUCT_PRICES: { basic: Cents; deep: Cents } = {
  basic: dollars(12),
  deep: dollars(15),
};

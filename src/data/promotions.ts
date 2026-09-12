import { dollars } from '../domain/money.js';
import { PromotionFamily, PromotionType, type Promotion } from '../domain/types.js';

/**
 * The two new-customer offers share the NEW_CUSTOMER family, which carries a
 * lifetime limit of 1 per customer. Redeeming the $15 Basic offer makes the
 * $20 Deep offer ineligible forever, and vice versa.
 */
export const PROMOTIONS: Promotion[] = [
  {
    id: 'promo_new_basic',
    code: 'NEW_CUSTOMER_BASIC',
    name: { en: 'New customer — $15 off Basic', fr: 'Nouveau client — 15 $ de rabais' },
    type: PromotionType.FIXED,
    amountCents: dollars(15),
    rate: null,
    family: PromotionFamily.NEW_CUSTOMER,
    lifetimeMaxUsagePerCustomer: 1,
    firstBookingOnly: true,
    eligibleCategoryIds: ['cat_basic'],
    eligibleServiceIds: null,
    minimumSpendCents: null,
    stackable: false,
    active: true,
    ownerReviewRequired: false,
    description: '$15 off the first eligible Basic cleaning.',
  },
  {
    id: 'promo_new_deep',
    code: 'NEW_CUSTOMER_DEEP',
    name: { en: 'New customer — $20 off Deep', fr: 'Nouveau client — 20 $ de rabais' },
    type: PromotionType.FIXED,
    amountCents: dollars(20),
    rate: null,
    family: PromotionFamily.NEW_CUSTOMER,
    lifetimeMaxUsagePerCustomer: 1,
    firstBookingOnly: true,
    eligibleCategoryIds: ['cat_deep'],
    eligibleServiceIds: null,
    minimumSpendCents: null,
    stackable: false,
    active: true,
    ownerReviewRequired: false,
    description: '$20 off the first eligible Deep cleaning.',
  },
  {
    id: 'promo_legacy_vip',
    code: 'LEGACY_VIP',
    name: { en: 'Legacy VIP Promotion', fr: 'Promotion VIP héritée' },
    type: PromotionType.FIXED,
    amountCents: dollars(100),
    rate: null,
    family: null,
    lifetimeMaxUsagePerCustomer: 1,
    firstBookingOnly: false,
    eligibleCategoryIds: null,
    eligibleServiceIds: null,
    minimumSpendCents: null,
    stackable: false,
    // Disabled. The historical "$100 / four services / 60 days" wording is ambiguous.
    active: false,
    ownerReviewRequired: true,
    description:
      'Legacy Setmore promotion requires owner confirmation before activation. Never auto-applies.',
  },
];

/** Legacy weekly plan: preserved for grandfathered customers, never public. */
export const LEGACY_WEEKLY_PLAN = {
  id: 'legacy_weekly_hebdo',
  legacySetmoreName: 'PROMOTION 4HRS HEBDOMADAIRE',
  status: 'OWNER_REVIEW_REQUIRED' as const,
  active: false,
  publiclyBookable: false,
  minimumMinutes: 240,
  termLengthMonths: 12,
  sameCleanerPreference: true,
  conflictNote:
    'Booking policy says 3h=$125 / 4h=$150 products+tax included. Banner says $25/hr, 4h minimum, ' +
    '12-month term, same cleaner weekly. These conflict. Requires owner decision before any public use.',
  observedPrices: { threeHourCents: dollars(125), fourHourCents: dollars(150) },
};

export const MIGRATION_REVIEW_ITEMS = [
  {
    id: 'mri_deep_2x2',
    subject: 'svc_deep_2x2',
    note: 'Deep Cleaning — 2 Cleaners × 2 Hours currently costs $130. Preserve price pending owner confirmation.',
  },
  {
    id: 'mri_deep_2x4',
    subject: 'svc_deep_2x4',
    note: 'Deep Cleaning — 2 Cleaners × 4 Hours is priced at $260, identical to Basic 2 Cleaners × 4 Hours. Preserve legacy price pending owner review.',
  },
  {
    id: 'mri_legacy_weekly',
    subject: 'legacy_weekly_hebdo',
    note: 'Legacy weekly promotion has two contradictory price structures and is cheaper than the new frequency engine. Owner must decide whether weekly customers are repriced.',
  },
  {
    id: 'mri_legacy_vip',
    subject: 'promo_legacy_vip',
    note: 'Legacy VIP $100 / 4 services / 60 days wording is ambiguous. Seeded disabled.',
  },
];

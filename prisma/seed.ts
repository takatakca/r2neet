import { PrismaClient } from '@prisma/client';
import { SERVICES, CATEGORIES, ADD_ONS } from '../src/data/catalogue.js';
import { resolveDatabase } from '../src/db/safety.js';

/**
 * Production catalogue seed.
 *
 * Idempotent by construction: every write is an upsert keyed on a stable id
 * or slug. Running this twice leaves exactly one canonical row per entity and
 * never deletes anything. There is deliberately no delete-all-and-recreate
 * path — that pattern is how a seed script destroys live bookings.
 *
 * Values come from `src/data/catalogue.ts`, the same source the pricing
 * engine reads, so the database and the engine cannot drift apart.
 */

export interface SeedResult {
  categories: number;
  serviceOptions: number;
  addOns: number;
  taxRules: number;
  promotions: number;
  transportationRules: number;
  businessConfiguration: number;
}

export async function seed(prisma: PrismaClient): Promise<SeedResult> {
  const result: SeedResult = {
    categories: 0,
    serviceOptions: 0,
    addOns: 0,
    taxRules: 0,
    promotions: 0,
    transportationRules: 0,
    businessConfiguration: 0,
  };

  /* ---------------- categories ---------------- */
  for (const [i, c] of CATEGORIES.entries()) {
    await prisma.serviceCategory.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        slug: c.slug ?? c.id,
        nameEn: c.name.en,
        nameFr: c.name.fr,
        sortOrder: i,
      },
      update: { nameEn: c.name.en, nameFr: c.name.fr, sortOrder: i },
    });
    result.categories++;
  }

  /* ---------------- service options ---------------- */
  for (const [i, s] of SERVICES.entries()) {
    await prisma.serviceOption.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        slug: s.slug ?? s.id,
        categoryId: s.categoryId,
        nameEn: s.name.en,
        nameFr: s.name.fr,
        legacySetmoreName: s.legacySetmoreName ?? null,
        basePriceCents: s.basePriceCents,
        pricingMode: s.pricingMode,
        durationMode: s.durationMode,
        appointmentDurationMinutes: s.appointmentDurationMinutes,
        requiredStaffCount: s.requiredStaffCount,
        labourMinutes: s.labourMinutes,
        productSupplyMode: s.productSupplyMode,
        allowedFrequencies: [...s.allowedFrequencies],
        paymentPolicy: 'PAY_LATER',
        active: s.active,
        publiclyBookable: s.publiclyBookable,
        sortOrder: i,
      },
      update: {
        nameEn: s.name.en,
        nameFr: s.name.fr,
        basePriceCents: s.basePriceCents,
        pricingMode: s.pricingMode,
        durationMode: s.durationMode,
        appointmentDurationMinutes: s.appointmentDurationMinutes,
        requiredStaffCount: s.requiredStaffCount,
        labourMinutes: s.labourMinutes,
        productSupplyMode: s.productSupplyMode,
        allowedFrequencies: [...s.allowedFrequencies],
        active: s.active,
        publiclyBookable: s.publiclyBookable,
        sortOrder: i,
      },
    });
    result.serviceOptions++;
  }

  /* ---------------- add-ons ---------------- */
  for (const a of ADD_ONS) {
    await prisma.addOn.upsert({
      where: { id: a.id },
      create: {
        id: a.id,
        slug: a.slug ?? a.id,
        nameEn: a.name.en,
        nameFr: a.name.fr,
        unitPriceCents: a.unitAmountCents,
        quantityBased: a.quantityEnabled,
        taxable: a.taxable,
        discountEligible: a.discountEligible ?? false,
        active: a.active,
      },
      update: {
        nameEn: a.name.en,
        nameFr: a.name.fr,
        unitPriceCents: a.unitAmountCents,
        quantityBased: a.quantityEnabled,
        active: a.active,
      },
    });
    result.addOns++;
  }

  /* ---------------- tax ----------------
   * GST and QST are both NON_COMPOUNDED: each is calculated independently
   * from the pre-tax taxable subtotal. displayOrder is presentation only and
   * must never imply compounding.
   */
  const taxes = [
    { id: 'tax_gst', code: 'GST', name: 'TPS / GST', rateMicroPercent: 5_000_000, order: 1 },
    { id: 'tax_qst', code: 'QST', name: 'TVQ / QST', rateMicroPercent: 9_975_000, order: 2 },
  ];
  for (const t of taxes) {
    await prisma.taxRule.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        code: t.code,
        name: t.name,
        rateMicroPercent: t.rateMicroPercent,
        compounding: 'NON_COMPOUNDED',
        displayOrder: t.order,
        active: true,
      },
      update: {
        rateMicroPercent: t.rateMicroPercent,
        compounding: 'NON_COMPOUNDED',
        displayOrder: t.order,
      },
    });
    result.taxRules++;
  }

  /* ---------------- transportation ---------------- */
  await prisma.transportationRule.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      baseAmountCents: 2500,
      includedDistanceKm: 20,
      extraKmRateCents: 65,
      quantityPerVisit: 1,
      taxable: true,
      discountEligible: false,
      enabled: true,
    },
    update: {
      baseAmountCents: 2500,
      includedDistanceKm: 20,
      extraKmRateCents: 65,
      quantityPerVisit: 1,
      taxable: true,
      discountEligible: false,
    },
  });
  result.transportationRules++;

  /* ---------------- promotions ----------------
   * Both new-customer promotions share the NEW_CUSTOMER family with a
   * lifetime limit of 1, so a customer cannot collect $15 on Basic and $20
   * on Deep. The legacy VIP promotion is seeded disabled pending owner
   * review — it is preserved, never silently activated.
   */
  const promos = [
    {
      id: 'promo_new_basic',
      code: 'NEW_CUSTOMER_BASIC',
      label: 'New customer — $15 off Basic',
      amountCents: 1500,
      categoryId: 'cat_basic',
      active: true,
      ownerReviewRequired: false,
    },
    {
      id: 'promo_new_deep',
      code: 'NEW_CUSTOMER_DEEP',
      label: 'New customer — $20 off Deep',
      amountCents: 2000,
      categoryId: 'cat_deep',
      active: true,
      ownerReviewRequired: false,
    },
    {
      id: 'promo_legacy_vip',
      code: 'LEGACY_VIP',
      label: 'Legacy VIP promotion — requires owner review',
      amountCents: 10000,
      categoryId: null,
      active: false,
      ownerReviewRequired: true,
    },
  ];
  for (const p of promos) {
    await prisma.promotion.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        code: p.code,
        label: p.label,
        type: 'FIXED',
        amountCents: p.amountCents,
        family: p.id === 'promo_legacy_vip' ? null : 'NEW_CUSTOMER',
        lifetimeMaxPerCustomer: p.id === 'promo_legacy_vip' ? null : 1,
        categoryId: p.categoryId,
        active: p.active,
        ownerReviewRequired: p.ownerReviewRequired,
      },
      update: {
        label: p.label,
        amountCents: p.amountCents,
        // active is intentionally NOT reset on re-seed: an owner who enables
        // or disables a promotion should not have it silently reverted.
      },
    });
    result.promotions++;
  }

  /* ---------------- business phones ----------------
   * Only the number already published by R2NETTE. Nothing invented.
   */
  await prisma.businessPhone.upsert({
    where: { phoneE164: '+15148252825' },
    create: {
      label: 'Booking',
      phoneE164: '+15148252825',
      displayNumber: '(514) 825-2825',
      purpose: 'BOOKING',
      isPublic: true,
      enabled: true,
      supportsInbound: true,
      supportsOutbound: false,
      priority: 0,
    },
    update: { displayNumber: '(514) 825-2825' },
  });

  /* ---------------- business configuration ---------------- */
  await prisma.businessConfiguration.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      timezone: 'America/Toronto',
      currency: 'CAD',
      quoteExpiryMinutes: 30,
      holdExpiryMinutes: 10,
      minimumLeadMinutes: 120,
      preJobBufferMinutes: 0,
      postJobBufferMinutes: 30,
      openMinute: 8 * 60,
      closeMinute: 17 * 60,
      generalHourlyMinimumMinutes: 180,
      monthlyDiscountMicro: 10_000_000,
      biweeklyDiscountMicro: 15_000_000,
      weeklyDiscountMicro: 25_000_000,
      productBasicCents: 1200,
      productDeepCents: 1500,
      defaultPaymentPolicy: 'PAY_LATER',
      recurringPaymentTiming: '24_HOURS_BEFORE',
      promotionStackingPolicy: 'BEST_SINGLE_DISCOUNT',
    },
    update: {
      timezone: 'America/Toronto',
      currency: 'CAD',
      productBasicCents: 1200,
      productDeepCents: 1500,
    },
  });
  result.businessConfiguration++;

  return result;
}

/* Direct execution: `npx vite-node prisma/seed.ts` */
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].includes('seed');

if (isMain) {
  const db = resolveDatabase(process.env);
  // eslint-disable-next-line no-console
  console.log(`Seeding ${db.describe} (${db.environment})`);
  const prisma = new PrismaClient();
  seed(prisma)
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log('Seed complete:', r);
    })
    .finally(() => prisma.$disconnect());
}

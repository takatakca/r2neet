import { describe, expect, it } from 'vitest';
import { createQuote, QuoteRequiredError, ValidationError } from '../src/engine/quote.js';
import {
  GUEST,
  recordRedemption,
  resolveDiscount,
  type CustomerEligibility,
} from '../src/engine/discounts.js';
import { calculateTax } from '../src/engine/tax.js';
import { buildRecurrenceDefinition, generateOccurrences } from '../src/engine/recurrence.js';
import { applyRate, dollars, divRoundHalfUp, percent } from '../src/domain/money.js';
import {
  CleaningFrequency,
  PaymentPolicyType,
  ProductSupplyType,
  QuoteLineType,
  TaxCompounding,
  WarningCode,
} from '../src/domain/types.js';
import { SERVICES, getService } from '../src/data/catalogue.js';
import { PROMOTIONS } from '../src/data/promotions.js';
import { BUSINESS_CONFIG, FREQUENCY_RULES, TAX_RULES, TRANSPORTATION_RULE } from '../src/data/config.js';

const BASIC_1x3 = 'svc_basic_1x3';
const DEEP_1x3 = 'svc_deep_1x3';

/** Pre-tax subtotal helper: everything except tax lines. */
const preTax = (q: ReturnType<typeof createQuote>) => q.subtotalBeforeTaxCents;
const line = (q: ReturnType<typeof createQuote>, type: string) =>
  q.lines.find((l) => l.type === type);

describe('TEST 1 — Basic one-time, client-supplied products', () => {
  it('is $110 service + $25 transport = $135 pre-tax', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      transport: { distanceKm: 0 },
      eligibility: { customerId: 'c1', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
    });
    expect(preTax(q)).toBe(13500);
  });
});

describe('TEST 2 — Basic weekly with R2NETTE products', () => {
  it('produces 11950 cents pre-tax with exact component amounts', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.WEEKLY,
      productSupplyOption: ProductSupplyType.R2NETTE_BASIC,
      transport: { distanceKm: 10 },
    });
    expect(line(q, QuoteLineType.SERVICE)!.subtotalCents).toBe(11000);
    expect(line(q, QuoteLineType.FREQUENCY_DISCOUNT)!.subtotalCents).toBe(-2750);
    expect(q.firstVisit.discountedServiceCents).toBe(8250);
    expect(line(q, QuoteLineType.PRODUCTS)!.subtotalCents).toBe(1200);
    expect(line(q, QuoteLineType.TRANSPORT)!.subtotalCents).toBe(2500);
    expect(preTax(q)).toBe(11950);
  });
});

describe('TEST 3 — Deep weekly with deep products', () => {
  it('produces 12625 cents pre-tax', () => {
    const q = createQuote({
      serviceOptionId: DEEP_1x3,
      frequency: CleaningFrequency.WEEKLY,
      productSupplyOption: ProductSupplyType.R2NETTE_DEEP,
      transport: { distanceKm: 5 },
    });
    expect(q.firstVisit.discountedServiceCents).toBe(8625);
    expect(preTax(q)).toBe(12625);
  });
});

describe('TEST 4 — Monthly discount is 10% and touches only the service', () => {
  it('discounts $11 and leaves products and transport whole', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.MONTHLY,
      productSupplyOption: ProductSupplyType.R2NETTE_BASIC,
      transport: { distanceKm: 0 },
      eligibility: { customerId: 'c2', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
    });
    expect(line(q, QuoteLineType.FREQUENCY_DISCOUNT)!.subtotalCents).toBe(-1100);
    expect(q.firstVisit.discountedServiceCents).toBe(9900);
    expect(line(q, QuoteLineType.PRODUCTS)!.subtotalCents).toBe(1200);
    expect(line(q, QuoteLineType.TRANSPORT)!.subtotalCents).toBe(2500);
  });
});

describe('TEST 5 — Biweekly discount is 15%', () => {
  it('discounts $16.50 leaving $93.50', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.BIWEEKLY,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'c3', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
    });
    expect(line(q, QuoteLineType.FREQUENCY_DISCOUNT)!.subtotalCents).toBe(-1650);
    expect(q.firstVisit.discountedServiceCents).toBe(9350);
  });
});

describe('TEST 6 — Client-supplied products', () => {
  it('is a $0 line that still records the decision', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
    });
    expect(line(q, QuoteLineType.PRODUCTS)!.subtotalCents).toBe(0);
    expect(q.productSupplySelection).toBe(ProductSupplyType.CLIENT_SUPPLIED);
    expect(q.jobSheetProducts).toBe('CLIENT SUPPLYING');
    expect(q.snapshot.productOption).not.toBeNull();
  });
});

describe('TEST 7 — Product amounts', () => {
  it('charges $12 basic and $15 deep', () => {
    const basic = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.R2NETTE_BASIC,
    });
    const deep = createQuote({
      serviceOptionId: DEEP_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.R2NETTE_DEEP,
    });
    expect(line(basic, QuoteLineType.PRODUCTS)!.subtotalCents).toBe(1200);
    expect(line(deep, QuoteLineType.PRODUCTS)!.subtotalCents).toBe(1500);
    expect(basic.jobSheetProducts).toBe('R2NETTE BASIC KIT');
    expect(deep.jobSheetProducts).toBe('R2NETTE DEEP KIT');
  });
});

describe('TEST 8 — One transport fee for a two-cleaner job', () => {
  it('charges $25 once, not $50', () => {
    const q = createQuote({
      serviceOptionId: 'svc_basic_2x2',
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
    });
    expect(q.requiredStaffCount).toBe(2);
    expect(line(q, QuoteLineType.TRANSPORT)!.subtotalCents).toBe(2500);
    expect(line(q, QuoteLineType.TRANSPORT)!.quantity).toBe(1);
  });
});

describe('TEST 9 — Distance within the included allowance', () => {
  it('adds no surcharge at exactly 20 km', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      transport: { distanceKm: 20 },
    });
    expect(line(q, QuoteLineType.DISTANCE)).toBeUndefined();
    expect(q.snapshot.transportation!.billableExtraKm).toBe(0);
  });
});

describe('TEST 10 — Distance beyond the allowance', () => {
  it('charges 10 km × $0.65 = $6.50 at 30 km', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      transport: { distanceKm: 30 },
    });
    expect(line(q, QuoteLineType.DISTANCE)!.subtotalCents).toBe(650);
    expect(q.snapshot.transportation!.billableExtraKm).toBe(10);
  });
});

describe('TEST 11 — Add-on quantity', () => {
  it('charges $10 × 2 loads of laundry', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      addOns: [{ id: 'addon_laundry', quantity: 2 }],
    });
    expect(line(q, QuoteLineType.ADD_ON)!.subtotalCents).toBe(2000);
  });
});

describe('TEST 12 — New customer Basic promotion', () => {
  it('applies $15 off for an eligible new customer', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'new1', familyRedemptions: {}, hasCompletedBooking: false },
    });
    expect(q.firstVisit.appliedDiscount!.source).toBe('NEW_CUSTOMER_BASIC');
    expect(q.firstVisit.appliedDiscount!.amountCents).toBe(1500);
    expect(q.firstVisit.discountedServiceCents).toBe(9500);
  });
});

describe('TEST 13 — New customer Deep promotion', () => {
  it('applies $20 off for an eligible new customer', () => {
    const q = createQuote({
      serviceOptionId: DEEP_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'new2', familyRedemptions: {}, hasCompletedBooking: false },
    });
    expect(q.firstVisit.appliedDiscount!.source).toBe('NEW_CUSTOMER_DEEP');
    expect(q.firstVisit.appliedDiscount!.amountCents).toBe(2000);
  });
});

describe('TEST 14 — Legacy VIP promotion', () => {
  it('is seeded disabled and never auto-applies', () => {
    const vip = PROMOTIONS.find((p) => p.code === 'LEGACY_VIP')!;
    expect(vip.active).toBe(false);
    expect(vip.ownerReviewRequired).toBe(true);

    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'new3', familyRedemptions: {}, hasCompletedBooking: false },
    });
    expect(q.firstVisit.appliedDiscount!.source).not.toBe('LEGACY_VIP');
    expect(q.firstVisit.discountedServiceCents).toBeGreaterThan(1000);
  });
});

describe('TEST 15 — Legacy weekly plan', () => {
  it('is not present in the public catalogue', () => {
    const leaked = SERVICES.find((s) => s.legacySetmoreName.includes('HEBDOMADAIRE'));
    expect(leaked).toBeUndefined();
  });
});

describe('TEST 16 — Window Cleaning is quote-required', () => {
  it('throws instead of returning a $0 checkout', () => {
    expect(() =>
      createQuote({ serviceOptionId: 'svc_window', frequency: CleaningFrequency.ONE_TIME }),
    ).toThrow(QuoteRequiredError);
    const window = getService('svc_window');
    expect(window.basePriceCents).toBeNull();
    expect(window.appointmentDurationMinutes).toBeNull();
  });
});

describe('TEST 17 — Money rounding is deterministic half-up', () => {
  it('rounds .5 away from zero and never uses floats', () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(4, 2)).toBe(2);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
    // 12.5% of $110 = $13.75 exactly
    expect(applyRate(11000, percent(12.5))).toBe(1375);
    // 33.333% of $99.99 = 33.32966... -> 3333
    expect(applyRate(9999, percent(33.333))).toBe(3333);
  });
});

describe('TEST 18 — GST and QST are separate line items', () => {
  it('returns two named tax lines', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'c4', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
    });
    expect(q.taxLines).toHaveLength(2);
    expect(q.taxLines.map((t) => t.code)).toEqual(['GST', 'QST']);
  });
});

describe('TEST 19 — Discount does not touch the product line', () => {
  it('[INV-TAX-03] leaves $12 products intact under a 25% weekly discount', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.WEEKLY,
      productSupplyOption: ProductSupplyType.R2NETTE_BASIC,
    });
    expect(line(q, QuoteLineType.PRODUCTS)!.subtotalCents).toBe(1200);
  });
});

describe('TEST 20 — Discount does not touch transportation', () => {
  it('[INV-TAX-04] leaves $25 transport intact under a 25% weekly discount', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.WEEKLY,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
    });
    expect(line(q, QuoteLineType.TRANSPORT)!.subtotalCents).toBe(2500);
  });
});

describe('TEST 21 — Discount does not touch the distance surcharge', () => {
  it('leaves the 30 km surcharge at $6.50 under a weekly discount', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.WEEKLY,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      transport: { distanceKm: 30 },
    });
    expect(line(q, QuoteLineType.DISTANCE)!.subtotalCents).toBe(650);
  });
});

describe('TEST 22 — Quote snapshot immutability', () => {
  it('keeps $110 after the persisted service price is mutated to $120', () => {
    const service = getService(BASIC_1x3);
    const originalPrice = service.basePriceCents;

    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'c5', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
    });
    const totalAtQuoteTime = q.grandTotalCents;

    // Mutate the live catalogue record, exactly as an admin price change would.
    (service as { basePriceCents: number }).basePriceCents = dollars(120);
    expect(getService(BASIC_1x3).basePriceCents).toBe(12000);

    // Re-read the previously issued quote. It must not re-price.
    expect(q.snapshot.serviceBasePriceCents).toBe(11000);
    expect(q.lines.find((l) => l.type === QuoteLineType.SERVICE)!.subtotalCents).toBe(11000);
    expect(q.grandTotalCents).toBe(totalAtQuoteTime);
    expect(q.snapshot.grandTotalCents).toBe(totalAtQuoteTime);

    // A NEW quote issued after the change reflects the new price.
    const q2 = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'c5', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
    });
    expect(q2.snapshot.serviceBasePriceCents).toBe(12000);
    expect(q2.grandTotalCents).toBeGreaterThan(totalAtQuoteTime);

    (service as { basePriceCents: number }).basePriceCents = originalPrice!;
  });
});

describe('TEST 23 — Deep 2×2 remains $130', () => {
  it('preserves the legacy price and flags it for review', () => {
    const s = getService('svc_deep_2x2');
    expect(s.basePriceCents).toBe(13000);
    expect(s.migrationReviewNote).toContain('$130');
  });
});

describe('TEST 24 — Deep 2×4 remains $260', () => {
  it('preserves the legacy price and flags the Basic collision', () => {
    const deep = getService('svc_deep_2x4');
    const basic = getService('svc_basic_2x4');
    expect(deep.basePriceCents).toBe(26000);
    expect(deep.basePriceCents).toBe(basic.basePriceCents);
    expect(deep.migrationReviewNote).toContain('identical');
  });
});

describe('TEST 25 — Invalid frequency rejected', () => {
  it('throws on an unknown frequency value', () => {
    expect(() =>
      createQuote({
        serviceOptionId: BASIC_1x3,
        frequency: 'FORTNIGHTLY' as never,
        productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      }),
    ).toThrow(ValidationError);
  });
});

describe('TEST 26 — Negative distance rejected', () => {
  it('throws on a negative km value', () => {
    expect(() =>
      createQuote({
        serviceOptionId: BASIC_1x3,
        frequency: CleaningFrequency.ONE_TIME,
        productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
        transport: { distanceKm: -5 },
      }),
    ).toThrow(ValidationError);
  });
});

describe('TEST 27 — Negative add-on quantity rejected', () => {
  it('throws on quantity below 1', () => {
    expect(() =>
      createQuote({
        serviceOptionId: BASIC_1x3,
        frequency: CleaningFrequency.ONE_TIME,
        productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
        addOns: [{ id: 'addon_laundry', quantity: -1 }],
      }),
    ).toThrow(ValidationError);
  });
});

describe('TEST 28 — Exact Québec tax on $135', () => {
  it('[INV-TAX-01] returns GST $6.75, QST $13.47, total $155.22 without compounding', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      transport: { distanceKm: 0 },
      eligibility: { customerId: 'c6', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
    });
    expect(q.taxableSubtotalCents).toBe(13500);

    const gst = q.taxLines.find((t) => t.code === 'GST')!;
    const qst = q.taxLines.find((t) => t.code === 'QST')!;
    expect(gst.amountCents).toBe(675);
    expect(qst.amountCents).toBe(1347);
    expect(q.taxTotalCents).toBe(2022);
    expect(q.grandTotalCents).toBe(15522);

    // Prove QST used the PRE-TAX base, not subtotal + GST.
    expect(qst.taxableBaseCents).toBe(13500);
    const compounded = applyRate(13500 + 675, percent(9.975));
    expect(qst.amountCents).not.toBe(compounded);
    expect(compounded).toBe(1414);
  });
});

describe('TEST 29 — Tax rounding half-up', () => {
  it('[INV-TAX-02] rounds $13.46625 up to $13.47', () => {
    expect(applyRate(13500, percent(9.975))).toBe(1347);
  });
});

describe('TEST 30 — Non-stackable: weekly beats the new-customer promo', () => {
  it('applies $27.50 only and does not consume the promotion', () => {
    const eligibility: CustomerEligibility = {
      customerId: 'w1',
      familyRedemptions: {},
      hasCompletedBooking: false,
    };
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.WEEKLY,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility,
    });
    expect(q.firstVisit.appliedDiscount!.source).toBe('WEEKLY_FREQUENCY');
    expect(q.firstVisit.appliedDiscount!.amountCents).toBe(2750);
    expect(q.firstVisit.discountedServiceCents).toBe(8250);

    // The $15 promo was evaluated, lost, and was NOT consumed.
    const loser = q.firstVisit.candidatesConsidered.find((c) => c.source === 'NEW_CUSTOMER_BASIC')!;
    expect(loser.eligible).toBe(true);
    expect(loser.applied).toBe(false);
    expect(q.snapshot.promotionApplied).toBeNull();
    expect(eligibility.familyRedemptions).toEqual({});
  });
});

describe('TEST 31 — Non-stackable: promo beats the monthly discount', () => {
  it('applies $15 only and drops the 10% for that visit', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.MONTHLY,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'm1', familyRedemptions: {}, hasCompletedBooking: false },
    });
    expect(q.firstVisit.appliedDiscount!.source).toBe('NEW_CUSTOMER_BASIC');
    expect(q.firstVisit.appliedDiscount!.amountCents).toBe(1500);
    expect(q.firstVisit.discountedServiceCents).toBe(9500);

    const monthly = q.firstVisit.candidatesConsidered.find((c) => c.source === 'MONTHLY_FREQUENCY')!;
    expect(monthly.amountCents).toBe(1100);
    expect(monthly.applied).toBe(false);
  });
});

describe('TEST 32 — New-customer lifetime limit across Basic and Deep', () => {
  it('makes the $20 Deep offer ineligible after the $15 Basic is redeemed', () => {
    const basicPromo = PROMOTIONS.find((p) => p.code === 'NEW_CUSTOMER_BASIC')!;
    let eligibility: CustomerEligibility = {
      customerId: 'life1',
      familyRedemptions: {},
      hasCompletedBooking: false,
    };

    const first = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility,
    });
    expect(first.firstVisit.appliedDiscount!.source).toBe('NEW_CUSTOMER_BASIC');

    // Booking confirmed + paid -> redemption recorded.
    eligibility = recordRedemption(eligibility, basicPromo);
    expect(eligibility.familyRedemptions['NEW_CUSTOMER']).toBe(1);

    const second = createQuote({
      serviceOptionId: DEEP_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility,
    });
    expect(second.firstVisit.appliedDiscount).toBeNull();
    const deepCandidate = second.firstVisit.candidatesConsidered.find(
      (c) => c.source === 'NEW_CUSTOMER_DEEP',
    )!;
    expect(deepCandidate.eligible).toBe(false);
    expect(deepCandidate.reason).toContain('lifetime limit');
  });
});

describe('TEST 33 — Unused promotion is not consumed', () => {
  it('leaves lifetime eligibility untouched when weekly wins', () => {
    const eligibility: CustomerEligibility = {
      customerId: 'u1',
      familyRedemptions: {},
      hasCompletedBooking: false,
    };
    createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.WEEKLY,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility,
    });
    expect(eligibility.familyRedemptions['NEW_CUSTOMER']).toBeUndefined();

    // Still eligible on a later one-time booking.
    const later = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility,
    });
    expect(later.firstVisit.appliedDiscount!.source).toBe('NEW_CUSTOMER_BASIC');
  });
});

describe('TEST 34 — Quote generation never writes a redemption', () => {
  it('does not mutate eligibility even when the promotion wins', () => {
    const eligibility = { customerId: 'nr1', familyRedemptions: {}, hasCompletedBooking: false };
    const before = JSON.stringify(eligibility);

    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility,
    });
    expect(q.firstVisit.appliedDiscount!.source).toBe('NEW_CUSTOMER_BASIC');
    expect(JSON.stringify(eligibility)).toBe(before);

    // Generating ten more quotes still consumes nothing.
    for (let i = 0; i < 10; i++) {
      createQuote({
        serviceOptionId: BASIC_1x3,
        frequency: CleaningFrequency.ONE_TIME,
        productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
        eligibility,
      });
    }
    expect(JSON.stringify(eligibility)).toBe(before);
  });
});

describe('TEST 35 — Monthly recurrence is a calendar rule, not 30 days', () => {
  it('clamps Jan 31 to Feb and returns to 31 in March', () => {
    const rule = FREQUENCY_RULES[CleaningFrequency.MONTHLY];
    expect(rule.intervalDays).toBeNull();
    expect(rule.recurrenceKind).toBe('CALENDAR_MONTH');

    const start = new Date(Date.UTC(2027, 0, 31, 15, 0));
    const def = buildRecurrenceDefinition(rule, start);
    expect(def.preferredDayOfMonth).toBe(31);

    const dates = generateOccurrences(def, start, 5).map((d) => d.toISOString().slice(0, 10));
    expect(dates).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);

    // Leap year clamps to the 29th.
    const leap = new Date(Date.UTC(2028, 0, 31, 15, 0));
    const leapDates = generateOccurrences(
      buildRecurrenceDefinition(rule, leap), leap, 2,
    ).map((d) => d.toISOString().slice(0, 10));
    expect(leapDates[1]).toBe('2028-02-29');

    // Weekly is every 7 days and yields five visits in a 31-day month.
    const weekly = FREQUENCY_RULES[CleaningFrequency.WEEKLY];
    expect(weekly.intervalDays).toBe(7);
    const wStart = new Date(Date.UTC(2026, 6, 1, 14, 0));
    const wDates = generateOccurrences(buildRecurrenceDefinition(weekly, wStart), wStart, 5);
    expect(wDates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29',
    ]);
  });
});

describe('TEST 36 — Carpet cleaning cannot be weekly', () => {
  it('rejects a recurring frequency', () => {
    expect(() =>
      createQuote({ serviceOptionId: 'svc_carpet', frequency: CleaningFrequency.WEEKLY }),
    ).toThrow(ValidationError);
  });
});

describe('TEST 37 — Move-In/Out cannot be biweekly', () => {
  it('rejects a recurring frequency', () => {
    expect(() =>
      createQuote({
        serviceOptionId: 'svc_move',
        frequency: CleaningFrequency.BIWEEKLY,
        productSupplyOption: ProductSupplyType.R2NETTE_DEEP,
      }),
    ).toThrow(ValidationError);
  });
});

describe('TEST 38 — Carpet cleaning rejects product charges', () => {
  it('refuses a basic product kit on a NOT_APPLICABLE service', () => {
    expect(() =>
      createQuote({
        serviceOptionId: 'svc_carpet',
        frequency: CleaningFrequency.ONE_TIME,
        productSupplyOption: ProductSupplyType.R2NETTE_BASIC,
      }),
    ).toThrow(ValidationError);

    // But prices fine with no product selection at all.
    const ok = createQuote({ serviceOptionId: 'svc_carpet', frequency: CleaningFrequency.ONE_TIME });
    expect(ok.lines.find((l) => l.type === QuoteLineType.PRODUCTS)).toBeUndefined();
    expect(ok.jobSheetProducts).toBe('NOT APPLICABLE');
  });
});

describe('TEST 39 — Missing required product selection rejected', () => {
  it('will not price a Basic cleaning without a products answer', () => {
    expect(() =>
      createQuote({ serviceOptionId: BASIC_1x3, frequency: CleaningFrequency.ONE_TIME }),
    ).toThrow(ValidationError);
  });
});

describe('TEST 40 — Default payment policy is PAY_LATER', () => {
  it('matches current Setmore behaviour of collecting $0 online', () => {
    expect(BUSINESS_CONFIG.defaultPaymentPolicy).toBe(PaymentPolicyType.PAY_LATER);
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
    });
    expect(q.paymentPolicy).toBe(PaymentPolicyType.PAY_LATER);
    expect(q.amountDueNowCents).toBe(0);
  });
});

describe('TEST 41 — Transportation is taxable', () => {
  it('includes the $25 fee in the taxable subtotal', () => {
    expect(TRANSPORTATION_RULE.taxable).toBe(true);
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'c7', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
    });
    const gst = q.taxLines.find((t) => t.code === 'GST')!;
    expect(gst.taxableBaseCents).toBe(13500);
    expect(q.taxableSubtotalCents).toBe(13500);
  });
});

describe('TEST 42 — Server ignores a client-supplied total', () => {
  it('[INV-TAX-05] returns its own authoritative amount', () => {
    const hostile = {
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { customerId: 'c8', familyRedemptions: { NEW_CUSTOMER: 1 }, hasCompletedBooking: true },
      total: 1.0,
      grandTotalCents: 100,
      amountDueNowCents: 100,
    } as never;
    const q = createQuote(hostile);
    expect(q.grandTotalCents).toBe(15522);
    expect(q.grandTotalCents).not.toBe(100);
  });
});

describe('TEST 43 — Monthly first visit vs subsequent visit', () => {
  it('exposes $95 first and $99 preview without blending or consuming', () => {
    const eligibility = { ...GUEST };
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.MONTHLY,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility,
    });

    expect(q.firstVisit.appliedDiscount!.source).toBe('NEW_CUSTOMER_BASIC');
    expect(q.firstVisit.appliedDiscount!.amountCents).toBe(1500);
    expect(q.firstVisit.discountedServiceCents).toBe(9500);

    expect(q.subsequentVisitPricingPreview).not.toBeNull();
    expect(q.subsequentVisitPricingPreview!.appliedDiscount!.source).toBe('MONTHLY_FREQUENCY');
    expect(q.subsequentVisitPricingPreview!.appliedDiscount!.amountCents).toBe(1100);
    expect(q.subsequentVisitPricingPreview!.discountedServiceCents).toBe(9900);

    expect(q.warningCodes).toContain(WarningCode.NEW_CUSTOMER_ELIGIBILITY_UNVERIFIED);
    expect(q.firstVisit.eligibilityStatus).toBe('PROVISIONAL');
    expect(eligibility.familyRedemptions).toEqual({});

    // The two prices are never averaged into one number.
    expect(q.firstVisit.discountedServiceCents).not.toBe(
      q.subsequentVisitPricingPreview!.discountedServiceCents,
    );
  });
});

describe('TEST 44 — Recurring quote shape is unconditional', () => {
  it('emits both sections for weekly even though the amounts match', () => {
    const q = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.WEEKLY,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
      eligibility: { ...GUEST },
    });
    expect(q.firstVisit).toBeDefined();
    expect(q.subsequentVisitPricingPreview).not.toBeNull();
    expect(q.firstVisit.discountedServiceCents).toBe(8250);
    expect(q.subsequentVisitPricingPreview!.discountedServiceCents).toBe(8250);
    expect(q.firstVisit.appliedDiscount!.source).toBe('WEEKLY_FREQUENCY');
    expect(q.subsequentVisitPricingPreview!.appliedDiscount!.source).toBe('WEEKLY_FREQUENCY');

    // One-time quotes carry no preview at all.
    const once = createQuote({
      serviceOptionId: BASIC_1x3,
      frequency: CleaningFrequency.ONE_TIME,
      productSupplyOption: ProductSupplyType.CLIENT_SUPPLIED,
    });
    expect(once.subsequentVisitPricingPreview).toBeNull();
  });
});

describe('Guard — tax rules are non-compounding by configuration', () => {
  it('refuses to calculate if a compounded rule is ever introduced', () => {
    const bad = TAX_RULES.map((r) =>
      r.code === 'QST' ? { ...r, compounding: TaxCompounding.COMPOUNDED } : r,
    );
    expect(() => calculateTax([], bad)).toThrow(/compounded/i);
  });
});

describe('Guard — discount resolution is pure', () => {
  it('never mutates the eligibility object it is given', () => {
    const eligibility = { customerId: 'p1', familyRedemptions: {}, hasCompletedBooking: false };
    resolveDiscount({
      service: getService(BASIC_1x3),
      baseServiceCents: 11000,
      frequency: CleaningFrequency.ONE_TIME,
      frequencyRule: FREQUENCY_RULES[CleaningFrequency.ONE_TIME],
      promotions: PROMOTIONS,
      eligibility,
      isFirstVisit: true,
    });
    expect(eligibility.familyRedemptions).toEqual({});
  });
});

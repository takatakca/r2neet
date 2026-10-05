import { Prisma, type PrismaClient } from '@prisma/client';
import { buildRecurrenceDefinition, generateOccurrences } from '../engine/recurrence.js';
import { createQuote } from '../engine/quote.js';
import { SERVICES } from '../data/catalogue.js';
import {
  CleaningFrequency,
  RecurrenceKind,
  ShortMonthPolicy,
  ProductSupplyType,
} from '../domain/types.js';
import { verifySlotStillOpen, type StaffBusy } from '../scheduling/availability.js';
import { acquireCapacityLocks, loadBusy } from '../db/prisma-repositories.js';
import { formatBookingNumber } from './booking.js';

/**
 * Turning a recurring plan into real bookings.
 *
 * Without this a weekly customer books once and nothing else ever happens —
 * the 25% plan is a promise the system does not keep.
 *
 * Three rules:
 *
 * 1. **Every occurrence is priced fresh.** Products, travel, tax and the
 *    catalogue can all change between visits, so each booking gets its own
 *    quote and its own frozen snapshot. This is why the booking flow calls
 *    the later-visit figure a *preview* and not a promise.
 *
 * 2. **Capacity is verified, never assumed.** An occurrence that cannot be
 *    staffed is recorded as needing attention rather than created as a
 *    booking nobody can service.
 *
 * 3. **Generation is idempotent.** The worker can run every five minutes, or
 *    twice at once, without producing duplicates.
 */

export const HORIZON_DAYS = 35;

export type OccurrenceOutcome =
  | 'CREATED'
  | 'ALREADY_EXISTS'
  | 'SKIPPED_BY_CUSTOMER'
  | 'NO_CAPACITY'
  | 'OUTSIDE_HORIZON'
  | 'SERIES_INACTIVE';

export interface MaterialiseResult {
  seriesId: string;
  created: number;
  skipped: number;
  noCapacity: number;
  outcomes: { at: string; outcome: OccurrenceOutcome; bookingNumber?: string }[];
}

const FREQUENCY_RULE: Record<
  string,
  { kind: RecurrenceKind; intervalDays: number | null; discountMicro: number }
> = {
  WEEKLY: { kind: RecurrenceKind.FIXED_INTERVAL_DAYS, intervalDays: 7, discountMicro: 25_000_000 },
  BIWEEKLY: { kind: RecurrenceKind.FIXED_INTERVAL_DAYS, intervalDays: 14, discountMicro: 15_000_000 },
  MONTHLY: { kind: RecurrenceKind.CALENDAR_MONTH, intervalDays: null, discountMicro: 10_000_000 },
};

export class RecurrenceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Upcoming dates for a plan, for the account page and dispatch. */
  async upcomingDates(seriesId: string, count = 6): Promise<Date[]> {
    const series = await this.prisma.recurrenceSeries.findUniqueOrThrow({
      where: { id: seriesId },
    });
    const rule = FREQUENCY_RULE[series.frequency];
    if (!rule) return [];

    const definition = buildRecurrenceDefinition(
      {
        frequency: series.frequency as CleaningFrequency,
        recurrenceKind: rule.kind,
        intervalDays: rule.intervalDays,
        shortMonthPolicy: ShortMonthPolicy.CLAMP_TO_LAST_DAY,
      } as never,
      series.startAt,
      series.timezone,
    );

    const skip = new Set((series.configSnapshot as { skipDates?: string[] } | null)?.skipDates ?? []);
    const at = this.now();

    // Generate generously, then filter: skips must not shorten the horizon.
    return generateOccurrences(definition, series.startAt, count * 4)
      .filter((d) => d > at)
      .filter((d) => !skip.has(this.dateKey(d, series.timezone)))
      .slice(0, count);
  }

  private dateKey(d: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }

  /**
   * Create any bookings due inside the horizon for one plan.
   *
   * Safe to call repeatedly: an occurrence that already has a booking is
   * reported as ALREADY_EXISTS and left alone.
   */
  async materialiseSeries(seriesId: string): Promise<MaterialiseResult> {
    const at = this.now();
    const result: MaterialiseResult = {
      seriesId,
      created: 0,
      skipped: 0,
      noCapacity: 0,
      outcomes: [],
    };

    const series = await this.prisma.recurrenceSeries.findUniqueOrThrow({
      where: { id: seriesId },
      include: { service: true, address: true },
    });

    if (series.status !== 'ACTIVE') {
      result.outcomes.push({ at: at.toISOString(), outcome: 'SERIES_INACTIVE' });
      return result;
    }
    if (series.endAt && series.endAt < at) {
      result.outcomes.push({ at: at.toISOString(), outcome: 'SERIES_INACTIVE' });
      return result;
    }

    const service = SERVICES.find((s) => s.id === series.serviceOptionId);
    if (!service || service.appointmentDurationMinutes === null) {
      result.outcomes.push({ at: at.toISOString(), outcome: 'SERIES_INACTIVE' });
      return result;
    }

    const horizonEnd = new Date(at.getTime() + HORIZON_DAYS * 86400000);
    const dates = (await this.upcomingDates(seriesId, 12)).filter((d) => d <= horizonEnd);

    for (const start of dates) {
      const end = new Date(start.getTime() + service.appointmentDurationMinutes * 60000);

      // Idempotency: one booking per series per instant.
      const existing = await this.prisma.booking.findFirst({
        where: {
          customerId: series.customerId,
          serviceOptionId: series.serviceOptionId,
          startAt: start,
          status: { notIn: ['CANCELLED'] },
        },
      });
      if (existing) {
        result.outcomes.push({
          at: start.toISOString(),
          outcome: 'ALREADY_EXISTS',
          bookingNumber: existing.bookingNumber,
        });
        continue;
      }

      // Priced fresh, every time.
      const quote = createQuote({
        serviceOptionId: series.serviceOptionId,
        frequency: series.frequency as CleaningFrequency,
        productSupplyOption: (series.productSupply ?? undefined) as ProductSupplyType | undefined,
        transport: { distanceKm: 0 },
        eligibility: {
          customerId: series.customerId,
          // A recurring visit is never a first booking, so the welcome offer
          // is not in play here.
          familyRedemptions: { NEW_CUSTOMER: 1 },
          hasCompletedBooking: true,
        },
      });

      try {
        const created = await this.prisma.$transaction(async (tx) => {
          // The same locks as holds, confirmations and reschedules. A key of
          // our own would never contend with a customer confirming an
          // overlapping visit, and both bookings would land on one crew.
          await acquireCapacityLocks(tx, { startUtc: start, endUtc: end });

          const staff = await tx.staff.findMany({
            where: { active: true },
            include: { skills: true, availability: true },
          });
          // The same busy view holds and confirmations use: active holds,
          // time off, and jobs within travel-buffer distance, not only
          // bookings overlapping this exact window. Holds are judged live by
          // this run's clock.
          const busy: StaffBusy[] = await loadBusy(tx, { startUtc: start, endUtc: end });

          const check = verifySlotStillOpen(
            service,
            start,
            staff.map((s) => ({
              id: s.id,
              displayName: s.displayName,
              active: s.active,
              skills: s.skills.map((k) => k.serviceOptionId),
              weeklyAvailability: s.availability.map((a) => ({
                weekday: a.weekday,
                startMinute: a.startMinute,
                endMinute: a.endMinute,
              })),
            })),
            busy,
            at,
          );
          if (!check.ok) return null;

          const persistedQuote = await tx.quote.create({
            data: {
              customerId: series.customerId,
              serviceOptionId: series.serviceOptionId,
              frequency: series.frequency,
              baseServiceCents: quote.firstVisit?.baseServiceCents ?? 0,
              subtotalCents: quote.subtotalBeforeTaxCents,
              gstCents: quote.taxLines[0]?.amountCents ?? 0,
              qstCents: quote.taxLines[1]?.amountCents ?? 0,
              taxTotalCents: quote.taxTotalCents,
              grandTotalCents: quote.grandTotalCents,
              gstRateMicroPercent: 5_000_000,
              qstRateMicroPercent: 9_975_000,
              pricingVersion: quote.pricingVersion ?? 'recurring',
              priceSnapshot: JSON.parse(JSON.stringify(quote)),
              expiresAt: new Date(start.getTime()),
            },
          });

          const year = at.getUTCFullYear();
          await tx.$executeRaw`
            INSERT INTO "BookingNumberSequence" ("year","lastValue","updatedAt")
            VALUES (${year}, 0, now()) ON CONFLICT ("year") DO NOTHING`;
          const rows = await tx.$queryRaw<{ lastValue: number }[]>`
            UPDATE "BookingNumberSequence" SET "lastValue" = "lastValue" + 1, "updatedAt" = now()
            WHERE "year" = ${year} RETURNING "lastValue"`;

          return tx.booking.create({
            data: {
              bookingNumber: formatBookingNumber(year, rows[0]!.lastValue),
              customerId: series.customerId,
              serviceOptionId: series.serviceOptionId,
              addressId: series.addressId,
              quoteId: persistedQuote.id,
              startAt: start,
              endAt: end,
              status: 'CONFIRMED',
              grandTotalCents: quote.grandTotalCents,
              priceSnapshot: JSON.parse(JSON.stringify(quote)),
              staff: { create: check.staffIds.map((staffId) => ({ staffId })) },
              history: {
                create: [
                  {
                    status: 'CONFIRMED',
                    actor: 'RECURRENCE',
                    reason: `Generated from plan ${seriesId}`,
                  },
                ],
              },
            },
          });
        });

        if (created) {
          result.created++;
          result.outcomes.push({
            at: start.toISOString(),
            outcome: 'CREATED',
            bookingNumber: created.bookingNumber,
          });
        } else {
          // Surfaced to dispatch rather than silently dropped.
          result.noCapacity++;
          result.outcomes.push({ at: start.toISOString(), outcome: 'NO_CAPACITY' });
        }
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          result.outcomes.push({ at: start.toISOString(), outcome: 'ALREADY_EXISTS' });
          continue;
        }
        throw e;
      }
    }

    return result;
  }

  /** Run every active plan. This is what a scheduled worker calls. */
  async materialiseAll(): Promise<MaterialiseResult[]> {
    const series = await this.prisma.recurrenceSeries.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    const out: MaterialiseResult[] = [];
    for (const s of series) {
      out.push(await this.materialiseSeries(s.id));
    }
    return out;
  }

  /** Skip one visit without breaking the rhythm of the plan. */
  async skipOccurrence(seriesId: string, dateKey: string, customerId: string) {
    const series = await this.prisma.recurrenceSeries.findUniqueOrThrow({ where: { id: seriesId } });
    if (series.customerId !== customerId) throw new Error('NOT_FOUND');

    const snapshot = (series.configSnapshot as { skipDates?: string[] } | null) ?? {};
    const skipDates = new Set(snapshot.skipDates ?? []);
    skipDates.add(dateKey);

    await this.prisma.recurrenceSeries.update({
      where: { id: seriesId },
      data: { configSnapshot: { ...snapshot, skipDates: [...skipDates] } as never },
    });

    // Cancel a materialised booking on that day, if one exists.
    const dayStart = new Date(`${dateKey}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 2 * 86400000);
    const booking = await this.prisma.booking.findFirst({
      where: {
        customerId,
        serviceOptionId: series.serviceOptionId,
        startAt: { gte: dayStart, lt: dayEnd },
        status: { notIn: ['CANCELLED'] },
      },
    });
    if (booking) {
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'CANCELLED' },
      });
      await this.prisma.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          status: 'CANCELLED',
          actor: `CUSTOMER:${customerId}`,
          reason: 'Skipped one visit in recurring plan',
        },
      });
    }
    return { skipped: dateKey };
  }

  /** Pause or resume. Pausing stops generation without losing the plan. */
  async setStatus(seriesId: string, status: 'ACTIVE' | 'PAUSED' | 'CANCELLED', customerId: string) {
    const series = await this.prisma.recurrenceSeries.findUniqueOrThrow({ where: { id: seriesId } });
    if (series.customerId !== customerId) throw new Error('NOT_FOUND');
    return this.prisma.recurrenceSeries.update({ where: { id: seriesId }, data: { status } });
  }
}

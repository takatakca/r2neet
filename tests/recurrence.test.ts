import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildRecurrenceDefinition, generateOccurrences } from '../src/engine/recurrence.js';
import { CleaningFrequency, RecurrenceKind, ShortMonthPolicy } from '../src/domain/types.js';
import { localToUtc } from '../src/scheduling/availability.js';
import { RecurrenceService } from '../src/booking/recurrence-service.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));

/** Local Toronto wall-clock time, which is what the customer actually sees. */
const wall = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

const dayOf = (date: Date) =>
  Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', day: 'numeric' }).format(date),
  );

function rule(frequency: CleaningFrequency, kind: RecurrenceKind, intervalDays: number | null) {
  return {
    frequency,
    recurrenceKind: kind,
    intervalDays,
    shortMonthPolicy: ShortMonthPolicy.CLAMP_TO_LAST_DAY,
  } as never;
}

describe('recurrence dates', () => {
  it('[INV-TIME-01] WEEKLY keeps the wall-clock time across the November fall-back', () => {
    // 20 Oct 2026 at 10:00 EDT; the clocks go back on 1 Nov.
    const start = localToUtc(2026, 10, 20, 10 * 60);
    const def = buildRecurrenceDefinition(
      rule(CleaningFrequency.WEEKLY, RecurrenceKind.FIXED_INTERVAL_DAYS, 7),
      start,
    );
    const dates = generateOccurrences(def, start, 4);
    // Naive UTC arithmetic silently moved this to 09:00 for the whole winter.
    expect(dates.map(wall)).toEqual(['10:00', '10:00', '10:00', '10:00']);
  });

  it('WEEKLY keeps the wall-clock time across the March spring-forward', () => {
    const start = localToUtc(2026, 2, 24, 9 * 60);
    const def = buildRecurrenceDefinition(
      rule(CleaningFrequency.WEEKLY, RecurrenceKind.FIXED_INTERVAL_DAYS, 7),
      start,
    );
    expect(generateOccurrences(def, start, 4).map(wall)).toEqual(['09:00', '09:00', '09:00', '09:00']);
  });

  it('WEEKLY is every 7 days, so a five-visit month gets five visits', () => {
    const start = localToUtc(2026, 7, 1, 10 * 60); // July 2026 begins on a Wednesday
    const def = buildRecurrenceDefinition(
      rule(CleaningFrequency.WEEKLY, RecurrenceKind.FIXED_INTERVAL_DAYS, 7),
      start,
    );
    const july = generateOccurrences(def, start, 6).filter(
      (x) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'numeric' }).format(x) === '7',
    );
    expect(july.length).toBe(5);
  });

  it('BIWEEKLY is every 14 days', () => {
    const start = localToUtc(2026, 6, 3, 13 * 60);
    const def = buildRecurrenceDefinition(
      rule(CleaningFrequency.BIWEEKLY, RecurrenceKind.FIXED_INTERVAL_DAYS, 14),
      start,
    );
    const dates = generateOccurrences(def, start, 3);
    expect(dayOf(dates[1]!)).toBe(17);
    expect(dates.map(wall)).toEqual(['13:00', '13:00', '13:00']);
  });

  it('[INV-TIME-02] MONTHLY from the 31st clamps in February and RETURNS to the 31st', () => {
    const start = localToUtc(2026, 1, 31, 9 * 60);
    const def = buildRecurrenceDefinition(
      rule(CleaningFrequency.MONTHLY, RecurrenceKind.CALENDAR_MONTH, null),
      start,
    );
    const dates = generateOccurrences(def, start, 5);
    // The preferred day is never overwritten by the clamp.
    expect(dates.map(dayOf)).toEqual([31, 28, 31, 30, 31]);
    expect(dates.every((x) => wall(x) === '09:00')).toBe(true);
  });

  it('MONTHLY handles a leap February', () => {
    const start = localToUtc(2028, 1, 30, 9 * 60);
    const def = buildRecurrenceDefinition(
      rule(CleaningFrequency.MONTHLY, RecurrenceKind.CALENDAR_MONTH, null),
      start,
    );
    expect(generateOccurrences(def, start, 3).map(dayOf)).toEqual([30, 29, 30]);
  });

  it('MONTHLY is not 30 days', () => {
    const start = localToUtc(2026, 1, 15, 10 * 60);
    const def = buildRecurrenceDefinition(
      rule(CleaningFrequency.MONTHLY, RecurrenceKind.CALENDAR_MONTH, null),
      start,
    );
    const dates = generateOccurrences(def, start, 3);
    expect(dates.map(dayOf)).toEqual([15, 15, 15]);
    // 30-day arithmetic would have produced the 14th, then the 13th.
  });

  it('MONTHLY rolls the year correctly', () => {
    const start = localToUtc(2026, 11, 20, 10 * 60);
    const def = buildRecurrenceDefinition(
      rule(CleaningFrequency.MONTHLY, RecurrenceKind.CALENDAR_MONTH, null),
      start,
    );
    const dates = generateOccurrences(def, start, 3);
    const year = (x: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric' }).format(x);
    expect(year(dates[2]!)).toBe('2027');
    expect(dates.map(dayOf)).toEqual([20, 20, 20]);
  });
});

d('recurrence materialisation', () => {
  let prisma: PrismaClient;
  let service: RecurrenceService;
  let customerId: string;
  let addressId: string;
  let seriesId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.staffAvailability.deleteMany();
    await prisma.staff.deleteMany();
    await prisma.bookingNumberSequence.deleteMany();
    await seed(prisma);

    await prisma.staff.create({ data: { displayName: 'Alice', availability: { create: ALL_WEEK } } });
    await prisma.staff.create({ data: { displayName: 'Bruno', availability: { create: ALL_WEEK } } });

    const c = await prisma.customer.create({ data: { firstName: 'Pascal' } });
    customerId = c.id;
    const a = await prisma.customerAddress.create({
      data: {
        customerId,
        formattedAddress: '754 Av. 36e, Lachine',
        city: 'Lachine',
        postalCode: 'H8T1B7',
        isDefault: true,
      },
    });
    addressId = a.id;

    // Weekly plan starting tomorrow at 10:00 local.
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() + 86400000));
    const [y, m, dd] = key.split('-').map(Number);

    const s = await prisma.recurrenceSeries.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId,
        frequency: 'WEEKLY',
        recurrenceKind: 'FIXED_INTERVAL_DAYS',
        productSupply: 'CLIENT_SUPPLIED',
        startAt: localToUtc(y!, m!, dd!, 10 * 60),
        status: 'ACTIVE',
      },
    });
    seriesId = s.id;
    service = new RecurrenceService(prisma);
  });

  it('lists upcoming dates for a plan', async () => {
    const dates = await service.upcomingDates(seriesId, 4);
    expect(dates).toHaveLength(4);
    expect(dates.every((x) => wall(x) === '10:00')).toBe(true);
    // Seven days apart, in local terms.
    const gapDays = (dates[1]!.getTime() - dates[0]!.getTime()) / 86400000;
    expect(Math.round(gapDays)).toBe(7);
  });

  it('creates real bookings inside the horizon, with a frozen price snapshot', async () => {
    const res = await service.materialiseSeries(seriesId);
    expect(res.created).toBeGreaterThan(0);

    const bookings = await prisma.booking.findMany({
      where: { customerId },
      include: { staff: true },
      orderBy: { startAt: 'asc' },
    });
    expect(bookings.length).toBe(res.created);
    for (const b of bookings) {
      expect(b.bookingNumber).toMatch(/^R2N-\d{4}-\d{6}$/);
      expect(b.staff).toHaveLength(2); // a 2-cleaner service really got 2
      expect(b.grandTotalCents).toBeGreaterThan(0);
      expect(b.priceSnapshot).toBeTruthy();
    }
  });

  it('prices each occurrence fresh rather than copying the first', async () => {
    await service.materialiseSeries(seriesId);
    const quotes = await prisma.quote.findMany({ where: { customerId } });
    const bookings = await prisma.booking.count({ where: { customerId } });
    // One quote per booking, not one shared quote.
    expect(quotes.length).toBe(bookings);
  });

  it('[INV-CAP-03] is idempotent: running twice creates nothing extra', async () => {
    const first = await service.materialiseSeries(seriesId);
    const second = await service.materialiseSeries(seriesId);

    expect(second.created).toBe(0);
    expect(second.outcomes.every((o) => o.outcome === 'ALREADY_EXISTS')).toBe(true);
    expect(await prisma.booking.count({ where: { customerId } })).toBe(first.created);
  });

  it('two concurrent workers do not double-book the customer', async () => {
    const other = new PrismaClient({ datasources: { db: { url: URL } } });
    try {
      const a = new RecurrenceService(prisma);
      const b = new RecurrenceService(other);
      await Promise.all([a.materialiseSeries(seriesId), b.materialiseSeries(seriesId)]);

      const bookings = await prisma.booking.findMany({ where: { customerId } });
      const starts = bookings.map((x) => x.startAt.toISOString());
      expect(new Set(starts).size).toBe(starts.length); // no duplicate instants
    } finally {
      await other.$disconnect();
    }
  });

  it('does not generate beyond the horizon', async () => {
    const res = await service.materialiseSeries(seriesId);
    const horizon = new Date(Date.now() + 36 * 86400000);
    const bookings = await prisma.booking.findMany({ where: { customerId } });
    expect(bookings.every((b) => b.startAt <= horizon)).toBe(true);
    expect(res.created).toBeLessThanOrEqual(6);
  });

  it('records NO_CAPACITY instead of creating a job nobody can service', async () => {
    // Take both cleaners off the roster entirely.
    await prisma.staff.updateMany({ data: { active: false } });
    const res = await service.materialiseSeries(seriesId);

    expect(res.created).toBe(0);
    expect(res.noCapacity).toBeGreaterThan(0);
    expect(await prisma.booking.count({ where: { customerId } })).toBe(0);
  });

  it('a paused plan generates nothing', async () => {
    await service.setStatus(seriesId, 'PAUSED', customerId);
    const res = await service.materialiseSeries(seriesId);
    expect(res.created).toBe(0);
    expect(res.outcomes[0]!.outcome).toBe('SERIES_INACTIVE');
  });

  it('resuming a paused plan starts generating again', async () => {
    await service.setStatus(seriesId, 'PAUSED', customerId);
    await service.materialiseSeries(seriesId);
    await service.setStatus(seriesId, 'ACTIVE', customerId);
    const res = await service.materialiseSeries(seriesId);
    expect(res.created).toBeGreaterThan(0);
  });

  it('one customer cannot pause another customer plan', async () => {
    const other = await prisma.customer.create({ data: {} });
    await expect(service.setStatus(seriesId, 'PAUSED', other.id)).rejects.toThrow(/NOT_FOUND/);
  });

  it('skipping one visit cancels that booking without shifting the rest', async () => {
    await service.materialiseSeries(seriesId);
    const before = await prisma.booking.findMany({
      where: { customerId, status: { notIn: ['CANCELLED'] } },
      orderBy: { startAt: 'asc' },
    });
    const target = before[1]!;
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(target.startAt);

    await service.skipOccurrence(seriesId, key, customerId);

    const cancelled = await prisma.booking.findUniqueOrThrow({ where: { id: target.id } });
    expect(cancelled.status).toBe('CANCELLED');

    // The rhythm is unchanged: the later visits keep their original dates.
    const after = await prisma.booking.findMany({
      where: { customerId, status: { notIn: ['CANCELLED'] } },
      orderBy: { startAt: 'asc' },
    });
    const untouched = before.filter((b) => b.id !== target.id).map((b) => b.startAt.toISOString());
    expect(after.map((b) => b.startAt.toISOString())).toEqual(untouched);
  });

  it('a skipped date is not regenerated on the next run', async () => {
    await service.materialiseSeries(seriesId);
    const bookings = await prisma.booking.findMany({
      where: { customerId },
      orderBy: { startAt: 'asc' },
    });
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(bookings[1]!.startAt);

    await service.skipOccurrence(seriesId, key, customerId);
    await service.materialiseSeries(seriesId);

    const active = await prisma.booking.findMany({
      where: { customerId, status: { notIn: ['CANCELLED'] } },
    });
    const keys = active.map((b) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(b.startAt),
    );
    expect(keys).not.toContain(key);
  });

  it('materialiseAll covers every active plan and ignores paused ones', async () => {
    const second = await prisma.recurrenceSeries.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId,
        frequency: 'MONTHLY',
        recurrenceKind: 'CALENDAR_MONTH',
        startAt: new Date(Date.now() + 2 * 86400000),
        status: 'PAUSED',
      },
    });
    const results = await service.materialiseAll();
    expect(results.some((r) => r.seriesId === seriesId)).toBe(true);
    expect(results.some((r) => r.seriesId === second.id)).toBe(false);
  });
});

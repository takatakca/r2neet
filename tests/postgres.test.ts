import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PrismaSchedulingRepo,
  PrismaQuoteRepo,
  PrismaCustomerRepo,
  capacityLockKey,
} from '../src/db/prisma-repositories.js';
import { BookingService } from '../src/booking/booking.js';
import { localToUtc } from '../src/scheduling/availability.js';
import { SERVICES } from '../src/data/catalogue.js';
import {
  resolveDatabase,
  assertDestructiveAllowed,
  DatabaseSafetyError,
} from '../src/db/safety.js';
import type { ServiceOption } from '../src/domain/types.js';

/**
 * These tests talk to a real PostgreSQL database.
 *
 * The point of the concurrency tests here is that they use TWO independent
 * PrismaClient instances with separate connection pools. Nothing is shared
 * in JavaScript. If both win the last crew, the locking is not real.
 */

const URL = process.env.TEST_DATABASE_URL;
const enabled = Boolean(URL);
const d = enabled ? describe : describe.skip;

const svc = (id: string): ServiceOption => {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw new Error(`missing ${id}`);
  return s;
};

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));

// Holds block capacity only while expiresAt is still ahead of the database
// clock. A fixed September 2026 instant is already in the past, so the
// fixture clock stays a minute ahead of the wall clock and the visit is on
// a later local day. The assertions still require the second hold to lose
// until that fixture clock passes the 10-minute hold.
const WALL = Date.now();
const NOW = new Date(WALL + 60_000);
const LATER_DAY = new Date(WALL + 36 * 3600 * 1000);
const LATER_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(LATER_DAY);
const [LATER_Y, LATER_M, LATER_D] = LATER_KEY.split('-').map(Number);
const START = localToUtc(LATER_Y!, LATER_M!, LATER_D!, 10 * 60);

describe('database safety guard', () => {
  it('refuses to fall back to DATABASE_URL when TEST_DATABASE_URL is missing', () => {
    expect(() =>
      resolveDatabase({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@prod.example.com/live' }),
    ).toThrow(/Refusing to fall back/i);
  });

  it('allows a test run when both URLs name the same disposable database', () => {
    const same = 'postgresql://postgres@localhost:5432/r2nette_test';
    const db = assertDestructiveAllowed({
      NODE_ENV: 'test',
      DATABASE_URL: same,
      TEST_DATABASE_URL: same,
    });
    expect(db.url).toBe(same);
    expect(db.environment).toBe('test');
    expect(db.destructiveAllowed).toBe(true);
  });

  it('refuses when production DATABASE_URL equals TEST_DATABASE_URL', () => {
    const same = 'postgresql://u@db.r2nette.ca/r2nette';
    expect(() =>
      resolveDatabase({ NODE_ENV: 'production', DATABASE_URL: same, TEST_DATABASE_URL: same }),
    ).toThrow(/identical/i);
  });

  it('[INV-DATA-01] blocks destructive operations against production', () => {
    expect(() =>
      assertDestructiveAllowed({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u@db.r2nette.ca/r2nette',
      }),
    ).toThrow(DatabaseSafetyError);
  });

  it('blocks destructive operations against a remote host even when named test', () => {
    expect(() =>
      assertDestructiveAllowed({
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://u@rds.amazonaws.com/r2nette_test',
      }),
    ).toThrow(/not identifiable as a disposable test database/i);
  });

  it('blocks a local database whose name does not look disposable', () => {
    expect(() =>
      assertDestructiveAllowed({
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://u@localhost:5432/r2nette',
      }),
    ).toThrow(/not identifiable/i);
  });

  it('allows a local, clearly-named test database', () => {
    const db = assertDestructiveAllowed({
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'postgresql://postgres@localhost:5433/r2nette_test',
    });
    expect(db.destructiveAllowed).toBe(true);
    expect(db.describe).toBe('localhost:5433/r2nette_test');
    expect(db.describe).not.toMatch(/postgres@/); // credentials stripped
  });
});

d('postgres persistence', () => {
  let prisma: PrismaClient;
  let prismaB: PrismaClient;
  let staffA: string;
  let staffB: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    prismaB = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
    await prismaB.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await prismaB.$disconnect();
  });

  beforeEach(async () => {
    // order matters for FKs
    await prisma.promotionRedemption.deleteMany();
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.bookingHold.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.staffTimeOff.deleteMany();
    await prisma.staffAvailability.deleteMany();
    await prisma.staffSkill.deleteMany();
    await prisma.staff.deleteMany();
    await prisma.bookingNumberSequence.deleteMany();
    await prisma.serviceOption.deleteMany();
    await prisma.serviceCategory.deleteMany();

    await prisma.serviceCategory.create({
      data: { id: 'cat_basic', slug: 'basic', nameEn: 'Basic', nameFr: 'Base' },
    });
    const s = svc('svc_basic_2x3');
    await prisma.serviceOption.create({
      data: {
        id: s.id,
        slug: s.id,
        categoryId: 'cat_basic',
        nameEn: 'Basic 2x3',
        nameFr: 'Base 2x3',
        basePriceCents: s.basePriceCents ?? 20000,
        appointmentDurationMinutes: s.appointmentDurationMinutes,
        requiredStaffCount: s.requiredStaffCount,
        labourMinutes: s.labourMinutes,
        productSupplyMode: 'REQUIRED_SELECTION',
        allowedFrequencies: ['ONE_TIME'],
      },
    });

    const a = await prisma.staff.create({
      data: { displayName: 'Alice', availability: { create: ALL_WEEK } },
    });
    const b = await prisma.staff.create({
      data: { displayName: 'Bruno', availability: { create: ALL_WEEK } },
    });
    staffA = a.id;
    staffB = b.id;
  });

  async function makeCustomer(phone: string): Promise<string> {
    const repo = new PrismaCustomerRepo(prisma);
    const c = await repo.create(phone);
    return c.id;
  }

  async function makeQuote(customerId: string, over: Record<string, unknown> = {}) {
    return prisma.quote.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        baseServiceCents: 20000,
        transportationCents: 2500,
        subtotalCents: 22500,
        gstCents: 1125,
        qstCents: 2244,
        taxTotalCents: 3369,
        grandTotalCents: 25869,
        gstRateMicroPercent: 5_000_000,
        qstRateMicroPercent: 9_975_000,
        pricingVersion: '2026-08-01',
        priceSnapshot: { baseServiceCents: 20000, grandTotalCents: 25869 },
        expiresAt: new Date(NOW.getTime() + 30 * 60000),
        ...over,
      },
    });
  }

  function service(prismaClient: PrismaClient, now: Date = NOW) {
    const repo = new PrismaSchedulingRepo(prismaClient);
    const quotes = new PrismaQuoteRepo(prismaClient);
    return new BookingService(repo, quotes, () => now, () => crypto.randomUUID(), {
      preJobMinutes: 0,
      postJobMinutes: 0,
    });
  }

  it('persists a customer from a verified phone', async () => {
    const id = await makeCustomer('+15148252825');
    const found = await new PrismaCustomerRepo(prisma).findByPhone('+15148252825');
    expect(found?.id).toBe(id);
  });

  it('concurrent creation of the same phone yields one customer, not two', async () => {
    const repoA = new PrismaCustomerRepo(prisma);
    const repoB = new PrismaCustomerRepo(prismaB);
    const [x, y] = await Promise.all([
      repoA.create('+15145551234'),
      repoB.create('+15145551234'),
    ]);
    expect(x.id).toBe(y.id);
    expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.customerPhone.count()).toBe(1);
  });

  it('changing the catalogue price does not mutate an existing quote', async () => {
    const cid = await makeCustomer('+15148252825');
    const q = await makeQuote(cid);

    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { basePriceCents: 26000 },
    });

    const after = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.baseServiceCents).toBe(20000);
    expect(after.grandTotalCents).toBe(25869);
    expect(after.qstRateMicroPercent).toBe(9_975_000);
  });

  it('an expired hold stops blocking capacity without its row being deleted', async () => {
    const c1 = await makeCustomer('+15148252825');
    const c2 = await makeCustomer('+15148252826');

    const held = await service(prisma).holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: START,
      customerId: c1,
    });
    await expect(
      service(prisma).holdSlot({ service: svc('svc_basic_2x3'), startUtc: START, customerId: c2 }),
    ).rejects.toThrow(/just taken/i);

    const later = new Date(NOW.getTime() + 11 * 60000);
    const second = await service(prisma, later).holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: START,
      customerId: c2,
    });

    expect(second.staffIds).toHaveLength(2);
    const stillThere = await prisma.bookingHold.findUnique({ where: { id: held.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.status).toBe('ACTIVE');
  });

  it('TWO INDEPENDENT DB CLIENTS racing for the final crew: exactly one wins', async () => {
    const c1 = await makeCustomer('+15148252825');
    const c2 = await makeCustomer('+15148252826');

    // Separate PrismaClients, separate connection pools, no shared JS state.
    const svcA = service(prisma);
    const svcB = service(prismaB);

    const results = await Promise.allSettled([
      svcA.holdSlot({ service: svc('svc_basic_2x3'), startUtc: START, customerId: c1 }),
      svcB.holdSlot({ service: svc('svc_basic_2x3'), startUtc: START, customerId: c2 }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(await prisma.bookingHold.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });

  it('confirms a booking, assigns two staff rows, and consumes the hold', async () => {
    const cid = await makeCustomer('+15148252825');
    const addr = await prisma.customerAddress.create({
      data: {
        customerId: cid,
        formattedAddress: '754 Av. 36e, Lachine',
        city: 'Lachine',
        postalCode: 'H8T1B7',
      },
    });
    const q = await makeQuote(cid);
    const s = service(prisma);
    const hold = await s.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: START,
      customerId: cid,
    });

    const booking = await s.confirmBooking({
      holdId: hold.id,
      quoteId: q.id,
      customerId: cid,
      addressId: addr.id,
      service: svc('svc_basic_2x3'),
      clientClaimedTotalCents: 100,
    });

    expect(booking.bookingNumber).toBe('R2N-2026-000001');
    expect(booking.grandTotalCents).toBe(25869); // not 100

    const staffRows = await prisma.bookingStaff.findMany({ where: { bookingId: booking.id } });
    expect(staffRows).toHaveLength(2);
    expect(staffRows.map((r) => r.staffId).sort()).toEqual([staffA, staffB].sort());

    const consumed = await prisma.bookingHold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(consumed.status).toBe('CONSUMED');
    expect(consumed.consumedAt).not.toBeNull();

    const history = await prisma.bookingStatusHistory.findMany({
      where: { bookingId: booking.id },
    });
    expect(history).toHaveLength(1);
  });

  it('booking survives a client restart — it is on disk, not in memory', async () => {
    const cid = await makeCustomer('+15148252825');
    const addr = await prisma.customerAddress.create({
      data: {
        customerId: cid,
        formattedAddress: '754 Av. 36e',
        city: 'Lachine',
        postalCode: 'H8T1B7',
      },
    });
    const q = await makeQuote(cid);
    const s = service(prisma);
    const hold = await s.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: START,
      customerId: cid,
    });
    const booking = await s.confirmBooking({
      holdId: hold.id,
      quoteId: q.id,
      customerId: cid,
      addressId: addr.id,
      service: svc('svc_basic_2x3'),
    });

    // brand new client, as if the process had been restarted
    const fresh = new PrismaClient({ datasources: { db: { url: URL } } });
    try {
      const found = await fresh.booking.findUniqueOrThrow({
        where: { bookingNumber: booking.bookingNumber },
        include: { staff: true },
      });
      expect(found.grandTotalCents).toBe(25869);
      expect(found.staff).toHaveLength(2);
      expect(found.priceSnapshot).toEqual({ baseServiceCents: 20000, grandTotalCents: 25869 });
    } finally {
      await fresh.$disconnect();
    }
  });

  it('the booking financial snapshot survives a later catalogue change', async () => {
    const cid = await makeCustomer('+15148252825');
    const addr = await prisma.customerAddress.create({
      data: { customerId: cid, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await makeQuote(cid);
    const s = service(prisma);
    const hold = await s.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: START,
      customerId: cid,
    });
    const booking = await s.confirmBooking({
      holdId: hold.id,
      quoteId: q.id,
      customerId: cid,
      addressId: addr.id,
      service: svc('svc_basic_2x3'),
    });

    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { basePriceCents: 30000 },
    });

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.grandTotalCents).toBe(25869);
    expect(after.priceSnapshot).toEqual({ baseServiceCents: 20000, grandTotalCents: 25869 });
  });

  it('an expired quote cannot create a booking', async () => {
    const cid = await makeCustomer('+15148252825');
    const addr = await prisma.customerAddress.create({
      data: { customerId: cid, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await makeQuote(cid, { expiresAt: new Date(NOW.getTime() - 1000) });
    const s = service(prisma);
    const hold = await s.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: START,
      customerId: cid,
    });
    await expect(
      s.confirmBooking({
        holdId: hold.id,
        quoteId: q.id,
        customerId: cid,
        addressId: addr.id,
        service: svc('svc_basic_2x3'),
      }),
    ).rejects.toThrow(/expired/i);
    expect(await prisma.booking.count()).toBe(0);
  });

  it('a customer cannot confirm against a quote belonging to someone else', async () => {
    const owner = await makeCustomer('+15148252825');
    const other = await makeCustomer('+15148252826');
    const addr = await prisma.customerAddress.create({
      data: { customerId: other, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await makeQuote(owner);
    const s = service(prisma);
    const hold = await s.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: START,
      customerId: other,
    });
    await expect(
      s.confirmBooking({
        holdId: hold.id,
        quoteId: q.id,
        customerId: other,
        addressId: addr.id,
        service: svc('svc_basic_2x3'),
      }),
    ).rejects.toThrow(/could not find that price/i);
  });

  it('[INV-CAP-01] concurrent booking-number allocation produces no duplicates', async () => {
    const repo = new PrismaSchedulingRepo(prisma);
    const repoB = new PrismaSchedulingRepo(prismaB);
    const calls = Array.from({ length: 20 }, (_, i) =>
      (i % 2 === 0 ? repo : repoB).nextBookingSequence(2026),
    );
    const values = await Promise.all(calls);
    expect(new Set(values).size).toBe(20);
    expect(Math.max(...values)).toBe(20);
  });

  it('the advisory lock key is stable per window and differs across windows', () => {
    const a = capacityLockKey(START, new Date(START.getTime() + 3 * 3600000));
    const b = capacityLockKey(START, new Date(START.getTime() + 3 * 3600000));
    const c = capacityLockKey(
      new Date(START.getTime() + 86400000),
      new Date(START.getTime() + 86400000 + 3 * 3600000),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a >= -(2n ** 63n) && a < 2n ** 63n).toBe(true);
  });

  it('a service address row is never the business origin', async () => {
    const cid = await makeCustomer('+15148252825');
    const addr = await prisma.customerAddress.create({
      data: {
        customerId: cid,
        formattedAddress: '754 Av. 36e, Lachine',
        city: 'Lachine',
        postalCode: 'H8T1B7',
      },
    });
    await prisma.businessConfiguration.upsert({
      where: { id: 'default' },
      create: { id: 'default', originFormattedAddress: '4625 Fairway, Lachine' },
      update: { originFormattedAddress: '4625 Fairway, Lachine' },
    });
    const config = await prisma.businessConfiguration.findUniqueOrThrow({
      where: { id: 'default' },
    });
    expect(addr.formattedAddress).not.toBe(config.originFormattedAddress);
    expect(addr.customerId).toBe(cid);
  });
});

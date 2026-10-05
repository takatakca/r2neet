import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PrismaSchedulingRepo,
  PrismaQuoteRepo,
  PrismaCustomerRepo,
  capacityLockKey,
  capacityLockKeys,
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

const START = localToUtc(2026, 9, 14, 10 * 60);
const NOW = localToUtc(2026, 9, 14, 6 * 60);

describe('database safety guard', () => {
  it('refuses to fall back to DATABASE_URL when TEST_DATABASE_URL is missing', () => {
    expect(() =>
      resolveDatabase({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@prod.example.com/live' }),
    ).toThrow(/Refusing to fall back/i);
  });

  it('refuses when the test URL equals the production URL', () => {
    const same = 'postgresql://u@localhost:5432/r2nette_test';
    expect(() =>
      resolveDatabase({ NODE_ENV: 'test', DATABASE_URL: same, TEST_DATABASE_URL: same }),
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

  it('two clients racing for OVERLAPPING windows cannot both take the last crew', async () => {
    const c1 = await makeCustomer('+15148252825');
    const c2 = await makeCustomer('+15148252826');

    // 10:00-13:00 and 11:00-14:00 need the same two cleaners. Locking on the
    // exact window gave these different keys, so both read "free" and both
    // won. They must serialize like identical windows do.
    const overlapping = new Date(START.getTime() + 60 * 60000);
    const results = await Promise.allSettled([
      service(prisma).holdSlot({ service: svc('svc_basic_2x3'), startUtc: START, customerId: c1 }),
      service(prismaB).holdSlot({ service: svc('svc_basic_2x3'), startUtc: overlapping, customerId: c2 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.bookingHold.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });

  it('one repo instance never leaks a transaction between concurrent callers', async () => {
    // The app shares one repo across every request. Two capacity
    // transactions on different days do not contend, so they interleave.
    const repo = new PrismaSchedulingRepo(prisma);
    const dayA = { startUtc: START, endUtc: new Date(START.getTime() + 3 * 3600000) };
    const dayB = {
      startUtc: new Date(START.getTime() + 3 * 86400000),
      endUtc: new Date(START.getTime() + 3 * 86400000 + 3 * 3600000),
    };
    let entered!: () => void;
    const firstInside = new Promise<void>((r) => (entered = r));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const first = repo.withCapacityLock(dayA, async () => {
      entered();
      await sleep(50);
      return repo.listBusy(dayA);
    });
    await firstInside;
    const second = repo.withCapacityLock(dayB, async () => {
      await sleep(150);
      return repo.listBusy(dayB);
    });
    await Promise.all([first, second]);

    // With a shared "current transaction" field, the repo was left pointing
    // at the first, now-closed transaction and every later query failed.
    await expect(repo.listBusy(dayA)).resolves.toEqual([]);
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

  async function bookingFixture(phone: string) {
    const cid = await makeCustomer(phone);
    const addr = await prisma.customerAddress.create({
      data: { customerId: cid, formattedAddress: '754 Av. 36e, Lachine', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await makeQuote(cid);
    return { cid, addressId: addr.id, quoteId: q.id };
  }

  async function addCleaners(...names: string[]) {
    for (const displayName of names) {
      await prisma.staff.create({ data: { displayName, availability: { create: ALL_WEEK } } });
    }
  }

  it('a released hold cannot be confirmed, and cannot take the crew from a live hold', async () => {
    const a = await bookingFixture('+15148252825');
    const b = await bookingFixture('+15148252826');
    const s = service(prisma);

    const heldA = await s.holdSlot({ service: svc('svc_basic_2x3'), startUtc: START, customerId: a.cid });
    // DELETE /booking-holds/:id: the customer let it go.
    await prisma.bookingHold.update({ where: { id: heldA.id }, data: { status: 'CANCELLED' } });
    const heldB = await s.holdSlot({ service: svc('svc_basic_2x3'), startUtc: START, customerId: b.cid });
    expect([...heldB.staffIds].sort()).toEqual([...heldA.staffIds].sort());

    await expect(
      s.confirmBooking({ holdId: heldA.id, quoteId: a.quoteId, customerId: a.cid, addressId: a.addressId, service: svc('svc_basic_2x3') }),
    ).rejects.toMatchObject({ code: 'HOLD_NOT_FOUND' });

    const booked = await s.confirmBooking({
      holdId: heldB.id, quoteId: b.quoteId, customerId: b.cid, addressId: b.addressId, service: svc('svc_basic_2x3'),
    });
    expect([...booked.staffIds].sort()).toEqual([...heldB.staffIds].sort());
    expect(await prisma.booking.count()).toBe(1);
  });

  it('two confirms of one hold racing on separate clients make exactly one booking', async () => {
    // Spare cleaners, so "enough free cleaners" cannot stop the second one;
    // only the hold being spent can.
    await addCleaners('Chloé', 'Dmitri');
    const a = await bookingFixture('+15148252825');
    const hold = await service(prisma).holdSlot({ service: svc('svc_basic_2x3'), startUtc: START, customerId: a.cid });
    const confirm = (client: PrismaClient) =>
      service(client).confirmBooking({
        holdId: hold.id, quoteId: a.quoteId, customerId: a.cid, addressId: a.addressId, service: svc('svc_basic_2x3'),
      });

    const results = await Promise.allSettled([confirm(prisma), confirm(prismaB)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'HOLD_CONSUMED' });
    expect(await prisma.booking.count()).toBe(1);
    expect(await prisma.bookingStaff.count()).toBe(2);
  });

  it('the held crew must still be free; other free cleaners do not stand in for them', async () => {
    await addCleaners('Chloé', 'Dmitri');
    const a = await bookingFixture('+15148252825');
    const other = await bookingFixture('+15148252826');
    const hold = await service(prisma).holdSlot({ service: svc('svc_basic_2x3'), startUtc: START, customerId: a.cid });

    // Meanwhile dispatch puts one of the held cleaners on an overlapping job.
    await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-900001',
        customerId: other.cid,
        serviceOptionId: 'svc_basic_2x3',
        addressId: other.addressId,
        quoteId: other.quoteId,
        startAt: new Date(START.getTime() + 60 * 60000),
        endAt: new Date(START.getTime() + 4 * 60 * 60000),
        grandTotalCents: 25869,
        priceSnapshot: {},
        staff: { create: [{ staffId: hold.staffIds[0]! }] },
      },
    });

    await expect(
      service(prisma).confirmBooking({
        holdId: hold.id, quoteId: a.quoteId, customerId: a.cid, addressId: a.addressId, service: svc('svc_basic_2x3'),
      }),
    ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(await prisma.bookingStaff.count({ where: { staffId: hold.staffIds[0]! } })).toBe(1);
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

  it('the advisory lock key is stable per service day and differs across days', () => {
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

  it('windows that could compete for one cleaner always share a lock key', () => {
    const at = (min: number) => new Date(START.getTime() + min * 60000);
    const morning = capacityLockKeys({ startUtc: at(0), endUtc: at(180) });
    const overlap = capacityLockKeys({ startUtc: at(60), endUtc: at(240) });
    const afterBuffer = capacityLockKeys({ startUtc: at(200), endUtc: at(380) });
    for (const other of [overlap, afterBuffer]) {
      expect(morning.some((k) => other.includes(k))).toBe(true);
    }
    // Acquisition order is fixed, so two transactions cannot deadlock.
    expect([...morning].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))).toEqual(morning);
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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  RosterService,
  RosterError,
  validateAvailability,
  timeToMinutes,
  minutesToTime,
  defaultAvailability,
} from '../src/staff/roster-service.js';
import { localToUtc } from '../src/scheduling/availability.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

describe('time helpers', () => {
  it('converts both ways', () => {
    expect(timeToMinutes('08:00')).toBe(480);
    expect(timeToMinutes('17:30')).toBe(1050);
    expect(minutesToTime(480)).toBe('08:00');
    expect(minutesToTime(1050)).toBe('17:30');
  });

  it('rejects nonsense rather than coercing it', () => {
    for (const bad of ['', '8', '25:00', '08:99', 'morning']) {
      expect(() => timeToMinutes(bad), bad).toThrow(RosterError);
    }
  });
});

describe('availability validation', () => {
  it('accepts a normal week', () => {
    expect(() => validateAvailability(defaultAvailability())).not.toThrow();
  });

  it('rejects an end before the start', () => {
    expect(() => validateAvailability([{ weekday: 1, startMinute: 600, endMinute: 540 }])).toThrow(
      /after the start/,
    );
  });

  it('REJECTS overlapping windows instead of merging them', () => {
    // Merging would hide a typo until someone is booked at a time they never
    // offered.
    expect(() =>
      validateAvailability([
        { weekday: 1, startMinute: 480, endMinute: 720 },
        { weekday: 1, startMinute: 600, endMinute: 900 },
      ]),
    ).toThrow(/overlap/);
  });

  it('allows two separate windows on the same day', () => {
    expect(() =>
      validateAvailability([
        { weekday: 1, startMinute: 480, endMinute: 720 },
        { weekday: 1, startMinute: 780, endMinute: 1020 },
      ]),
    ).not.toThrow();
  });

  it('rejects a window running past midnight', () => {
    expect(() => validateAvailability([{ weekday: 1, startMinute: 1380, endMinute: 1500 }])).toThrow();
  });

  it('names the day in the error, so the owner knows where to look', () => {
    try {
      validateAvailability([{ weekday: 3, startMinute: 600, endMinute: 540 }]);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('Wednesday');
    }
  });
});

d('roster', () => {
  let prisma: PrismaClient;
  let roster: RosterService;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.staffSession.deleteMany();
    await prisma.staffUser.deleteMany();
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.staffTimeOff.deleteMany();
    await prisma.staffSkill.deleteMany();
    await prisma.staffAvailability.deleteMany();
    await prisma.staff.deleteMany();
    await seed(prisma);
    roster = new RosterService(prisma);
  });

  /** A confirmed booking for a staff member at a given local day/time. */
  async function bookFor(staffId: string, daysAhead: number, hour: number) {
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() + daysAhead * 86400000));
    const [y, m, dd] = key.split('-').map(Number);
    const startAt = localToUtc(y!, m!, dd!, hour * 60);

    const c = await prisma.customer.create({ data: { firstName: 'C' } });
    const a = await prisma.customerAddress.create({
      data: { customerId: c.id, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId: c.id,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        baseServiceCents: 20000,
        subtotalCents: 20000,
        gstCents: 0,
        qstCents: 0,
        taxTotalCents: 0,
        grandTotalCents: 20000,
        gstRateMicroPercent: 5_000_000,
        qstRateMicroPercent: 9_975_000,
        pricingVersion: 't',
        priceSnapshot: {},
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return prisma.booking.create({
      data: {
        bookingNumber: `R2N-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        customerId: c.id,
        serviceOptionId: 'svc_basic_2x3',
        addressId: a.id,
        quoteId: q.id,
        startAt,
        endAt: new Date(startAt.getTime() + 3 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 20000,
        priceSnapshot: {},
        staff: { create: [{ staffId }] },
      },
    });
  }

  it('creates a cleaner with a workable week by default', async () => {
    const created = await roster.create({ displayName: 'Alice Tremblay' });
    const list = await roster.list();
    const alice = list.find((s) => s.id === created.id)!;

    expect(alice.displayName).toBe('Alice Tremblay');
    expect(alice.active).toBe(true);
    // Created with no availability, a cleaner can never be booked — which
    // looks like a broken system rather than an empty schedule.
    expect(alice.availability).toHaveLength(5);
    expect(alice.weeklyHours).toBe(45);
  });

  it('can create a cleaner with no availability when asked explicitly', async () => {
    const created = await roster.create({ displayName: 'Bruno', availability: [] });
    const bruno = (await roster.list()).find((s) => s.id === created.id)!;
    expect(bruno.availability).toHaveLength(0);
    expect(bruno.weeklyHours).toBe(0);
  });

  it('refuses a nameless cleaner', async () => {
    await expect(roster.create({ displayName: '   ' })).rejects.toThrow(/needs a name/);
  });

  it('refuses an unknown skill rather than storing a typo', async () => {
    await expect(
      roster.create({ displayName: 'X', skills: ['svc_not_real'] }),
    ).rejects.toThrow(/Unknown service/);
  });

  it('hires a cleaner with skills in one step', async () => {
    const created = await roster.create({
      displayName: 'Camille Roy',
      skills: ['svc_basic_2x3', 'svc_deep_2x3', 'svc_move'],
    });
    const camille = (await roster.list()).find((s) => s.id === created.id)!;
    expect(camille.skills).toEqual(expect.arrayContaining(['svc_basic_2x3', 'svc_deep_2x3', 'svc_move']));
  });

  it('replaces skills rather than accumulating them', async () => {
    const s = await roster.create({ displayName: 'Alice', skills: ['svc_basic_2x3'] });
    await roster.setSkills(s.id, ['svc_deep_2x3', 'svc_carpet']);
    const alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.skills).toEqual(expect.arrayContaining(['svc_deep_2x3', 'svc_carpet']));
    expect(alice.skills).not.toContain('svc_basic_2x3');
  });

  it('replaces a week rather than accumulating windows', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    await roster.setAvailability(s.id, [{ weekday: 6, startMinute: 540, endMinute: 780 }]);

    const alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.availability).toHaveLength(1);
    expect(alice.availability[0]!.weekday).toBe(6);
  });

  it('WARNS about jobs the new week would no longer cover', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    // Book them on a Saturday at 09:00.
    const saturday = (() => {
      const now = new Date();
      const day = Number(
        new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', weekday: 'narrow' })
          .formatToParts(now)
          .length,
      );
      void day;
      // Find the next Saturday within two weeks.
      for (let i = 1; i <= 14; i++) {
        const cand = new Date(Date.now() + i * 86400000);
        const name = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Toronto',
          weekday: 'short',
        }).format(cand);
        if (name === 'Sat') return i;
      }
      return 7;
    })();
    const booking = await bookFor(s.id, saturday, 9);

    // Now restrict them to weekdays only.
    const res = await roster.setAvailability(s.id, defaultAvailability());

    expect(res.conflicts.map((c) => c.bookingNumber)).toContain(booking.bookingNumber);
  });

  it('reports no conflict when the new week still covers the job', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    const monday = (() => {
      for (let i = 1; i <= 14; i++) {
        const cand = new Date(Date.now() + i * 86400000);
        const name = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Toronto',
          weekday: 'short',
        }).format(cand);
        if (name === 'Mon') return i;
      }
      return 7;
    })();
    await bookFor(s.id, monday, 10);

    const res = await roster.setAvailability(s.id, defaultAvailability());
    expect(res.conflicts).toHaveLength(0);
  });

  /* ---------------- deactivation ---------------- */

  it('REFUSES to deactivate a cleaner with upcoming jobs', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    const booking = await bookFor(s.id, 3, 10);

    await expect(roster.setActive(s.id, false)).rejects.toThrow(booking.bookingNumber);
    const alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.active).toBe(true);
  });

  it('deactivates cleanly once the jobs are gone', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    const b = await bookFor(s.id, 3, 10);
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });

    await roster.setActive(s.id, false);
    const alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.active).toBe(false);
    // Deactivated, never deleted: their history stays intact.
    expect(await prisma.staff.count({ where: { id: s.id } })).toBe(1);
  });

  it('past jobs do not block deactivation', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    await bookFor(s.id, -5, 10);
    await expect(roster.setActive(s.id, false)).resolves.toBeTruthy();
  });

  /* ---------------- time off ---------------- */

  it('records time off and names the jobs it affects', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    const booking = await bookFor(s.id, 5, 10);

    const res = await roster.addTimeOff(
      s.id,
      new Date(Date.now() + 4 * 86400000),
      new Date(Date.now() + 7 * 86400000),
      'Vacation',
    );
    // Silently abandoning the job would be worse than refusing outright.
    expect(res.affectedBookings.map((b) => b.bookingNumber)).toContain(booking.bookingNumber);
  });

  it('refuses overlapping time off', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    await roster.addTimeOff(s.id, new Date(Date.now() + 86400000), new Date(Date.now() + 5 * 86400000));
    await expect(
      roster.addTimeOff(s.id, new Date(Date.now() + 3 * 86400000), new Date(Date.now() + 8 * 86400000)),
    ).rejects.toThrow(/overlaps/);
  });

  it('refuses a backwards range', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    await expect(
      roster.addTimeOff(s.id, new Date(Date.now() + 5 * 86400000), new Date(Date.now() + 86400000)),
    ).rejects.toThrow(/end after/);
  });

  it('lists upcoming time off so it can be removed', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    const res = await roster.addTimeOff(
      s.id,
      new Date(Date.now() + 86400000),
      new Date(Date.now() + 5 * 86400000),
      'Vacation',
    );
    const alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.upcomingTimeOff).toHaveLength(1);
    expect(alice.upcomingTimeOff[0]!.id).toBe(res.timeOff.id);
    expect(alice.upcomingTimeOff[0]!.reason).toBe('Vacation');
  });

  it('shows current time off on the roster', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    await roster.addTimeOff(s.id, new Date(Date.now() - 3600_000), new Date(Date.now() + 86400000));
    const alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.onTimeOffUntil).not.toBeNull();
  });

  /* ---------------- coverage ---------------- */

  it('reports a weekday with no cleaners as a gap', async () => {
    await roster.create({ displayName: 'Alice' }); // weekdays only
    const coverage = await roster.coverage();

    const sunday = coverage.find((c) => c.weekday === 0)!;
    // A day with nobody looks like "fully booked" to a customer.
    expect(sunday.cleaners).toBe(0);
    expect(sunday.canStaffTwoPersonJobs).toBe(false);

    const monday = coverage.find((c) => c.weekday === 1)!;
    expect(monday.cleaners).toBe(1);
    expect(monday.earliest).toBe('08:00');
    expect(monday.latest).toBe('17:00');
  });

  it('flags days that cannot staff a two-cleaner service', async () => {
    await roster.create({ displayName: 'Alice' });
    let coverage = await roster.coverage();
    expect(coverage.find((c) => c.weekday === 1)!.canStaffTwoPersonJobs).toBe(false);

    await roster.create({ displayName: 'Bruno' });
    coverage = await roster.coverage();
    expect(coverage.find((c) => c.weekday === 1)!.canStaffTwoPersonJobs).toBe(true);
  });

  it('excludes deactivated cleaners from coverage', async () => {
    const a = await roster.create({ displayName: 'Alice' });
    await roster.create({ displayName: 'Bruno' });
    await roster.setActive(a.id, false);

    const monday = (await roster.coverage()).find((c) => c.weekday === 1)!;
    expect(monday.cleaners).toBe(1);
  });

  it('shows whether a cleaner has a login, without exposing the account', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    let alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.hasLogin).toBe(false);

    await prisma.staffUser.create({
      data: {
        email: 'alice@r2nette.ca',
        passwordHash: 'scrypt$16384$aa$bb',
        displayName: 'Alice',
        role: 'CLEANER',
        staffId: s.id,
      },
    });
    alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.hasLogin).toBe(true);
    expect(JSON.stringify(alice)).not.toMatch(/scrypt|passwordHash/);
  });

  it('counts upcoming jobs per cleaner', async () => {
    const s = await roster.create({ displayName: 'Alice' });
    await bookFor(s.id, 2, 10);
    await bookFor(s.id, 4, 10);
    await bookFor(s.id, -2, 10); // past

    const alice = (await roster.list()).find((x) => x.id === s.id)!;
    expect(alice.upcomingJobs).toBe(2);
  });
});

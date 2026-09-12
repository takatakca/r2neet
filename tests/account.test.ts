import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApi, SESSION_COOKIE } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import { localToUtc } from '../src/scheduling/availability.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));

d('customer account', () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createApi>;
  let staffA: string;
  let staffB: string;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.promotionClaim.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.paymentMethodReference.deleteMany();
    await prisma.paymentProviderCustomer.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.customerSession.deleteMany();
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
    await prisma.staffAvailability.deleteMany();
    await prisma.staff.deleteMany();
    await prisma.bookingNumberSequence.deleteMany();
    await seed(prisma);
    staffA = (await prisma.staff.create({ data: { displayName: 'Alice', availability: { create: ALL_WEEK } } })).id;
    staffB = (await prisma.staff.create({ data: { displayName: 'Bruno', availability: { create: ALL_WEEK } } })).id;
    app = createApi({ prisma, verification: new FakeVerificationProvider('123456') });
  });

  async function login(phone: string) {
    await request(app).post('/api/v1/auth/phone/send').send({ phone });
    const v = await request(app).post('/api/v1/auth/phone/verify').send({ phone, code: '123456' });
    const cookie = (v.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(SESSION_COOKIE),
    )!;
    const me = await request(app).get('/api/v1/customer/me').set('Cookie', cookie);
    return { cookie, customerId: me.body.customer.id as string };
  }

  /** Create a booking a given number of hours from now. */
  async function makeBooking(customerId: string, hoursAway: number, assign = true) {
    const addr = await prisma.customerAddress.create({
      data: {
        customerId,
        label: 'Home',
        formattedAddress: '754 Av. 36e, Lachine',
        city: 'Lachine',
        postalCode: 'H8T1B7',
        isDefault: true,
      },
    });
    const q = await prisma.quote.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        baseServiceCents: 20000,
        subtotalCents: 22500,
        gstCents: 1125,
        qstCents: 2244,
        taxTotalCents: 3369,
        grandTotalCents: 25869,
        gstRateMicroPercent: 5_000_000,
        qstRateMicroPercent: 9_975_000,
        pricingVersion: 't',
        priceSnapshot: {},
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const start = new Date(Date.now() + hoursAway * 3600_000);
    const b = await prisma.booking.create({
      data: {
        bookingNumber: `R2N-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: start,
        endAt: new Date(start.getTime() + 3 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
        ...(assign ? { staff: { create: [{ staffId: staffA }, { staffId: staffB }] } } : {}),
      },
    });
    return { booking: b, addressId: addr.id };
  }

  /* ---------------- overview ---------------- */

  it('requires a session', async () => {
    expect((await request(app).get('/api/v1/account/overview')).status).toBe(401);
  });

  it('separates upcoming from past bookings', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    await makeBooking(customerId, 72);
    await makeBooking(customerId, -72);

    const res = await request(app).get('/api/v1/account/overview').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toHaveLength(1);
    expect(res.body.past).toHaveLength(1);
    expect(res.body.upcoming[0].bookingNumber).toMatch(/^R2N-/);
  });

  it('flags what the customer may change, per the 24-hour policy', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    await makeBooking(customerId, 72);
    await makeBooking(customerId, 6);

    const res = await request(app).get('/api/v1/account/overview').set('Cookie', cookie);
    const far = res.body.upcoming.find((b: { canCancel: boolean }) => b.canCancel);
    const near = res.body.upcoming.find((b: { withinCutoff: boolean }) => b.withinCutoff);
    expect(far).toBeTruthy();
    expect(near).toBeTruthy();
    expect(near.canCancel).toBe(false);
    expect(near.canReschedule).toBe(false);
  });

  it('[INV-AUTH-06] never exposes another customer bookings or addresses', async () => {
    const victim = await login('514 825 2826');
    await makeBooking(victim.customerId, 72);

    const attacker = await login('514 825 2825');
    const res = await request(app).get('/api/v1/account/overview').set('Cookie', attacker.cookie);
    expect(res.body.upcoming).toHaveLength(0);
    expect(res.body.addresses).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toMatch(/Av\. 36e/);
  });

  it('shows payment method crumbs but never a card number', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    await prisma.paymentMethodReference.create({
      data: {
        customerId,
        providerMethodId: 'pm_1',
        methodType: 'card',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2030,
        isDefault: true,
      },
    });
    const res = await request(app).get('/api/v1/account/overview').set('Cookie', cookie);
    expect(res.body.paymentMethods[0].last4).toBe('4242');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/pm_1/); // no provider token
    expect(body).not.toMatch(/\d{13,19}/); // no PAN
  });

  /* ---------------- cancel ---------------- */

  it('cancels a booking more than 24 hours away', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { booking } = await makeBooking(customerId, 72);

    const res = await request(app)
      .post(`/api/v1/account/bookings/${booking.id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason: 'Away that week' });

    expect(res.status).toBe(200);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.status).toBe('CANCELLED');
    const history = await prisma.bookingStatusHistory.findMany({ where: { bookingId: booking.id } });
    expect(history.some((h) => h.status === 'CANCELLED' && h.reason === 'Away that week')).toBe(true);
  });

  it('refuses to cancel inside the 24-hour window', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { booking } = await makeBooking(customerId, 6);

    const res = await request(app)
      .post(`/api/v1/account/bookings/${booking.id}/cancel`)
      .set('Cookie', cookie);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.status).toBe('CONFIRMED');
  });

  it('cancelling gives the welcome offer back', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { booking } = await makeBooking(customerId, 72);
    await prisma.promotionClaim.create({
      data: {
        customerId,
        promotionFamily: 'NEW_CUSTOMER',
        promotionId: 'promo_new_basic',
        amountCents: 1500,
        bookingId: booking.id,
        status: 'REDEEMED',
        redeemedAt: new Date(),
      },
    });

    await request(app).post(`/api/v1/account/bookings/${booking.id}/cancel`).set('Cookie', cookie);

    const claim = await prisma.promotionClaim.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(claim.status).toBe('RELEASED');
    expect(claim.releaseReason).toBe('BOOKING_CANCELLED');
  });

  it('cancelling twice is idempotent', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { booking } = await makeBooking(customerId, 72);
    await request(app).post(`/api/v1/account/bookings/${booking.id}/cancel`).set('Cookie', cookie);
    const second = await request(app)
      .post(`/api/v1/account/bookings/${booking.id}/cancel`)
      .set('Cookie', cookie);
    expect(second.status).toBe(200);
    expect(second.body.alreadyCancelled).toBe(true);
  });

  it('one customer cannot cancel another customer booking', async () => {
    const victim = await login('514 825 2826');
    const { booking } = await makeBooking(victim.customerId, 72);
    const attacker = await login('514 825 2825');

    const res = await request(app)
      .post(`/api/v1/account/bookings/${booking.id}/cancel`)
      .set('Cookie', attacker.cookie);

    expect(res.status).toBe(404);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.status).toBe('CONFIRMED');
  });

  /* ---------------- reschedule ---------------- */

  /** Tomorrow at a given local hour, well outside the 24-hour cutoff. */
  function soon(hour: number, daysAhead = 3) {
    const d = new Date(Date.now() + daysAhead * 86400000);
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    const [y, m, day] = key.split('-').map(Number);
    return localToUtc(y!, m!, day!, hour * 60);
  }

  it('moves a booking to a genuinely free slot and reassigns the crew', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { booking } = await makeBooking(customerId, 72);
    const target = soon(13);

    const res = await request(app)
      .post(`/api/v1/account/bookings/${booking.id}/reschedule`)
      .set('Cookie', cookie)
      .send({ startAt: target.toISOString() });

    expect(res.status).toBe(200);
    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { staff: true },
    });
    expect(row.startAt.toISOString()).toBe(target.toISOString());
    expect(row.staff).toHaveLength(2); // crew re-verified, not assumed
    const history = await prisma.bookingStatusHistory.findMany({ where: { bookingId: booking.id } });
    expect(history.some((h) => h.status === 'RESCHEDULED')).toBe(true);
  });

  it('[INV-CAP-02] refuses a slot the business cannot staff', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { booking } = await makeBooking(customerId, 72);
    const target = soon(9);

    // Both cleaners are already committed elsewhere at that time.
    const other = await prisma.customer.create({ data: {} });
    const addr = await prisma.customerAddress.create({
      data: { customerId: other.id, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.findFirstOrThrow();
    await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-999111',
        customerId: other.id,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: target,
        endAt: new Date(target.getTime() + 3 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
        staff: { create: [{ staffId: staffA }, { staffId: staffB }] },
      },
    });

    const res = await request(app)
      .post(`/api/v1/account/bookings/${booking.id}/reschedule`)
      .set('Cookie', cookie)
      .send({ startAt: target.toISOString() });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.startAt.toISOString()).not.toBe(target.toISOString()); // unmoved
  });

  it('refuses to reschedule inside the 24-hour window', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { booking } = await makeBooking(customerId, 6);
    const res = await request(app)
      .post(`/api/v1/account/bookings/${booking.id}/reschedule`)
      .set('Cookie', cookie)
      .send({ startAt: soon(13).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
  });

  it('one customer cannot reschedule another customer booking', async () => {
    const victim = await login('514 825 2826');
    const { booking } = await makeBooking(victim.customerId, 72);
    const attacker = await login('514 825 2825');
    const res = await request(app)
      .post(`/api/v1/account/bookings/${booking.id}/reschedule`)
      .set('Cookie', attacker.cookie)
      .send({ startAt: soon(13).toISOString() });
    expect(res.status).toBe(404);
  });

  /* ---------------- addresses & profile ---------------- */

  it('sets a default address, and only one at a time', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    await makeBooking(customerId, 72);
    const second = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: '99 Rue Y', city: 'Laval', postalCode: 'H7N3S8' },
    });

    await request(app).post(`/api/v1/account/addresses/${second.id}/default`).set('Cookie', cookie);

    const rows = await prisma.customerAddress.findMany({ where: { customerId } });
    expect(rows.filter((a) => a.isDefault)).toHaveLength(1);
    expect(rows.find((a) => a.isDefault)!.id).toBe(second.id);
  });

  it('refuses to delete an address with an upcoming cleaning', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { addressId } = await makeBooking(customerId, 72);
    const res = await request(app)
      .delete(`/api/v1/account/addresses/${addressId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ADDRESS_IN_USE');
  });

  it('deletes an unused address, and repeating is harmless', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const spare = await prisma.customerAddress.create({
      data: { customerId, formattedAddress: '99 Rue Y', city: 'Laval', postalCode: 'H7N3S8' },
    });
    expect((await request(app).delete(`/api/v1/account/addresses/${spare.id}`).set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).delete(`/api/v1/account/addresses/${spare.id}`).set('Cookie', cookie)).status).toBe(200);
  });

  it('one customer cannot delete another customer address', async () => {
    const victim = await login('514 825 2826');
    const { addressId } = await makeBooking(victim.customerId, 72);
    const attacker = await login('514 825 2825');
    await request(app).delete(`/api/v1/account/addresses/${addressId}`).set('Cookie', attacker.cookie);
    expect(await prisma.customerAddress.count({ where: { id: addressId } })).toBe(1);
  });

  it('updates the profile and validates the email', async () => {
    const { cookie } = await login('514 825 2825');
    const ok = await request(app)
      .patch('/api/v1/account/profile')
      .set('Cookie', cookie)
      .send({ firstName: 'Pascal', email: 'pascal@example.com' });
    expect(ok.body.firstName).toBe('Pascal');

    const bad = await request(app)
      .patch('/api/v1/account/profile')
      .set('Cookie', cookie)
      .send({ email: 'not-an-email' });
    expect(bad.status).toBe(400);
  });

  it('lists active recurring plans', async () => {
    const { cookie, customerId } = await login('514 825 2825');
    const { addressId } = await makeBooking(customerId, 72);
    await prisma.recurrenceSeries.create({
      data: {
        customerId,
        serviceOptionId: 'svc_basic_2x3',
        addressId,
        frequency: 'WEEKLY',
        startAt: new Date(),
        status: 'ACTIVE',
      },
    });
    const res = await request(app).get('/api/v1/account/overview').set('Cookie', cookie);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0].frequency).toBe('WEEKLY');
  });
});

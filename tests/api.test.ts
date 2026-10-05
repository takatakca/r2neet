import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApi, REGISTRATION_COOKIE, SESSION_COOKIE } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import { seed } from '../prisma/seed.js';
import { localToUtc } from '../src/scheduling/availability.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import {
  TEST_OTP,
  logIn,
  registrationProfile,
  setCookie,
  signUp,
} from './support/customer-auth.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));

// Tomorrow at 10:00 local. Real clock throughout: the pricing engine
// stamps quote expiry from the real time, so a frozen test clock would make
// every quote look expired the moment the booking service read it.
const TOMORROW = new Date(Date.now() + 24 * 3600 * 1000);
const DATE_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(TOMORROW);
const [DY, DM, DD] = DATE_KEY.split('-').map(Number);
const START = localToUtc(DY!, DM!, DD!, 10 * 60);
const YEAR = new Date().getUTCFullYear();

d('HTTP API', () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createApi>;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
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
    await prisma.staffAvailability.deleteMany();
    await prisma.staffSkill.deleteMany();
    await prisma.staff.deleteMany();
    await prisma.bookingNumberSequence.deleteMany();

    await seed(prisma);
    await prisma.staff.create({ data: { displayName: 'Alice', availability: { create: ALL_WEEK } } });
    await prisma.staff.create({ data: { displayName: 'Bruno', availability: { create: ALL_WEEK } } });

    app = createApi({ prisma, verification: new FakeVerificationProvider('123456') });
  });

  /**
   * Register a new customer for this phone through the real sign-up flow
   * (send -> verify -> registration/complete) and return the session cookie.
   */
  async function login(phone: string): Promise<string> {
    return (await signUp(app, phone)).cookie;
  }

  async function addressFor(cookie: string): Promise<string> {
    const me = await request(app).get('/api/v1/customer/me').set('Cookie', cookie);
    const a = await prisma.customerAddress.create({
      data: {
        customerId: me.body.customer.id,
        formattedAddress: '754 Av. 36e, Lachine',
        city: 'Lachine',
        postalCode: 'H8T1B7',
      },
    });
    return a.id;
  }

  async function makeQuote(cookie: string, body: Record<string, unknown> = {}) {
    const res = await request(app)
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        productSupplyOption: 'CLIENT_SUPPLIED',
        distanceKm: 12,
        ...body,
      });
    return res;
  }

  /* ---------------- auth & session ---------------- */

  it('OTP send is neutral for known and unknown numbers alike', async () => {
    // Both numbers now have a completed account.
    await login('514 825 2825');
    await login('514 825 2826');

    // Each intent is probed with its own pair of numbers so the per-phone
    // resend cooldown cannot make the two answers differ for another reason.
    const probes = [
      { intent: 'login', known: '514 825 2825', unknown: '514 825 2827' },
      { intent: 'signup', known: '514 825 2826', unknown: '514 825 2828' },
    ];
    for (const { intent, known: knownPhone, unknown: unknownPhone } of probes) {
      const known = await request(app)
        .post('/api/v1/auth/phone/send')
        .send({ phone: knownPhone, intent });
      const unknown = await request(app)
        .post('/api/v1/auth/phone/send')
        .send({ phone: unknownPhone, intent });
      expect(known.status, intent).toBe(200);
      expect(unknown.status, intent).toBe(known.status);
      expect(Object.keys(known.body).sort()).toEqual(Object.keys(unknown.body).sort());
      expect(known.body.sent).toBe(unknown.body.sent);
      expect(known.body.message).toBe(unknown.body.message);
      expect(JSON.stringify(known.body)).not.toMatch(/customerId|firstName|returning|ACCOUNT_/i);
    }
  });

  it('a wrong code does not create a session', async () => {
    // Login against an existing account: a wrong code must not take it over.
    await login('514 825 2825');
    await request(app).post('/api/v1/auth/phone/send').send({ phone: '514 825 2825', intent: 'login' });
    const asLogin = await request(app)
      .post('/api/v1/auth/phone/verify')
      .send({ phone: '514 825 2825', code: '000000', intent: 'login' });
    expect(asLogin.status).toBe(400);
    expect(asLogin.body.error.code).toBe('OTP_DENIED');
    expect(asLogin.headers['set-cookie']).toBeUndefined();

    // Sign-up for a new number: no session and no registration proof either.
    await request(app).post('/api/v1/auth/phone/send').send({ phone: '514 825 2826', intent: 'signup' });
    const asSignup = await request(app)
      .post('/api/v1/auth/phone/verify')
      .send({ phone: '514 825 2826', code: '000000', intent: 'signup' });
    expect(asSignup.status).toBe(400);
    expect(asSignup.body.error.code).toBe('OTP_DENIED');
    expect(asSignup.headers['set-cookie']).toBeUndefined();
    expect(await prisma.customer.count()).toBe(1);
  });

  it('sign-up creates exactly one customer, and a usable session only once registration completes', async () => {
    await request(app).post('/api/v1/auth/phone/send').send({ phone: '514 825 2825', intent: 'signup' });
    const verified = await request(app)
      .post('/api/v1/auth/phone/verify')
      .send({ phone: '514 825 2825', code: TEST_OTP, intent: 'signup' });
    expect(verified.status).toBe(200);
    expect(verified.body.outcome).toBe('PROFILE_REQUIRED');
    expect(verified.body.registration.verifiedPhone).toBe('+15148252825');
    // A proven phone is not yet an account: no customer row, no session.
    expect(setCookie(verified, SESSION_COOKIE)).toBeUndefined();
    expect(await prisma.customer.count()).toBe(0);
    const registration = setCookie(verified, REGISTRATION_COOKIE)!;
    expect(registration).toBeTruthy();
    // The registration proof cannot be used as a customer session.
    const early = await request(app).get('/api/v1/customer/me').set('Cookie', registration);
    expect(early.status).toBe(401);

    const completed = await request(app)
      .post('/api/v1/auth/registration/complete')
      .set('Cookie', registration)
      .send(registrationProfile('514 825 2825'));
    expect(completed.status).toBe(201);
    const cookie = setCookie(completed, SESSION_COOKIE)!;
    const me = await request(app).get('/api/v1/customer/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.customer.verifiedPhone).toBe('+15148252825');
    expect(await prisma.customer.count()).toBe(1);

    // The proof is single-use: replaying it cannot register a second time.
    const replay = await request(app)
      .post('/api/v1/auth/registration/complete')
      .set('Cookie', registration)
      .send(registrationProfile('514 825 2825'));
    expect(replay.status).toBe(401);
    expect(await prisma.customer.count()).toBe(1);

    // Logging back in reuses that customer rather than creating another.
    const again = await logIn(app, '514 825 2825');
    expect(again.customerId).toBe(me.body.customer.id);
    expect(await prisma.customer.count()).toBe(1);
  });

  it('login for a number with no account is refused only after the code is proven', async () => {
    const sent = await request(app)
      .post('/api/v1/auth/phone/send')
      .send({ phone: '514 825 2827', intent: 'login' });
    expect(sent.status).toBe(200); // nothing revealed before proof

    const wrong = await request(app)
      .post('/api/v1/auth/phone/verify')
      .send({ phone: '514 825 2827', code: '000000', intent: 'login' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('OTP_DENIED');

    const proven = await request(app)
      .post('/api/v1/auth/phone/verify')
      .send({ phone: '514 825 2827', code: TEST_OTP, intent: 'login' });
    expect(proven.status).toBe(404);
    expect(proven.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(setCookie(proven, SESSION_COOKIE)).toBeUndefined();
    expect(await prisma.customer.count()).toBe(0);

    // The phone is proven, so the profile form can finish the sign-up
    // without a second code.
    const registration = setCookie(proven, REGISTRATION_COOKIE);
    expect(registration).toBeTruthy();
    const completed = await request(app)
      .post('/api/v1/auth/registration/complete')
      .set('Cookie', registration!)
      .send(registrationProfile('514 825 2827'));
    expect(completed.status).toBe(201);
    expect(await prisma.customer.count()).toBe(1);
  });

  it('a customer imported from Setmore keeps their record on first sign-in', async () => {
    // Imported phones are unverified and may lack a full name.
    const imported = await prisma.customer.create({
      data: {
        firstName: 'Marie',
        phones: { create: { phoneE164: '+15148252829', verifiedAt: null, isPrimary: true } },
      },
    });

    await request(app).post('/api/v1/auth/phone/send').send({ phone: '514 825 2829', intent: 'login' });
    const proven = await request(app)
      .post('/api/v1/auth/phone/verify')
      .send({ phone: '514 825 2829', code: TEST_OTP, intent: 'login' });
    expect(proven.status).toBe(404);
    const registration = setCookie(proven, REGISTRATION_COOKIE)!;

    const completed = await request(app)
      .post('/api/v1/auth/registration/complete')
      .set('Cookie', registration)
      .send(registrationProfile('514 825 2829', { firstName: 'Marie', lastName: 'Gagnon' }));
    expect(completed.status).toBe(201);
    expect(completed.body.customer.id).toBe(imported.id);
    expect(await prisma.customer.count()).toBe(1);

    const again = await logIn(app, '514 825 2829');
    expect(again.customerId).toBe(imported.id);
  });

  it('sign-up for a number that already has an account is refused only after the code is proven', async () => {
    await login('514 825 2825');

    const sent = await request(app)
      .post('/api/v1/auth/phone/send')
      .send({ phone: '514 825 2825', intent: 'signup' });
    expect(sent.status).toBe(200); // nothing revealed before proof

    const proven = await request(app)
      .post('/api/v1/auth/phone/verify')
      .send({ phone: '514 825 2825', code: TEST_OTP, intent: 'signup' });
    expect(proven.status).toBe(409);
    expect(proven.body.error.code).toBe('ACCOUNT_ALREADY_EXISTS');
    expect(setCookie(proven, SESSION_COOKIE)).toBeUndefined();
    expect(setCookie(proven, REGISTRATION_COOKIE)).toBeUndefined();
    expect(await prisma.customer.count()).toBe(1);
  });

  it('rejects /customer/me without a session', async () => {
    const res = await request(app).get('/api/v1/customer/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('the operations API is mounted: admin roster requires a staff session', async () => {
    const res = await request(app).get('/api/v1/admin/roster');
    expect(res.status).toBe(401);
  });

  it('logout invalidates the session', async () => {
    const cookie = await login('514 825 2825');
    await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    const after = await request(app).get('/api/v1/customer/me').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('a customerId in the body cannot impersonate another customer', async () => {
    const victim = await login('514 825 2825');
    const victimMe = await request(app).get('/api/v1/customer/me').set('Cookie', victim);
    const victimId = victimMe.body.customer.id;

    const attacker = await login('514 825 2826');
    const res = await request(app)
      .get('/api/v1/customer/me')
      .set('Cookie', attacker)
      .query({ customerId: victimId });

    // Identity comes from the cookie; the query parameter is ignored.
    expect(res.body.customer.id).not.toBe(victimId);
  });

  it('customer A cannot read customer B addresses', async () => {
    const b = await login('514 825 2826');
    await addressFor(b);
    const a = await login('514 825 2825');
    const res = await request(app).get('/api/v1/customer/addresses').set('Cookie', a);
    expect(res.body.addresses).toHaveLength(0);
  });

  it('customer A cannot read customer B booking by id', async () => {
    const b = await login('514 825 2826');
    const bAddr = await addressFor(b);
    const bQuote = await makeQuote(b);
    const bHold = await request(app)
      .post('/api/v1/booking-holds')
      .set('Cookie', b)
      .send({ quoteId: bQuote.body.quote.id, startAt: START.toISOString() });
    const bBooking = await request(app)
      .post('/api/v1/bookings')
      .set('Cookie', b)
      .send({ holdId: bHold.body.hold.id, quoteId: bQuote.body.quote.id, addressId: bAddr });
    expect(bBooking.status).toBe(201);

    const a = await login('514 825 2825');
    const res = await request(app)
      .get(`/api/v1/bookings/${bBooking.body.booking.id}`)
      .set('Cookie', a);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
  });

  /* ---------------- services & quotes ---------------- */

  it('exposes Window Cleaning as QUOTE_REQUIRED, never $0', async () => {
    const res = await request(app).get('/api/v1/services');
    const w = res.body.services.find((s: { id: string }) => s.id === 'svc_window');
    expect(w.pricingMode).toBe('QUOTE_REQUIRED');
    expect(w.basePriceCents).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/migration|review/i);
  });

  it('returns the exact Québec tax result for a Basic one-time quote', async () => {
    const cookie = await login('514 825 2825');
    const res = await makeQuote(cookie);
    expect(res.status).toBe(200);
    const q = res.body.quote;
    // A guest is provisionally eligible for NEW_CUSTOMER_BASIC ($15), and
    // BEST_SINGLE_DISCOUNT applies it since there is no frequency discount
    // on a one-time booking:
    //   20000 base − 1500 promo + 2500 transport = 21000 taxable
    //   GST 5%      = 1050
    //   QST 9.975%  = 2094.75 → 2095 (half-up)
    //   total       = 24145
    expect(q.subtotalBeforeTaxCents).toBe(21000);
    expect(q.taxLines[0].amountCents).toBe(1050);
    expect(q.taxLines[1].amountCents).toBe(2095);
    expect(q.grandTotalCents).toBe(24145);
    expect(q.warningCodes).toContain('NEW_CUSTOMER_ELIGIBILITY_UNVERIFIED');
  });

  it('ignores a client-supplied total', async () => {
    const cookie = await login('514 825 2825');
    const res = await makeQuote(cookie, {
      total: 1,
      totalCents: 100,
      grandTotalCents: 100,
      gstCents: 0,
      qstCents: 0,
    });
    expect(res.body.quote.grandTotalCents).toBe(24145);
    const persisted = await prisma.quote.findUniqueOrThrow({
      where: { id: res.body.quote.id },
    });
    expect(persisted.grandTotalCents).toBe(24145);
  });

  it('returns both visit sections for a recurring quote', async () => {
    const cookie = await login('514 825 2825');
    const res = await makeQuote(cookie, {
      serviceOptionId: 'svc_basic_1x3',
      frequency: 'MONTHLY',
      productSupplyOption: 'CLIENT_SUPPLIED',
    });
    expect(res.body.quote.firstVisit).toBeTruthy();
    expect(res.body.quote.subsequentVisitPricingPreview).toBeTruthy();
  });

  it('rejects a weekly carpet cleaning', async () => {
    const cookie = await login('514 825 2825');
    const res = await makeQuote(cookie, {
      serviceOptionId: 'svc_carpet',
      frequency: 'WEEKLY',
      productSupplyOption: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a fixed quote for Window Cleaning', async () => {
    const cookie = await login('514 825 2825');
    const res = await makeQuote(cookie, { serviceOptionId: 'svc_window' });
    expect(res.status).toBe(400);
  });

  it('a persisted quote is unchanged by a later catalogue price change', async () => {
    const cookie = await login('514 825 2825');
    const res = await makeQuote(cookie);
    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { basePriceCents: 30000 },
    });
    const after = await prisma.quote.findUniqueOrThrow({ where: { id: res.body.quote.id } });
    expect(after.grandTotalCents).toBe(24145);
  });

  /* ---------------- availability ---------------- */

  it('returns real slots and never leaks staff identities', async () => {
    const res = await request(app)
      .get('/api/v1/availability')
      .query({ serviceOptionId: 'svc_basic_2x3', date: DATE_KEY });
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/staffId|Alice|Bruno/);
  });

  it('refuses availability for a quote-required service', async () => {
    const res = await request(app)
      .get('/api/v1/availability')
      .query({ serviceOptionId: 'svc_window', date: DATE_KEY });
    expect(res.status).toBe(400);
  });

  /* ---------------- holds & bookings ---------------- */

  it('creates a hold and then a real booking with a server number', async () => {
    const cookie = await login('514 825 2825');
    const addressId = await addressFor(cookie);
    const quote = await makeQuote(cookie);

    const hold = await request(app)
      .post('/api/v1/booking-holds')
      .set('Cookie', cookie)
      .send({ quoteId: quote.body.quote.id, startAt: START.toISOString() });
    expect(hold.status).toBe(201);
    expect(hold.body.hold.expiresAt).toBeTruthy();

    const booking = await request(app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .send({
        holdId: hold.body.hold.id,
        quoteId: quote.body.quote.id,
        addressId,
        bookingNumber: 'R2N-9999-999999', // ignored
        grandTotalCents: 1, // ignored
      });

    expect(booking.status).toBe(201);
    expect(booking.body.booking.bookingNumber).toBe(`R2N-${YEAR}-000001`);
    expect(booking.body.booking.grandTotalCents).toBe(24145);
    expect(booking.body.booking.paymentStatus).toBe('NOT_COLLECTED');
    expect(booking.body.booking.crewSize).toBe(2);

    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.body.booking.id },
      include: { staff: true, history: true },
    });
    expect(row.staff).toHaveLength(2);
    expect(row.history).toHaveLength(1);

    const consumed = await prisma.bookingHold.findUniqueOrThrow({
      where: { id: hold.body.hold.id },
    });
    expect(consumed.status).toBe('CONSUMED');
  });

  it('rejects a booking with an expired hold', async () => {
    const cookie = await login('514 825 2825');
    const addressId = await addressFor(cookie);
    const quote = await makeQuote(cookie);
    const hold = await request(app)
      .post('/api/v1/booking-holds')
      .set('Cookie', cookie)
      .send({ quoteId: quote.body.quote.id, startAt: START.toISOString() });

    await prisma.bookingHold.update({
      where: { id: hold.body.hold.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .send({ holdId: hold.body.hold.id, quoteId: quote.body.quote.id, addressId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    expect(await prisma.booking.count()).toBe(0);
  });

  it('customer B cannot cancel customer A hold', async () => {
    const a = await login('514 825 2825');
    const quote = await makeQuote(a);
    const hold = await request(app)
      .post('/api/v1/booking-holds')
      .set('Cookie', a)
      .send({ quoteId: quote.body.quote.id, startAt: START.toISOString() });

    const b = await login('514 825 2826');
    const res = await request(app)
      .get(`/api/v1/booking-holds/${hold.body.hold.id}`)
      .set('Cookie', b);
    expect(res.status).toBe(404);

    const still = await prisma.bookingHold.findUniqueOrThrow({ where: { id: hold.body.hold.id } });
    expect(still.status).toBe('ACTIVE');
  });

  /* ---------------- idempotency ---------------- */

  it('the same Idempotency-Key returns the same booking, not a second one', async () => {
    const cookie = await login('514 825 2825');
    const addressId = await addressFor(cookie);
    const quote = await makeQuote(cookie);
    const hold = await request(app)
      .post('/api/v1/booking-holds')
      .set('Cookie', cookie)
      .send({ quoteId: quote.body.quote.id, startAt: START.toISOString() });

    const payload = { holdId: hold.body.hold.id, quoteId: quote.body.quote.id, addressId };
    const first = await request(app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'retry-abc')
      .send(payload);
    const second = await request(app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'retry-abc')
      .send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.booking.bookingNumber).toBe(first.body.booking.bookingNumber);
    expect(await prisma.booking.count()).toBe(1);
    expect(await prisma.bookingStaff.count()).toBe(2); // not four
  });

  it('the same key with a different payload is a conflict, not a second command', async () => {
    const cookie = await login('514 825 2825');
    const addressId = await addressFor(cookie);
    const quote = await makeQuote(cookie);
    const hold = await request(app)
      .post('/api/v1/booking-holds')
      .set('Cookie', cookie)
      .send({ quoteId: quote.body.quote.id, startAt: START.toISOString() });

    await request(app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'k1')
      .send({ holdId: hold.body.hold.id, quoteId: quote.body.quote.id, addressId });

    const conflict = await request(app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'k1')
      .send({ holdId: hold.body.hold.id, quoteId: quote.body.quote.id, addressId, note: 'changed' });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await prisma.booking.count()).toBe(1);
  });

  /* ---------------- integrations ---------------- */

  it('reports integration status without inventing a green light', async () => {
    const res = await request(app).get('/api/v1/integrations/status');
    const stripe = res.body.integrations.find((i: { key: string }) => i.key === 'stripe');
    expect(stripe.status).toBe('NOT_CONFIGURED');
  });
});

d('production seed', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('running the seed twice leaves one canonical row per entity', async () => {
    await seed(prisma);
    const first = {
      services: await prisma.serviceOption.count(),
      addOns: await prisma.addOn.count(),
      taxes: await prisma.taxRule.count(),
      promos: await prisma.promotion.count(),
      categories: await prisma.serviceCategory.count(),
    };
    await seed(prisma);
    const second = {
      services: await prisma.serviceOption.count(),
      addOns: await prisma.addOn.count(),
      taxes: await prisma.taxRule.count(),
      promos: await prisma.promotion.count(),
      categories: await prisma.serviceCategory.count(),
    };
    expect(second).toEqual(first);
    expect(first.services).toBe(11);
  });

  it('seeds the approved catalogue values exactly', async () => {
    await seed(prisma);
    const expected: Record<string, number | null> = {
      svc_basic_1x3: 11000,
      svc_basic_2x2: 14000,
      svc_basic_2x3: 20000,
      svc_basic_2x4: 26000,
      svc_deep_1x3: 11500,
      svc_deep_2x2: 13000,
      svc_deep_2x3: 23000,
      svc_deep_2x4: 26000,
      svc_move: 14000,
      svc_carpet: 19900,
      svc_window: null,
    };
    for (const [id, cents] of Object.entries(expected)) {
      const row = await prisma.serviceOption.findUniqueOrThrow({ where: { id } });
      expect(row.basePriceCents, id).toBe(cents);
    }

    const w = await prisma.serviceOption.findUniqueOrThrow({ where: { id: 'svc_window' } });
    expect(w.pricingMode).toBe('QUOTE_REQUIRED');
    expect(w.appointmentDurationMinutes).toBeNull(); // no invented duration

    const cfg = await prisma.businessConfiguration.findUniqueOrThrow({ where: { id: 'default' } });
    expect(cfg.productBasicCents).toBe(1200);
    expect(cfg.productDeepCents).toBe(1500);
    expect(cfg.defaultPaymentPolicy).toBe('PAY_LATER');
    expect(cfg.recurringPaymentTiming).toBe('24_HOURS_BEFORE');
    expect(cfg.timezone).toBe('America/Toronto');

    const t = await prisma.transportationRule.findUniqueOrThrow({ where: { id: 'default' } });
    expect(t.baseAmountCents).toBe(2500);
    expect(t.includedDistanceKm).toBe(20);
    expect(t.extraKmRateCents).toBe(65);
    expect(t.taxable).toBe(true);

    const gst = await prisma.taxRule.findUniqueOrThrow({ where: { id: 'tax_gst' } });
    const qst = await prisma.taxRule.findUniqueOrThrow({ where: { id: 'tax_qst' } });
    expect(gst.rateMicroPercent).toBe(5_000_000);
    expect(qst.rateMicroPercent).toBe(9_975_000);
    expect(qst.compounding).toBe('NON_COMPOUNDED');

    const vip = await prisma.promotion.findUniqueOrThrow({ where: { id: 'promo_legacy_vip' } });
    expect(vip.active).toBe(false);
    expect(vip.ownerReviewRequired).toBe(true);

    // Both new-customer promos share one lifetime family.
    const basic = await prisma.promotion.findUniqueOrThrow({ where: { id: 'promo_new_basic' } });
    const deep = await prisma.promotion.findUniqueOrThrow({ where: { id: 'promo_new_deep' } });
    expect(basic.family).toBe('NEW_CUSTOMER');
    expect(deep.family).toBe('NEW_CUSTOMER');
    expect(basic.lifetimeMaxPerCustomer).toBe(1);
  });
});

/**
 * The $258.69 fixture, documented.
 *
 * Basic Cleaning — 2 Cleaners × 3 Hours, one-time, client supplies products,
 * 12 km (inside the 20 km allowance, so no distance surcharge):
 *
 *   base service          20000
 *   products (client)         0
 *   transportation         2500
 *   ------------------------------
 *   taxable subtotal      22500
 *   GST  5%                1125
 *   QST  9.975%            2244   (22500 × 9.975% = 2244.375 → half-up)
 *   ------------------------------
 *   grand total           25869   = $258.69
 *
 * Verified against the authoritative engine, not hand-computed — the HTTP
 * quote test above asserts every one of these numbers through the API.
 */

d('durability across process restart', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.idempotencyRecord.deleteMany();
    await prisma.customerSession.deleteMany();
    await prisma.promotionClaim.deleteMany();
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
    await prisma.staff.create({ data: { displayName: 'Alice', availability: { create: ALL_WEEK } } });
    await prisma.staff.create({ data: { displayName: 'Bruno', availability: { create: ALL_WEEK } } });
  });

  /** A fresh app + fresh PrismaClient stands in for a restarted process. */
  function freshContext() {
    const client = new PrismaClient({ datasources: { db: { url: URL } } });
    return {
      client,
      app: createApi({ prisma: client, verification: new FakeVerificationProvider('123456') }),
    };
  }

  it('a session created by context A is valid in context B after A is gone', async () => {
    const a = freshContext();
    const { cookie } = await signUp(a.app, '514 825 2825');
    await a.client.$disconnect(); // context A is gone

    const b = freshContext();
    const me = await request(b.app).get('/api/v1/customer/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.customer.verifiedPhone).toBe('+15148252825');
    await b.client.$disconnect();
  });

  it('the raw session token is never stored — only its hash', async () => {
    const a = freshContext();
    const { cookie } = await signUp(a.app, '514 825 2825');
    const token = cookie.split(';')[0]!.split('=')[1]!;

    const rows = await prisma.customerSession.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionTokenHash).not.toBe(token);
    expect(rows[0]!.sessionTokenHash).toHaveLength(64); // sha256 hex
    await a.client.$disconnect();
  });

  it('logout in one context revokes the session everywhere', async () => {
    const a = freshContext();
    const { cookie } = await signUp(a.app, '514 825 2825');
    await request(a.app).post('/api/v1/auth/logout').set('Cookie', cookie);
    await a.client.$disconnect();

    const b = freshContext();
    const me = await request(b.app).get('/api/v1/customer/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
    await b.client.$disconnect();
  });

  it('an idempotent booking replays in a different context after a restart', async () => {
    const a = freshContext();
    const { cookie } = await signUp(a.app, '514 825 2825');
    const me = await request(a.app).get('/api/v1/customer/me').set('Cookie', cookie);
    const addr = await prisma.customerAddress.create({
      data: {
        customerId: me.body.customer.id,
        formattedAddress: '754 Av. 36e',
        city: 'Lachine',
        postalCode: 'H8T1B7',
      },
    });
    const quote = await request(a.app)
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        productSupplyOption: 'CLIENT_SUPPLIED',
        distanceKm: 12,
      });
    const hold = await request(a.app)
      .post('/api/v1/booking-holds')
      .set('Cookie', cookie)
      .send({ quoteId: quote.body.quote.id, startAt: START.toISOString() });

    const payload = {
      holdId: hold.body.hold.id,
      quoteId: quote.body.quote.id,
      addressId: addr.id,
    };
    const first = await request(a.app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'restart-key')
      .send(payload);
    expect(first.status).toBe(201);
    await a.client.$disconnect(); // process dies

    // The mobile client retries against a different instance.
    const b = freshContext();
    const retry = await request(b.app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'restart-key')
      .send(payload);

    expect(retry.status).toBe(201);
    expect(retry.body.booking.bookingNumber).toBe(first.body.booking.bookingNumber);
    expect(await prisma.booking.count()).toBe(1);
    expect(await prisma.bookingStaff.count()).toBe(2);
    await b.client.$disconnect();
  });

  it('a failed booking frees the idempotency key for a genuine retry', async () => {
    const a = freshContext();
    const { cookie } = await signUp(a.app, '514 825 2825');
    const me = await request(a.app).get('/api/v1/customer/me').set('Cookie', cookie);
    const addr = await prisma.customerAddress.create({
      data: {
        customerId: me.body.customer.id,
        formattedAddress: '754 Av. 36e',
        city: 'Lachine',
        postalCode: 'H8T1B7',
      },
    });
    const quote = await request(a.app)
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        productSupplyOption: 'CLIENT_SUPPLIED',
        distanceKm: 12,
      });
    const hold = await request(a.app)
      .post('/api/v1/booking-holds')
      .set('Cookie', cookie)
      .send({ quoteId: quote.body.quote.id, startAt: START.toISOString() });

    // Expire the hold so the first attempt fails.
    await prisma.bookingHold.update({
      where: { id: hold.body.hold.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const payload = {
      holdId: hold.body.hold.id,
      quoteId: quote.body.quote.id,
      addressId: addr.id,
    };
    const failed = await request(a.app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'retry-after-failure')
      .send(payload);
    expect(failed.status).toBe(400);

    // The key must not be poisoned by a failure.
    expect(await prisma.idempotencyRecord.count({ where: { key: 'retry-after-failure' } })).toBe(0);
    await a.client.$disconnect();
  });
});

d('returning-customer booking template', () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createApi>;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.idempotencyRecord.deleteMany();
    await prisma.customerSession.deleteMany();
    await prisma.promotionClaim.deleteMany();
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
    await prisma.staff.create({ data: { displayName: 'Alice', availability: { create: ALL_WEEK } } });
    await prisma.staff.create({ data: { displayName: 'Bruno', availability: { create: ALL_WEEK } } });
    app = createApi({ prisma, verification: new FakeVerificationProvider('123456') });
  });

  /** Register a new customer through the real sign-up flow; returns the session cookie. */
  async function login(phone: string) {
    return (await signUp(app, phone)).cookie;
  }

  /** Book once so there is history to build a template from. */
  async function bookOnce(cookie: string, notes: string) {
    const me = await request(app).get('/api/v1/customer/me').set('Cookie', cookie);
    const addr = await prisma.customerAddress.create({
      data: {
        customerId: me.body.customer.id,
        label: 'Home',
        formattedAddress: '754 Av. 36e, Lachine',
        city: 'Lachine',
        postalCode: 'H8T1B7',
        isDefault: true,
      },
    });
    const quote = await request(app)
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'WEEKLY',
        productSupplyOption: 'CLIENT_SUPPLIED',
        distanceKm: 12,
      });
    const hold = await request(app)
      .post('/api/v1/booking-holds')
      .set('Cookie', cookie)
      .send({ quoteId: quote.body.quote.id, startAt: START.toISOString() });
    const booking = await request(app)
      .post('/api/v1/bookings')
      .set('Cookie', cookie)
      .send({ holdId: hold.body.hold.id, quoteId: quote.body.quote.id, addressId: addr.id });
    // A private note recorded against that visit.
    await prisma.bookingStatusHistory.create({
      data: { bookingId: booking.body.booking.id, status: 'CONFIRMED', notes },
    });
    return { addressId: addr.id, booking: booking.body.booking };
  }

  it('returns a reusable template after a real booking', async () => {
    const cookie = await login('514 825 2825');
    const { addressId } = await bookOnce(cookie, 'Door code 4417, spare key under mat');

    const res = await request(app).get('/api/v1/customer/context').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.customer.isReturningCustomer).toBe(true);
    expect(res.body.bookingTemplate.serviceOptionId).toBe('svc_basic_2x3');
    expect(res.body.bookingTemplate.frequency).toBe('WEEKLY');
    expect(res.body.bookingTemplate.addressId).toBe(addressId);
    expect(res.body.bookingTemplate.requiredStaffCount).toBe(2);
    expect(res.body.addresses).toHaveLength(1);
  });

  it('never reuses door codes, entry notes or old payment state', async () => {
    const cookie = await login('514 825 2825');
    await bookOnce(cookie, 'Door code 4417, spare key under mat');

    const res = await request(app).get('/api/v1/customer/context').set('Cookie', cookie);
    const body = JSON.stringify(res.body);

    expect(body).not.toMatch(/4417/);
    expect(body).not.toMatch(/spare key/i);
    expect(body).not.toMatch(/priceSnapshot|grandTotalCents|holdId|bookingNumber/);
    expect(body).not.toMatch(/staffId|paymentStatus/);
  });

  it('a new customer gets no template rather than a fabricated one', async () => {
    const cookie = await login('514 825 2825');
    const res = await request(app).get('/api/v1/customer/context').set('Cookie', cookie);
    expect(res.body.customer.isReturningCustomer).toBe(false);
    expect(res.body.bookingTemplate).toBeNull();
    expect(res.body.addresses).toEqual([]);
  });

  it('customer A never receives customer B template or addresses', async () => {
    const b = await login('514 825 2826');
    await bookOnce(b, 'Buzzer 402');

    const a = await login('514 825 2825');
    const res = await request(app).get('/api/v1/customer/context').set('Cookie', a);
    expect(res.body.bookingTemplate).toBeNull();
    expect(res.body.addresses).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/Av\. 36e|Buzzer/);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/customer/context');
    expect(res.status).toBe(401);
  });

  it('drops the address from the template once the customer deletes it', async () => {
    const cookie = await login('514 825 2825');
    const { addressId } = await bookOnce(cookie, 'x');
    // Address removed from the saved list but still referenced by history.
    await prisma.customerAddress.update({
      where: { id: addressId },
      data: { customerId: (await prisma.customer.create({ data: {} })).id },
    });

    const res = await request(app).get('/api/v1/customer/context').set('Cookie', cookie);
    expect(res.body.bookingTemplate.addressId).toBeNull();
    expect(res.body.bookingTemplate.serviceOptionId).toBe('svc_basic_2x3');
  });

  it('omits a template for a service that is no longer bookable', async () => {
    const cookie = await login('514 825 2825');
    await bookOnce(cookie, 'x');
    await prisma.serviceOption.update({
      where: { id: 'svc_basic_2x3' },
      data: { active: false },
    });
    const res = await request(app).get('/api/v1/customer/context').set('Cookie', cookie);
    expect(res.body.bookingTemplate).toBeNull();
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { createOpsApi, STAFF_COOKIE } from '../src/api/ops.js';
import {
  StaffAuthService,
  hashPassword,
  verifyPassword,
  passwordProblems,
  can,
  permissionsFor,
} from '../src/auth/staff-auth.js';
import { FakeVoiceProvider } from '../src/callbacks/callback-service.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));

describe('password hashing', () => {
  it('never stores the password, and salts every hash', async () => {
    const a = await hashPassword('CorrectHorse42Battery');
    const b = await hashPassword('CorrectHorse42Battery');
    expect(a).not.toContain('CorrectHorse42Battery');
    expect(a).not.toBe(b); // distinct salts
    expect(a.startsWith('scrypt$')).toBe(true);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('CorrectHorse42Battery');
    expect(await verifyPassword('CorrectHorse42Battery', h)).toBe(true);
    expect(await verifyPassword('correcthorse42battery', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('rejects a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'md5$deadbeef')).toBe(false);
  });

  it('enforces a real password bar', () => {
    expect(passwordProblems('short')).not.toHaveLength(0);
    expect(passwordProblems('alllowercase123')).not.toHaveLength(0);
    expect(passwordProblems('R2netteAdmin2026')).not.toHaveLength(0); // business name
    expect(passwordProblems('MapleRiver47Sky')).toHaveLength(0);
  });
});

describe('role permissions', () => {
  it('gives the owner everything', () => {
    expect(can('OWNER', 'staff.manage')).toBe(true);
    expect(can('OWNER', 'reviews.moderate')).toBe(true);
  });

  it('lets a dispatcher run the day but not moderate reviews or manage staff', () => {
    expect(can('DISPATCHER', 'dispatch.assign')).toBe(true);
    expect(can('DISPATCHER', 'callbacks.act')).toBe(true);
    expect(can('DISPATCHER', 'reviews.moderate')).toBe(false);
    expect(can('DISPATCHER', 'staff.manage')).toBe(false);
    expect(can('DISPATCHER', 'integrations.view')).toBe(false);
  });

  it('gives a cleaner only their own jobs', () => {
    expect(permissionsFor('CLEANER')).toEqual(['crew.ownJobs']);
    expect(can('CLEANER', 'dispatch.view')).toBe(false);
    expect(can('CLEANER', 'dashboard.view')).toBe(false);
    expect(can('CLEANER', 'callbacks.view')).toBe(false);
  });
});

d('staff authentication', () => {
  let prisma: PrismaClient;
  let app: express.Express;
  let auth: StaffAuthService;
  let cleanerStaffId: string;
  let otherStaffId: string;

  const OWNER = { email: 'owner@r2nette.ca', password: 'MapleRiver47Sky' };
  const DISPATCH = { email: 'dispatch@r2nette.ca', password: 'BlueHeron92Trail' };
  const CLEANER = { email: 'alice@r2nette.ca', password: 'SilverPine33Wave' };

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.staffSession.deleteMany();
    await prisma.staffUser.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.callbackRequest.deleteMany();
    await prisma.review.deleteMany();
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
    await prisma.staffTimeOff.deleteMany();
    await prisma.staff.deleteMany();
    await seed(prisma);

    cleanerStaffId = (await prisma.staff.create({
      data: { displayName: 'Alice', availability: { create: ALL_WEEK } },
    })).id;
    otherStaffId = (await prisma.staff.create({
      data: { displayName: 'Bruno', availability: { create: ALL_WEEK } },
    })).id;

    auth = new StaffAuthService(prisma);
    await auth.createUser({ ...OWNER, displayName: 'Owner', role: 'OWNER', mustChangePassword: false });
    await auth.createUser({ ...DISPATCH, displayName: 'Dispatch', role: 'DISPATCHER', mustChangePassword: false });
    await auth.createUser({
      ...CLEANER,
      displayName: 'Alice',
      role: 'CLEANER',
      staffId: cleanerStaffId,
      mustChangePassword: false,
    });

    app = express();
    app.use(createOpsApi({ prisma, voice: new FakeVoiceProvider() }));
  });

  async function login(who: { email: string; password: string }) {
    const res = await request(app).post('/api/v1/staff/login').send(who);
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(STAFF_COOKIE))!;
  }

  /* ---------------- the shared token is gone ---------------- */

  it('the old shared bearer token no longer works', async () => {
    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Authorization', 'Bearer dev-admin-token');
    expect(res.status).toBe(401);
  });

  it('a token in the query string no longer works either', async () => {
    const res = await request(app).get('/api/v1/admin/dashboard').query({ token: 'dev-admin-token' });
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated request to every admin route', async () => {
    for (const path of [
      '/api/v1/admin/dashboard',
      '/api/v1/admin/dispatch',
      '/api/v1/admin/callbacks',
      '/api/v1/admin/reviews',
      '/api/v1/admin/integrations',
      '/api/v1/admin/cutover',
    ]) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
  });

  /* ---------------- login ---------------- */

  it('signs in and returns the role and permissions', async () => {
    const res = await request(app).post('/api/v1/staff/login').send(OWNER);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('OWNER');
    expect(res.body.permissions).toContain('staff.manage');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPass = await request(app)
      .post('/api/v1/staff/login')
      .send({ email: OWNER.email, password: 'WrongPassword99X' });
    const unknown = await request(app)
      .post('/api/v1/staff/login')
      .send({ email: 'nobody@r2nette.ca', password: 'WrongPassword99X' });
    expect(wrongPass.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPass.body.error.message).toBe(unknown.body.error.message);
    expect(wrongPass.body.error.code).toBe(unknown.body.error.code);
  });

  it('locks an account after repeated failures, then refuses even the right password', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/v1/staff/login').send({ email: OWNER.email, password: 'Nope12345678' });
    }
    const res = await request(app).post('/api/v1/staff/login').send(OWNER);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('a successful login clears the failure counter', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/v1/staff/login').send({ email: OWNER.email, password: 'Nope12345678' });
    }
    await login(OWNER);
    const user = await prisma.staffUser.findUniqueOrThrow({ where: { email: OWNER.email } });
    expect(user.failedAttempts).toBe(0);
  });

  it('stores only a hash of the session token', async () => {
    const cookie = await login(OWNER);
    const token = cookie.split(';')[0]!.split('=')[1]!;
    const rows = await prisma.staffSession.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionTokenHash).not.toBe(token);
    expect(rows[0]!.sessionTokenHash).toHaveLength(64);
  });

  it('logout revokes the session immediately', async () => {
    const cookie = await login(OWNER);
    expect((await request(app).get('/api/v1/admin/dashboard').set('Cookie', cookie)).status).toBe(200);
    await request(app).post('/api/v1/staff/logout').set('Cookie', cookie);
    expect((await request(app).get('/api/v1/admin/dashboard').set('Cookie', cookie)).status).toBe(401);
  });

  it('deactivating a person kills their access without deleting history', async () => {
    const cookie = await login(DISPATCH);
    expect((await request(app).get('/api/v1/admin/dispatch').set('Cookie', cookie)).status).toBe(200);
    await prisma.staffUser.update({ where: { email: DISPATCH.email }, data: { active: false } });
    expect((await request(app).get('/api/v1/admin/dispatch').set('Cookie', cookie)).status).toBe(401);
  });

  /* ---------------- role isolation ---------------- */

  it('a dispatcher can run the day', async () => {
    const cookie = await login(DISPATCH);
    expect((await request(app).get('/api/v1/admin/dashboard').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/dispatch').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/callbacks').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/roster').set('Cookie', cookie)).status).toBe(200);
  });

  it('a dispatcher cannot hire, change hours, or deactivate — only the owner can', async () => {
    const cookie = await login(DISPATCH);
    const hire = await request(app)
      .post('/api/v1/admin/roster')
      .set('Cookie', cookie)
      .send({ displayName: 'Camille Roy' });
    expect(hire.status).toBe(403);

    const hours = await request(app)
      .put(`/api/v1/admin/roster/${cleanerStaffId}/availability`)
      .set('Cookie', cookie)
      .send({ availability: ALL_WEEK });
    expect(hours.status).toBe(403);

    const skills = await request(app)
      .put(`/api/v1/admin/roster/${cleanerStaffId}/skills`)
      .set('Cookie', cookie)
      .send({ skills: ['svc_basic_2x3'] });
    expect(skills.status).toBe(403);

    const off = await request(app)
      .post(`/api/v1/admin/roster/${cleanerStaffId}/active`)
      .set('Cookie', cookie)
      .send({ active: false });
    expect(off.status).toBe(403);
  });

  it('a dispatcher may add time off, and the owner may hire with skills', async () => {
    const dispatch = await login(DISPATCH);
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() + 10 * 86400000));
    const timeOff = await request(app)
      .post(`/api/v1/admin/roster/${cleanerStaffId}/time-off`)
      .set('Cookie', dispatch)
      .send({ from: key, through: key, reason: 'Call-in' });
    expect(timeOff.status).toBe(200);

    const owner = await login(OWNER);
    const hire = await request(app)
      .post('/api/v1/admin/roster')
      .set('Cookie', owner)
      .send({
        displayName: 'Camille Roy',
        skills: ['svc_basic_2x3', 'svc_deep_2x3'],
      });
    expect(hire.status).toBe(201);
    const list = await request(app).get('/api/v1/admin/roster').set('Cookie', owner);
    const camille = list.body.staff.find((s: { id: string }) => s.id === hire.body.id);
    expect(camille.availability).toHaveLength(5);
    expect(camille.skills).toEqual(expect.arrayContaining(['svc_basic_2x3', 'svc_deep_2x3']));
  });

  it('[INV-AUTH-05] a dispatcher cannot moderate reviews or read integrations', async () => {
    const cookie = await login(DISPATCH);
    const review = await prisma.review.create({
      data: {
        source: 'MANUAL_APPROVED',
        customerDisplayName: 'X',
        rating: 5,
        reviewDate: new Date(),
        status: 'PENDING',
      },
    });
    expect(
      (await request(app).post(`/api/v1/admin/reviews/${review.id}/publish`).set('Cookie', cookie)).status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/admin/integrations').set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/cutover').set('Cookie', cookie)).status).toBe(403);

    const still = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(still.status).toBe('PENDING'); // unchanged
  });

  it('a cleaner cannot reach any admin surface', async () => {
    const cookie = await login(CLEANER);
    for (const path of [
      '/api/v1/admin/dashboard',
      '/api/v1/admin/dispatch',
      '/api/v1/admin/roster',
      '/api/v1/admin/callbacks',
      '/api/v1/admin/reviews',
      '/api/v1/admin/integrations',
      '/api/v1/admin/cutover',
    ]) {
      expect((await request(app).get(path).set('Cookie', cookie)).status, path).toBe(403);
    }
  });

  it('a cleaner cannot assign jobs', async () => {
    const cookie = await login(CLEANER);
    const res = await request(app)
      .post('/api/v1/admin/bookings/anything/assign')
      .set('Cookie', cookie)
      .send({ staffId: otherStaffId });
    expect(res.status).toBe(403);
  });

  /* ---------------- dispatch capacity ---------------- */

  // A week out, 10:00 local, so live holds and the real clock agree.
  const DAY = new Date(Date.now() + 7 * 86400000);
  const at = (hour: number) => {
    const d = new Date(DAY);
    d.setUTCHours(hour + 4, 0, 0, 0); // Toronto is UTC-4 in summer, UTC-5 in winter; either is fine here
    return d;
  };
  let jobSeq = 0;

  async function job(start: Date, hours = 3, staffIds: string[] = []) {
    jobSeq += 1;
    const customer = await prisma.customer.create({ data: { firstName: 'Job', lastName: `Owner ${jobSeq}` } });
    const address = await prisma.customerAddress.create({
      data: { customerId: customer.id, formattedAddress: '1 Rue Test', city: 'Montréal', postalCode: 'H2X1Y4' },
    });
    const quote = await prisma.quote.create({
      data: {
        customerId: customer.id,
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        baseServiceCents: 20000,
        transportationCents: 0,
        subtotalCents: 20000,
        gstCents: 1000,
        qstCents: 1995,
        taxTotalCents: 2995,
        grandTotalCents: 22995,
        gstRateMicroPercent: 5_000_000,
        qstRateMicroPercent: 9_975_000,
        pricingVersion: '2026-08-01',
        priceSnapshot: {},
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return prisma.booking.create({
      data: {
        bookingNumber: `R2N-2026-9${String(jobSeq).padStart(5, '0')}`,
        customerId: customer.id,
        serviceOptionId: 'svc_basic_2x3',
        addressId: address.id,
        quoteId: quote.id,
        startAt: start,
        endAt: new Date(start.getTime() + hours * 3600000),
        grandTotalCents: 22995,
        priceSnapshot: {},
        staff: { create: staffIds.map((staffId) => ({ staffId })) },
      },
    });
  }

  async function assign(bookingId: string, staffId: string) {
    const cookie = await login(DISPATCH);
    return request(app)
      .post(`/api/v1/admin/bookings/${bookingId}/assign`)
      .set('Cookie', cookie)
      .send({ staffId });
  }

  it('a dispatcher cannot give away a cleaner a customer is holding at checkout', async () => {
    const target = await job(at(11));
    const holder = await prisma.customer.create({ data: {} });
    await prisma.bookingHold.create({
      data: {
        customerId: holder.id,
        serviceOptionId: 'svc_basic_2x3',
        startAt: at(10),
        endAt: at(13),
        requiredStaffCount: 2,
        staffIds: [otherStaffId, cleanerStaffId],
        expiresAt: new Date(Date.now() + 10 * 60000),
      },
    });

    const res = await assign(target.id, otherStaffId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STAFF_CONFLICT');
    expect(await prisma.bookingStaff.count({ where: { bookingId: target.id } })).toBe(0);
  });

  it('a dispatcher cannot book a cleaner back to back with no time to travel', async () => {
    const first = await job(at(10), 3, [otherStaffId]);
    const tooClose = await job(at(13));
    const res = await assign(tooClose.id, otherStaffId);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(first.bookingNumber);

    const withTravel = await job(new Date(at(13).getTime() + 30 * 60000));
    expect((await assign(withTravel.id, otherStaffId)).status).toBe(200);
  });

  it('a dispatcher cannot assign a cleaner during their time off', async () => {
    await prisma.staffTimeOff.create({
      data: { staffId: otherStaffId, startAt: at(8), endAt: at(18), reason: 'Appointment' },
    });
    const target = await job(at(10));
    const res = await assign(target.id, otherStaffId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STAFF_CONFLICT');
  });

  /* ---------------- cleaner scoping ---------------- */

  it("[INV-AUTH-04] a cleaner sees only their own jobs, whatever staffId they send", async () => {
    const cookie = await login(CLEANER);
    const res = await request(app)
      .get('/api/v1/crew/jobs')
      .query({ staffId: otherStaffId }) // trying to read a colleague's day
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    // The query parameter is ignored; the account decides.
    expect(JSON.stringify(res.body)).not.toMatch(otherStaffId);
  });

  it('a cleaner cannot advance a job that is not theirs', async () => {
    const cookie = await login(CLEANER);
    const customer = await prisma.customer.create({ data: {} });
    const addr = await prisma.customerAddress.create({
      data: { customerId: customer.id, formattedAddress: 'x', city: 'Lachine', postalCode: 'H8T1B7' },
    });
    const q = await prisma.quote.create({
      data: {
        customerId: customer.id,
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
    const booking = await prisma.booking.create({
      data: {
        bookingNumber: 'R2N-2026-000501',
        customerId: customer.id,
        serviceOptionId: 'svc_basic_2x3',
        addressId: addr.id,
        quoteId: q.id,
        startAt: new Date(Date.now() + 3600_000),
        endAt: new Date(Date.now() + 4 * 3600_000),
        status: 'CONFIRMED',
        grandTotalCents: 25869,
        priceSnapshot: {},
        staff: { create: [{ staffId: otherStaffId }] }, // Bruno's job
      },
    });

    const res = await request(app)
      .post(`/api/v1/crew/jobs/${booking.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'EN_ROUTE', staffId: otherStaffId });

    expect(res.status).toBe(403);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.status).toBe('CONFIRMED');
  });

  /* ---------------- password change ---------------- */

  it('changing a password requires the current one and enforces strength', async () => {
    const cookie = await login(OWNER);
    const wrong = await request(app)
      .post('/api/v1/staff/password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'nope', newPassword: 'GoldenFalcon88Ridge' });
    expect(wrong.status).toBe(400);

    const weak = await request(app)
      .post('/api/v1/staff/password')
      .set('Cookie', cookie)
      .send({ currentPassword: OWNER.password, newPassword: 'password123' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
  });

  it('changing a password revokes other sessions but keeps the current one', async () => {
    const laptop = await login(OWNER);
    const phone = await login(OWNER);

    const res = await request(app)
      .post('/api/v1/staff/password')
      .set('Cookie', phone)
      .send({ currentPassword: OWNER.password, newPassword: 'GoldenFalcon88Ridge' });
    expect(res.status).toBe(200);

    expect((await request(app).get('/api/v1/staff/me').set('Cookie', phone)).status).toBe(200);
    expect((await request(app).get('/api/v1/staff/me').set('Cookie', laptop)).status).toBe(401);
  });

  it('refuses reusing the same password', async () => {
    const cookie = await login(OWNER);
    const res = await request(app)
      .post('/api/v1/staff/password')
      .set('Cookie', cookie)
      .send({ currentPassword: OWNER.password, newPassword: OWNER.password });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PASSWORD_REUSED');
  });

  /* ---------------- audit ---------------- */

  it('attributes actions to a person, not a shared token', async () => {
    await login(OWNER);
    await request(app).post('/api/v1/staff/login').send({ email: OWNER.email, password: 'Nope12345678' });

    const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(logs.some((l) => l.action === 'STAFF_LOGIN')).toBe(true);
    expect(logs.some((l) => l.action === 'STAFF_LOGIN_FAILED')).toBe(true);
    for (const l of logs) {
      expect(l.actorType).toBe('STAFF');
      expect(l.actorId).toBeTruthy();
    }
  });

  it('never leaks a password hash through any endpoint', async () => {
    const cookie = await login(OWNER);
    const me = await request(app).get('/api/v1/staff/me').set('Cookie', cookie);
    const body = JSON.stringify(me.body);
    expect(body).not.toMatch(/scrypt\$/);
    expect(body).not.toMatch(/passwordHash/);
  });
});

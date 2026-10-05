import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApi } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import {
  FakePlacesProvider,
  SessionTokenManager,
  normalizeComponents,
} from '../src/integrations/places.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';
import { signUp } from './support/customer-auth.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

describe('autocomplete session tokens', () => {
  it('reuses one token across keystrokes in the same session', () => {
    const m = new SessionTokenManager();
    const a = m.acquire('s1');
    const b = m.acquire('s1');
    const c = m.acquire('s1');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('mints a fresh token after Place Details retires the session', () => {
    const m = new SessionTokenManager();
    const first = m.acquire('s1');
    m.retire('s1'); // details fetched — session over
    const second = m.acquire('s1');
    expect(second).not.toBe(first);
  });

  it('gives different sessions different tokens', () => {
    const m = new SessionTokenManager();
    expect(m.acquire('s1')).not.toBe(m.acquire('s2'));
  });

  it('expires a stale token so an abandoned search does not reuse it', () => {
    let clock = 0;
    const m = new SessionTokenManager(() => clock, 60_000);
    const first = m.acquire('s1');
    clock = 61_000;
    expect(m.acquire('s1')).not.toBe(first);
  });
});

describe('address normalization', () => {
  it('maps Google address components to R2NETTE fields', () => {
    const out = normalizeComponents({
      id: 'place_754',
      formattedAddress: '754 Av. 36e, Lachine, QC H8T 1B7, Canada',
      location: { latitude: 45.4419, longitude: -73.6764 },
      addressComponents: [
        { types: ['street_number'], longText: '754', shortText: '754' },
        { types: ['route'], longText: 'Avenue 36e', shortText: 'Av 36e' },
        { types: ['locality'], longText: 'Lachine', shortText: 'Lachine' },
        { types: ['administrative_area_level_1'], longText: 'Quebec', shortText: 'QC' },
        { types: ['postal_code'], longText: 'H8T 1B7', shortText: 'H8T 1B7' },
        { types: ['country'], longText: 'Canada', shortText: 'CA' },
      ],
    });
    expect(out.streetNumber).toBe('754');
    expect(out.city).toBe('Lachine');
    expect(out.province).toBe('QC');
    expect(out.postalCode).toBe('H8T 1B7');
    expect(out.latitude).toBeCloseTo(45.4419);
  });

  it('survives a sparse response without throwing', () => {
    const out = normalizeComponents({
      id: 'p',
      formattedAddress: 'Somewhere',
      location: { latitude: 1, longitude: 2 },
    });
    expect(out.city).toBe('');
    expect(out.province).toBe('QC');
  });
});

d('address HTTP routes', () => {
  let prisma: PrismaClient;
  let places: FakePlacesProvider;
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
    await prisma.promotionClaim.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.paymentMethodReference.deleteMany();
    await prisma.paymentProviderCustomer.deleteMany();
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.bookingHold.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.customerSession.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    await seed(prisma);
    places = new FakePlacesProvider();
    app = createApi({
      prisma,
      verification: new FakeVerificationProvider('123456'),
      places,
      origin: { latitude: 45.4419, longitude: -73.6764 },
    });
  });

  /** Register a new customer through the real sign-up flow; returns the session cookie. */
  async function login(phone = '514 825 2825') {
    return (await signUp(app, phone)).cookie;
  }

  it('returns suggestions and keeps one token per search session', async () => {
    const first = await request(app).get('/api/v1/address/autocomplete').query({ q: '754 av' });
    const sessionId = first.body.sessionId;
    expect(first.body.suggestions).toHaveLength(2);

    await request(app).get('/api/v1/address/autocomplete').query({ q: '754 ave', sessionId });
    await request(app).get('/api/v1/address/autocomplete').query({ q: '754 avenue', sessionId });

    const used = new Set(places.autocompleteCalls.map((c) => c.sessionToken));
    expect(used.size).toBe(1); // one token for the whole session
    expect(places.autocompleteCalls).toHaveLength(3);
  });

  it('does not call Google for very short input', async () => {
    const res = await request(app).get('/api/v1/address/autocomplete').query({ q: 'ab' });
    expect(res.body.suggestions).toEqual([]);
    expect(places.autocompleteCalls).toHaveLength(0);
  });

  it('selecting an address saves it and returns server-computed distance', async () => {
    const cookie = await login();
    places.nextDistanceMeters = 12_000;

    const first = await request(app).get('/api/v1/address/autocomplete').query({ q: '754 av' });
    const res = await request(app)
      .post('/api/v1/address/select')
      .set('Cookie', cookie)
      .send({ placeId: 'place_754', sessionId: first.body.sessionId, unit: '402' });

    expect(res.status).toBe(200);
    expect(res.body.address.city).toBe('Lachine');
    expect(res.body.address.unit).toBe('402');
    expect(res.body.travel.distanceKm).toBe(12);
    expect(places.routeCalls).toBe(1);

    const saved = await prisma.customerAddress.findFirstOrThrow();
    expect(saved.placeId).toBe('place_754');
    expect(saved.latitude).toBeCloseTo(45.4419);
  });

  it('retires the session token after Place Details', async () => {
    const cookie = await login();
    const first = await request(app).get('/api/v1/address/autocomplete').query({ q: '754 av' });
    const sessionId = first.body.sessionId;
    const tokenUsedForSearch = places.autocompleteCalls[0]!.sessionToken;

    await request(app)
      .post('/api/v1/address/select')
      .set('Cookie', cookie)
      .send({ placeId: 'place_754', sessionId });
    expect(places.detailsCalls[0]!.sessionToken).toBe(tokenUsedForSearch);

    // The next search must not reuse that token.
    await request(app).get('/api/v1/address/autocomplete').query({ q: '760 av', sessionId });
    const next = places.autocompleteCalls[places.autocompleteCalls.length - 1]!.sessionToken;
    expect(next).not.toBe(tokenUsedForSearch);
  });

  it('requires a session to save an address', async () => {
    const res = await request(app).post('/api/v1/address/select').send({ placeId: 'place_754' });
    expect(res.status).toBe(401);
  });

  it('never exposes the business origin to the browser', async () => {
    const cookie = await login();
    const res = await request(app)
      .post('/api/v1/address/select')
      .set('Cookie', cookie)
      .send({ placeId: 'place_754' });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/origin/i);
    expect(body).not.toMatch(/Fairway/i);
  });

  it('prices from the server-derived distance, ignoring any distanceKm the client sends', async () => {
    const cookie = await login();
    places.nextDistanceMeters = 35_000; // 35 km -> 15 billable km

    const sel = await request(app)
      .post('/api/v1/address/select')
      .set('Cookie', cookie)
      .send({ placeId: 'place_754' });
    const addressId = sel.body.address.id;

    const quote = await request(app)
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        productSupplyOption: 'CLIENT_SUPPLIED',
        addressId,
        distanceKm: 0, // the customer would love this to be free
      });

    // 15 km beyond the 20 km allowance x $0.65 = $9.75
    const distanceLine = quote.body.quote.lines.find(
      (l: { type: string }) => l.type === 'DISTANCE',
    );
    expect(distanceLine).toBeTruthy();
    expect(distanceLine.subtotalCents).toBe(975);
  });

  it('charges no distance surcharge inside the 20 km allowance', async () => {
    const cookie = await login();
    places.nextDistanceMeters = 18_000;
    const sel = await request(app)
      .post('/api/v1/address/select')
      .set('Cookie', cookie)
      .send({ placeId: 'place_754' });

    const quote = await request(app)
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        productSupplyOption: 'CLIENT_SUPPLIED',
        addressId: sel.body.address.id,
      });

    const distanceLine = quote.body.quote.lines.find(
      (l: { type: string }) => l.type === 'DISTANCE',
    );
    expect(distanceLine).toBeUndefined();
  });

  it('one customer cannot quote against another customer address', async () => {
    const victim = await login('514 825 2826');
    const sel = await request(app)
      .post('/api/v1/address/select')
      .set('Cookie', victim)
      .send({ placeId: 'place_754' });

    const attacker = await login('514 825 2825');
    const res = await request(app)
      .post('/api/v1/quotes')
      .set('Cookie', attacker)
      .send({
        serviceOptionId: 'svc_basic_2x3',
        frequency: 'ONE_TIME',
        productSupplyOption: 'CLIENT_SUPPLIED',
        addressId: sel.body.address.id,
      });
    expect(res.status).toBe(404);
  });

  it('reports NOT_CONFIGURED instead of faking addresses', async () => {
    const bare = createApi({ prisma, verification: new FakeVerificationProvider('123456') });
    const res = await request(bare).get('/api/v1/address/autocomplete').query({ q: '754 av' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });
});

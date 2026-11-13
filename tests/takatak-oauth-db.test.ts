// Claude (Anthropic) · 2026-11-10. "Continuer avec TAKATAK" against disposable CI PostgreSQL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createApi } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import type { TakatakIdentity } from '../src/identity/takatak-oauth.js';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite('TAKATAK sign-in real PostgreSQL transactions', () => {
  let prisma: PrismaClient;
  const subjects: string[] = [];
  const customerIds: string[] = [];
  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    const rows = await prisma.customer.findMany({ where: { OR: [{ emailAuthSubject: { in: subjects } }, { id: { in: customerIds } }] }, select: { id: true } });
    const ids = rows.map((c) => c.id);
    await prisma.takatakSyncEvent.deleteMany({ where: { externalUserId: { in: ids } } });
    await prisma.customerPhone.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customerSession.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  function fixture(identity: Partial<TakatakIdentity> = {}) {
    const subject = `takatak-${randomUUID()}`;
    subjects.push(subject);
    const full: TakatakIdentity = {
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      phone: null,
      phoneVerified: false,
      name: 'Alex Gagnon',
      ...identity,
    };
    const app = createApi({
      prisma,
      verification: new FakeVerificationProvider('123456'),
      publicUrl: 'https://r2nette.example',
      takatakOAuth: {
        configured: true,
        authorizationUrl: async ({ state }) => `https://auth.takatak.example/authorize?state=${state}`,
        exchangeCode: async () => full,
        googleConfigured: false,
        sendEmailCode: async () => undefined,
        verifyEmailCode: async () => { throw new Error('not used'); },
        signInWithPassword: async () => { throw new Error('not used'); },
        setPassword: async () => { throw new Error('not used'); },
        googleAuthorizationUrl: () => 'https://auth.takatak.example/authorize',
        exchangeGoogleCode: async () => { throw new Error('not used'); },
        beginAuthorization: async () => { throw new Error('not used'); },
        authorizationDetails: async () => { throw new Error('not used'); },
        decideConsent: async () => { throw new Error('not used'); },
        revokeSession: async () => undefined,
      },
    });
    return { app, identity: full };
  }

  async function signIn(app: ReturnType<typeof createApi>, query = 'terms=1&locale=fr') {
    const started = await request(app).get(`/api/v1/auth/takatak/start?${query}`);
    const state = new URL(started.headers.location!).searchParams.get('state')!;
    const cookie = (started.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    return request(app).get(`/api/v1/auth/takatak/callback?code=one-time&state=${encodeURIComponent(state)}`).set('Cookie', cookie);
  }

  it('creates the R2NETTE copy, imports a TAKATAK-verified phone and queues the profile for TAKATAK', async () => {
    const phone = `+1514${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const { app, identity } = fixture({ phone, phoneVerified: true });
    const res = await signIn(app);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/#book');
    const customer = await prisma.customer.findUniqueOrThrow({ where: { emailAuthSubject: identity.subject }, include: { phones: true } });
    expect(customer).toMatchObject({ email: identity.email, firstName: 'Alex', lastName: 'Gagnon', marketingConsent: false, termsVersion: '2026-10-29' });
    expect(customer.phones).toEqual([expect.objectContaining({ phoneE164: phone, isPrimary: true })]);
    expect(customer.phones[0]!.verifiedAt).not.toBeNull();
    const session = await prisma.customerSession.findFirstOrThrow({ where: { customerId: customer.id } });
    expect(session.emailVerifiedAt).not.toBeNull();
    const event = await prisma.takatakSyncEvent.findFirstOrThrow({ where: { externalUserId: customer.id } });
    expect(event.eventType).toBe('CUSTOMER_REGISTERED');

    // Second visit signs the same customer in; no duplicate account.
    const again = await signIn(app, 'locale=fr&returnTo=%2Faccount');
    expect(again.headers.location).toBe('/account');
    expect(await prisma.customer.count({ where: { emailAuthSubject: identity.subject } })).toBe(1);
    expect(await prisma.customerSession.count({ where: { customerId: customer.id } })).toBe(2);
  });

  it('links a legacy phone customer through the relation lookup and claims a historic email profile, ending its old sessions', async () => {
    const phone = `+1438${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const legacy = await prisma.customer.create({ data: { phones: { create: { phoneE164: phone, verifiedAt: new Date('2026-01-01') } } } });
    customerIds.push(legacy.id);
    const { app, identity } = fixture({ email: null, emailVerified: false, phone, phoneVerified: true });
    const res = await signIn(app);
    expect(res.headers.location).toBe('/#book');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: legacy.id } })).emailAuthSubject).toBe(identity.subject);

    const email = `historic-${randomUUID()}@example.test`;
    const historic = await prisma.customer.create({ data: { email } });
    customerIds.push(historic.id);
    const old = await prisma.customerSession.create({
      data: { sessionTokenHash: `old-${randomUUID()}`, customerId: historic.id, phoneVerifiedAt: new Date('2026-10-01'), expiresAt: new Date('2027-01-01') },
    });
    const second = fixture({ email });
    const claimed = await signIn(second.app);
    expect(claimed.headers.location).toBe('/#book');
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: historic.id } });
    expect(after.emailAuthSubject).toBe(second.identity.subject);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect((await prisma.customerSession.findUniqueOrThrow({ where: { id: old.id } })).revokedAt).not.toBeNull();
    expect(await prisma.customerSession.count({ where: { customerId: historic.id, revokedAt: null } })).toBe(1);

    // Owned by another TAKATAK identity: still refused.
    const taken = await prisma.customer.create({ data: { email: `taken-${randomUUID()}@example.test`, emailAuthSubject: `other-${randomUUID()}` } });
    customerIds.push(taken.id);
    const third = fixture({ email: taken.email! });
    const refused = await signIn(third.app);
    expect(refused.headers.location).toBe('/login?takatak=link-required');
    expect(await prisma.customerSession.count({ where: { customerId: taken.id } })).toBe(0);
  });
});

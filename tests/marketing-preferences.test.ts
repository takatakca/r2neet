import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createApi, SESSION_COOKIE } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import { enqueueCustomerProfile } from '../src/integrations/takatak-sync.js';

vi.mock('../src/integrations/takatak-sync.js', async (original) => ({
  ...await original<typeof import('../src/integrations/takatak-sync.js')>(),
  enqueueCustomerProfile: vi.fn(),
}));

describe('account marketing preferences HTTP boundary', () => {
  const at = new Date('2026-10-22T12:00:00Z');
  const update = vi.fn();
  const transaction = { customer: { update } };
  const prisma = {
    customerSession: {
      findUnique: vi.fn(async () => ({ id: 'session', customerId: 'own-customer', revokedAt: null,
        expiresAt: new Date('2026-10-23T12:00:00Z') })),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction)),
  } as unknown as PrismaClient;
  const app = createApi({ prisma, verification: new FakeVerificationProvider('123456'), now: () => at });
  const endpoint = '/api/v1/account/marketing-preferences';
  const cookie = `${SESSION_COOKIE}=synthetic-token`;

  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue({});
  });

  it('requires a customer session before any update', async () => {
    await request(app).patch(endpoint).send({ marketingConsent: true }).expect(401);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([true, false])('persists the explicit choice %s with server time and queues the existing profile contract', async (choice) => {
    const result = await request(app).patch(endpoint).set('Cookie', cookie)
      .send({ marketingConsent: choice }).expect(200);
    expect(result.body).toEqual({ marketingConsent: choice, marketingConsentUpdatedAt: at.toISOString() });
    expect(update).toHaveBeenCalledWith({ where: { id: 'own-customer' },
      data: { marketingConsent: choice, marketingConsentUpdatedAt: at } });
    expect(enqueueCustomerProfile).toHaveBeenCalledWith(transaction, 'own-customer', 'PROFILE_UPDATED', at);
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it.each([{ marketingConsent: 'true' }, {}, { marketingConsent: true, customerId: 'other-customer' }])(
    'rejects coercion, missing choice and customer-id injection: %j', async (body) => {
      await request(app).patch(endpoint).set('Cookie', cookie).send(body).expect(400);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('rejects browser cross-site requests and form submissions', async () => {
    await request(app).patch(endpoint).set('Cookie', cookie).set('Sec-Fetch-Site', 'cross-site')
      .send({ marketingConsent: true }).expect(400);
    await request(app).patch(endpoint).set('Cookie', cookie).type('form')
      .send({ marketingConsent: 'true' }).expect(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not acknowledge success if the update fails', async () => {
    update.mockRejectedValue(new Error('synthetic persistence failure'));
    await request(app).patch(endpoint).set('Cookie', cookie).send({ marketingConsent: false }).expect(500);
    expect(enqueueCustomerProfile).not.toHaveBeenCalled();
  });
});

// Claude (Anthropic) · 2026-11-12 — owner order: no phone sign-in anywhere,
// only email code and Google. The routes answer 410 when it is off.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApi } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';

const prisma: any = {
  customerSession: { findUnique: async () => null },
  customer: {},
  customerPhone: { findUnique: async () => null },
};

describe('phone sign-in switch', () => {
  it('turns every phone and phone-linked Google route off', async () => {
    const app = createApi({ prisma, verification: new FakeVerificationProvider('123456'), phoneLogin: false });
    const calls = [
      request(app).post('/api/v1/auth/phone/send').send({ phone: '(514) 555-1212', intent: 'login' }),
      request(app).post('/api/v1/auth/phone/verify').send({ phone: '(514) 555-1212', code: '123456', intent: 'login' }),
      request(app).post('/api/v1/auth/registration/complete').send({}),
      request(app).get('/api/v1/auth/google/start'),
      request(app).get('/api/v1/auth/google/callback?code=x&state=y'),
    ];
    for (const res of await Promise.all(calls)) {
      expect([res.status, res.body.error?.code]).toEqual([410, 'PHONE_LOGIN_DISABLED']);
    }
  });

  it('leaves the email-code and TAKATAK routes alone', async () => {
    const app = createApi({ prisma, verification: new FakeVerificationProvider('123456'), phoneLogin: false });
    const config = await request(app).get('/api/v1/auth/takatak/config');
    expect(config.status).toBe(200);
    const logout = await request(app).post('/api/v1/auth/logout');
    expect(logout.status).not.toBe(410);
  });

  it('keeps the routes on when the switch is not set, as the older tests expect', async () => {
    const app = createApi({ prisma, verification: new FakeVerificationProvider('123456') });
    const res = await request(app).post('/api/v1/auth/phone/send').send({ phone: '(514) 555-1212', intent: 'login' });
    expect(res.status).not.toBe(410);
  });
});

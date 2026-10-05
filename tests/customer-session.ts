import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import type { Express } from 'express';
import { REGISTRATION_COOKIE, SESSION_COOKIE } from '../src/api/app.js';

function cookieNamed(res: Response, name: string): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = list.find((entry) => entry.startsWith(`${name}=`));
  expect(cookie).toEqual(expect.stringContaining(`${name}=`));
  return cookie!;
}

/**
 * Sign up through the real phone + registration endpoints and return the
 * customer session cookie. Verify alone does not create a customer.
 */
export async function customerSession(app: Express, phone: string): Promise<string> {
  const send = await request(app)
    .post('/api/v1/auth/phone/send')
    .send({ phone, intent: 'signup' });
  expect(send.status).toBe(200);

  const verify = await request(app)
    .post('/api/v1/auth/phone/verify')
    .send({ phone, code: '123456', intent: 'signup' });
  expect(verify.status).toBe(200);
  expect(verify.body.outcome).toBe('PROFILE_REQUIRED');

  const digits = phone.replace(/\D/g, '');
  const complete = await request(app)
    .post('/api/v1/auth/registration/complete')
    .set('Cookie', cookieNamed(verify, REGISTRATION_COOKIE))
    .send({
      firstName: 'Alex',
      lastName: 'Tremblay',
      email: `user-${digits}@example.test`,
      locale: 'en',
      termsAccepted: true,
      privacyAccepted: true,
      marketingConsent: false,
    });
  expect(complete.status).toBe(201);

  return cookieNamed(complete, SESSION_COOKIE);
}

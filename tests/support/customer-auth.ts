import request from 'supertest';
import { expect } from 'vitest';
import {
  REGISTRATION_COOKIE,
  SESSION_COOKIE,
  type createApi,
} from '../../src/api/app.js';

/**
 * Customer phone-auth helpers for HTTP tests.
 *
 * They drive the real routes in the order a browser does, so any test that
 * needs a signed-in customer also proves the contract production relies on:
 *
 *   new number:      send(signup) -> verify(signup) -> registration/complete
 *   existing number: send(login)  -> verify(login)
 *
 * A customer session cookie is only issued by verify(login) for a completed
 * account, or by registration/complete. Nothing here writes a session row
 * directly.
 */

type Api = ReturnType<typeof createApi>;

/** The code `new FakeVerificationProvider('123456')` accepts. */
export const TEST_OTP = '123456';

/** One cookie, by name, from a response's Set-Cookie headers. */
export function setCookie(
  res: request.Response,
  name: string,
): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
}

/**
 * A valid registration/complete body. The email is derived from the phone so
 * two customers in one test never collide on the unique email column.
 */
export function registrationProfile(
  phone: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const digits = phone.replace(/\D/g, '');
  return {
    firstName: 'Test',
    lastName: `Customer ${digits.slice(-4)}`,
    email: `customer.${digits}@example.com`,
    locale: 'en',
    termsAccepted: true,
    privacyAccepted: true,
    marketingConsent: false,
    ...overrides,
  };
}

export interface SignedInCustomer {
  /** The Set-Cookie line for the customer session, usable as a Cookie header. */
  cookie: string;
  customerId: string;
}

/** Register a NEW customer through the sign-up flow and return its session. */
export async function signUp(
  app: Api,
  phone: string,
  profile: Record<string, unknown> = {},
): Promise<SignedInCustomer> {
  const sent = await request(app)
    .post('/api/v1/auth/phone/send')
    .send({ phone, intent: 'signup' });
  expect(sent.status, 'signup: send').toBe(200);

  const verified = await request(app)
    .post('/api/v1/auth/phone/verify')
    .send({ phone, code: TEST_OTP, intent: 'signup' });
  expect(verified.status, 'signup: verify').toBe(200);
  expect(verified.body.outcome).toBe('PROFILE_REQUIRED');
  // Proving the phone is not an account: no customer session yet.
  expect(setCookie(verified, SESSION_COOKIE)).toBeUndefined();
  const registration = setCookie(verified, REGISTRATION_COOKIE);
  expect(registration, 'signup: registration cookie').toBeTruthy();

  const completed = await request(app)
    .post('/api/v1/auth/registration/complete')
    .set('Cookie', registration!)
    .send(registrationProfile(phone, profile));
  expect(completed.status, 'signup: registration/complete').toBe(201);
  const cookie = setCookie(completed, SESSION_COOKIE);
  expect(cookie, 'signup: session cookie').toBeTruthy();

  return { cookie: cookie!, customerId: completed.body.customer.id as string };
}

/** Log an EXISTING, completed customer in and return its session. */
export async function logIn(
  app: Api,
  phone: string,
): Promise<SignedInCustomer> {
  const sent = await request(app)
    .post('/api/v1/auth/phone/send')
    .send({ phone, intent: 'login' });
  expect(sent.status, 'login: send').toBe(200);

  const verified = await request(app)
    .post('/api/v1/auth/phone/verify')
    .send({ phone, code: TEST_OTP, intent: 'login' });
  expect(verified.status, 'login: verify').toBe(200);
  expect(verified.body.outcome).toBe('AUTHENTICATED');
  const cookie = setCookie(verified, SESSION_COOKIE);
  expect(cookie, 'login: session cookie').toBeTruthy();

  return { cookie: cookie!, customerId: verified.body.customer.id as string };
}

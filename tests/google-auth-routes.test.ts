import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApi, GOOGLE_LINK_COOKIE, SESSION_COOKIE } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';

interface OAuthRow {
  id: string;
  stateHash: string;
  linkTokenHash: string | null;
  googleAuthSubject: string | null;
  verifiedPhone: string | null;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
}

function cookieValue(response: request.Response, name: string): string {
  const raw = response.headers['set-cookie'];
  const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const header = headers.find((item) => item.startsWith(`${name}=`));
  if (!header) throw new Error(`Missing ${name} cookie`);
  return header.split(';')[0]!;
}

function setCookies(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function createTestApi() {
  const rows: OAuthRow[] = [];
  let sessionCreated = false;
  const prisma = {
    customerSession: {
      findUnique: async () => null,
      create: async () => {
        sessionCreated = true;
        return {};
      },
    },
    customer: {
      findUnique: async () => null,
    },
    googleAuthTransaction: {
      create: async ({ data }: { data: Omit<OAuthRow, 'id' | 'createdAt' | 'linkTokenHash' | 'googleAuthSubject' | 'verifiedPhone' | 'completedAt'> }) => {
        rows.push({
          ...data,
          id: 'oauth-transaction',
          linkTokenHash: null,
          googleAuthSubject: null,
          verifiedPhone: null,
          createdAt: new Date(),
          completedAt: null,
        });
      },
      findUnique: async ({ where }: { where: Partial<OAuthRow> }) =>
        rows.find((row) => Object.entries(where).every(([key, value]) => row[key as keyof OAuthRow] === value)) ??
        null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Partial<OAuthRow>;
        data: Partial<OAuthRow>;
      }) => {
        const row = rows.find((candidate) =>
          Object.entries(where).every(([key, value]) =>
            key === 'expiresAt'
              ? candidate.expiresAt > new Date()
              : candidate[key as keyof OAuthRow] === value,
          ),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const app = createApi({
    prisma: prisma as never,
    verification: new FakeVerificationProvider(),
    publicUrl: 'https://r2nette.ca',
    googleAuth: {
      configured: true,
      authorizationUrl(publicUrl, challenge) {
        const callback = new URL('/api/v1/auth/google/callback', publicUrl);
        const authorize = new URL('https://supabase.example.test/auth/v1/authorize');
        authorize.searchParams.set('redirect_to', callback.toString());
        authorize.searchParams.set('code_challenge', challenge);
        return authorize.toString();
      },
      async exchangeCode() {
        return { subject: 'verified-google-subject' };
      },
    },
  });
  return { app, get sessionCreated() { return sessionCreated; } };
}

describe('Google OAuth routes', () => {
  it('uses browser-bound state and does not issue a session until the phone is linked', async () => {
    const { app, sessionCreated } = createTestApi();
    const start = await request(app)
      .get('/api/v1/auth/google/start')
      .query({ returnTo: 'https://attacker.example/steal' });
    const state = cookieValue(start, 'r2n_google_state');
    const verifier = cookieValue(start, 'r2n_google_verifier');

    expect(start.status).toBe(302);
    expect(new URL(start.headers.location!).searchParams.get('redirect_to')).toBe(
      'https://r2nette.ca/api/v1/auth/google/callback',
    );

    const callback = await request(app)
      .get('/api/v1/auth/google/callback')
      .query({ code: 'one-time-code' })
      .set('Cookie', `${state}; ${verifier}`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(
      'https://r2nette.ca/login?google=phone&returnTo=%2Faccount',
    );
    expect(cookieValue(callback, GOOGLE_LINK_COOKIE)).toMatch(
      /^r2n_google_link=/,
    );
    expect(
      setCookies(callback).some((item) =>
        item.startsWith(`${SESSION_COOKIE}=`),
      ),
    ).toBe(false);
    expect(sessionCreated).toBe(false);
  });

  it('rejects a forged browser-state cookie without exchanging the code', async () => {
    const { app } = createTestApi();
    const start = await request(app).get('/api/v1/auth/google/start');
    const state = cookieValue(start, 'r2n_google_state').replace(
      /=.*/,
      '=forged-state',
    );
    const verifier = cookieValue(start, 'r2n_google_verifier');

    const callback = await request(app)
      .get('/api/v1/auth/google/callback')
      .query({ code: 'one-time-code' })
      .set('Cookie', `${state}; ${verifier}`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/login?google=error');
    expect(
      setCookies(callback).some((item) =>
        item.startsWith(`${GOOGLE_LINK_COOKIE}=`),
      ),
    ).toBe(false);
  });
});

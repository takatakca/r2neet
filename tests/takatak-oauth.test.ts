// Claude (Anthropic) · 2026-11-10 — "Continuer avec TAKATAK"
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createApi } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import {
  SupabaseTakatakOAuthProvider,
  type TakatakIdentity,
  type TakatakOAuthProvider,
} from '../src/identity/takatak-oauth.js';

const at = new Date('2026-11-10T15:00:00Z');
const ORIGIN = 'https://r2nette.ca';
const CALLBACK = `${ORIGIN}/api/v1/auth/takatak/callback`;

type Row = Record<string, any>;

function setup(opts: { identity?: Partial<TakatakIdentity>; customers?: Row[]; phones?: Row[]; sessionCustomer?: string | null } = {}) {
  const defaults = { firstName: null, lastName: null, email: null, preferredLocale: 'fr', registrationCompletedAt: null, termsAcceptedAt: null,
    privacyAcceptedAt: null, marketingConsent: false, marketingConsentUpdatedAt: null, createdAt: at, updatedAt: at };
  const customers: Row[] = (opts.customers ?? []).map((c) => ({ ...defaults, ...c }));
  const phones: Row[] = [...(opts.phones ?? [])];
  const sessions: Row[] = [];
  const syncEvents: Row[] = [];
  const match = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => row[k] === v);
  const prisma: any = {
    customerSession: {
      findUnique: async () => (opts.sessionCustomer ? { customerId: opts.sessionCustomer, revokedAt: null, expiresAt: new Date('2027-01-01') } : null),
      update: async () => ({}),
      create: async ({ data }: any) => { sessions.push(data); return data; },
    },
    customer: {
      findUnique: async ({ where }: any) => customers.find((c) => match(c, where)) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const c = customers.find((row) => match(row, where));
        if (!c) throw new Error('missing');
        return { ...c, phones: phones.filter((p) => p.customerId === c.id), addresses: [] };
      },
      create: async ({ data }: any) => {
        if (customers.some((c) => (data.email && c.email === data.email) || c.emailAuthSubject === data.emailAuthSubject)) throw new Error('unique');
        const row = { id: `customer-${customers.length + 1}`, createdAt: at, updatedAt: at, firstName: null, lastName: null, marketingConsentUpdatedAt: null, ...data };
        customers.push(row);
        return row;
      },
      update: async ({ where, data }: any) => { const c = customers.find((row) => match(row, where))!; Object.assign(c, data); return c; },
      updateMany: async ({ where, data }: any) => {
        const rows = customers.filter((c) => match(c, where));
        rows.forEach((c) => Object.assign(c, data));
        return { count: rows.length };
      },
    },
    customerPhone: {
      findUnique: async ({ where }: any) => {
        const p = phones.find((row) => row.phoneE164 === where.phoneE164);
        return p ? { ...p, customer: customers.find((c) => c.id === p.customerId) } : null;
      },
      create: async ({ data }: any) => { phones.push({ id: `phone-${phones.length + 1}`, createdAt: at, ...data }); return data; },
    },
    takatakSyncEvent: { upsert: async ({ create }: any) => { syncEvents.push(create); return create; } },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);

  const identity: TakatakIdentity = {
    subject: 'takatak-user-1',
    email: 'marie@example.ca',
    emailVerified: true,
    phone: null,
    phoneVerified: false,
    name: 'Marie Tremblay',
    ...opts.identity,
  };
  const takatakOAuth: TakatakOAuthProvider & { exchangeCode: ReturnType<typeof vi.fn> } = {
    configured: true,
    authorizationUrl: vi.fn(async ({ redirectUri, challenge, state, locale }) => {
      const u = new URL('https://auth.takatak.test/auth/v1/oauth/authorize');
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('state', state);
      u.searchParams.set('ui_locales', locale);
      return u.toString();
    }),
    exchangeCode: vi.fn(async () => identity),
  };
  const app = createApi({
    prisma,
    verification: new FakeVerificationProvider('123456'),
    takatakOAuth,
    publicUrl: ORIGIN,
    now: () => at,
  });
  return { app, customers, phones, sessions, syncEvents, takatakOAuth };
}

async function start(app: ReturnType<typeof createApi>, query = 'terms=1&locale=fr', cookie?: string) {
  const req = request(app).get(`/api/v1/auth/takatak/start?${query}`);
  if (cookie) req.set('Cookie', cookie);
  const res = await req;
  expect(res.status).toBe(303);
  const target = new URL(res.headers.location!);
  const set = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('r2n_takatak_oauth='))!;
  return { target, cookie: set.split(';')[0]!, setCookie: set };
}

async function callback(app: ReturnType<typeof createApi>, cookie: string, state: string, extra = 'code=abc') {
  return request(app).get(`/api/v1/auth/takatak/callback?${extra}&state=${encodeURIComponent(state)}`).set('Cookie', cookie);
}

describe('Continuer avec TAKATAK — sign-up and sign-in', () => {
  it('sends the browser to TAKATAK with PKCE and keeps the verifier server-side in a scoped httpOnly cookie', async () => {
    const s = setup();
    const { target, setCookie } = await start(s.app, 'terms=1&locale=en&returnTo=%2Fpayment%3Fq%3D1');
    expect(target.host).toBe('auth.takatak.test');
    expect(target.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(target.searchParams.get('ui_locales')).toBe('en');
    expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth\/takatak/);
    const pending = JSON.parse(Buffer.from(setCookie.split(';')[0]!.split('=')[1]!, 'base64url').toString());
    expect(createHash('sha256').update(pending.verifier).digest('base64url')).toBe(target.searchParams.get('code_challenge'));
    expect(pending.returnTo).toBe('/payment?q=1');
  });

  it('creates the R2NETTE copy of a new TAKATAK customer, signs them in and queues the profile back to TAKATAK', async () => {
    const s = setup({ identity: { phone: '+15145551212', phoneVerified: true } });
    const { target, cookie } = await start(s.app);
    const res = await callback(s.app, cookie, target.searchParams.get('state')!);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/#book');
    expect(s.takatakOAuth.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ code: 'abc', redirectUri: CALLBACK }));
    expect(s.customers[0]).toMatchObject({
      email: 'marie@example.ca', emailAuthSubject: 'takatak-user-1', emailVerifiedAt: at,
      firstName: 'Marie', lastName: 'Tremblay', preferredLocale: 'fr', termsVersion: '2026-10-29', marketingConsent: false,
    });
    expect(s.phones[0]).toMatchObject({ phoneE164: '+15145551212', verifiedAt: at, customerId: s.customers[0]!.id });
    expect(s.sessions[0]).toMatchObject({ customerId: s.customers[0]!.id, emailVerifiedAt: at, phoneVerifiedAt: null });
    expect(s.syncEvents[0]).toMatchObject({ eventType: 'CUSTOMER_REGISTERED', externalUserId: s.customers[0]!.id });
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('r2n_session=') && /HttpOnly/i.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith('r2n_takatak_oauth=;'))).toBe(true);
  });

  it('signs in a returning customer already linked by TAKATAK id (including email-first customers) without asking for terms again', async () => {
    const s = setup({ customers: [{ id: 'existing', email: 'marie@example.ca', emailAuthSubject: 'takatak-user-1', firstName: 'Marie', lastName: null }] });
    const { target, cookie } = await start(s.app, 'locale=fr&returnTo=%2Faccount');
    const res = await callback(s.app, cookie, target.searchParams.get('state')!);
    expect(res.headers.location).toBe('/account');
    expect(s.customers).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ customerId: 'existing' });
  });

  it('asks a brand-new customer to accept the terms before an account is created', async () => {
    const s = setup();
    const { target, cookie } = await start(s.app, 'locale=fr');
    const res = await callback(s.app, cookie, target.searchParams.get('state')!);
    expect(res.headers.location).toBe('/signup?takatak=terms');
    expect(s.customers).toHaveLength(0);
    expect(s.sessions).toHaveLength(0);
  });

  it('never takes over a historic profile that only lists the same email', async () => {
    const s = setup({ customers: [{ id: 'historic', email: 'marie@example.ca', emailAuthSubject: null }] });
    const { target, cookie } = await start(s.app);
    const res = await callback(s.app, cookie, target.searchParams.get('state')!);
    expect(res.headers.location).toBe('/login?takatak=link-required');
    expect(s.customers[0]!.emailAuthSubject).toBeNull();
    expect(s.sessions).toHaveLength(0);
  });

  it('links a legacy phone customer when TAKATAK verified the same phone', async () => {
    const s = setup({
      identity: { email: null, emailVerified: false, phone: '+15145551212', phoneVerified: true },
      customers: [{ id: 'legacy', email: null, emailAuthSubject: null, firstName: null, lastName: null }],
      phones: [{ customerId: 'legacy', phoneE164: '+15145551212', verifiedAt: new Date('2026-01-01') }],
    });
    const { target, cookie } = await start(s.app);
    const res = await callback(s.app, cookie, target.searchParams.get('state')!);
    expect(res.headers.location).toBe('/#book');
    expect(s.customers[0]).toMatchObject({ emailAuthSubject: 'takatak-user-1', firstName: 'Marie', lastName: 'Tremblay' });
    expect(s.sessions[0]).toMatchObject({ customerId: 'legacy', phoneVerifiedAt: at });
  });

  it('does not attach an unverified TAKATAK phone or require email for the phone route', async () => {
    const s = setup({ identity: { email: null, emailVerified: false, phone: '+15145551212', phoneVerified: false } });
    const { target, cookie } = await start(s.app);
    const res = await callback(s.app, cookie, target.searchParams.get('state')!);
    expect(res.headers.location).toBe('/signup?takatak=email-required');
    expect(s.customers).toHaveLength(0);
  });

  it('rejects a forged state, a replayed callback and a cancelled consent', async () => {
    const s = setup();
    const { target, cookie } = await start(s.app);
    expect((await callback(s.app, cookie, 'x'.repeat(43))).headers.location).toBe('/login?takatak=expired');
    expect((await request(s.app).get(`/api/v1/auth/takatak/callback?code=abc&state=${target.searchParams.get('state')}`)).headers.location).toBe('/login?takatak=expired');
    expect((await callback(s.app, cookie, target.searchParams.get('state')!, 'error=access_denied')).headers.location).toBe('/login?takatak=cancelled');
    expect(s.takatakOAuth.exchangeCode).not.toHaveBeenCalled();
  });

  it('expires the pending sign-in after ten minutes', async () => {
    const s = setup();
    const { target, cookie } = await start(s.app);
    const raw = JSON.parse(Buffer.from(cookie.split('=')[1]!, 'base64url').toString());
    raw.createdAt = at.getTime() - 11 * 60_000;
    const old = `r2n_takatak_oauth=${Buffer.from(JSON.stringify(raw)).toString('base64url')}`;
    expect((await callback(s.app, old, target.searchParams.get('state')!)).headers.location).toBe('/login?takatak=expired');
  });

  it('only returns to same-site pages', async () => {
    const s = setup();
    for (const evil of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/api/v1/admin', '/login']) {
      const { cookie } = await start(s.app, `terms=1&returnTo=${encodeURIComponent(evil)}`);
      const pending = JSON.parse(Buffer.from(cookie.split('=')[1]!, 'base64url').toString());
      expect(pending.returnTo).toBe('/#book');
    }
  });

  it('links TAKATAK to the signed-in account and refuses a TAKATAK account already used elsewhere', async () => {
    const s = setup({ sessionCustomer: 'legacy', customers: [{ id: 'legacy', email: 'old@example.ca', emailAuthSubject: null }] });
    const { target, cookie } = await start(s.app, 'intent=link', 'r2n_session=opaque');
    const res = await request(s.app)
      .get(`/api/v1/auth/takatak/callback?code=abc&state=${encodeURIComponent(target.searchParams.get('state')!)}`)
      .set('Cookie', `${cookie}; r2n_session=opaque`);
    expect(res.headers.location).toBe('/account?takatak=linked');
    expect(s.customers[0]!.emailAuthSubject).toBe('takatak-user-1');

    const t = setup({ sessionCustomer: 'legacy', customers: [
      { id: 'legacy', email: 'old@example.ca', emailAuthSubject: null },
      { id: 'other', email: 'marie@example.ca', emailAuthSubject: 'takatak-user-1' },
    ] });
    const second = await start(t.app, 'intent=link', 'r2n_session=opaque');
    const refused = await request(t.app)
      .get(`/api/v1/auth/takatak/callback?code=abc&state=${encodeURIComponent(second.target.searchParams.get('state')!)}`)
      .set('Cookie', `${second.cookie}; r2n_session=opaque`);
    expect(refused.headers.location).toBe('/account?takatak=already-linked');
    expect(t.customers[0]!.emailAuthSubject).toBeNull();
  });

  it('sends visitors back with a clear reason when TAKATAK sign-in is not configured', async () => {
    const s = setup();
    (s.takatakOAuth as any).configured = false;
    const res = await request(s.app).get('/api/v1/auth/takatak/start');
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/login?takatak=unavailable');
    expect((await request(s.app).get('/api/v1/auth/takatak/config')).body).toEqual({ configured: false });
  });
});

describe('TAKATAK OAuth provider boundary', () => {
  const env = { TAKATAK_SUPABASE_URL: 'https://auth.takatak.test', TAKATAK_SUPABASE_ANON_KEY: 'public-anon', TAKATAK_OAUTH_CLIENT_ID: 'r2nette-client' };

  it('is off until the client id is set', () => {
    expect(new SupabaseTakatakOAuthProvider({ ...env, TAKATAK_OAUTH_CLIENT_ID: '' }).configured).toBe(false);
    expect(new SupabaseTakatakOAuthProvider(env).configured).toBe(true);
  });

  it('exchanges the code as a public PKCE client and trusts only TAKATAK userinfo', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://auth.takatak.test/auth/v1/oauth/authorize',
          token_endpoint: 'https://evil.example/token',
          userinfo_endpoint: 'https://auth.takatak.test/auth/v1/oauth/userinfo',
        }));
      }
      if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'access-1', id_token: 'never-used' }));
      return new Response(JSON.stringify({ sub: 'user-1', email: 'Marie@Example.ca', email_verified: true, phone_number: '15145551212', phone_number_verified: true, name: 'Marie Tremblay' }));
    });
    const p = new SupabaseTakatakOAuthProvider(env, fetcher as typeof fetch);
    const url = new URL(await p.authorizationUrl({ redirectUri: CALLBACK, challenge: 'c'.repeat(43), state: 's'.repeat(43), locale: 'fr' }));
    expect(url.searchParams.get('client_id')).toBe('r2nette-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email profile phone');
    const identity = await p.exchangeCode({ code: 'abc', verifier: 'v'.repeat(43), redirectUri: CALLBACK });
    expect(identity).toEqual({ subject: 'user-1', email: 'marie@example.ca', emailVerified: true, phone: '+15145551212', phoneVerified: true, name: 'Marie Tremblay' });
    const token = calls.find((c) => c.url.includes('/oauth/token'))!;
    expect(token.url).toBe('https://auth.takatak.test/auth/v1/oauth/token');
    const body = new URLSearchParams(String(token.init!.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: 'authorization_code', code: 'abc', client_id: 'r2nette-client', redirect_uri: CALLBACK, code_verifier: 'v'.repeat(43) });
    const info = calls.find((c) => c.url.endsWith('/oauth/userinfo'))!;
    expect((info.init!.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('treats an unverified email as no email and a rejected code as invalid', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'a' }));
      if (String(url).endsWith('/oauth/userinfo')) return new Response(JSON.stringify({ sub: 'u', email: 'x@example.ca', email_verified: false }));
      return new Response('{}', { status: 404 });
    });
    const p = new SupabaseTakatakOAuthProvider(env, fetcher as typeof fetch);
    expect(await p.exchangeCode({ code: 'abc', verifier: 'v'.repeat(43), redirectUri: CALLBACK })).toMatchObject({ emailVerified: false });
    const refused = new SupabaseTakatakOAuthProvider(env, (async () => new Response('{}', { status: 400 })) as typeof fetch);
    await expect(refused.exchangeCode({ code: 'abc', verifier: 'v'.repeat(43), redirectUri: CALLBACK })).rejects.toMatchObject({ code: 'TAKATAK_CODE_INVALID' });
  });
});

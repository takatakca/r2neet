// Claude (Anthropic) · 2026-11-11 — sign in on r2nette.ca by email code or
// Google; the TAKATAK consent screen is shown here and the existing
// /api/v1/auth/takatak/callback finishes the sign-in.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createApi } from '../src/api/app.js';
import { generateEncryptionKey } from '../src/auth/encryption.js';
import { FakeVerificationProvider, IdentityError } from '../src/identity/identity.js';
import type { AuthorizationView, HubSession, TakatakIdentity, TakatakOAuthProvider } from '../src/identity/takatak-oauth.js';

const ORIGIN = 'https://r2nette.ca';
const CALLBACK = `${ORIGIN}/api/v1/auth/takatak/callback`;
const AUTH_ID = 'abcdefghijklmnopqrstuvwxyz234567';
const start = Date.parse('2026-11-11T09:00:00Z');
type Row = Record<string, any>;

beforeAll(() => {
  process.env.FIELD_ENCRYPTION_KEY = generateEncryptionKey();
});

function setup(opts: { customers?: Row[]; phones?: Row[]; googleConfigured?: boolean } = {}) {
  let clock = start;
  const defaults = { firstName: null, lastName: null, email: null, preferredLocale: 'fr', registrationCompletedAt: null, termsAcceptedAt: null,
    privacyAcceptedAt: null, marketingConsent: false, marketingConsentUpdatedAt: null, createdAt: new Date(start), updatedAt: new Date(start) };
  const customers: Row[] = (opts.customers ?? []).map((c) => ({ ...defaults, ...c }));
  const phones: Row[] = [...(opts.phones ?? [])];
  const sessions: Row[] = [];
  const match = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => row[k] === v);
  const prisma: any = {
    customerSession: {
      findUnique: async () => null,
      update: async () => ({}),
      create: async ({ data }: any) => { sessions.push(data); return data; },
      updateMany: async ({ where, data }: any) => {
        const rows = sessions.filter((row) => row.customerId === where.customerId && row.revokedAt === where.revokedAt);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    customer: {
      findUnique: async ({ where }: any) => customers.find((c) => match(c, where)) ?? null,
      findFirst: async ({ where }: any) => customers.find((c) => (where.OR as Row[]).some((w) => match(c, w))) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const c = customers.find((row) => match(row, where));
        if (!c) throw new Error('missing');
        return { ...c, phones: phones.filter((p) => p.customerId === c.id), addresses: [] };
      },
      create: async ({ data }: any) => {
        const row = { id: `customer-${customers.length + 1}`, createdAt: new Date(clock), updatedAt: new Date(clock), firstName: null, lastName: null, marketingConsentUpdatedAt: null, ...data };
        customers.push(row);
        return row;
      },
      update: async ({ where, data }: any) => { const c = customers.find((row) => match(row, where))!; Object.assign(c, data); return c; },
      updateMany: async ({ where, data }: any) => { const rows = customers.filter((c) => match(c, where)); rows.forEach((c) => Object.assign(c, data)); return { count: rows.length }; },
    },
    customerPhone: {
      findUnique: async ({ where }: any) => { const p = phones.find((row) => row.phoneE164 === where.phoneE164); return p ? { ...p, customer: customers.find((c) => c.id === p.customerId) } : null; },
      create: async ({ data }: any) => { phones.push({ id: `phone-${phones.length + 1}`, ...data }); return data; },
    },
    takatakSyncEvent: { upsert: async ({ create }: any) => create },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);

  const identity: TakatakIdentity = { subject: 'takatak-user-1', email: 'marie@example.ca', emailVerified: true, phone: null, phoneVerified: false, name: 'Marie Tremblay' };
  const session: HubSession = { accessToken: 'hub-at', subject: 'takatak-user-1', email: 'marie@example.ca', phone: null };
  const begun: { state?: string; challenge?: string } = {};
  const details: AuthorizationView = { kind: 'consent', details: { authorizationId: AUTH_ID, appName: 'R2NETTE', returnAddress: CALLBACK, account: 'marie@example.ca', scopes: ['Confirmer que vous êtes connecté à TAKATAK', 'Voir votre adresse courriel', 'Voir votre nom et votre profil', 'Voir votre numéro de téléphone'] } };
  const provider = {
    configured: true,
    googleConfigured: opts.googleConfigured ?? true,
    authorizationUrl: vi.fn(async ({ state }: { state: string }) => `https://auth.takatak.test/auth/v1/oauth/authorize?state=${state}`),
    exchangeCode: vi.fn(async () => identity),
    sendEmailCode: vi.fn(async () => undefined),
    verifyEmailCode: vi.fn(async () => session),
    signInWithPassword: vi.fn(async (_email: string, _password: string) => session),
    setPassword: vi.fn(async (_accessToken: string, _password: string): Promise<void> => undefined),
    googleAuthorizationUrl: vi.fn(({ redirectUri }: { redirectUri: string; challenge: string }) => `https://auth.takatak.test/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`),
    exchangeGoogleCode: vi.fn(async () => session),
    beginAuthorization: vi.fn(async (input: { state: string; challenge: string }) => { begun.state = input.state; begun.challenge = input.challenge; return AUTH_ID; }),
    authorizationDetails: vi.fn(async (): Promise<AuthorizationView> => details),
    decideConsent: vi.fn(async ({ decision }: { decision: 'approve' | 'deny' }) =>
      decision === 'approve' ? `${CALLBACK}?code=abc&state=${begun.state}` : `${CALLBACK}?error=access_denied&state=${begun.state}`),
    revokeSession: vi.fn(async () => undefined),
  } satisfies TakatakOAuthProvider;
  const app = createApi({ prisma, verification: new FakeVerificationProvider('123456'), takatakOAuth: provider, publicUrl: ORIGIN, now: () => new Date(clock) });
  return { app, customers, sessions, provider, begun, identity, session, tick: (ms: number) => { clock += ms; } };
}

/** A tiny cookie jar: keeps the latest value per name, drops cleared cookies. */
class Jar {
  private store = new Map<string, string>();
  absorb(res: request.Response) {
    for (const line of (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
      const [pair, ...attrs] = line.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      const expired = attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a)) || value === '';
      if (expired) this.store.delete(name!.trim()); else this.store.set(name!.trim(), value);
    }
    return res;
  }
  header() { return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  has(name: string) { return this.store.has(name); }
  get(name: string) { return this.store.get(name); }
  drop(name: string) { this.store.delete(name); }
}
const decode = (raw: string) => JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');

function post(app: ReturnType<typeof createApi>, jar: Jar, path: string, body: unknown, headers: Record<string, string> = {}) {
  return request(app).post(`/api/v1/auth/takatak/${path}`).set('Cookie', jar.header()).set('Content-Type', 'application/json').set(headers).send(JSON.stringify(body)).then((r) => jar.absorb(r));
}
function get(app: ReturnType<typeof createApi>, jar: Jar, path: string) {
  return request(app).get(path.startsWith('/') ? path : `/api/v1/auth/takatak/${path}`).set('Cookie', jar.header()).then((r) => jar.absorb(r));
}

describe('Sign in on r2nette.ca — email code', () => {
  it('sends a code, verifies it, shows consent, approves, and the existing callback signs the new customer in', async () => {
    const { app, customers, sessions, provider, begun } = setup();
    const jar = new Jar();

    const sent = await post(app, jar, 'email/send', { email: '  Marie@Example.CA ' });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ sent: true });
    // The hub's email template reads this address to word the code email for this site.
    expect(provider.sendEmailCode).toHaveBeenCalledWith('marie@example.ca', { redirectTo: `${ORIGIN}/api/v1/auth/takatak/google/callback` });

    const verified = await post(app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ consent: true });
    expect(provider.verifyEmailCode).toHaveBeenCalledWith('marie@example.ca', '123456');
    expect(jar.has('r2n_takatak_oauth')).toBe(true);
    expect(jar.has('r2n_takatak_consent')).toBe(true);
    const pending = decode(jar.get('r2n_takatak_oauth')!);
    expect(pending).toMatchObject({ v: 1, returnTo: '/#book', locale: 'fr', terms: true, link: null });
    expect(begun.challenge).toBe(sha(pending.verifier));
    expect(begun.state).toBe(pending.state);
    expect(jar.get('r2n_takatak_consent')).not.toContain('hub-at');

    const consent = await get(app, jar, 'consent');
    expect(consent.status).toBe(200);
    expect(consent.body).toEqual({ app: 'R2NETTE', returnAddress: CALLBACK, account: 'marie@example.ca', scopes: ['Confirmer que vous êtes connecté à TAKATAK', 'Voir votre adresse courriel', 'Voir votre nom et votre profil', 'Voir votre numéro de téléphone'], needsTerms: false });
    expect(provider.authorizationDetails).toHaveBeenCalledWith({ authorizationId: AUTH_ID, accessToken: 'hub-at', subject: 'takatak-user-1', locale: 'fr' });

    const approved = await post(app, jar, 'consent', { decision: 'approve' });
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({ next: `${CALLBACK}?code=abc&state=${pending.state}` });
    expect(provider.decideConsent).toHaveBeenCalledWith({ authorizationId: AUTH_ID, accessToken: 'hub-at', decision: 'approve' });
    expect(provider.revokeSession).toHaveBeenCalledWith('hub-at');
    expect(jar.has('r2n_takatak_consent')).toBe(false);
    expect(jar.has('r2n_takatak_oauth')).toBe(true);

    const finished = await get(app, jar, new URL(approved.body.next).pathname + new URL(approved.body.next).search);
    expect(finished.status).toBe(303);
    expect(finished.headers.location).toBe('/#book');
    expect(sessions).toHaveLength(1);
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ emailAuthSubject: 'takatak-user-1', email: 'marie@example.ca', firstName: 'Marie', lastName: 'Tremblay' });
    expect(customers[0]!.termsAcceptedAt).toBeInstanceOf(Date);
  });

  it('renders the consent details in the language the page asks for', async () => {
    const { app, provider } = setup();
    const jar = new Jar();
    await post(app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
    expect((await get(app, jar, 'consent?locale=en')).status).toBe(200);
    expect(provider.authorizationDetails).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en' }));
    expect((await get(app, jar, 'consent?locale=xx')).status).toBe(200);
    expect(provider.authorizationDetails).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'fr' }));
  });

  it('replaces a forged same-origin returnTo ("https://site//evil") with the default', async () => {
    const { app } = setup();
    for (const forged of [`${ORIGIN}//evil.example`, `${ORIGIN}/\\evil.example`]) {
      const jar = new Jar();
      const verified = await post(app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true, returnTo: forged });
      expect(verified.status).toBe(200);
      expect(decode(jar.get('r2n_takatak_oauth')!).returnTo).toBe('/#book');
    }
  });

  describe('when the hub already holds an earlier approval', () => {
    // Owner order 2026-11-12: every sign-in ends with the "Autoriser l’accès" card, then the
    // customer goes back to the page they left, even when TAKATAK approved R2NETTE before.
    async function earlier(locale: 'fr' | 'en' = 'fr') {
      const ctx = setup();
      ctx.provider.authorizationDetails.mockImplementation(async () => ({ kind: 'approved', redirectUrl: `${CALLBACK}?code=abc&state=${ctx.begun.state}` }));
      const jar = new Jar();
      const verified = await post(ctx.app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale, terms: true, returnTo: '/#book' });
      return { ...ctx, jar, verified };
    }

    it('still shows the consent card after the code', async () => {
      const { app, provider, jar, verified } = await earlier('fr');
      expect(verified.status).toBe(200);
      expect(verified.body).toEqual({ consent: true });
      expect(jar.has('r2n_takatak_consent')).toBe(true);
      expect(provider.revokeSession).not.toHaveBeenCalled();
      // The hub has no details to give for an approved request: the card comes from this site's own request.
      provider.authorizationDetails.mockClear();
      const card = await get(app, jar, 'consent');
      expect(card.status).toBe(200);
      expect(card.body).toEqual({ app: 'R2NETTE', returnAddress: CALLBACK, account: 'marie@example.ca', scopes: ['Confirmer que vous êtes connecté à TAKATAK', 'Voir votre adresse courriel', 'Voir votre nom et votre profil', 'Voir votre numéro de téléphone'], needsTerms: false });
      expect(provider.authorizationDetails).not.toHaveBeenCalled();
      const en = await get(app, jar, 'consent?locale=en');
      expect(en.body.scopes[1]).toBe('See your email address');
    });

    it('Autoriser finishes the sign-in and returns to the page the customer left', async () => {
      const { app, provider, jar, sessions, begun } = await earlier('fr');
      const approved = await post(app, jar, 'consent', { decision: 'approve' });
      expect(approved.status).toBe(200);
      expect(approved.body).toEqual({ next: `${CALLBACK}?code=abc&state=${begun.state}` });
      expect(provider.decideConsent).not.toHaveBeenCalled();
      expect(provider.revokeSession).toHaveBeenCalledWith('hub-at');
      expect(jar.has('r2n_takatak_consent')).toBe(false);
      const finished = await get(app, jar, new URL(approved.body.next).pathname + new URL(approved.body.next).search);
      expect(finished.status).toBe(303);
      expect(finished.headers.location).toBe('/#book');
      expect(sessions).toHaveLength(1);
    });

    it('Refuser ends the sign-in without a session', async () => {
      const { app, provider, jar, sessions } = await earlier('en');
      const denied = await post(app, jar, 'consent', { decision: 'deny' });
      expect(denied.status).toBe(200);
      expect(provider.decideConsent).not.toHaveBeenCalled();
      expect(provider.revokeSession).toHaveBeenCalledWith('hub-at');
      const finished = await get(app, jar, new URL(denied.body.next).pathname + new URL(denied.body.next).search);
      expect(finished.status).toBe(303);
      expect(finished.headers.location).toContain('/login?takatak=cancelled');
      expect(sessions).toHaveLength(0);
    });

    it('is used once: a second answer finds no card', async () => {
      const { app, jar } = await earlier('fr');
      expect((await post(app, jar, 'consent', { decision: 'approve' })).status).toBe(200);
      expect((await post(app, jar, 'consent', { decision: 'approve' })).status).toBe(410);
    });

    it('refuses an earlier-approval address that points to another host', async () => {
      const ctx = setup();
      ctx.provider.authorizationDetails.mockImplementation(async () => ({ kind: 'approved', redirectUrl: `https://evil.example/api/v1/auth/takatak/callback?code=abc&state=${ctx.begun.state}` }));
      const jar = new Jar();
      const verified = await post(ctx.app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
      expect(verified.status).toBe(502);
      expect(verified.body.error.code).toBe('CONSENT_INVALID');
      expect(jar.has('r2n_takatak_consent')).toBe(false);
      expect(ctx.provider.revokeSession).toHaveBeenCalledWith('hub-at');
    });
  });

  it('refuses a redirect_url with another state or another host', async () => {
    for (const forged of [`${CALLBACK}?code=abc&state=someone-elses-state`, `https://evil.example/api/v1/auth/takatak/callback?code=abc&state=`]) {
      const { app, provider, sessions, begun } = setup();
      provider.decideConsent.mockImplementation(async () => forged.endsWith('state=') ? `${forged}${begun.state}` : forged);
      const jar = new Jar();
      await post(app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
      const approved = await post(app, jar, 'consent', { decision: 'approve' });
      expect(approved.status).toBe(502);
      expect(approved.body.error.code).toBe('CONSENT_INVALID');
      expect(approved.body.next).toBeUndefined();
      expect(jar.has('r2n_takatak_consent')).toBe(false);
      expect(sessions).toHaveLength(0);
    }
  });

  it('answers 410 when the consent cookie is missing, stale, or already used', async () => {
    const { app, tick } = setup();
    const jar = new Jar();
    expect((await get(app, jar, 'consent')).status).toBe(410);
    expect((await post(app, jar, 'consent', { decision: 'approve' })).body.error.code).toBe('CONSENT_EXPIRED');

    await post(app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
    const first = await post(app, jar, 'consent', { decision: 'approve' });
    expect(first.status).toBe(200);
    // The browser dropped the cleared cookie; a second tap finds nothing.
    const second = await post(app, jar, 'consent', { decision: 'approve' });
    expect(second.status).toBe(410);
    expect(second.body.error.code).toBe('CONSENT_EXPIRED');

    const late = new Jar();
    await post(app, late, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
    tick(11 * 60_000);
    expect((await get(app, late, 'consent')).status).toBe(410);
  });

  it('ends a refusal at /login?takatak=cancelled', async () => {
    const { app, sessions } = setup();
    const jar = new Jar();
    await post(app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
    const denied = await post(app, jar, 'consent', { decision: 'deny' });
    expect(denied.status).toBe(200);
    const next = new URL(denied.body.next);
    expect(next.origin + next.pathname).toBe(CALLBACK);
    expect(next.searchParams.get('error')).toBe('access_denied');
    const finished = await get(app, jar, next.pathname + next.search);
    expect(finished.status).toBe(303);
    expect(finished.headers.location).toBe('/login?takatak=cancelled');
    expect(sessions).toHaveLength(0);
  });

  it('rejects malformed codes and emails before calling the hub', async () => {
    const { app, provider } = setup();
    const jar = new Jar();
    for (const body of [
      { email: 'marie@example.ca', code: '12 34 56', locale: 'fr', terms: true },
      { email: 'marie@example.ca', code: 'abc123', locale: 'fr', terms: true },
      { email: 'not-an-email', code: '123456', locale: 'fr', terms: true },
      { email: 'marie@example.ca', code: '123456', locale: 'de', terms: true },
    ]) {
      const res = await post(app, jar, 'email/verify', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await post(app, jar, 'email/send', { email: 'nope' })).status).toBe(400);
    expect(provider.verifyEmailCode).not.toHaveBeenCalled();
    expect(provider.sendEmailCode).not.toHaveBeenCalled();
  });

  it('maps hub errors to the documented codes', async () => {
    const { app, provider } = setup();
    const jar = new Jar();
    const body = { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true };
    provider.verifyEmailCode.mockRejectedValueOnce(new IdentityError('bad', 'EMAIL_CODE_INVALID'));
    let res = await post(app, jar, 'email/verify', body);
    expect([res.status, res.body.error.code]).toEqual([401, 'EMAIL_CODE_INVALID']);
    provider.verifyEmailCode.mockRejectedValueOnce(new IdentityError('wait', 'OTP_PROVIDER_LIMIT'));
    res = await post(app, jar, 'email/verify', body);
    expect([res.status, res.body.error.code]).toEqual([429, 'OTP_PROVIDER_LIMIT']);
    provider.verifyEmailCode.mockRejectedValueOnce(new IdentityError('down', 'TAKATAK_AUTH_UNAVAILABLE'));
    res = await post(app, jar, 'email/verify', body);
    expect([res.status, res.body.error.code]).toEqual([503, 'TAKATAK_AUTH_UNAVAILABLE']);
    provider.sendEmailCode.mockRejectedValueOnce(new IdentityError('down', 'TAKATAK_AUTH_UNAVAILABLE'));
    res = await post(app, jar, 'email/send', { email: 'marie@example.ca' });
    expect([res.status, res.body.error.code]).toEqual([503, 'TAKATAK_AUTH_UNAVAILABLE']);
    expect(jar.has('r2n_takatak_consent')).toBe(false);
  });

  it('answers 503 when the server has no encryption key', async () => {
    const saved = process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.FIELD_ENCRYPTION_KEY;
    try {
      const { app, provider } = setup();
      const res = await post(app, new Jar(), 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
      expect([res.status, res.body.error.code]).toEqual([503, 'TAKATAK_AUTH_UNAVAILABLE']);
      expect(provider.beginAuthorization).not.toHaveBeenCalled();
    } finally {
      process.env.FIELD_ENCRYPTION_KEY = saved;
    }
  });

  it('rate limits sends per email and per ip', async () => {
    const { app, provider, tick } = setup();
    const jar = new Jar();
    expect((await post(app, jar, 'email/send', { email: 'marie@example.ca' })).status).toBe(200);
    tick(10_000);
    let res = await post(app, jar, 'email/send', { email: 'marie@example.ca' });
    expect([res.status, res.body.error.code]).toEqual([429, 'OTP_COOLDOWN']);
    for (let i = 0; i < 4; i++) { tick(31_000); expect((await post(app, jar, 'email/send', { email: 'marie@example.ca' })).status).toBe(200); }
    tick(31_000);
    res = await post(app, jar, 'email/send', { email: 'marie@example.ca' });
    expect([res.status, res.body.error.code]).toEqual([429, 'OTP_PHONE_LIMIT']);

    provider.verifyEmailCode.mockRejectedValue(new IdentityError('bad', 'EMAIL_CODE_INVALID'));
    const other = new Jar();
    for (let i = 0; i < 5; i++) expect((await post(app, other, 'email/verify', { email: 'paul@example.ca', code: '000000', locale: 'fr', terms: true })).status).toBe(401);
    res = await post(app, other, 'email/verify', { email: 'paul@example.ca', code: '000000', locale: 'fr', terms: true });
    expect([res.status, res.body.error.code]).toEqual([429, 'OTP_ATTEMPT_LIMIT']);
    expect(provider.verifyEmailCode).toHaveBeenCalledTimes(5);
  });

  it('keeps the consent cookie under the browser limit, and refuses a token too large to hold', async () => {
    const big = setup();
    big.provider.verifyEmailCode.mockResolvedValueOnce({ ...big.session, accessToken: 'x'.repeat(2_400) });
    const res = await post(big.app, new Jar(), 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
    expect(res.status).toBe(200);
    const line = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('r2n_takatak_consent='))!;
    expect(line.split(';')[0]!.length).toBeLessThan(4_000);

    const huge = setup();
    huge.provider.verifyEmailCode.mockResolvedValueOnce({ ...huge.session, accessToken: 'x'.repeat(4_000) });
    const jar = new Jar();
    const refused = await post(huge.app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
    expect([refused.status, refused.body.error.code]).toEqual([503, 'TAKATAK_AUTH_UNAVAILABLE']);
    expect(jar.has('r2n_takatak_consent')).toBe(false);
    expect(huge.provider.revokeSession).toHaveBeenCalledWith('x'.repeat(4_000));
  });

  it('limits code checks and consent reads per ip, whatever the email', async () => {
    const { app, provider } = setup();
    provider.verifyEmailCode.mockRejectedValue(new IdentityError('bad', 'EMAIL_CODE_INVALID'));
    for (let i = 0; i < 30; i += 1) {
      const r = await post(app, new Jar(), 'email/verify', { email: `p${i}@example.ca`, code: '123456', locale: 'fr', terms: true });
      expect(r.status).toBe(401);
    }
    const blocked = await post(app, new Jar(), 'email/verify', { email: 'p99@example.ca', code: '123456', locale: 'fr', terms: true });
    expect([blocked.status, blocked.body.error.code]).toEqual([429, 'SIGNIN_IP_LIMIT']);
    expect(provider.verifyEmailCode).toHaveBeenCalledTimes(30);

    for (let i = 0; i < 60; i += 1) expect((await get(app, new Jar(), 'consent')).status).toBe(410);
    expect((await get(app, new Jar(), 'consent')).status).toBe(429);
  });

  it('answers 410 when the hub no longer knows the authorization', async () => {
    const { app, provider } = setup();
    const jar = new Jar();
    await post(app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true });
    provider.authorizationDetails.mockRejectedValueOnce(new IdentityError('gone', 'CONSENT_EXPIRED'));
    const res = await get(app, jar, 'consent');
    expect([res.status, res.body.error.code]).toEqual([410, 'CONSENT_EXPIRED']);
  });

  it('rejects cross-site and non-JSON requests', async () => {
    const { app, provider } = setup();
    const jar = new Jar();
    const crossSite = await post(app, jar, 'email/send', { email: 'marie@example.ca' }, { 'sec-fetch-site': 'cross-site' });
    expect([crossSite.status, crossSite.body.error.code]).toEqual([403, 'REQUEST_REJECTED']);
    const form = await request(app).post('/api/v1/auth/takatak/email/send').set('Content-Type', 'application/x-www-form-urlencoded').send('email=marie%40example.ca');
    expect(form.status).toBe(403);
    expect(provider.sendEmailCode).not.toHaveBeenCalled();
  });
});

describe('Sign in on r2nette.ca — terms and returning customers', () => {
  const verify = (app: any, jar: Jar, terms: boolean, returnTo = '/account') =>
    post(app, jar, 'email/verify', { email: 'marie@example.ca', code: '123456', locale: 'fr', terms, returnTo });

  it('asks a first-time customer for the terms on the consent card, then creates the account', async () => {
    const { app, customers, sessions, provider } = setup();
    const jar = new Jar();
    await verify(app, jar, false);
    const consent = await get(app, jar, 'consent');
    expect(consent.body.needsTerms).toBe(true);

    // Autoriser without the box: nothing is spent, the card can be ticked and sent again.
    const refused = await post(app, jar, 'consent', { decision: 'approve' });
    expect([refused.status, refused.body.error.code]).toEqual([400, 'TERMS_REQUIRED']);
    expect(provider.decideConsent).not.toHaveBeenCalled();
    expect(jar.has('r2n_takatak_consent')).toBe(true);
    expect((await get(app, jar, 'consent')).status).toBe(200);

    const approved = await post(app, jar, 'consent', { decision: 'approve', terms: true });
    expect(approved.status).toBe(200);
    expect(decode(jar.get('r2n_takatak_oauth')!)).toMatchObject({ terms: true, returnTo: '/account' });
    const finished = await get(app, jar, new URL(approved.body.next).pathname + new URL(approved.body.next).search);
    expect(finished.headers.location).toBe('/account');
    expect(customers).toHaveLength(1);
    expect(customers[0]!.termsAcceptedAt).toBeInstanceOf(Date);
    expect(sessions).toHaveLength(1);
  });

  it('lets anyone refuse without ticking, and never asks a known customer', async () => {
    const fresh = setup();
    const jar = new Jar();
    await verify(fresh.app, jar, false);
    const denied = await post(fresh.app, jar, 'consent', { decision: 'deny' });
    expect(denied.status).toBe(200);

    for (const known of [{ emailAuthSubject: 'takatak-user-1' }, { googleAuthSubject: 'takatak-user-1' }, { email: 'marie@example.ca' }]) {
      const s = setup({ customers: [{ id: 'c1', ...known }] });
      const j = new Jar();
      await verify(s.app, j, false);
      expect((await get(s.app, j, 'consent')).body.needsTerms).toBe(false);
      expect((await post(s.app, j, 'consent', { decision: 'approve' })).status).toBe(200);
    }
  });

  it('signs in, in one go, a customer whose older profile holds the same address, and ends the older sessions', async () => {
    const { app, customers, sessions } = setup({ customers: [{ id: 'historic', email: 'marie@example.ca', emailAuthSubject: null, googleAuthSubject: null }] });
    sessions.push({ customerId: 'historic', revokedAt: null });
    const jar = new Jar();
    await verify(app, jar, false, '/#book');
    const approved = await post(app, jar, 'consent', { decision: 'approve' });
    const finished = await get(app, jar, new URL(approved.body.next).pathname + new URL(approved.body.next).search);
    expect(finished.headers.location).toBe('/#book');
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ id: 'historic', emailAuthSubject: 'takatak-user-1' });
    expect(sessions[0]!.revokedAt).toBeInstanceOf(Date);
    expect(sessions.at(-1)).toMatchObject({ customerId: 'historic' });
    expect(jar.has('r2n_session') || (finished.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('r2n_session='))).toBe(true);
  });
});

describe('Sign in on r2nette.ca — Google', () => {
  it('starts Google with PKCE and finishes with the consent step', async () => {
    const { app, provider } = setup();
    const jar = new Jar();
    const started = await get(app, jar, 'google/start?locale=en&returnTo=%2Faccount&terms=1');
    expect(started.status).toBe(303);
    expect(jar.has('r2n_takatak_google')).toBe(true);
    const google = decode(jar.get('r2n_takatak_google')!);
    expect(google).toMatchObject({ v: 1, returnTo: '/account', locale: 'en', terms: true });
    const target = new URL(started.headers.location!);
    // The hub keeps its own state and never sends ours back: do not send one.
    expect(target.searchParams.has('state')).toBe(false);
    expect(target.searchParams.get('redirect_to')).toBe(`${ORIGIN}/api/v1/auth/takatak/google/callback`);
    expect(provider.googleAuthorizationUrl).toHaveBeenCalledWith({ redirectUri: `${ORIGIN}/api/v1/auth/takatak/google/callback`, challenge: sha(google.verifier) });

    // What the real hub sends back: the code, nothing else.
    const back = await get(app, jar, 'google/callback?code=g');
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe('/login?consent=1&returnTo=%2Faccount');
    expect(provider.exchangeGoogleCode).toHaveBeenCalledWith({ code: 'g', verifier: google.verifier });
    expect(jar.has('r2n_takatak_google')).toBe(false);
    expect(jar.has('r2n_takatak_consent')).toBe(true);
    expect(jar.has('r2n_takatak_oauth')).toBe(true);
    expect(decode(jar.get('r2n_takatak_oauth')!)).toMatchObject({ returnTo: '/account', locale: 'en', terms: true, link: null });

    const consent = await get(app, jar, 'consent');
    expect(consent.status).toBe(200);
    expect(consent.body.app).toBe('R2NETTE');
    expect(provider.authorizationDetails).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', subject: 'takatak-user-1' }));
  });

  it('goes straight to the sign-in page when there is nothing to return to, and reports failures as reasons', async () => {
    const { app, provider, tick } = setup();
    // No Google cookie in this browser: a code from someone else's flow is refused unexchanged.
    const stranger = await get(app, new Jar(), 'google/callback?code=g');
    expect(stranger.headers.location).toBe('/login?takatak=expired');
    expect(provider.exchangeGoogleCode).not.toHaveBeenCalled();

    const jar = new Jar();
    await get(app, jar, 'google/start');
    tick(11 * 60_000);
    expect((await get(app, jar, 'google/callback?code=g')).headers.location).toBe('/login?takatak=expired');
    expect(jar.has('r2n_takatak_google')).toBe(false);
    expect(provider.exchangeGoogleCode).not.toHaveBeenCalled();

    await get(app, jar, 'google/start');
    provider.exchangeGoogleCode.mockRejectedValueOnce(new IdentityError('no', 'GOOGLE_AUTH_DENIED'));
    expect((await get(app, jar, 'google/callback?code=g')).headers.location).toBe('/login?takatak=error');

    // Cancel at Google: the hub sends error fields and no code.
    await get(app, jar, 'google/start');
    expect((await get(app, jar, 'google/callback?error=access_denied&error_code=403&error_description=denied')).headers.location).toBe('/login?takatak=cancelled');
    expect(provider.exchangeGoogleCode).toHaveBeenCalledTimes(1);

    await get(app, jar, 'google/start');
    expect((await get(app, jar, 'google/callback')).headers.location).toBe('/login?takatak=expired');

    await get(app, jar, 'google/start');
    const ok = decode(jar.get('r2n_takatak_google')!);
    expect((await get(app, jar, 'google/callback?code=g')).headers.location).toBe('/login?consent=1');
    expect(provider.exchangeGoogleCode).toHaveBeenLastCalledWith({ code: 'g', verifier: ok.verifier });
  });

  it('signs in a customer who linked Google earlier on /phone-login, without a second account', async () => {
    const { app, customers, sessions } = setup({ customers: [{ id: 'c-google', googleAuthSubject: 'takatak-user-1', emailAuthSubject: null, email: null }] });
    const jar = new Jar();
    await get(app, jar, 'google/start?terms=1');
    await get(app, jar, 'google/callback?code=g');
    const approved = await post(app, jar, 'consent', { decision: 'approve' });
    const finished = await get(app, jar, new URL(approved.body.next).pathname + new URL(approved.body.next).search);
    expect(finished.status).toBe(303);
    expect(finished.headers.location).toBe('/#book');
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ id: 'c-google', emailAuthSubject: 'takatak-user-1', googleAuthSubject: 'takatak-user-1' });
    expect(sessions).toHaveLength(1);
  });

  it('refuses to start when Google is off at the hub', async () => {
    const { app } = setup({ googleConfigured: false });
    const res = await get(app, new Jar(), 'google/start');
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/login?takatak=unavailable');
  });
});

describe('Sign in on r2nette.ca — config', () => {
  it('reports google in the config', async () => {
    expect((await request(setup().app).get('/api/v1/auth/takatak/config')).body).toEqual({ configured: true, google: true });
    expect((await request(setup({ googleConfigured: false }).app).get('/api/v1/auth/takatak/config')).body).toEqual({ configured: true, google: false });
  });
});

// Claude (Anthropic) · 2026-11-13 — password accounts. Sign up (email code or Google) ends with a chosen
// password before the « Autoriser l’accès » card; existing customers sign in with email + password.
// The password lives only in the hub: it is never stored, logged or put in a cookie by this server.
describe('Sign in on r2nette.ca — password step (sign up and forgotten password)', () => {
  const PW = 'Correct-Horse-9!x';
  const verifyBody = (extra: Record<string, unknown> = {}) => ({ email: 'marie@example.ca', code: '123456', locale: 'fr', terms: true, ...extra });
  async function waiting(extra: Record<string, unknown> = {}) {
    const ctx = setup();
    const jar = new Jar();
    const verified = await post(ctx.app, jar, 'email/verify', verifyBody({ intent: 'signup', ...extra }));
    return { ...ctx, jar, verified };
  }

  it('a sign-up code stops at the password step: no card, no authorization, nothing created yet', async () => {
    const { provider, jar, verified, customers, sessions } = await waiting();
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ password: true, email: 'marie@example.ca' });
    expect(provider.verifyEmailCode).toHaveBeenCalledWith('marie@example.ca', '123456');
    expect(provider.setPassword).not.toHaveBeenCalled();
    expect(provider.beginAuthorization).not.toHaveBeenCalled();
    expect(jar.has('r2n_takatak_consent')).toBe(true);
    expect(jar.get('r2n_takatak_consent')).not.toContain('hub-at');
    expect(decode(jar.get('r2n_takatak_oauth')!)).toMatchObject({ intent: 'signup', returnTo: '/#book', locale: 'fr', terms: true });
    expect(customers).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it('a forgotten-password code stops at the same step', async () => {
    const { verified, jar } = await waiting({ intent: 'reset' });
    expect(verified.body).toEqual({ password: true, email: 'marie@example.ca' });
    expect(decode(jar.get('r2n_takatak_oauth')!).intent).toBe('reset');
  });

  it('a plain sign-in code still goes straight to the card, and an unknown intent is refused', async () => {
    const { app, provider } = setup();
    const jar = new Jar();
    expect((await post(app, jar, 'email/verify', verifyBody({ intent: 'signin' }))).body).toEqual({ consent: true });
    expect((await post(app, new Jar(), 'email/verify', verifyBody())).body).toEqual({ consent: true });
    const bad = await post(app, new Jar(), 'email/verify', verifyBody({ intent: 'admin' }));
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(provider.verifyEmailCode).toHaveBeenCalledTimes(2);
  });

  it('the card cannot be reached while the password is still to be chosen', async () => {
    const { app, jar, provider } = await waiting();
    const read = await get(app, jar, 'consent');
    expect([read.status, read.body.error.code]).toEqual([409, 'PASSWORD_REQUIRED']);
    const decide = await post(app, jar, 'consent', { decision: 'approve' });
    expect([decide.status, decide.body.error.code]).toEqual([409, 'PASSWORD_REQUIRED']);
    expect(provider.decideConsent).not.toHaveBeenCalled();
    expect(jar.has('r2n_takatak_consent')).toBe(true); // still there for the password step
  });

  it('status says whether a password step is waiting, and for which address', async () => {
    const { app, jar } = await waiting();
    expect((await get(app, new Jar(), 'password/status')).status).toBe(410);
    const status = await get(app, jar, 'password/status');
    expect([status.status, status.body]).toEqual([200, { email: 'marie@example.ca', intent: 'signup' }]);
    // Someone mid-way through a plain sign-in has no password step.
    const plain = new Jar();
    await post(app, plain, 'email/verify', verifyBody());
    expect((await get(app, plain, 'password/status')).status).toBe(410);
  });

  it('refuses a mismatch or a weak password without calling the hub, and keeps the step open for a retry', async () => {
    const { app, jar, provider } = await waiting();
    const mismatch = await post(app, jar, 'password/set', { password: PW, confirm: PW + 'x' });
    expect([mismatch.status, mismatch.body.error.code]).toEqual([400, 'PASSWORD_MISMATCH']);
    for (const weak of ['short1A!', 'alllowercase1!', 'NOLOWERCASE1!', 'NoDigitsHere!!', 'NoSymbolsHere12', 'Marie-Password-1!']) {
      const res = await post(app, jar, 'password/set', { password: weak, confirm: weak });
      expect([res.status, res.body.error.code]).toEqual([400, 'WEAK_PASSWORD']);
    }
    expect(provider.setPassword).not.toHaveBeenCalled();
    expect((await get(app, jar, 'password/status')).status).toBe(200);
    expect((await post(app, jar, 'password/set', { password: PW, confirm: PW })).status).toBe(200);
  });

  it('sets the password at the hub, shows the card, and Autoriser signs in and returns to the page the customer left', async () => {
    const { app, jar, provider, customers, sessions, begun } = await waiting({ returnTo: '/account' });
    const saved = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    expect([saved.status, saved.body]).toEqual([200, { consent: true }]);
    expect(provider.setPassword).toHaveBeenCalledTimes(1);
    expect(provider.setPassword).toHaveBeenCalledWith('hub-at', PW);
    expect(provider.beginAuthorization).toHaveBeenCalledTimes(1);

    const card = await get(app, jar, 'consent');
    expect(card.status).toBe(200);
    expect(card.body.app).toBe('R2NETTE');
    const approved = await post(app, jar, 'consent', { decision: 'approve' });
    expect(approved.status).toBe(200);
    const next = new URL(approved.body.next);
    const finished = await get(app, jar, next.pathname + next.search);
    expect(finished.status).toBe(303);
    expect(finished.headers.location).toBe('/account');
    expect(begun.state).toBeTruthy();
    expect(customers).toHaveLength(1);
    expect(sessions).toHaveLength(1);
  });

  it('sends the password exactly as typed, spaces included', async () => {
    const { app, jar, provider } = await waiting();
    const spaced = '  Correct-Horse-9!x  ';
    expect((await post(app, jar, 'password/set', { password: spaced, confirm: spaced })).status).toBe(200);
    expect(provider.setPassword).toHaveBeenCalledWith('hub-at', spaced);
  });

  it('never stores or returns the password: not in a cookie, not in any body', async () => {
    const { app, jar, provider } = await waiting();
    const saved = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    const card = await get(app, jar, 'consent');
    expect(jar.header()).not.toContain(PW);
    expect(JSON.stringify([saved.body, card.body])).not.toContain(PW);
    for (const cookie of ['r2n_takatak_consent', 'r2n_takatak_oauth']) {
      const raw = jar.get(cookie)!;
      expect(raw).not.toContain(encodeURIComponent(PW));
      expect(Buffer.from(raw, 'base64url').toString('utf8')).not.toContain(PW);
    }
    expect(provider.revokeSession).not.toHaveBeenCalled();
  });

  it('answers 410, never 500, with no password step, after it was used, or after it expired', async () => {
    const { app, jar, tick } = await waiting();
    expect((await post(app, new Jar(), 'password/set', { password: PW, confirm: PW })).status).toBe(410);
    // A customer in the middle of a plain sign-in cannot use this route to change anything.
    const plain = new Jar();
    await post(app, plain, 'email/verify', verifyBody());
    const wrongStage = await post(app, plain, 'password/set', { password: PW, confirm: PW });
    expect([wrongStage.status, wrongStage.body.error.code]).toEqual([410, 'CONSENT_EXPIRED']);
    // Used: the second try finds the card stage, not the password stage.
    expect((await post(app, jar, 'password/set', { password: PW, confirm: PW })).status).toBe(200);
    const again = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    expect([again.status, again.body.error.code]).toEqual([410, 'CONSENT_EXPIRED']);
    // Expired.
    const late = new Jar();
    await post(app, late, 'email/verify', verifyBody({ intent: 'signup' }));
    tick(11 * 60_000);
    expect((await post(app, late, 'password/set', { password: PW, confirm: PW })).status).toBe(410);
    expect((await get(app, late, 'password/status')).status).toBe(410);
  });

  it('treats "the hub already has this password" as done, so a retry after a hiccup carries on', async () => {
    const { app, jar, provider } = await waiting();
    provider.setPassword.mockRejectedValueOnce(new IdentityError('same', 'PASSWORD_UNCHANGED'));
    const saved = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    expect([saved.status, saved.body]).toEqual([200, { consent: true }]);
  });

  it('keeps the step open when the hub is down after the password was set, and the retry finishes', async () => {
    const { app, jar, provider } = await waiting();
    provider.beginAuthorization.mockRejectedValueOnce(new IdentityError('down', 'TAKATAK_AUTH_UNAVAILABLE'));
    const first = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    expect([first.status, first.body.error.code]).toEqual([503, 'TAKATAK_AUTH_UNAVAILABLE']);
    provider.setPassword.mockRejectedValueOnce(new IdentityError('same', 'PASSWORD_UNCHANGED'));
    const retry = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    expect([retry.status, retry.body]).toEqual([200, { consent: true }]);
  });

  it('maps what the hub says about a password to the documented codes', async () => {
    const { app, jar, provider } = await waiting();
    provider.setPassword.mockRejectedValueOnce(new IdentityError('weak', 'WEAK_PASSWORD'));
    let res = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    expect([res.status, res.body.error.code]).toEqual([400, 'WEAK_PASSWORD']);
    provider.setPassword.mockRejectedValueOnce(new IdentityError('limit', 'PASSWORD_PROVIDER_LIMIT'));
    res = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    expect([res.status, res.body.error.code]).toEqual([429, 'PASSWORD_PROVIDER_LIMIT']);
    provider.setPassword.mockRejectedValueOnce(new IdentityError('gone', 'CONSENT_EXPIRED'));
    res = await post(app, jar, 'password/set', { password: PW, confirm: PW });
    expect([res.status, res.body.error.code]).toEqual([410, 'CONSENT_EXPIRED']);
    expect(provider.beginAuthorization).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies and other-site posts', async () => {
    const { app, jar } = await waiting();
    for (const body of [{}, { password: PW }, { password: '', confirm: '' }, { password: PW, confirm: PW, extra: 1 }, { password: 'x'.repeat(300), confirm: 'x'.repeat(300) }]) {
      const res = await post(app, jar, 'password/set', body);
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
    const cross = await post(app, jar, 'password/set', { password: PW, confirm: PW }, { 'Sec-Fetch-Site': 'cross-site' });
    expect(cross.status).toBe(403);
  });

  it('replaces a forged returnTo on the sign-up path as well', async () => {
    const { jar } = await waiting({ returnTo: `${ORIGIN}//evil.example` });
    expect(decode(jar.get('r2n_takatak_oauth')!).returnTo).toBe('/#book');
  });
});

describe('Sign in on r2nette.ca — password step with Google', () => {
  const PW = 'Correct-Horse-9!x';

  it('a Google sign-up comes back to the password step; a Google sign-in goes straight to the card', async () => {
    const { app, provider, customers } = setup();
    const signup = new Jar();
    const started = await get(app, signup, 'google/start?locale=fr&returnTo=%2Faccount&terms=1&intent=signup');
    expect(started.status).toBe(303);
    expect(decode(signup.get('r2n_takatak_google')!)).toMatchObject({ intent: 'signup', returnTo: '/account' });
    const back = await get(app, signup, 'google/callback?code=g');
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe('/login?step=password&returnTo=%2Faccount');
    expect(provider.beginAuthorization).not.toHaveBeenCalled();
    expect(customers).toHaveLength(0);
    expect((await get(app, signup, 'password/status')).body).toEqual({ email: 'marie@example.ca', intent: 'signup' });
    expect((await get(app, signup, 'consent')).status).toBe(409);
    const saved = await post(app, signup, 'password/set', { password: PW, confirm: PW });
    expect([saved.status, saved.body]).toEqual([200, { consent: true }]);
    expect(provider.setPassword).toHaveBeenCalledWith('hub-at', PW);

    const signin = new Jar();
    await get(app, signin, 'google/start?locale=fr&returnTo=%2Faccount&terms=1');
    expect(decode(signin.get('r2n_takatak_google')!).intent).toBe('signin');
    const straight = await get(app, signin, 'google/callback?code=g');
    expect(straight.headers.location).toBe('/login?consent=1&returnTo=%2Faccount');
  });

  it('an unknown intent in the address is a plain sign-in', async () => {
    const { app } = setup();
    const jar = new Jar();
    await get(app, jar, 'google/start?intent=admin');
    expect(decode(jar.get('r2n_takatak_google')!).intent).toBe('signin');
  });

  it('goes back to the sign-in page, not to a half-open step, when the password step cannot be held', async () => {
    const { app } = setup();
    const jar = new Jar();
    await get(app, jar, 'google/start?intent=signup');
    delete process.env.FIELD_ENCRYPTION_KEY;
    try {
      const back = await get(app, jar, 'google/callback?code=g');
      expect(back.status).toBe(303);
      expect(back.headers.location).toBe('/login?takatak=error');
    } finally {
      process.env.FIELD_ENCRYPTION_KEY = generateEncryptionKey();
    }
  });
});

describe('Sign in on r2nette.ca — email and password', () => {
  const PW = 'Correct-Horse-9!x';
  const login = (extra: Record<string, unknown> = {}) => ({ email: 'marie@example.ca', password: PW, locale: 'fr', terms: false, ...extra });

  it('checks the password at the hub, then shows the card, then returns to the page the customer left', async () => {
    const { app, provider, customers, sessions } = setup();
    const jar = new Jar();
    const res = await post(app, jar, 'password/login', login({ email: ' Marie@Example.CA ', returnTo: '/account', terms: true }));
    expect([res.status, res.body]).toEqual([200, { consent: true }]);
    expect(provider.signInWithPassword).toHaveBeenCalledWith('marie@example.ca', PW);
    expect(provider.sendEmailCode).not.toHaveBeenCalled(); // a password sign-in sends no email
    expect(decode(jar.get('r2n_takatak_oauth')!)).toMatchObject({ returnTo: '/account', intent: 'signin' });
    expect(jar.header()).not.toContain(PW);
    const card = await get(app, jar, 'consent');
    expect(card.status).toBe(200);
    const approved = await post(app, jar, 'consent', { decision: 'approve' });
    const next = new URL(approved.body.next);
    const finished = await get(app, jar, next.pathname + next.search);
    expect(finished.headers.location).toBe('/account');
    expect(sessions).toHaveLength(1);
    expect(customers).toHaveLength(1);
  });

  it('gives the same 401 for a wrong password and for an address with no account', async () => {
    const { app, provider } = setup();
    provider.signInWithPassword.mockRejectedValue(new IdentityError('The email or password is not right.', 'INVALID_CREDENTIALS'));
    const known = await post(app, new Jar(), 'password/login', login());
    const unknown = await post(app, new Jar(), 'password/login', login({ email: 'nobody@example.ca' }));
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(known.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(known.body.error.message);
    expect(JSON.stringify([known.body, unknown.body])).not.toContain(PW);
    expect(provider.beginAuthorization).not.toHaveBeenCalled();
  });

  it('allows five wrong passwords per address in 15 minutes, answers 429 on the sixth, and lets them in again later', async () => {
    const { app, provider, tick } = setup();
    provider.signInWithPassword.mockRejectedValue(new IdentityError('no', 'INVALID_CREDENTIALS'));
    for (let i = 0; i < 5; i += 1) expect((await post(app, new Jar(), 'password/login', login())).status).toBe(401);
    const locked = await post(app, new Jar(), 'password/login', login());
    expect([locked.status, locked.body.error.code]).toEqual([429, 'PASSWORD_LOGIN_LIMIT']);
    expect(provider.signInWithPassword).toHaveBeenCalledTimes(5); // the sixth never reaches the hub
    // Another address is not affected.
    expect((await post(app, new Jar(), 'password/login', login({ email: 'paul@example.ca' }))).status).toBe(401);
    // The code and Google routes are separate doors and still open.
    expect((await post(app, new Jar(), 'email/send', { email: 'marie@example.ca' })).status).toBe(200);
    tick(16 * 60_000);
    provider.signInWithPassword.mockResolvedValue({ accessToken: 'hub-at', subject: 'takatak-user-1', email: 'marie@example.ca', phone: null });
    expect((await post(app, new Jar(), 'password/login', login())).status).toBe(200);
  });

  it('a good password clears the count, and many parallel guesses cannot all slip through', async () => {
    const { app, provider } = setup();
    provider.signInWithPassword.mockRejectedValue(new IdentityError('no', 'INVALID_CREDENTIALS'));
    for (let i = 0; i < 4; i += 1) await post(app, new Jar(), 'password/login', login());
    provider.signInWithPassword.mockResolvedValueOnce({ accessToken: 'hub-at', subject: 'takatak-user-1', email: 'marie@example.ca', phone: null });
    expect((await post(app, new Jar(), 'password/login', login())).status).toBe(200);
    provider.signInWithPassword.mockRejectedValue(new IdentityError('no', 'INVALID_CREDENTIALS'));
    // The count restarted: four more wrong ones are still answered by the hub.
    for (let i = 0; i < 4; i += 1) expect((await post(app, new Jar(), 'password/login', login())).status).toBe(401);

    const burst = setup();
    burst.provider.signInWithPassword.mockRejectedValue(new IdentityError('no', 'INVALID_CREDENTIALS'));
    const results = await Promise.all(Array.from({ length: 12 }, () => post(burst.app, new Jar(), 'password/login', login())));
    expect(burst.provider.signInWithPassword.mock.calls.length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(7);
  });

  it('does not count a hub limit or outage as a wrong password', async () => {
    const { app, provider } = setup();
    provider.signInWithPassword.mockRejectedValue(new IdentityError('limit', 'PASSWORD_PROVIDER_LIMIT'));
    for (let i = 0; i < 6; i += 1) {
      const res = await post(app, new Jar(), 'password/login', login());
      expect([res.status, res.body.error.code]).toEqual([429, 'PASSWORD_PROVIDER_LIMIT']);
    }
    provider.signInWithPassword.mockRejectedValue(new IdentityError('down', 'TAKATAK_AUTH_UNAVAILABLE'));
    const down = await post(app, new Jar(), 'password/login', login());
    expect([down.status, down.body.error.code]).toEqual([503, 'TAKATAK_AUTH_UNAVAILABLE']);
    provider.signInWithPassword.mockResolvedValue({ accessToken: 'hub-at', subject: 'takatak-user-1', email: 'marie@example.ca', phone: null });
    expect((await post(app, new Jar(), 'password/login', login())).status).toBe(200);
  });

  it('limits password sign-ins per visitor, whatever the address', async () => {
    const { app, provider } = setup();
    provider.signInWithPassword.mockRejectedValue(new IdentityError('no', 'INVALID_CREDENTIALS'));
    for (let i = 0; i < 30; i += 1) expect((await post(app, new Jar(), 'password/login', login({ email: `person${i}@example.ca` }))).status).toBe(401);
    const blocked = await post(app, new Jar(), 'password/login', login({ email: 'person99@example.ca' }));
    expect([blocked.status, blocked.body.error.code]).toEqual([429, 'SIGNIN_IP_LIMIT']);
  });

  it('rejects malformed bodies before the hub, replaces a forged returnTo, and refuses other sites', async () => {
    const { app, provider } = setup();
    for (const body of [{}, login({ password: '' }), login({ email: 'nope' }), login({ locale: 'de' }), { ...login(), extra: 1 }, login({ password: 'x'.repeat(300) })]) {
      const res = await post(app, new Jar(), 'password/login', body);
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
    expect(provider.signInWithPassword).not.toHaveBeenCalled();
    const jar = new Jar();
    expect((await post(app, jar, 'password/login', login({ returnTo: `${ORIGIN}//evil.example` }))).status).toBe(200);
    expect(decode(jar.get('r2n_takatak_oauth')!).returnTo).toBe('/#book');
    expect((await post(app, new Jar(), 'password/login', login(), { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  });

  it('answers 503 when this server cannot hold the hub session', async () => {
    const { app } = setup();
    const saved = process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.FIELD_ENCRYPTION_KEY;
    try {
      const res = await post(app, new Jar(), 'password/login', login());
      expect([res.status, res.body.error.code]).toEqual([503, 'TAKATAK_AUTH_UNAVAILABLE']);
    } finally {
      process.env.FIELD_ENCRYPTION_KEY = saved;
    }
  });
});

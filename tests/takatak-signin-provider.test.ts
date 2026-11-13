// Claude (Anthropic) · 2026-11-11 — hub calls behind the r2nette.ca sign-in
// (email code, Google, consent shown on r2nette.ca).
import { describe, it, expect, vi } from 'vitest';
import {
  SupabaseTakatakOAuthProvider,
  consentScopeText,
} from '../src/identity/takatak-oauth.js';

const env = { TAKATAK_SUPABASE_URL: 'https://auth.takatak.test', TAKATAK_SUPABASE_ANON_KEY: 'public-anon', TAKATAK_OAUTH_CLIENT_ID: 'r2nette-client' };
const CALLBACK = 'https://r2nette.ca/api/v1/auth/takatak/callback';
const AUTH_ID = 'abcdefghijklmnopqrstuvwxyz234567';
type Call = { url: string; init?: RequestInit };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const headersOf = (c: Call) => c.init!.headers as Record<string, string>;
const bodyOf = (c: Call) => JSON.parse(String(c.init!.body));

describe('TAKATAK hub: email code', () => {
  it('sends the email code with create_user and the anon key', async () => {
    const { calls, fetcher } = fakeFetch(() => json({}));
    await new SupabaseTakatakOAuthProvider(env, fetcher).sendEmailCode('marie@example.ca');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://auth.takatak.test/auth/v1/otp');
    expect(calls[0]!.init!.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({ email: 'marie@example.ca', create_user: true });
    expect(headersOf(calls[0]!).apikey).toBe('public-anon');
  });

  it('tells the hub which site asked, so its email can speak for that site', async () => {
    const { calls, fetcher } = fakeFetch(() => json({}));
    await new SupabaseTakatakOAuthProvider(env, fetcher).sendEmailCode('marie@example.ca', { redirectTo: 'https://r2nette.ca/api/v1/auth/takatak/google/callback' });
    expect(calls[0]!.url).toBe('https://auth.takatak.test/auth/v1/otp?redirect_to=https%3A%2F%2Fr2nette.ca%2Fapi%2Fv1%2Fauth%2Ftakatak%2Fgoogle%2Fcallback');
    expect(bodyOf(calls[0]!)).toEqual({ email: 'marie@example.ca', create_user: true });
  });

  it('verifies the code and returns the hub session only for a confirmed matching email', async () => {
    const user = { id: 'u1', email: 'marie@example.ca', email_confirmed_at: '2026-11-11T00:00:00Z', phone: '15145551212' };
    const ok = fakeFetch(() => json({ access_token: 'at', user }));
    const p = new SupabaseTakatakOAuthProvider(env, ok.fetcher);
    await expect(p.verifyEmailCode('marie@example.ca', '123456')).resolves.toEqual({ accessToken: 'at', subject: 'u1', email: 'marie@example.ca', phone: '+15145551212' });
    expect(ok.calls[0]!.url).toBe('https://auth.takatak.test/auth/v1/verify');
    expect(bodyOf(ok.calls[0]!)).toEqual({ type: 'email', email: 'marie@example.ca', token: '123456' });

    const other = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({ access_token: 'at', user: { ...user, email: 'other@example.ca' } })).fetcher);
    await expect(other.verifyEmailCode('marie@example.ca', '123456')).rejects.toMatchObject({ code: 'EMAIL_CODE_INVALID' });

    const unconfirmed = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({ access_token: 'at', user: { ...user, email_confirmed_at: null } })).fetcher);
    await expect(unconfirmed.verifyEmailCode('marie@example.ca', '123456')).rejects.toMatchObject({ code: 'EMAIL_CODE_INVALID' });

    const wrong = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({ error: 'otp_expired' }, 400)).fetcher);
    await expect(wrong.verifyEmailCode('marie@example.ca', '000000')).rejects.toMatchObject({ code: 'EMAIL_CODE_INVALID' });

    const limited = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 429)).fetcher);
    await expect(limited.verifyEmailCode('marie@example.ca', '123456')).rejects.toMatchObject({ code: 'OTP_PROVIDER_LIMIT' });
    await expect(limited.sendEmailCode('marie@example.ca')).rejects.toMatchObject({ code: 'OTP_PROVIDER_LIMIT' });

    const down = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => { throw new TypeError('fetch failed'); }).fetcher);
    await expect(down.verifyEmailCode('marie@example.ca', '123456')).rejects.toMatchObject({ code: 'TAKATAK_AUTH_UNAVAILABLE' });
    await expect(down.sendEmailCode('marie@example.ca')).rejects.toMatchObject({ code: 'TAKATAK_AUTH_UNAVAILABLE' });
  });
});

describe('TAKATAK hub: configuration', () => {
  it('accepts http only on the local machine, as the Google provider does', () => {
    expect(new SupabaseTakatakOAuthProvider({ ...env, TAKATAK_SUPABASE_URL: 'http://127.0.0.1:3200' }).configured).toBe(true);
    expect(new SupabaseTakatakOAuthProvider({ ...env, TAKATAK_SUPABASE_URL: 'http://localhost:3200' }).configured).toBe(true);
    expect(new SupabaseTakatakOAuthProvider({ ...env, TAKATAK_SUPABASE_URL: 'http://evil.example' }).configured).toBe(false);
  });
});

describe('TAKATAK hub: Google', () => {
  it('is on only with the anon key, and builds the authorize url with PKCE and no state of ours', () => {
    expect(new SupabaseTakatakOAuthProvider({ ...env, TAKATAK_SUPABASE_ANON_KEY: '' }).googleConfigured).toBe(false);
    const p = new SupabaseTakatakOAuthProvider(env);
    expect(p.googleConfigured).toBe(true);
    const url = new URL(p.googleAuthorizationUrl({ redirectUri: 'https://r2nette.ca/api/v1/auth/takatak/google/callback', challenge: 'c'.repeat(43) }));
    expect(url.origin + url.pathname).toBe('https://auth.takatak.test/auth/v1/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: 'google',
      redirect_to: 'https://r2nette.ca/api/v1/auth/takatak/google/callback',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 's256',
    });
  });

  it('exchanges the Google code and requires the google identity', async () => {
    const user = { id: 'u2', email: 'paul@example.ca', identities: [{ provider: 'google' }] };
    const ok = fakeFetch(() => json({ access_token: 'g-at', user }));
    const p = new SupabaseTakatakOAuthProvider(env, ok.fetcher);
    await expect(p.exchangeGoogleCode({ code: 'gcode', verifier: 'v'.repeat(43) })).resolves.toEqual({ accessToken: 'g-at', subject: 'u2', email: 'paul@example.ca', phone: null });
    expect(ok.calls[0]!.url).toBe('https://auth.takatak.test/auth/v1/token?grant_type=pkce');
    expect(bodyOf(ok.calls[0]!)).toEqual({ auth_code: 'gcode', code_verifier: 'v'.repeat(43) });

    const notGoogle = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({ access_token: 'x', user: { id: 'u3', identities: [{ provider: 'email' }] } })).fetcher);
    await expect(notGoogle.exchangeGoogleCode({ code: 'gcode', verifier: 'v'.repeat(43) })).rejects.toMatchObject({ code: 'GOOGLE_AUTH_DENIED' });
    const refused = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 400)).fetcher);
    await expect(refused.exchangeGoogleCode({ code: 'gcode', verifier: 'v'.repeat(43) })).rejects.toMatchObject({ code: 'GOOGLE_AUTH_DENIED' });
  });
});

describe('TAKATAK hub: consent on r2nette.ca', () => {
  const begin = { redirectUri: CALLBACK, challenge: 'c'.repeat(43), state: 's'.repeat(43), locale: 'fr' as const };

  it('begins an authorization and reads the id from the consent redirect', async () => {
    const ok = fakeFetch((url) => url.includes('/.well-known/') ? json({}, 404)
      : new Response(null, { status: 302, headers: { location: `https://takatak.ca/oauth/consent?authorization_id=${AUTH_ID}` } }));
    const p = new SupabaseTakatakOAuthProvider(env, ok.fetcher);
    await expect(p.beginAuthorization(begin)).resolves.toBe(AUTH_ID);
    const authorize = ok.calls.find((c) => c.url.includes('/oauth/authorize'))!;
    expect(authorize.init!.redirect).toBe('manual');
    const sent = new URL(authorize.url);
    expect(sent.searchParams.get('client_id')).toBe('r2nette-client');
    expect(sent.searchParams.get('state')).toBe('s'.repeat(43));
    expect(sent.searchParams.get('code_challenge')).toBe('c'.repeat(43));

    const foreign = new SupabaseTakatakOAuthProvider(env, fakeFetch((url) => url.includes('/.well-known/') ? json({}, 404)
      : new Response(null, { status: 302, headers: { location: `https://evil.example/oauth/consent?authorization_id=${AUTH_ID}` } })).fetcher);
    await expect(foreign.beginAuthorization(begin)).rejects.toMatchObject({ code: 'CONSENT_INVALID' });
    const badId = new SupabaseTakatakOAuthProvider(env, fakeFetch((url) => url.includes('/.well-known/') ? json({}, 404)
      : new Response(null, { status: 302, headers: { location: 'https://takatak.ca/oauth/consent?authorization_id=ABC' } })).fetcher);
    await expect(badId.beginAuthorization(begin)).rejects.toMatchObject({ code: 'CONSENT_INVALID' });
    const down = new SupabaseTakatakOAuthProvider(env, fakeFetch((url) => url.includes('/.well-known/') ? json({}, 404) : json({}, 500)).fetcher);
    await expect(down.beginAuthorization(begin)).rejects.toMatchObject({ code: 'TAKATAK_AUTH_UNAVAILABLE' });
  });

  it('reads consent details, rejects another user, and recognises an already approved request', async () => {
    const details = { authorization_id: AUTH_ID, client: { name: 'R2NETTE' }, redirect_uri: CALLBACK, scope: 'openid email profile phone', user: { id: 'u1', email: 'marie@example.ca' } };
    const ok = fakeFetch(() => json(details));
    const p = new SupabaseTakatakOAuthProvider(env, ok.fetcher);
    await expect(p.authorizationDetails({ authorizationId: AUTH_ID, accessToken: 'at', subject: 'u1', locale: 'fr' })).resolves.toEqual({
      kind: 'consent',
      details: {
        authorizationId: AUTH_ID,
        appName: 'R2NETTE',
        returnAddress: CALLBACK,
        account: 'marie@example.ca',
        scopes: [
          'Confirmer que vous êtes connecté à TAKATAK',
          'Voir votre adresse courriel',
          'Voir votre nom et votre profil',
          'Voir votre numéro de téléphone',
        ],
      },
    });
    expect(ok.calls[0]!.url).toBe(`https://auth.takatak.test/auth/v1/oauth/authorizations/${AUTH_ID}`);
    expect(headersOf(ok.calls[0]!).Authorization).toBe('Bearer at');
    expect(headersOf(ok.calls[0]!).apikey).toBe('public-anon');

    const otherUser = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({ ...details, user: { id: 'u2' } })).fetcher);
    await expect(otherUser.authorizationDetails({ authorizationId: AUTH_ID, accessToken: 'at', subject: 'u1', locale: 'fr' })).rejects.toMatchObject({ code: 'CONSENT_INVALID' });
    const otherId = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({ ...details, authorization_id: 'x'.repeat(32) })).fetcher);
    await expect(otherId.authorizationDetails({ authorizationId: AUTH_ID, accessToken: 'at', subject: 'u1', locale: 'fr' })).rejects.toMatchObject({ code: 'CONSENT_INVALID' });

    const approved = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({ redirect_url: `${CALLBACK}?code=x&state=s` })).fetcher);
    await expect(approved.authorizationDetails({ authorizationId: AUTH_ID, accessToken: 'at', subject: 'u1', locale: 'en' })).resolves.toEqual({ kind: 'approved', redirectUrl: `${CALLBACK}?code=x&state=s` });

    const gone = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 404)).fetcher);
    await expect(gone.authorizationDetails({ authorizationId: AUTH_ID, accessToken: 'at', subject: 'u1', locale: 'en' })).rejects.toMatchObject({ code: 'CONSENT_EXPIRED' });
    const refusedRead = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 400)).fetcher);
    await expect(refusedRead.authorizationDetails({ authorizationId: AUTH_ID, accessToken: 'at', subject: 'u1', locale: 'en' })).rejects.toMatchObject({ code: 'CONSENT_INVALID' });
  });

  it('approves and denies with the user token and returns redirect_url', async () => {
    const ok = fakeFetch(() => json({ redirect_url: `${CALLBACK}?code=abc&state=s` }));
    const p = new SupabaseTakatakOAuthProvider(env, ok.fetcher);
    await expect(p.decideConsent({ authorizationId: AUTH_ID, accessToken: 'at', decision: 'approve' })).resolves.toBe(`${CALLBACK}?code=abc&state=s`);
    expect(ok.calls[0]!.url).toBe(`https://auth.takatak.test/auth/v1/oauth/authorizations/${AUTH_ID}/consent`);
    expect(ok.calls[0]!.init!.method).toBe('POST');
    expect(headersOf(ok.calls[0]!).Authorization).toBe('Bearer at');
    expect(bodyOf(ok.calls[0]!)).toEqual({ action: 'approve' });
    await p.decideConsent({ authorizationId: AUTH_ID, accessToken: 'at', decision: 'deny' });
    expect(bodyOf(ok.calls[1]!)).toEqual({ action: 'deny' });

    const refused = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 400)).fetcher);
    await expect(refused.decideConsent({ authorizationId: AUTH_ID, accessToken: 'at', decision: 'approve' })).rejects.toMatchObject({ code: 'CONSENT_INVALID' });
    const gone = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 410)).fetcher);
    await expect(gone.decideConsent({ authorizationId: AUTH_ID, accessToken: 'at', decision: 'approve' })).rejects.toMatchObject({ code: 'CONSENT_EXPIRED' });
    const empty = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({})).fetcher);
    await expect(empty.decideConsent({ authorizationId: AUTH_ID, accessToken: 'at', decision: 'approve' })).rejects.toMatchObject({ code: 'CONSENT_INVALID' });
  });

  it('revokes the hub session quietly', async () => {
    const ok = fakeFetch(() => new Response(null, { status: 204 }));
    await new SupabaseTakatakOAuthProvider(env, ok.fetcher).revokeSession('at');
    expect(ok.calls[0]!.url).toBe('https://auth.takatak.test/auth/v1/logout?scope=local');
    expect(headersOf(ok.calls[0]!).Authorization).toBe('Bearer at');
    const failing = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 500)).fetcher);
    await expect(failing.revokeSession('at')).resolves.toBeUndefined();
    const down = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => { throw new TypeError('fetch failed'); }).fetcher);
    await expect(down.revokeSession('at')).resolves.toBeUndefined();
  });

  it('maps scopes to the TAKATAK wording in both languages', () => {
    expect(consentScopeText('openid email profile phone offline_access custom:x', 'fr')).toEqual([
      'Confirmer que vous êtes connecté à TAKATAK',
      'Voir votre adresse courriel',
      'Voir votre nom et votre profil',
      'Voir votre numéro de téléphone',
      'Rester connecté après avoir fermé l’application',
      'Accès « custom:x »',
    ]);
    expect(consentScopeText('openid phone', 'en')).toEqual(['Confirm that you are signed in to TAKATAK', 'See your phone number']);
    expect(consentScopeText('', 'en')).toEqual([]);
  });
});

// Claude (Anthropic) · 2026-11-13 — passwords live in the hub: r2nette only sets one (after a code or Google)
// and checks one (password sign-in). Neither call may ever put the password in an error.
describe('TAKATAK hub: password', () => {
  const secret = 'Correct-Horse-9!';
  const user = { id: 'u1', email: 'marie@example.ca', email_confirmed_at: '2026-11-13T00:00:00Z', phone: '' };

  it('checks a password through the hub password grant and returns the session', async () => {
    const ok = fakeFetch(() => json({ access_token: 'pw-at', user }));
    const p = new SupabaseTakatakOAuthProvider(env, ok.fetcher);
    await expect(p.signInWithPassword('Marie@Example.ca', secret)).resolves.toEqual({ accessToken: 'pw-at', subject: 'u1', email: 'marie@example.ca', phone: null });
    expect(ok.calls[0]!.url).toBe('https://auth.takatak.test/auth/v1/token?grant_type=password');
    expect(ok.calls[0]!.init!.method).toBe('POST');
    expect(bodyOf(ok.calls[0]!)).toEqual({ email: 'marie@example.ca', password: secret });
    expect(headersOf(ok.calls[0]!).apikey).toBe('public-anon');
    expect(headersOf(ok.calls[0]!).Authorization).toBeUndefined();
  });

  it('sends the password exactly as typed, spaces included', async () => {
    const ok = fakeFetch(() => json({ access_token: 'pw-at', user }));
    await new SupabaseTakatakOAuthProvider(env, ok.fetcher).signInWithPassword('marie@example.ca', '  Spaced-Out-9!  ');
    expect(bodyOf(ok.calls[0]!).password).toBe('  Spaced-Out-9!  ');
  });

  it('answers the same INVALID_CREDENTIALS for a wrong password, an unknown email, an unconfirmed email and a mismatched user', async () => {
    const cases = [
      json({ error: 'invalid_grant', error_code: 'invalid_credentials' }, 400),
      json({ error_code: 'email_not_confirmed' }, 400),
      json({}, 401),
      json({}, 422),
      json({ access_token: 'x', user: { ...user, email: 'someone-else@example.ca' } }),
      json({ access_token: 'x', user: { ...user, email_confirmed_at: null } }),
      json({ user }), // no access token
    ];
    for (const response of cases) {
      const p = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => response.clone()).fetcher);
      const error = await p.signInWithPassword('marie@example.ca', secret).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });

  it('maps hub limits and outages on sign-in without calling them a wrong password', async () => {
    const limited = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 429)).fetcher);
    await expect(limited.signInWithPassword('marie@example.ca', secret)).rejects.toMatchObject({ code: 'PASSWORD_PROVIDER_LIMIT' });
    const down = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => { throw new TypeError('fetch failed'); }).fetcher);
    await expect(down.signInWithPassword('marie@example.ca', secret)).rejects.toMatchObject({ code: 'TAKATAK_AUTH_UNAVAILABLE' });
    const error500 = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => json({}, 502)).fetcher);
    await expect(error500.signInWithPassword('marie@example.ca', secret)).rejects.toMatchObject({ code: 'TAKATAK_AUTH_UNAVAILABLE' });
  });

  it('sets a password with PUT /user and the customer token', async () => {
    const ok = fakeFetch(() => json({ id: 'u1' }));
    await expect(new SupabaseTakatakOAuthProvider(env, ok.fetcher).setPassword('hub-at', secret)).resolves.toBeUndefined();
    expect(ok.calls[0]!.url).toBe('https://auth.takatak.test/auth/v1/user');
    expect(ok.calls[0]!.init!.method).toBe('PUT');
    expect(headersOf(ok.calls[0]!).Authorization).toBe('Bearer hub-at');
    expect(headersOf(ok.calls[0]!).apikey).toBe('public-anon');
    expect(bodyOf(ok.calls[0]!)).toEqual({ password: secret });
  });

  it('translates the hub answers for setting a password, never echoing the password', async () => {
    const cases: Array<[Response, string]> = [
      [json({ error_code: 'weak_password', msg: 'Password should contain lowercase' }, 422), 'WEAK_PASSWORD'],
      [json({ error_code: 'same_password' }, 422), 'PASSWORD_UNCHANGED'],
      [json({ error_code: 'something_new' }, 422), 'WEAK_PASSWORD'],
      [json({}, 400), 'WEAK_PASSWORD'],
      [json({}, 401), 'CONSENT_EXPIRED'],
      [json({}, 403), 'CONSENT_EXPIRED'],
      [json({}, 429), 'PASSWORD_PROVIDER_LIMIT'],
      [json({}, 503), 'TAKATAK_AUTH_UNAVAILABLE'],
    ];
    for (const [response, code] of cases) {
      const p = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => response.clone()).fetcher);
      const error = await p.setPassword('hub-at', secret).catch((e: unknown) => e);
      expect(error).toMatchObject({ code });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String((error as Error).message)).not.toContain(secret);
    }
    const down = new SupabaseTakatakOAuthProvider(env, fakeFetch(() => { throw new TypeError('fetch failed'); }).fetcher);
    await expect(down.setPassword('hub-at', secret)).rejects.toMatchObject({ code: 'TAKATAK_AUTH_UNAVAILABLE' });
  });
});

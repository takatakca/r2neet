import { describe, expect, it } from 'vitest';
import { IdentityError } from '../src/identity/identity.js';
import { SupabaseGoogleAuthProvider } from '../src/identity/google-auth.js';

const CONFIG = {
  TAKATAK_SUPABASE_URL: 'https://project.supabase.co/',
  TAKATAK_SUPABASE_ANON_KEY: 'public-anon-key',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function providerWith(
  reply: (url: string, init: RequestInit) => Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const request = init ?? {};
    calls.push({ url, init: request });
    return reply(url, request);
  }) as typeof fetch;
  return {
    calls,
    provider: new SupabaseGoogleAuthProvider(CONFIG, fetcher),
  };
}

describe('TAKATAK Supabase Google auth provider', () => {
  it('requires a valid Supabase URL and public anon key', () => {
    expect(new SupabaseGoogleAuthProvider({}).configured).toBe(false);
    expect(
      new SupabaseGoogleAuthProvider({
        ...CONFIG,
        TAKATAK_SUPABASE_URL: 'http://project.supabase.co',
      }).configured,
    ).toBe(false);
    expect(
      new SupabaseGoogleAuthProvider({
        ...CONFIG,
        TAKATAK_SUPABASE_URL: 'http://localhost:54321',
      }).configured,
    ).toBe(true);
  });

  it('starts Google OAuth with a fixed R2NETTE callback and PKCE', () => {
    const provider = new SupabaseGoogleAuthProvider(CONFIG);
    const authorize = new URL(
      provider.authorizationUrl(
        'https://r2nette.ca',
        'pkce-challenge',
      ),
    );
    const callback = new URL(authorize.searchParams.get('redirect_to')!);

    expect(authorize.origin).toBe('https://project.supabase.co');
    expect(authorize.pathname).toBe('/auth/v1/authorize');
    expect(authorize.searchParams.get('provider')).toBe('google');
    expect(authorize.searchParams.get('code_challenge')).toBe('pkce-challenge');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256');
    expect(callback.origin).toBe('https://r2nette.ca');
    expect(callback.pathname).toBe('/api/v1/auth/google/callback');
    expect(callback.search).toBe('');
  });

  it('exchanges PKCE codes using only the Supabase anon key', async () => {
    const { calls, provider } = providerWith(async () =>
      response({
        user: {
          id: 'supabase-google-user',
          app_metadata: { providers: ['google'] },
        },
      }),
    );

    await expect(provider.exchangeCode('authorization-code', 'verifier')).resolves.toEqual({
      subject: 'supabase-google-user',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://project.supabase.co/auth/v1/token?grant_type=pkce',
    );
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toMatchObject({
      apikey: 'public-anon-key',
      Authorization: 'Bearer ' + 'public-anon-key',
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      auth_code: 'authorization-code',
      code_verifier: 'verifier',
    });
  });

  it('accepts a Google identity from the identity list', async () => {
    const { provider } = providerWith(async () =>
      response({
        user: {
          id: 'supabase-google-user',
          identities: [{ provider: 'google' }],
        },
      }),
    );

    await expect(provider.exchangeCode('code', 'verifier')).resolves.toEqual({
      subject: 'supabase-google-user',
    });
  });

  it('rejects non-Google or malformed identities', async () => {
    for (const user of [
      { id: 'user', app_metadata: { providers: ['phone'] } },
      { app_metadata: { providers: ['google'] } },
      null,
    ]) {
      const { provider } = providerWith(async () => response({ user }));
      await expect(provider.exchangeCode('code', 'verifier')).rejects.toMatchObject({
        code: 'GOOGLE_AUTH_DENIED',
      });
    }
  });

  it('does not expose Supabase provider failures', async () => {
    const { provider } = providerWith(async () =>
      response({ message: 'private provider diagnostic' }, 503),
    );

    await expect(provider.exchangeCode('code', 'verifier')).rejects.toEqual(
      expect.objectContaining({
        code: 'GOOGLE_AUTH_PROVIDER_UNAVAILABLE',
        message: 'TAKATAK Google authentication is temporarily unavailable.',
      }),
    );

    const offline = new SupabaseGoogleAuthProvider(
      CONFIG,
      (async () => {
        throw new Error('private network diagnostic');
      }) as typeof fetch,
    );
    await expect(offline.exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      IdentityError,
    );
  });
});
